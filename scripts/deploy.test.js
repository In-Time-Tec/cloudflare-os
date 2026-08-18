import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "jsonc-parser";
import {
  ensureRemoteResources,
  generateConfigs,
  getDeploymentSecrets,
  resolveAdmins,
  validateConfig,
} from "./deploy.mjs";

const accountId = "0123456789abcdef0123456789abcdef";
const validConfig = {
  workers: {
    router: "acme-os",
    backend: "acme-os-backend",
    context: "acme-os-context",
    scheduler: "acme-os-scheduler",
    microsoft: "acme-os-microsoft",
  },
  auth: { admins: ["password:admin"] },
  context: { sharingDomain: "acme-workers-dev" },
  ai: {
    providers: ["openrouter"],
    defaultModel: "openai/gpt-5.6-luna",
  },
  resources: {
    templatesKvNamespace: "acme-os-backend-templates",
    avatarsKvNamespace: "acme-os-backend-avatars",
    templateContentBucket: "acme-os-backend-template-content",
    contextKvNamespace: "acme-os-context-collections",
  },
};
const resolvedResources = {
  templatesKvNamespaceId: "11111111111111111111111111111111",
  avatarsKvNamespaceId: "22222222222222222222222222222222",
  contextKvNamespaceId: "33333333333333333333333333333333",
  workersSubdomain: "acme",
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
    microsoft: await baseConfig("../packages/gatekeeper-microsoft/wrangler.jsonc"),
  };
}

test("rejects invalid deployment identities", () => {
  const duplicate = structuredClone(validConfig);
  duplicate.workers.context = duplicate.workers.backend;
  assert.throws(() => validateConfig(duplicate), /unique/i);

  const malformedAdmin = structuredClone(validConfig);
  malformedAdmin.auth.admins = ["no-colon-principal"];
  assert.throws(() => validateConfig(malformedAdmin), /principal/i);

  const missingResource = structuredClone(validConfig);
  delete missingResource.resources.contextKvNamespace;
  assert.throws(() => validateConfig(missingResource), /contextKvNamespace/);

  const unsupportedAiProvider = structuredClone(validConfig);
  unsupportedAiProvider.ai.providers = ["unknown"];
  assert.throws(() => validateConfig(unsupportedAiProvider), /AI providers/);
});

test("generates the workers.dev composition", async () => {
  const generated = generateConfigs(
      validConfig,
      accountId,
      await baseConfigs(),
      resolvedResources,
      { MICROSOFT_CLIENT_ID: "client-id" },
  );

  assert.equal(generated.router.name, "acme-os");
  assert.equal(generated.router.workers_dev, true);
  assert.deepEqual(generated.router.services.map(({ binding, service }) => ({ binding, service })), [
    { binding: "WORKSHOP_BACKEND", service: "acme-os-backend" },
    { binding: "GATEKEEPER_CONTEXT", service: "acme-os-context" },
    { binding: "GATEKEEPER_SCHEDULER", service: "acme-os-scheduler" },
    { binding: "GATEKEEPER_MICROSOFT", service: "acme-os-microsoft" },
  ]);
  assert.equal(generated.router.assets.directory, "../workshop-frontend/dist");
  assert.ok(generated.router.assets.run_worker_first.includes("/orb-api/*"));

  assert.equal(generated.backend.workers_dev, false);
  assert.deepEqual(generated.backend.vars.ADMINS, ["password:admin"]);
  // Microsoft Entra is the only sign-in method when its secrets are configured.
  assert.equal(generated.backend.vars.AUTH_GATEKEEPERS, "microsoft");
  assert.equal(generated.backend.vars.DISABLE_PASSWORD_AUTH, "true");

  // Without Microsoft secrets, password auth stays on so the deployment isn't locked out.
  const generatedNoAuth = generateConfigs(
      validConfig, accountId, await baseConfigs(), resolvedResources, {});
  assert.equal(generatedNoAuth.backend.vars.DISABLE_PASSWORD_AUTH, "false");
  assert.deepEqual(
      generated.backend.services.map(({ binding, service }) => ({ binding, service })), [
    { binding: "GATEKEEPER_CONTEXT", service: "acme-os-context" },
    { binding: "GATEKEEPER_SCHEDULER", service: "acme-os-scheduler" },
    { binding: "GATEKEEPER_MICROSOFT", service: "acme-os-microsoft" },
  ]);
  assert.equal(generated.microsoft.workers_dev, false);
  assert.equal(generated.microsoft.vars.BASE_URL,
      "https://acme-os.acme.workers.dev/gatekeeper/microsoft");
  assert.equal(generated.backend.vars.PUBLIC_BASE_URL, "https://acme-os.acme.workers.dev");
  assert.equal(generated.backend.vars.DEPLOYMENT_AI_PROVIDERS, "openrouter");
  assert.equal(generated.backend.vars.DEPLOYMENT_AI_DEFAULT_MODEL, "openai/gpt-5.6-luna");
  assert.deepEqual(generated.backend.ai, { binding: "WORKERS_AI" });
  assert.deepEqual(generated.backend.kv_namespaces, [
    { binding: "TEMPLATES", id: resolvedResources.templatesKvNamespaceId },
    { binding: "AVATARS", id: resolvedResources.avatarsKvNamespaceId },
  ]);
  assert.deepEqual(generated.backend.r2_buckets, [
    { binding: "TEMPLATE_CONTENT", bucket_name: "acme-os-backend-template-content" },
  ]);
  assert.deepEqual(generated.backend.services[0], {
    binding: "GATEKEEPER_CONTEXT",
    service: "acme-os-context",
    entrypoint: "GatekeeperVendor",
    props: { sharingDomain: "acme-workers-dev" },
  });

  assert.equal(generated.context.workers_dev, false);
  assert.deepEqual(generated.context.kv_namespaces, [{
    binding: "CONTEXT_COLLECTIONS",
    id: resolvedResources.contextKvNamespaceId,
  }]);
  assert.equal(generated.scheduler.workers_dev, false);
});

test("requires and resolves deployment-managed provider secrets", () => {
  const entraEnv = {
    MICROSOFT_CLIENT_ID: "client-id",
    MICROSOFT_CLIENT_SECRET: "client-secret",
    MICROSOFT_TENANT_ID: "tenant-id",
  };
  assert.deepEqual(
      getDeploymentSecrets(validConfig, { OPENROUTER_API_TOKEN: "openrouter-token", ...entraEnv }),
      {
        backend: { OPENROUTER_API_TOKEN: "openrouter-token" },
        microsoft: {
          CLIENT_ID: "client-id",
          CLIENT_SECRET: "client-secret",
          TENANT_ID: "tenant-id",
        },
      },
  );
  assert.throws(
      () => getDeploymentSecrets(validConfig, {}),
      /OPENROUTER_API_TOKEN is required/,
  );
  // A partial Entra configuration is a mistake, not a downgrade.
  assert.throws(
      () => getDeploymentSecrets(validConfig,
          { OPENROUTER_API_TOKEN: "t", MICROSOFT_CLIENT_ID: "only-one" }),
      /Partial Microsoft Entra configuration/,
  );
  // No Entra secrets at all deploys unconfigured (sign-in shows the not-configured page).
  const withoutAi = structuredClone(validConfig);
  delete withoutAi.ai;
  assert.deepEqual(getDeploymentSecrets(withoutAi, {}), { backend: {}, microsoft: {} });
});

test("folds the secret-configured Entra admin principal into ADMINS", () => {
  assert.deepEqual(resolveAdmins(validConfig, {}), ["password:admin"]);
  assert.deepEqual(
      resolveAdmins(validConfig, {
        MICROSOFT_TENANT_ID: "tenant-id",
        MICROSOFT_ADMIN_OID: "oid-123",
      }),
      [
        "password:admin",
        "https://login.microsoftonline.com/tenant-id/v2.0:oid-123",
      ],
  );
});

test("reuses storage created by a partial deployment and creates only missing resources", async () => {
  const requests = [];
  const existingNamespaces = [
    {
      title: validConfig.resources.templatesKvNamespace,
      id: resolvedResources.templatesKvNamespaceId,
    },
    {
      title: validConfig.resources.avatarsKvNamespace,
      id: resolvedResources.avatarsKvNamespaceId,
    },
    {
      title: validConfig.resources.contextKvNamespace,
      id: resolvedResources.contextKvNamespaceId,
    },
  ];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    requests.push({ path: url.pathname, method: init.method ?? "GET" });
    if (url.pathname.endsWith("/storage/kv/namespaces")) {
      return Response.json({
        success: true,
        result: existingNamespaces,
        result_info: { total_pages: 1 },
      });
    }
    if (url.pathname.endsWith("/workers/subdomain")) {
      return Response.json({ success: true, result: { subdomain: "acme" } });
    }
    if (url.pathname.endsWith(`/${validConfig.resources.templateContentBucket}`) &&
        (init.method ?? "GET") === "GET") {
      return Response.json(
          { success: false, errors: [{ code: 10006, message: "bucket not found" }] },
          { status: 404 },
      );
    }
    if (url.pathname.endsWith("/r2/buckets") && init.method === "POST") {
      return Response.json({ success: true, result: { name: "created" } });
    }
    throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url.pathname}`);
  };

  const resources = await ensureRemoteResources(validConfig, accountId, "test-token", fetchImpl);

  assert.deepEqual(resources, resolvedResources);
  assert.deepEqual(requests, [
    {
      path: `/client/v4/accounts/${accountId}/storage/kv/namespaces`,
      method: "GET",
    },
    {
      path: `/client/v4/accounts/${accountId}/workers/subdomain`,
      method: "GET",
    },
    {
      path: `/client/v4/accounts/${accountId}/r2/buckets/` +
        validConfig.resources.templateContentBucket,
      method: "GET",
    },
    {
      path: `/client/v4/accounts/${accountId}/r2/buckets`,
      method: "POST",
    },
  ]);
});
