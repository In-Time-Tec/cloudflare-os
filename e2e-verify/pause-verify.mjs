import { newWebSocketRpcSession } from "../packages/workshop-frontend/node_modules/capnweb/dist/index.js";
import { argon2id } from "../packages/workshop-frontend/node_modules/hash-wasm/dist/index.esm.js";
import { SERVICE_SALT } from "./salt.mjs";
const api = newWebSocketRpcSession("wss://intimetec-cloudflare-os.dallenpyrah.workers.dev/api");
async function hashPassword(u, p) {
  const ub = new TextEncoder().encode(u);
  const salt = new Uint8Array(SERVICE_SALT.length + ub.length);
  salt.set(SERVICE_SALT); salt.set(ub, SERVICE_SALT.length);
  return argon2id({ password: p, salt, parallelism: 1, iterations: 3, memorySize: 65536, hashLength: 32, outputType: "binary" });
}
const token = await api.login("e2everifier", await hashPassword("e2everifier", "e2e-verify-password-1"));
const authed = await api.authenticate(token);
const models = await authed.listModels();
const overseer = await authed.newThread();
const meta = await overseer.getMetadata();
console.log("thread:", meta.id);
await overseer.newChat("Run `echo hi` with executeShell then reply 'done'. Nothing else.", models[0].id);
console.log("waiting for agent + idle pause (checks every 60s for 9 min)...");
for (let i = 0; i < 9; i++) {
  await new Promise(r => setTimeout(r, 60000));
  const m = await overseer.getMetadata();
  console.log(`t+${i+1}min orbStatus:`, m.orbStatus);
  if (m.orbStatus === "paused") { console.log("VERIFY orb-pause: OK"); process.exit(0); }
}
console.log("VERIFY orb-pause: NOT PAUSED after 9min");
process.exit(1);
