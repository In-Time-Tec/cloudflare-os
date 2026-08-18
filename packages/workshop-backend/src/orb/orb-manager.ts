// Orb lifecycle management for one thread.
//
// An "orb" is the E2B sandbox backing a thread: created lazily on first use, woken by activity,
// explicitly paused after idle, and destroyed with the thread. The thread's Overseer DO is the
// single writer of orb state, which serializes all lifecycle transitions (no create/resume
// races). See plans/threads-orbs.md D2 and plans/research-e2b-orbs.md §4.
//
// The module is written in Effect style internally, but exposes small Promise-returning
// functions, since the Overseer is plain async TypeScript.

import { Effect } from "effect";
import { createLogger } from "@gadgets/backend-utils/logger";
import {
  connectSandbox, createSandbox, killSandbox, pauseSandbox, type E2bError,
} from "./e2b-api.js";

type OrbLogFields = {
  event: string;
  threadId?: string;
  sandboxId?: string;
  error?: unknown;
};

const logger = createLogger<OrbLogFields>({ component: "workshop.orb" });

/** Orb status as persisted in the thread DO and shown in the UI. */
export type OrbStatus = "none" | "running" | "paused";

/** The slice of orb state the thread DO persists. */
export type OrbState = {
  sandboxId?: string;
  status: OrbStatus;
  /** ms since epoch of the last activity that touched the orb. */
  lastActivity: number;
};

/** Deployment-wide orb settings (admin-configured; no per-thread sizing). */
export type OrbSettings = {
  enabled: boolean;
  /** E2B template the sandbox boots from ("base" unless the deployment ships its own). */
  orbTemplateId: string;
  /** Idle minutes before the DO pauses the orb. */
  idleMinutes: number;
};

export const DEFAULT_ORB_SETTINGS: OrbSettings = {
  enabled: false,
  orbTemplateId: "base",
  idleMinutes: 5,
};

/** TTL we ask E2B for on create/connect; the DO alarm pauses well before this backstop. */
const SANDBOX_TTL_SECONDS = 60 * 15;

/** How the storage layer of the owning DO exposes orb state to this module. */
export type OrbStateStore = {
  get(): OrbState;
  put(state: OrbState): void;
};

const run = <A>(threadId: string, effect: Effect.Effect<A, E2bError>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.tapError((error) =>
        Effect.sync(() => logger.warn("orb operation failed", {
          event: `orb.${error._tag}`, threadId, error,
        }))),
    ),
  );

/**
 * Ensure the thread's orb exists and is awake, returning its (possibly renewed) sandbox id.
 * Creates the sandbox on first use; otherwise issues the connect (resume-or-touch) primitive.
 * The sandbox id returned by every connect is re-persisted — E2B ids can drift across resumes.
 */
export async function wakeOrb(
  apiKey: string, threadId: string, settings: OrbSettings, store: OrbStateStore,
): Promise<{ sandboxId: string; resumed: boolean }> {
  const state = store.get();

  if (state.sandboxId === undefined) {
    const info = await run(threadId, createSandbox(apiKey, {
      templateId: settings.orbTemplateId,
      timeoutSeconds: SANDBOX_TTL_SECONDS,
      autoPause: true,
      metadata: { threadId },
    }));
    store.put({ sandboxId: info.sandboxID, status: "running", lastActivity: Date.now() });
    logger.info("orb created", { event: "orb.created", threadId, sandboxId: info.sandboxID });
    return { sandboxId: info.sandboxID, resumed: false };
  }

  const info = await run(threadId,
      connectSandbox(apiKey, state.sandboxId, SANDBOX_TTL_SECONDS));
  store.put({ sandboxId: info.sandboxID, status: "running", lastActivity: Date.now() });
  if (info.resumed) {
    logger.info("orb resumed", { event: "orb.resumed", threadId, sandboxId: info.sandboxID });
  }
  return { sandboxId: info.sandboxID, resumed: info.resumed };
}

/** Record activity without a control-plane round trip (the alarm reads lastActivity). */
export function touchOrb(store: OrbStateStore): void {
  const state = store.get();
  if (state.status === "running") {
    store.put({ ...state, lastActivity: Date.now() });
  }
}

/**
 * Explicitly pause the orb (deterministic snapshot boundary — preferred over E2B auto-pause,
 * which has a known write-back race). Called from the DO alarm once idle. Safe when already
 * paused or never created.
 */
export async function sleepOrb(
  apiKey: string, threadId: string, store: OrbStateStore,
): Promise<void> {
  const state = store.get();
  if (state.sandboxId === undefined || state.status !== "running") return;
  await run(threadId, pauseSandbox(apiKey, state.sandboxId));
  store.put({ ...state, status: "paused" });
  logger.info("orb paused", { event: "orb.paused", threadId, sandboxId: state.sandboxId });
}

/** Destroy the orb outright (thread deletion). Also frees a paused snapshot. */
export async function destroyOrb(
  apiKey: string, threadId: string, store: OrbStateStore,
): Promise<void> {
  const state = store.get();
  if (state.sandboxId === undefined) return;
  await run(threadId, killSandbox(apiKey, state.sandboxId));
  store.put({ status: "none", lastActivity: Date.now() });
  logger.info("orb destroyed", { event: "orb.destroyed", threadId, sandboxId: state.sandboxId });
}

/** True when the orb has been idle long enough for the alarm to pause it. */
export function orbIdleExpired(state: OrbState, settings: OrbSettings, now: number): boolean {
  return state.status === "running" &&
      now - state.lastActivity >= settings.idleMinutes * 60_000;
}
