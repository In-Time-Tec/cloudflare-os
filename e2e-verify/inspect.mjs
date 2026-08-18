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
const threadId = process.argv[2];
const overseer = await authed.openThread(threadId);
const history = await overseer.getChatHistory(0);
console.log("messages:", history.messages.length);
for (const m of history.messages) {
  const body = m.type === "message" ? String(m.message).slice(0, 400)
      : m.type === "error" ? "ERR: " + String(m.message).slice(0, 400) : "";
  console.log(`--- [${m.type}] [${m.author?.type}/${m.author?.id ?? ""}]`, body.replace(/\n/g, " "));
  if (m.toolCalls) for (const tc of m.toolCalls) {
    console.log(`    tool: ${tc.toolName}`, JSON.stringify(tc.input).slice(0, 200), "->", String(tc.output ?? "").slice(0, 300).replace(/\n/g, " "), tc.error ? "ERROR: " + String(tc.error).slice(0, 400) : "");
  }
}
const meta = await overseer.getMetadata();
console.log("orbStatus:", meta.orbStatus);
process.exit(0);
