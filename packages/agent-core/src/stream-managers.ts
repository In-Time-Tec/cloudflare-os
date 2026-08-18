import * as Y from "yjs";
import { createLogger } from "@gadgets/backend-utils/logger";
import type { AiChatStreamEvent, AiToolCall, WorkpieceId } from "@gadgets/workshop-shared/api";
import { StreamingToolInputParser } from "./streaming-json-parser.js";

const logger = createLogger<{toolCallId?: string; error?: unknown}>({ component: "agent-core.preview" });

// =======================================================================================

export type CodePreviewEntry = {
  toolName: "writeFile" | "editFile";
  parser: StreamingToolInputParser;
  /**
   * The edit's target workpiece, resolved from the streaming input's prefix fields once they are
   * complete. `null` means resolution failed (e.g. the agent omitted `workpiece` in a thread
   * with no default artifact) — the tool call itself will fail, so no preview is shown.
   */
  target?: {workpieceId: WorkpieceId, rootName: string} | null;
  /** Whether we've already emitted the toolCallTarget event. To avoid emitting multiple times. */
  targetEmitted?: boolean;
  cursor?: {
    ytext: Y.Text;       // the Y.Text entry in #previewDoc being modified
    insertPos: number;    // current cursor position for the next insert
    fieldLength: number;  // how much of the streaming field has been applied
  };
};

/**
 * Description of a file-editing tool call which we may need to replay. `rootName` names the
 * Y.Doc root map holding the target workpiece's files.
 */
export type ReplayPendingEdit = {
  toolName: "writeFile";
  rootName: string;
  filename: string;
  content: string;
} | {
  toolName: "editFile";
  rootName: string;
  filename: string;
  textToReplace: string;
  replacement: string;
};

/** Apply pending edit to a Y.Doc. */
export function applyPendingEditToYdoc(ydoc: Y.Doc, edit: ReplayPendingEdit) {
  switch (edit.toolName) {
    case "writeFile":
      ydoc.transact(tr => {
        let txt = new Y.Text();
        txt.insert(0, edit.content);
        ydoc.getMap<Y.Text>(edit.rootName).set(edit.filename, txt);
      });
      break;

    case "editFile": {
      let text = ydoc.getMap<Y.Text>(edit.rootName).get(edit.filename);
      if (!text) {
        throw new Error("File does not exist.");
      }

      let content = text.toString();
      let pos = content.indexOf(edit.textToReplace);
      if (pos < 0) {
        throw new Error("No matching text was found in the file.");
      }
      if (content.indexOf(edit.textToReplace, pos + 1) >= 0) {
        throw new Error("Multiple matches were found. The text to match must be unique.");
      }

      ydoc.transact(tr => {
        text.delete(pos, edit.textToReplace.length);
        text.insert(pos, edit.replacement);
      });
      break;
    }

    default:
      edit satisfies never;
      throw new Error("Unknown edit.");
  }
}

/**
 * Apply pending edit to file content as a string.
 *
 * This is used to replay pending edits to handle readFile-after-edit-in-same-turn correctly.
 */
export function applyPendingEditToText(content: string | null, edit: ReplayPendingEdit): string | null {
  switch (edit.toolName) {
    case "writeFile":
      return edit.content;

    case "editFile": {
      if (content === null) {
        throw new Error("File does not exist.");
      }

      let pos = content.indexOf(edit.textToReplace);
      if (pos < 0) {
        throw new Error("No matching text was found in the file.");
      }
      if (content.indexOf(edit.textToReplace, pos + 1) >= 0) {
        throw new Error("Multiple matches were found. The text to match must be unique.");
      }
      return content.slice(0, pos) + edit.replacement +
          content.slice(pos + edit.textToReplace.length);
    }

    default:
      edit satisfies never;
      throw new Error("Unknown edit.");
  }
}

/**
 * Manages live code previews for writeFile and editFile tool calls while the LLM is still
 * streaming.  As tool-call input tokens arrive, the streaming JSON parser extracts the
 * filename and content/replacement incrementally.  Once enough is known, a cursor is
 * activated on a shadow Y.Doc (cloned from the current project state) and new characters
 * are inserted at the cursor position.  Each Y.Doc mutation is captured and emitted to the
 * client as a "codeUpdate" stream event so the UI can show a real-time diff preview.
 */
export class CodePreviewManager {
  #previewDoc?: Y.Doc;
  #previews = new Map<string, CodePreviewEntry>();
  #broken = false;
  #activeFile: {workpieceId: WorkpieceId, filename: string} | null = null;

  /**
   * `resolveWorkpiece` resolves an edit's (optional) `workpiece` input field -- the chat binding
   * name of the target workpiece -- to the workpiece whose files are being edited, identifying
   * its files root in the preview doc and the target for setActiveFile/toolCallTarget events (a
   * filename alone doesn't identify a file).
   */
  constructor(private getBaseDoc: () => Y.Doc,
              private emit: (event: AiChatStreamEvent) => void,
              private resolveWorkpiece:
                  (workpiece?: string) => {workpieceId: WorkpieceId, rootName: string}) {}

  startToolCall(toolCallId: string, toolName: AiToolCall["toolName"]) {
    if (toolName !== "writeFile" && toolName !== "editFile") {
      return;
    }

    this.#ensureSession();
    let streamingField = toolName === "writeFile" ? "content" : "replacement";
    this.#previews.set(toolCallId, {
      toolName,
      parser: new StreamingToolInputParser(streamingField),
    });
  }

  appendInput(toolCallId: string, delta: string) {
    let entry = this.#previews.get(toolCallId);
    if (!entry || this.#broken) return;

    try {
      entry.parser.append(delta);
      if (entry.parser.hasError) throw new Error("Invalid JSON in tool input");

      this.#maybeEmitActiveFile(toolCallId, entry);

      if (entry.cursor) {
        this.#appendAtCursor(entry);
      } else {
        this.#tryActivateCursor(entry);
      }
    } catch (err) {
      this.#broken = true;
      logger.warn("failed to parse provisional tool input", {
        event: "agent.provisional.tool.input.parse.failed", toolCallId, error: err,
      });
      this.emit({type: "codeReset"});
    }
  }

  finishToolCall(toolCallId: string, success: boolean) {
    if (!this.#previews.has(toolCallId)) return;

    if (!success) {
      this.#previews.delete(toolCallId);
    }
  }

  clear() {
    this.#previewDoc = undefined;
    this.#previews.clear();
    this.#broken = false;
    this.#activeFile = null;
  }

  clearActiveFile() {
    if (this.#activeFile === null) return;

    this.#activeFile = null;
    this.emit({type: "setActiveFile", file: null});
  }

  #ensureSession() {
    if (this.#previewDoc) return;

    let baseUpdate = Y.encodeStateAsUpdateV2(this.getBaseDoc());
    this.#previewDoc = new Y.Doc();
    Y.applyUpdateV2(this.#previewDoc, baseUpdate);
    this.emit({type: "codeReset"});
  }

  #maybeEmitActiveFile(toolCallId: string, entry: CodePreviewEntry) {
    let prefix = entry.parser.prefixFields;
    let filename = prefix?.filename;
    if (typeof filename !== "string") {
      return;
    }

    // Resolve the target workpiece once the prefix fields (which precede the streaming content
    // field, hence are complete) are available.
    if (entry.target === undefined) {
      let rawWorkpiece = prefix!.workpiece;
      try {
        entry.target =
            this.resolveWorkpiece(typeof rawWorkpiece === "string" ? rawWorkpiece : undefined);
      } catch {
        // Unresolvable target: the tool call itself will fail, so show no preview for it.
        entry.target = null;
      }
    }
    if (!entry.target) return;
    let workpieceId = entry.target.workpieceId;

    // Tell the UI this call's target file so it can display before it finalizes.
    if (!entry.targetEmitted) {
      entry.targetEmitted = true;
      this.emit({type: "toolCallTarget", toolCallId, file: {workpieceId, filename}});
    }

    if (this.#activeFile !== null && this.#activeFile.workpieceId === workpieceId &&
        this.#activeFile.filename === filename) {
      return;
    }
    this.#activeFile = {workpieceId, filename};
    this.emit({type: "setActiveFile", file: {workpieceId, filename}});
  }

  // Try to activate direct cursor-based insertion for a preview. For writeFile, this
  // requires a complete filename and at least the start of content. For editFile, this
  // requires complete filename and textToReplace, a unique match in the file, and at
  // least the start of replacement.  In both cases, prefixFields being non-null means
  // all preceding fields are complete and the streaming field has begun.
  #tryActivateCursor(entry: CodePreviewEntry) {
    let prefix = entry.parser.prefixFields;
    if (!prefix || !entry.target) return;

    let previewFiles = this.#previewDoc!.getMap<Y.Text>(entry.target.rootName);
    let filename = prefix.filename as string;
    let streamValue = entry.parser.streamingValue;

    if (entry.toolName === "writeFile") {
      // Replace or create the file entry in previewDoc.
      let ytext = new Y.Text();
      if (streamValue !== "") {
        ytext.insert(0, streamValue);
      }
      this.#mutateAndEmit(() => previewFiles.set(filename, ytext));

      entry.cursor = { ytext, insertPos: streamValue.length,
                       fieldLength: streamValue.length };
      return;
    }

    // editFile
    let textToReplace = prefix.textToReplace as string;

    let ytext = previewFiles.get(filename);
    if (!ytext) return;

    let content = ytext.toString();
    let pos = content.indexOf(textToReplace);
    if (pos < 0) return;
    if (content.indexOf(textToReplace, pos + 1) >= 0) return;

    // Delete the matched text and insert replacement so far.
    this.#mutateAndEmit(() => {
      ytext!.delete(pos, textToReplace.length);
      if (streamValue !== "") {
        ytext!.insert(pos, streamValue);
      }
    });

    entry.cursor = { ytext, insertPos: pos + streamValue.length,
                     fieldLength: streamValue.length };
  }

  // Fast path: insert new content directly at the cursor position.
  #appendAtCursor(entry: CodePreviewEntry) {
    let streamValue = entry.parser.streamingValue;
    let newChars = streamValue.slice(entry.cursor!.fieldLength);
    if (newChars === "") return;

    this.#mutateAndEmit(() => {
      entry.cursor!.ytext.insert(entry.cursor!.insertPos, newChars);
    });
    entry.cursor!.insertPos += newChars.length;
    entry.cursor!.fieldLength = streamValue.length;
  }

  // Apply a mutation to #previewDoc, capture the resulting Y.Doc update, and emit it.
  #mutateAndEmit(fn: () => void) {
    let updates: Uint8Array[] = [];
    let handler = (update: Uint8Array) => updates.push(update);
    this.#previewDoc!.on("updateV2", handler);
    try {
      fn();
    } finally {
      this.#previewDoc!.off("updateV2", handler);
    }
    if (updates.length > 0) {
      this.emit({type: "codeUpdate", update: updates.length === 1
          ? updates[0] : Y.mergeUpdatesV2(updates)});
    }
  }
}

/**
 * Streams the `code` field of executeCode tool calls to the client as it arrives, so the
 * UI can display the code the agent is about to run before the tool call is actually
 * invoked.  Emits incremental "toolCodeDelta" stream events containing only the new
 * characters decoded since the last event.
 */
export class ExecuteCodeStreamManager {
  #streams = new Map<string, {parser: StreamingToolInputParser, emittedLength: number}>();

  constructor(private emit: (event: AiChatStreamEvent) => void) {}

  startToolCall(toolCallId: string, toolName: AiToolCall["toolName"]) {
    if (toolName !== "executeCode") {
      return;
    }

    this.#streams.set(toolCallId, {
      parser: new StreamingToolInputParser("code"),
      emittedLength: 0,
    });
  }

  appendInput(toolCallId: string, delta: string) {
    let stream = this.#streams.get(toolCallId);
    if (!stream) return;

    try {
      stream.parser.append(delta);
      if (stream.parser.hasError) {
        this.#streams.delete(toolCallId);
        logger.warn("failed to parse provisional executeCode input", {
          event: "agent.provisional.execute.code.input.parse.failed",
          toolCallId,
        });
        return;
      }

      if (!stream.parser.prefixFields) return;

      let code = stream.parser.streamingValue;
      let newDelta = code.slice(stream.emittedLength);
      if (newDelta !== "") {
        stream.emittedLength = code.length;
        this.emit({
          type: "toolCodeDelta",
          toolCallId,
          delta: newDelta,
        });
      }
    } catch (err) {
      this.#streams.delete(toolCallId);
      logger.warn("failed to parse provisional executeCode input", {
        event: "agent.provisional.execute.code.input.parse.failed",
        toolCallId, error: err,
      });
    }
  }

  finishToolCall(toolCallId: string) {
    this.#streams.delete(toolCallId);
  }

  clear() {
    this.#streams.clear();
  }
}

// Renders a JSON-structured tool result as the exact text the model sees. Used by both the live
// tools and history replay so the two can never drift.
