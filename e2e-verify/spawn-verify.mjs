// E2E: thread graph — agent spawns a child thread, waits for its response.
import { newWebSocketRpcSession } from "../packages/workshop-frontend/node_modules/capnweb/dist/index.js";
import { argon2id } from "../packages/workshop-frontend/node_modules/hash-wasm/dist/index.esm.js";
import { SERVICE_SALT } from "./salt.mjs";

const api = newWebSocketRpcSession("wss://intimetec-cloudflare-os.dallenpyrah.workers.dev/api");
const USERNAME = "e2everifier";
async function hashPassword(username, password) {
  const usernameBuf = new TextEncoder().encode(username);
  const salt = new Uint8Array(SERVICE_SALT.length + usernameBuf.length);
  salt.set(SERVICE_SALT); salt.set(usernameBuf, SERVICE_SALT.length);
  return argon2id({ password, salt, parallelism: 1, iterations: 3, memorySize: 65536, hashLength: 32, outputType: "binary" });
}
const token = await api.login(USERNAME, await hashPassword(USERNAME, "e2e-verify-password-1"));
const authed = await api.authenticate(token);
const models = await authed.listModels();
const modelId = models[0].id;

const overseer = await authed.newThread();
const meta = await overseer.getMetadata();
console.log("parent thread:", meta.id);

const prompt = "Use your spawnThread tool to spawn a child thread titled 'Fruit picker' with this task: " +
    "'Reply with the name of exactly one fruit, nothing else.' Then use waitForThreads to collect its " +
    "response, and reply to me with: CHILD SAID: <the child's response>. Do not create any artifacts.";
const chatId = await overseer.newChat(prompt, modelId);
console.log("chatId:", chatId);

// Poll chat history until the agent's final message or timeout.
const deadline = Date.now() + 300000;
let final = null;
while (Date.now() < deadline) {
  await new Promise(r => setTimeout(r, 10000));
  const history = await overseer.getChatHistory(0);
  const agentMsgs = history.messages.filter(m => m.type === "message" && m.author.type === "agent" && String(m.message).trim());
  const errs = history.messages.filter(m => m.type === "error");
  if (errs.length) { console.log("ERROR MSG:", String(errs[errs.length-1].message).slice(0, 500)); }
  for (const m of history.messages) {
    if (m.toolCalls) for (const tc of m.toolCalls) {
      console.log("  tool:", tc.toolName, JSON.stringify(tc.input ?? {}).slice(0, 120), "->", String(tc.output ?? "").slice(0, 200).replace(/\n/g, " "));
    }
  }
  if (agentMsgs.length) {
    const last = agentMsgs[agentMsgs.length - 1];
    if (String(last.message).includes("CHILD SAID")) { final = String(last.message); break; }
  }
}
console.log("final agent message:", final ? final.slice(0, 300) : "(none)");

// Sidebar check: child thread should appear in listThreads with parentThreadId.
const threads = await authed.listThreads();
console.log("threads:", threads.length);
for (const t of threads) {
  console.log("  -", t.id.slice(0, 12), JSON.stringify(t.title), "parent:", t.parentThreadId ? t.parentThreadId.slice(0, 12) : null);
}
const child = threads.find(t => t.parentThreadId === meta.id);
console.log("VERIFY thread-spawn:", final ? "OK" : "TIMEOUT");
console.log("VERIFY child-in-sidebar:", child ? "OK (" + JSON.stringify(child.title) + ")" : "MISSING");
process.exit(0);
