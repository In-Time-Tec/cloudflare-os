import { readFileSync, writeFileSync } from "node:fs";
import { RpcTarget, newWebSocketRpcSession } from "capnweb";
import { Duration, Effect, Schedule } from "effect";
import { runAgent } from "@gadgets/agent-core";
import type { OrbHooks, OrbTurnRecord } from "@gadgets/workshop-shared/orb-harness";
import { HarnessAgentHooks, type Remoted } from "./hooks-adapter.js";
import { makeProxyHandle } from "./proxy-handle.js";

const HARNESS_DIR = process.env.ORB_HARNESS_DIR ?? "/home/user/.orb-harness";
const SESSION_FILE = `${HARNESS_DIR}/session.jwt`;

function readSession(): { jwt: string; origin: string } {
  const jwt = (process.env.ORB_SESSION_JWT ??
      readFileSync(SESSION_FILE, "utf8")).trim();
  const origin = (process.env.ORB_ORIGIN ??
      readFileSync(`${HARNESS_DIR}/origin.txt`, "utf8")).trim();
  return { jwt, origin };
}

function writeSessionJwt(jwt: string): void {
  writeFileSync(SESSION_FILE, jwt);
}

function harnessUrl(origin: string): string {
  return origin.replace(/^http/, "ws") + "/orb-api/harness";
}

class HarnessTarget extends RpcTarget {
  private running = new Map<string, AbortController>();

  constructor(private hooks: Remoted<OrbHooks>) {
    super();
  }

  runTurn(turn: OrbTurnRecord): void {
    if (this.running.has(turn.turnId)) return;
    const controller = new AbortController();
    this.running.set(turn.turnId, controller);
    void this.#run(turn, controller.signal).finally(() => {
      this.running.delete(turn.turnId);
    });
  }

  abortTurn(turnId: string): void {
    this.running.get(turnId)?.abort();
  }

  ping(): void {}

  async #run(initial: OrbTurnRecord, signal: AbortSignal): Promise<void> {
    let turn = initial;
    let nudged = false;
    let lastCallbackCount = 0;
    try {
      for (;;) {
        if (signal.aborted) throw new Error("Turn aborted.");
        const hooks = new HarnessAgentHooks(this.hooks, turn);
        const handle = makeProxyHandle(turn);
        const checkpoint = await runAgent(
            hooks, handle, turn.chatId, turn.author, turn.chatMessages, signal,
            turn.initiator, turn.callbackInitiated, turn.compaction);
        if (checkpoint) {
          if (turn.stopAfterCompaction) {
            await this.hooks.reportTurnTerminal(turn.turnId, { kind: "ok", checkpoint });
            return;
          }
          await this.hooks.reportTurnTerminal(turn.turnId, { kind: "compacted", checkpoint });
          const grantJwt = await this.hooks.mintInferenceGrant(turn.turnId);
          turn = {
            ...turn,
            grantJwt,
            chatMessages: await this.hooks.listChatTail(turn.chatId),
            compaction: { ...turn.compaction, checkpoint, measuredTokens: 0 },
          };
          continue;
        }
        const callbackCount = await this.hooks.activeAgentCallbackCount(turn.chatId);
        if (!turn.callbackInitiated || callbackCount === 0) {
          await this.hooks.reportTurnTerminal(turn.turnId, { kind: "ok" });
          return;
        }
        if (nudged && callbackCount >= lastCallbackCount) {
          await this.hooks.rejectAllAgentCallbacks(
              turn.chatId, "Agent failed to resolve callbacks after multiple attempts.");
          await this.hooks.reportTurnTerminal(turn.turnId, {
            kind: "failed",
            error: `Failed to resolve ${callbackCount} outstanding callback(s).`,
          });
          return;
        }
        if (nudged && callbackCount < lastCallbackCount) nudged = false;
        lastCallbackCount = callbackCount;
        await this.hooks.nudgeOutstandingCallbacks(turn.chatId);
        nudged = true;
        const grantJwt = await this.hooks.mintInferenceGrant(turn.turnId);
        turn = {
          ...turn,
          grantJwt,
          callbackInitiated: true,
          chatMessages: await this.hooks.listChatTail(turn.chatId),
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        await this.hooks.reportTurnTerminal(turn.turnId, { kind: "failed", error: message });
      } catch { }
    }
  }
}

const runSession = Effect.gen(function* () {
  const { jwt: initialJwt, origin } = readSession();
  const api = newWebSocketRpcSession<{
    authenticateOrbHarness(jwt: string): Promise<Remoted<OrbHooks>>;
  }>(harnessUrl(origin));
  yield* Effect.addFinalizer(() => Effect.sync(() => api[Symbol.dispose]()));
  const hooks = yield* Effect.tryPromise({
    try: () => api.authenticateOrbHarness(initialJwt),
    catch: (cause) => cause,
  });
  const target = new HarnessTarget(hooks);
  yield* Effect.tryPromise({
    try: () => Promise.resolve(hooks.attachHarness(target)),
    catch: (cause) => cause,
  });
  const pending = yield* Effect.tryPromise({
    try: () => hooks.claimPendingTurn(),
    catch: (cause) => cause,
  });
  if (pending) target.runTurn(pending);
  yield* Effect.forever(
    Effect.sleep(Duration.minutes(10)).pipe(
      Effect.andThen(Effect.tryPromise({
        try: (): Promise<string> => hooks.refreshOrbSession(),
        catch: (cause) => cause,
      })),
      Effect.tap((next) => Effect.sync(() => writeSessionJwt(next))),
    ),
  );
});

const program = Effect.scoped(runSession).pipe(
  Effect.catchCause((cause) => Effect.sync(() => {
    console.error(cause);
  })),
  Effect.repeat(Schedule.min([
    Schedule.exponential(Duration.seconds(1)),
    Schedule.spaced(Duration.seconds(30)),
  ])),
);

void Effect.runPromise(program);
