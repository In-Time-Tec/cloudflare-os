// Helpers around managing templates and encoding/decoding template downloads (`.template` files).
//
// `.template` archives are streamed as a 24-byte prefix (magic, version, metadata byte length,
// content byte length), followed by UTF-8 JSON metadata and the gzip-compressed Yjs snapshot.
// See docs/templates.md for the full format description.

import { TemplateMetadata, TemplateOutput, TemplatePublicInfo, isOutputIcon } from '@gadgets/workshop-shared/api';

export const FEATURED_TEMPLATES_KEY = '.featured';

/**
 * Reserved key in the TEMPLATES KV namespace holding the deployment-wide admin config (a single
 * JSON object). AdminSettings already owns this namespace; see admin-config.ts.
 */
export const ADMIN_CONFIG_KEY = '.adminConfig';

const TEMPLATE_ARCHIVE_MAGIC = 0xec2e2d3a2300e317n;
const TEMPLATE_ARCHIVE_VERSION = 1;
const TEMPLATE_ARCHIVE_PREFIX_BYTES = 24;
const MAX_TEMPLATE_METADATA_BYTES = 64 * 1024;
const MAX_TEMPLATE_CONTENT_BYTES = 32 * 1024 * 1024;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export type TemplateKvRecord = {
  metadata: TemplateMetadata;
  /**
   * The User DO that published or uploaded this template, and which owns the authoritative
   * "featured" bit for it. Undefined for a template the deployment installed itself, which
   * has no owning user.
   */
  ownerId?: string;
  artifactId?: string;  // undefined = uploaded, not published from a artifact on this instance
};

export function isReservedTemplateKey(id: string): boolean {
  return id === FEATURED_TEMPLATES_KEY || id === ADMIN_CONFIG_KEY;
}

export function reviveTemplateMetadata(metadata: TemplateMetadata): TemplateMetadata {
  metadata.created = new Date(metadata.created);
  metadata.lastUpdated = new Date(metadata.lastUpdated);
  return metadata;
}

// Longest accepted output slug/noun. Display strings shown in tabs and chips, so this keeps the
// UI intact rather than being a safety limit.
const MAX_OUTPUT_STRING_LENGTH = 40;

function outputString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_OUTPUT_STRING_LENGTH) return undefined;
  return trimmed;
}

/**
 * Accept a template's declared output format only if it is completely well-formed, otherwise
 * treat the template as declaring nothing (a generic app). Template metadata arrives from
 * uploaded archives, so an unknown icon key or an overlong noun must degrade rather than reach
 * the UI.
 */
export function sanitizeTemplateOutput(output: unknown): TemplateOutput | undefined {
  if (!output || typeof output !== "object") return undefined;
  let {id, noun, plural, icon} = output as Partial<TemplateOutput>;
  let cleanId = outputString(id);
  let cleanNoun = outputString(noun);
  let cleanPlural = outputString(plural);
  if (!cleanId || !cleanNoun || !cleanPlural || !isOutputIcon(icon)) return undefined;
  return {id: cleanId, noun: cleanNoun, plural: cleanPlural, icon};
}

export function parseTemplateKvRecord(raw: string): TemplateKvRecord {
  let kvRecord = JSON.parse(raw) as TemplateKvRecord;
  kvRecord.metadata = reviveTemplateMetadata(kvRecord.metadata);
  return kvRecord;
}

export function parseFeaturedTemplates(raw: string): TemplatePublicInfo[] {
  let featured = JSON.parse(raw) as TemplatePublicInfo[];
  for (let entry of featured) {
    entry.metadata = reviveTemplateMetadata(entry.metadata);
  }
  return featured;
}

export function serializeFeaturedTemplates(featured: TemplatePublicInfo[]): string {
  return JSON.stringify(featured);
}

/**
 * The env a template KV read needs. Narrowed to the one binding so helpers that only read
 * templates can be called from anywhere holding it, without passing a whole env around.
 */
export type TemplateKvEnv = Pick<Cloudflare.Env, 'TEMPLATES'>;

export async function readTemplateKvRecord(
  env: TemplateKvEnv,
  templateId: string,
): Promise<TemplateKvRecord | null> {
  if (isReservedTemplateKey(templateId)) {
    return null;
  }

  let raw = await env.TEMPLATES.get(templateId);
  if (!raw) {
    return null;
  }

  return parseTemplateKvRecord(raw);
}

export async function listFeaturedTemplatesFromKv(
  env: TemplateKvEnv,
): Promise<TemplatePublicInfo[]> {
  let raw = await env.TEMPLATES.get(FEATURED_TEMPLATES_KEY);
  if (!raw) {
    return [];
  }

  return parseFeaturedTemplates(raw);
}

/**
 * Read a template's code snapshot (an uncompressed Yjs V2 state update of a doc whose unnamed
 * root map is filename -> Y.Text) from R2, or null if the content object doesn't exist.
 */
export async function readTemplateContent(
  env: Pick<Cloudflare.Env, 'TEMPLATE_CONTENT'>,
  templateId: string,
  version: number,
): Promise<Uint8Array | null> {
  let r2Object = await env.TEMPLATE_CONTENT.get(`${templateId}/${version}`);
  if (!r2Object) {
    return null;
  }

  let decompressed = r2Object.body.pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(decompressed).arrayBuffer());
}

export function randomTemplateId(): string {
  let idBytes = new Uint8Array(16);
  crypto.getRandomValues(idBytes);
  return idBytes.toHex();
}

function encodeTemplateArchivePrefix(metadata: TemplateMetadata, contentLength: number): Uint8Array {
  let metadataBytes = textEncoder.encode(JSON.stringify(metadata));
  let result = new Uint8Array(TEMPLATE_ARCHIVE_PREFIX_BYTES + metadataBytes.byteLength);
  let view = new DataView(result.buffer);
  view.setBigUint64(0, TEMPLATE_ARCHIVE_MAGIC);
  view.setUint32(8, TEMPLATE_ARCHIVE_VERSION);
  view.setUint32(12, metadataBytes.byteLength);
  view.setBigUint64(16, BigInt(contentLength));
  result.set(metadataBytes, TEMPLATE_ARCHIVE_PREFIX_BYTES);
  return result;
}

export function buildTemplateArchiveStream(
  metadata: TemplateMetadata,
  content: ReadableStream<Uint8Array>,
  contentLength: number,
): ReadableStream<Uint8Array> {
  let archive = new TransformStream<Uint8Array, Uint8Array>();

  void (async () => {
    try {
      await new Response(encodeTemplateArchivePrefix(metadata, contentLength)).body!
          .pipeTo(archive.writable, { preventClose: true });
      await content.pipeTo(archive.writable);
    } catch (err) {
      await archive.writable.abort(err);
    }
  })();

  return archive.readable;
}

function makeStreamPrefixReader(stream: ReadableStream<Uint8Array>) {
  let reader = stream.getReader();
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let tailTaken = false;

  function consume(length: number): Uint8Array {
    let result = new Uint8Array(length);
    let offset = 0;

    while (offset < length) {
      let chunk = pending[0];
      let take = Math.min(length - offset, chunk.byteLength);
      result.set(chunk.subarray(0, take), offset);
      offset += take;
      pendingBytes -= take;

      if (take === chunk.byteLength) {
        pending.shift();
      } else {
        pending[0] = chunk.subarray(take);
      }
    }

    return result;
  }

  async function fill(length: number): Promise<void> {
    while (pendingBytes < length) {
      let { done, value } = await reader.read();
      if (done) {
        throw new Error("Unexpected end of artifact archive.");
      }
      let chunk = value!;
      pending.push(chunk);
      pendingBytes += chunk.byteLength;
    }
  }

  return {
    async readExact(length: number): Promise<Uint8Array> {
      if (tailTaken) throw new Error("Archive content stream already opened.");
      await fill(length);
      return consume(length);
    },

    takeTail(): ReadableStream<Uint8Array> {
      if (tailTaken) throw new Error("Archive content stream already opened.");
      tailTaken = true;

      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (pending.length > 0) {
            let chunk = pending.shift()!;
            pendingBytes -= chunk.byteLength;
            controller.enqueue(chunk);
            return;
          }

          let { done, value } = await reader.read();
          if (done) {
            controller.close();
          } else {
            controller.enqueue(value);
          }
        },

        cancel(reason) {
          return reader.cancel(reason);
        },
      });
    },
  };
}

export async function parseTemplateArchive(archive: ReadableStream<Uint8Array>)
    : Promise<{metadata: TemplateMetadata, contentLength: number, content: ReadableStream<Uint8Array>}> {
  let reader = makeStreamPrefixReader(archive);
  let prefix = await reader.readExact(TEMPLATE_ARCHIVE_PREFIX_BYTES);
  let view = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);

  if (view.getBigUint64(0) !== TEMPLATE_ARCHIVE_MAGIC) {
    throw new Error("Invalid artifact archive magic number.");
  }

  let version = view.getUint32(8);
  if (version !== TEMPLATE_ARCHIVE_VERSION) {
    throw new Error(`Unsupported artifact archive version: ${version}.`);
  }

  let metadataSize = view.getUint32(12);
  if (metadataSize === 0) {
    throw new Error("Artifact archive is missing template metadata.");
  }
  if (metadataSize > MAX_TEMPLATE_METADATA_BYTES) {
    throw new Error("Artifact archive metadata size is out of range.");
  }

  let contentLength = Number(view.getBigUint64(16));
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
    throw new Error("Artifact archive has an invalid content length.");
  }
  if (contentLength > MAX_TEMPLATE_CONTENT_BYTES) {
    throw new Error("Artifact archive content is too large.");
  }

  let metadataBytes = await reader.readExact(metadataSize);
  let rawMetadata: TemplateMetadata;
  try {
    rawMetadata = JSON.parse(textDecoder.decode(metadataBytes));
  } catch {
    throw new Error("Artifact archive metadata is not valid JSON.");
  }

  let metadata = reviveTemplateMetadata(rawMetadata);
  return { metadata, contentLength, content: reader.takeTail() };
}
