import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse, printParseErrorCode } from "jsonc-parser";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatedName = "wrangler.prod.jsonc";
const packageDirs = {
  router: join(root, "packages/router"),
  backend: join(root, "packages/workshop-backend"),
  context: join(root, "packages/gatekeeper-context"),
  scheduler: join(root, "packages/gatekeeper-scheduler"),
  microsoft: join(root, "packages/gatekeeper-microsoft"),
};
const generatedPaths = Object.fromEntries(
    Object.entries(packageDirs).map(([name, directory]) => [name, join(directory, generatedName)]),
);
const resourceNames = [
  "templatesKvNamespace",
  "avatarsKvNamespace",
  "templateContentBucket",
  "contextKvNamespace",
];
const managedAiProviders = new Set(["openrouter"]);
const checkResources = {
  templatesKvNamespaceId: "00000000000000000000000000000001",
  avatarsKvNamespaceId: "00000000000000000000000000000002",
  contextKvNamespaceId: "00000000000000000000000000000003",
  workersSubdomain: "example",
};

/** Validate the repository-owned workers.dev deployment contract. */
export function validateConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Deployment configuration must be an object.");
  }

  const workerNames = ["router", "backend", "context", "scheduler", "microsoft"]
      .map((key) => config.workers?.[key]);
  if (!workerNames.every((name) =>
    typeof name === "string" && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)
  )) {
    throw new Error("Every Worker name must be a valid lowercase Cloudflare Worker name.");
  }
  if (new Set(workerNames).size !== workerNames.length) {
    throw new Error("Worker names must be unique.");
  }

  // Admins are verified principals, "<issuer>:<subject>" — e.g. "password:admin" for a local
  // password account, or "<provider issuer>:<provider subject>" for OAuth sign-ins.
  if (!Array.isArray(config.auth?.admins) || config.auth.admins.length === 0 ||
      !config.auth.admins.every((principal) =>
        typeof principal === "string" && principal.includes(":"))) {
    throw new Error('Every administrator must be a "<issuer>:<subject>" principal.');
  }
  if (typeof config.context?.sharingDomain !== "string" || !config.context.sharingDomain.trim()) {
    throw new Error("Context sharingDomain must be a non-empty string.");
  }

  if (config.ai !== undefined) {
    if (!Array.isArray(config.ai.providers) || config.ai.providers.length === 0 ||
        !config.ai.providers.every((provider) => managedAiProviders.has(provider)) ||
        new Set(config.ai.providers).size !== config.ai.providers.length) {
      throw new Error("AI providers must be a unique, non-empty list of supported providers.");
    }
    if (typeof config.ai.defaultModel !== "string" || !config.ai.defaultModel.trim()) {
      throw new Error("AI defaultModel must be a non-empty model ID.");
    }
  }

  for (const key of resourceNames) {
    const value = config.resources?.[key];
    if (typeof value !== "string" ||
        !/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(value)) {
      throw new Error(`Deployment resource ${key} must be a valid Cloudflare resource name.`);
    }
  }
  if (new Set(resourceNames.map((key) => config.resources[key])).size !== resourceNames.length) {
    throw new Error("Deployment resource names must be unique.");
  }

  return config;
}

function setCommon(base, accountId, name, workersDev = false) {
  const config = structuredClone(base);
  config.account_id = accountId;
  config.name = name;
  config.workers_dev = workersDev;
  delete config.route;
  delete config.routes;
  return config;
}

/** Generate the four Wrangler configurations deployed by `pnpm deploy`. */
export function generateConfigs(config, accountId, bases, resources) {
  validateConfig(config);
  if (!/^[a-f\d]{32}$/i.test(accountId)) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID must be a 32-character hexadecimal account ID.");
  }
  for (const key of [
    "templatesKvNamespaceId",
    "avatarsKvNamespaceId",
    "contextKvNamespaceId",
  ]) {
    if (!/^[a-f\d]{32}$/i.test(resources?.[key] ?? "")) {
      throw new Error(`Resolved deployment resource ${key} must be a Cloudflare KV namespace ID.`);
    }
  }

  const context = setCommon(bases.context, accountId, config.workers.context);
  context.kv_namespaces = [{
    binding: "CONTEXT_COLLECTIONS",
    id: resources.contextKvNamespaceId,
  }];

  const scheduler = setCommon(bases.scheduler, accountId, config.workers.scheduler);

  const microsoft = setCommon(bases.microsoft, accountId, config.workers.microsoft);
  microsoft.vars = {
    ...microsoft.vars,
    // The public origin is the router's workers.dev URL; the router proxies
    // /gatekeeper/microsoft/* to this Worker.
    BASE_URL: `https://${config.workers.router}.${resources.workersSubdomain}.workers.dev` +
        "/gatekeeper/microsoft",
  };

  const backend = setCommon(bases.backend, accountId, config.workers.backend);
  backend.vars = {
    ...backend.vars,
    ADMINS: config.auth.admins,
    // Microsoft Entra is the only sign-in method: allowlist it and disable password auth.
    AUTH_GATEKEEPERS: "microsoft",
    DISABLE_PASSWORD_AUTH: "true",
    ...(config.ai ? {
      DEPLOYMENT_AI_PROVIDERS: config.ai.providers.join(","),
      DEPLOYMENT_AI_DEFAULT_MODEL: config.ai.defaultModel,
    } : {}),
  };
  backend.ai = { binding: "WORKERS_AI" };
  backend.services = [
    {
      binding: "GATEKEEPER_CONTEXT",
      service: config.workers.context,
      entrypoint: "GatekeeperVendor",
      props: { sharingDomain: config.context.sharingDomain },
    },
    {
      binding: "GATEKEEPER_SCHEDULER",
      service: config.workers.scheduler,
      entrypoint: "GatekeeperVendor",
    },
    {
      binding: "GATEKEEPER_MICROSOFT",
      service: config.workers.microsoft,
      entrypoint: "GatekeeperVendor",
    },
  ];
  backend.kv_namespaces = [
    {
      binding: "TEMPLATES",
      id: resources.templatesKvNamespaceId,
    },
    {
      binding: "AVATARS",
      id: resources.avatarsKvNamespaceId,
    },
  ];
  backend.r2_buckets = [{
    binding: "TEMPLATE_CONTENT",
    bucket_name: config.resources.templateContentBucket,
  }];

  const router = setCommon(bases.router, accountId, config.workers.router, true);
  router.services = [
    {
      binding: "WORKSHOP_BACKEND",
      service: config.workers.backend,
    },
    {
      binding: "GATEKEEPER_CONTEXT",
      service: config.workers.context,
    },
    {
      binding: "GATEKEEPER_SCHEDULER",
      service: config.workers.scheduler,
    },
    {
      binding: "GATEKEEPER_MICROSOFT",
      service: config.workers.microsoft,
    },
  ];

  return { context, scheduler, backend, router, microsoft };
}

/** Resolve the per-Worker secrets required by the deployment contract. */
export function getDeploymentSecrets(config, environment = process.env) {
  const backend = {};
  if (config.ai?.providers.includes("openrouter")) {
    if (!environment.OPENROUTER_API_TOKEN) {
      throw new Error(
          "OPENROUTER_API_TOKEN is required when the deployment enables OpenRouter.");
    }
    backend.OPENROUTER_API_TOKEN = environment.OPENROUTER_API_TOKEN;
  }

  // Microsoft Entra is the deployment's only sign-in method. Its app-registration credentials are
  // deploy-time secrets (MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET / MICROSOFT_TENANT_ID);
  // until all three are configured the gatekeeper deploys unconfigured and sign-in shows its
  // "not configured" page — adding the secrets and re-deploying requires no code change.
  const microsoftNames =
      ["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET", "MICROSOFT_TENANT_ID"];
  const present = microsoftNames.filter((name) => environment[name]);
  const microsoft = {};
  // Web Push credentials for the conversations feature; optional (no push until configured).
  for (const name of ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"]) {
    if (environment[name]) microsoft[name] = environment[name];
  }
  if (present.length === microsoftNames.length) {
    for (const name of microsoftNames) {
      microsoft[name.slice("MICROSOFT_".length)] = environment[name];
    }
  } else if (present.length > 0) {
    throw new Error(
        `Partial Microsoft Entra configuration: set all of ${microsoftNames.join(", ")} or none.`);
  } else {
    console.warn(
        "MICROSOFT_* secrets are not configured; deploying with Microsoft sign-in unconfigured.");
  }

  return { backend, microsoft };
}

/**
 * The deployment's admin principals: the literal entries from the config plus, when the
 * MICROSOFT_TENANT_ID and MICROSOFT_ADMIN_OID secrets are set, the Entra principal
 * "https://login.microsoftonline.com/<tenant>/v2.0:<oid>". Keeps the admin grant with the other
 * Entra secrets instead of committing tenant/oid GUIDs to the repo.
 */
export function resolveAdmins(config, environment = process.env) {
  const admins = [...config.auth.admins];
  if (environment.MICROSOFT_TENANT_ID && environment.MICROSOFT_ADMIN_OID) {
    admins.push(`https://login.microsoftonline.com/${environment.MICROSOFT_TENANT_ID}/v2.0` +
        `:${environment.MICROSOFT_ADMIN_OID}`);
  }
  return admins;
}

class CloudflareApiError extends Error {
  constructor(path, status, errors) {
    const detail = errors.length > 0
      ? errors.map(({ code, message }) => `${message} (${code})`).join(", ")
      : `HTTP ${status}`;
    super(`Cloudflare API request ${path} failed: ${detail}.`);
    this.status = status;
  }
}

async function cloudflareRequest(path, apiToken, options = {}, fetchImpl = fetch) {
  const response = await fetchImpl(`https://api.cloudflare.com/client/v4${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new CloudflareApiError(path, response.status, []);
  }
  if (!response.ok || payload.success === false) {
    throw new CloudflareApiError(path, response.status, payload.errors ?? []);
  }
  return payload;
}

async function listKvNamespaces(accountId, apiToken, fetchImpl) {
  const namespaces = [];
  let page = 1;
  while (true) {
    const payload = await cloudflareRequest(
        `/accounts/${accountId}/storage/kv/namespaces?per_page=1000&page=${page}`,
        apiToken,
        {},
        fetchImpl,
    );
    namespaces.push(...payload.result);
    if (page >= (payload.result_info?.total_pages ?? 1)) break;
    page += 1;
  }
  return namespaces;
}

/** Provision or reconnect the stable storage resources needed by the deployment. */
export async function ensureRemoteResources(config, accountId, apiToken, fetchImpl = fetch) {
  validateConfig(config);
  if (!/^[a-f\d]{32}$/i.test(accountId)) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID must be a 32-character hexadecimal account ID.");
  }
  if (!apiToken) {
    throw new Error("CLOUDFLARE_API_TOKEN is required to deploy.");
  }

  const kvNames = {
    templatesKvNamespaceId: config.resources.templatesKvNamespace,
    avatarsKvNamespaceId: config.resources.avatarsKvNamespace,
    contextKvNamespaceId: config.resources.contextKvNamespace,
  };
  const existing = new Map(
      (await listKvNamespaces(accountId, apiToken, fetchImpl)).map(({ title, id }) => [title, id]),
  );
  const resolved = {};
  for (const [key, title] of Object.entries(kvNames)) {
    let id = existing.get(title);
    if (!id) {
      const payload = await cloudflareRequest(
          `/accounts/${accountId}/storage/kv/namespaces`,
          apiToken,
          { method: "POST", body: JSON.stringify({ title }) },
          fetchImpl,
      );
      id = payload.result.id;
      console.log(`Created KV namespace ${title}.`);
    } else {
      console.log(`Reusing KV namespace ${title}.`);
    }
    resolved[key] = id;
  }

  // The account's workers.dev subdomain determines the deployment's public origin (the router
  // runs with workers_dev), which the Microsoft gatekeeper needs for its OAuth redirect URI.
  const subdomainPayload = await cloudflareRequest(
      `/accounts/${accountId}/workers/subdomain`, apiToken, {}, fetchImpl);
  resolved.workersSubdomain = subdomainPayload.result.subdomain;

  const bucketName = config.resources.templateContentBucket;
  const bucketPath = `/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucketName)}`;
  try {
    await cloudflareRequest(bucketPath, apiToken, {}, fetchImpl);
    console.log(`Reusing R2 bucket ${bucketName}.`);
  } catch (error) {
    if (!(error instanceof CloudflareApiError) || error.status !== 404) throw error;
    await cloudflareRequest(
        `/accounts/${accountId}/r2/buckets`,
        apiToken,
        { method: "POST", body: JSON.stringify({ name: bucketName }) },
        fetchImpl,
    );
    console.log(`Created R2 bucket ${bucketName}.`);
  }

  return resolved;
}

async function readJsonc(path) {
  const errors = [];
  const value = parse(await readFile(path, "utf8"), errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new Error(
        `${relative(root, path)}: ${printParseErrorCode(errors[0].error)} ` +
        `at offset ${errors[0].offset}`,
    );
  }
  return value;
}

function run(args, cwd = root) {
  const result = spawnSync("pnpm", args, { cwd, env: process.env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`pnpm ${args.join(" ")} failed in ${relative(root, cwd) || "."}.`);
  }
}

function build() {
  for (const packageName of [
    "@gadgets/gatekeeper-context",
    "@gadgets/gatekeeper-scheduler",
    "@gadgets/microsoft-gatekeeper",
    "@gadgets/workshop-frontend",
    "@gadgets/workshop-backend",
    "@gadgets/router",
  ]) {
    run(["--filter", packageName, "build"]);
  }
}

async function main() {
  const config = validateConfig(await readJsonc(join(root, "deployment/workers-dev.jsonc")));
  // Fold in the secret-configured Entra admin principal (if provided) before generating configs.
  config.auth = { ...config.auth, admins: resolveAdmins(config) };
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const check = process.argv.includes("--check");
  // Fail before changing remote state if a required application secret is unavailable.
  const deploymentSecrets = check ? {} : getDeploymentSecrets(config);
  const resources = check
    ? checkResources
    : await ensureRemoteResources(config, accountId, process.env.CLOUDFLARE_API_TOKEN ?? "");
  const generated = generateConfigs(config, accountId, {
    router: await readJsonc(join(packageDirs.router, "wrangler.jsonc")),
    backend: await readJsonc(join(packageDirs.backend, "wrangler.jsonc")),
    context: await readJsonc(join(packageDirs.context, "wrangler.jsonc")),
    scheduler: await readJsonc(join(packageDirs.scheduler, "wrangler.jsonc")),
    microsoft: await readJsonc(join(packageDirs.microsoft, "wrangler.jsonc")),
  }, resources);

  let secretsDirectory;
  try {
    await Promise.all(Object.entries(generated).map(([name, value]) =>
      writeFile(generatedPaths[name], `${JSON.stringify(value, null, 2)}\n`)
    ));
    const secretsFiles = {};
    if (!check) {
      secretsDirectory = await mkdtemp(join(tmpdir(), "cloudflare-os-deploy-"));
      for (const [name, secrets] of Object.entries(deploymentSecrets)) {
        if (Object.keys(secrets).length === 0) continue;
        const file = join(secretsDirectory, `${name}-secrets.json`);
        await writeFile(file, JSON.stringify(secrets), { mode: 0o600 });
        secretsFiles[name] = file;
      }
    }
    build();

    for (const name of ["context", "scheduler", "microsoft", "backend", "router"]) {
      const deployArgs = check ? ["--dry-run"] :
          secretsFiles[name] ? ["--secrets-file", secretsFiles[name]] : [];
      run(
          ["exec", "wrangler", "deploy", "--config", generatedName, ...deployArgs],
          packageDirs[name],
      );
    }
  } finally {
    await Promise.all([
      ...Object.values(generatedPaths).map((path) => rm(path, { force: true })),
      ...(secretsDirectory ? [rm(secretsDirectory, { recursive: true, force: true })] : []),
    ]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    console.error(`\nDeploy failed. ${error.message}`);
    process.exitCode = 1;
  }
}
