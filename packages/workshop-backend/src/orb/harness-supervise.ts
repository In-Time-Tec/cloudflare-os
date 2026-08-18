import { Effect } from "effect";
import { createLogger } from "@gadgets/backend-utils/logger";
import { ORB_HARNESS_HASH, ORB_HARNESS_SOURCE } from "../generated/orb-harness-bundle.js";
import {
  isProcessAlive, runCommand, signalProcess, startDetached, writeFile,
} from "./envd.js";
import type { OrbSettings, OrbStateStore } from "./orb-manager.js";
import { wakeOrb } from "./orb-manager.js";

const logger = createLogger<{
  event: string;
  threadId?: string;
  sandboxId?: string;
  error?: unknown;
}>({ component: "workshop.orb.harness" });

const HARNESS_DIR = "/home/user/.orb-harness";
const HARNESS_FILE = `${HARNESS_DIR}/harness.mjs`;
const SESSION_FILE = `${HARNESS_DIR}/session.jwt`;
const ORIGIN_FILE = `${HARNESS_DIR}/origin.txt`;

export async function ensureHarnessProcess(args: {
  apiKey: string;
  threadId: string;
  settings: OrbSettings;
  store: OrbStateStore;
  origin: string;
  sessionJwt: string;
  restart: boolean;
}): Promise<{ sandboxId: string }> {
  const { sandboxId } = await wakeOrb(args.apiKey, args.threadId, args.settings, args.store);
  const state = args.store.get();
  const token = state.envdAccessToken;
  const run = <A>(effect: Effect.Effect<A, unknown>) =>
    Effect.runPromise(effect.pipe(
      Effect.tapError((error) => Effect.sync(() => logger.warn("harness supervise failed", {
        event: "orb.harness.supervise.failed", threadId: args.threadId, sandboxId, error,
      }))),
    ));

  await run(runCommand(sandboxId, token, `mkdir -p ${HARNESS_DIR}`, 15_000));

  const hashMatches = state.harnessHash === ORB_HARNESS_HASH;
  if (!hashMatches) {
    await run(writeFile(sandboxId, token, HARNESS_FILE, ORB_HARNESS_SOURCE));
  }
  await run(writeFile(sandboxId, token, SESSION_FILE, args.sessionJwt));
  await run(writeFile(sandboxId, token, ORIGIN_FILE, args.origin));

  let pid = state.harnessPid;
  let alive = false;
  if (pid !== undefined) {
    try {
      alive = await run(isProcessAlive(sandboxId, token, pid));
    } catch {
      alive = true;
    }
  }

  if (alive && hashMatches && !args.restart) {
    return { sandboxId };
  }

  if (pid !== undefined && alive) {
    await run(signalProcess(sandboxId, token, pid, "TERM")).catch(() => undefined);
    await scheduler.wait(500);
    await run(signalProcess(sandboxId, token, pid, "KILL")).catch(() => undefined);
  }

  const nextPid = await run(startDetached(
      sandboxId, token, `node ${HARNESS_FILE}`));
  args.store.put({
    ...args.store.get(),
    harnessPid: nextPid,
    harnessHash: ORB_HARNESS_HASH,
  });
  logger.info("orb harness started", {
    event: "orb.harness.started", threadId: args.threadId, sandboxId,
  });
  return { sandboxId };
}
