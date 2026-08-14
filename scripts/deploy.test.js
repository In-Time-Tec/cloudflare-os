import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "jsonc-parser";
import { generateConfigs, validateConfig } from "./deploy.mjs";

const accountId = "0123456789abcdef0123456789abcdef";
const validConfig = {
  workers: {
    router: "acme-os",
    backend: "acme-os-backend",
    context: "acme-os-context",
    scheduler: "acme-os-scheduler",
  },
  auth: { admins: ["admin"] },
  context: { sharingDomain: "acme-workers-dev" },
  resources: {
    blueprintsKvNamespaceId: null,
    avatarsKvNamespaceId: null,
    blueprintContentBucket: null,
    contextKvNamespaceId: null,
  },
};

async function baseConfig(path) {
  return parse(await readFile(new URL(path, import.meta.url), "utf8"));
}

async function baseConfigs() {
  return {
    router: await baseConfig("../packages/router/wrangler.jsonc"),
    backend: await baseConfig("../packages/workshop-backend/wrangler.jsonc"),
    context: await baseConfig("../packages/gatekeeper-context/wrangler.jsonc"),
    scheduler: await baseConfig("../packages/gatekeeper-scheduler/wrangler.jsonc"),
  };
}

test("rejects invalid deployment identities", () => {
  const duplicate = structuredClone(validConfig);
  duplicate.workers.context = duplicate.workers.backend;
  assert.throws(() => validateConfig(duplicate), /unique/i);

  const malformedAdmin = structuredClone(validConfig);
  malformedAdmin.auth.admins = ["Admin User"];
  assert.throws(() => validateConfig(malformedAdmin), /username/i);

  const missingResource = structuredClone(validConfig);
  delete missingResource.resources.contextKvNamespaceId;
  assert.throws(() => validateConfig(missingResource), /contextKvNamespaceId/);
});

test("generates the workers.dev composition", async () => {
  const generated = generateConfigs(validConfig, accountId, await baseConfigs());

  assert.equal(generated.router.name, "acme-os");
  assert.equal(generated.router.workers_dev, true);
  assert.deepEqual(generated.router.services.map(({ binding, service }) => ({ binding, service })), [
    { binding: "WORKSHOP_BACKEND", service: "acme-os-backend" },
    { binding: "GATEKEEPER_CONTEXT", service: "acme-os-context" },
    { binding: "GATEKEEPER_SCHEDULER", service: "acme-os-scheduler" },
  ]);
  assert.equal(generated.router.assets.directory, "../workshop-frontend/dist");

  assert.equal(generated.backend.workers_dev, false);
  assert.deepEqual(generated.backend.vars.ADMINS, ["admin"]);
  assert.deepEqual(generated.backend.ai, { binding: "WORKERS_AI" });
  assert.deepEqual(generated.backend.kv_namespaces, [
    { binding: "BLUEPRINTS" },
    { binding: "AVATARS" },
  ]);
  assert.deepEqual(generated.backend.r2_buckets, [{ binding: "BLUEPRINT_CONTENT" }]);
  assert.deepEqual(generated.backend.services[0], {
    binding: "GATEKEEPER_CONTEXT",
    service: "acme-os-context",
    entrypoint: "GatekeeperVendor",
    props: { sharingDomain: "acme-workers-dev" },
  });

  assert.equal(generated.context.workers_dev, false);
  assert.deepEqual(generated.context.kv_namespaces, [{ binding: "CONTEXT_COLLECTIONS" }]);
  assert.equal(generated.scheduler.workers_dev, false);
});
