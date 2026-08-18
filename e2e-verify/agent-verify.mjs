// Deep E2E: agent turn, orb lifecycle, executeShell, thread graph.
import { newWebSocketRpcSession, RpcTarget } from "../packages/workshop-frontend/node_modules/capnweb/dist/index.js";
import { argon2id } from "../packages/workshop-frontend/node_modules/hash-wasm/dist/index.esm.js";
import { SERVICE_SALT } from "./salt.mjs";

const BASE = "wss://intimetec-cloudflare-os.dallenpyrah.workers.dev/api";
const USERNAME = "e2everifier";
const PASSWORD = "e2e-verify-password-1";

async function hashPassword(username, password) {
  const usernameBuf = new TextEncoder().encode(username);
  const salt = new Uint8Array(SERVICE_SALT.length + usernameBuf.length);
  salt.set(SERVICE_SALT);
  salt.set(usernameBuf, SERVICE_SALT.length);
  return argon2id({ password, salt, parallelism: 1, iterations: 3, memorySize: 65536,
                    hashLength: 32, outputType: "binary" });
}

const api = newWebSocketRpcSession(BASE);
const token = await api.login(USERNAME, await hashPassword(USERNAME, PASSWORD));
if (!token) throw new Error("login failed");
const authed = await api.authenticate(token);

const models = await authed.listModels();
console.log("models total", models.length, "first:", models[0]?.id);
if (models.length === 0) throw new Error("no models");
const modelId = models[0].id;

const overseer = await authed.newThread();
const meta = await overseer.getMetadata();
console.log("thread:", meta.id, "orbStatus:", meta.orbStatus);

const messages = [];
let resolveDone;
const donePromise = new Promise((res) => { resolveDone = res; });
let sawActive = false;

class ChatSub extends RpcTarget {
  update(msg) {
    messages.push(msg);
    if (msg.type === "message") {
      console.log(`[${msg.author.type}]`, String(msg.message).slice(0, 300).replace(/\n/g, " "));
    } else if (msg.type === "error") {
      console.log(`[error]`, String(msg.message).slice(0, 300));
    } else {
      console.log(`[${msg.type}]`);
    }
  }
  chatMetadataUpdate(chatMeta) {
    const active = !!chatMeta.activeAgent;
    console.log("chatMeta activeAgent:", active ? chatMeta.activeAgent.id : null);
    if (active) sawActive = true;
    if (!active && sawActive) resolveDone();
  }
  streamEvent() {}
}

const prompt = "Use your executeShell tool to run this exact command: echo orb-verify-$((6*7)). " +
    "Then reply with just the command output. Do not create any artifacts.";
const chatId = await overseer.newChat(prompt, modelId);
console.log("chatId:", chatId);
const sub = await overseer.subscribeToChat(new ChatSub());

// Poll orb status while the agent runs.
const orbStatuses = new Set([meta.orbStatus]);
const poller = setInterval(async () => {
  try {
    const m = await overseer.getMetadata();
    if (!orbStatuses.has(m.orbStatus)) {
      console.log("orbStatus ->", m.orbStatus);
      orbStatuses.add(m.orbStatus);
    }
  } catch {}
}, 5000);

const timeout = new Promise((res) => setTimeout(() => res("TIMEOUT"), 240000));
const outcome = await Promise.race([donePromise.then(() => "DONE"), timeout]);
clearInterval(poller);
console.log("agent turn outcome:", outcome);

const finalMeta = await overseer.getMetadata();
console.log("final orbStatus:", finalMeta.orbStatus, "seen:", [...orbStatuses].join(","));

const agentText = messages.filter(m => m.type === "message" && m.author.type === "agent")
    .map(m => m.message).join("\n");
const toolMsgs = messages.filter(m => m.type === "message" && m.toolCalls?.length)
    .flatMap(m => m.toolCalls.map(tc => tc.toolName));
console.log("tools used:", JSON.stringify(toolMsgs));
console.log("VERIFY agent-turn:", outcome === "DONE" ? "OK" : "TIMEOUT");
console.log("VERIFY orb-wake:", orbStatuses.has("running") ? "OK" : "NOT-SEEN(" + [...orbStatuses].join(",") + ")");
console.log("VERIFY shell-output:", agentText.includes("orb-verify-42") ? "OK" : "MISSING");
process.exit(0);
