import { spawnSync } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
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
};
const generatedPaths = Object.fromEntries(
    Object.entries(packageDirs).map(([name, directory]) => [name, join(directory, generatedName)]),
);

/** Validate the repository-owned workers.dev deployment contract. */
export function validateConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Deployment configuration must be an object.");
  }

  const workerNames = ["router", "backend", "context", "scheduler"]
      .map((key) => config.workers?.[key]);
  if (!workerNames.every((name) =>
    typeof name === "string" && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)
  )) {
    throw new Error("Every Worker name must be a valid lowercase Cloudflare Worker name.");
  }
  if (new Set(workerNames).size !== workerNames.length) {
    throw new Error("Worker names must be unique.");
  }

  if (!Array.isArray(config.auth?.admins) || config.auth.admins.length === 0 ||
      !config.auth.admins.every((username) =>
        typeof username === "string" && /^[a-z][a-z0-9_]*$/.test(username))) {
    throw new Error("Every administrator must be a normalized password-account username.");
  }
  if (typeof config.context?.sharingDomain !== "string" || !config.context.sharingDomain.trim()) {
    throw new Error("Context sharingDomain must be a non-empty string.");
  }

  for (const key of [
    "blueprintsKvNamespaceId",
    "avatarsKvNamespaceId",
    "blueprintContentBucket",
    "contextKvNamespaceId",
  ]) {
    const value = config.resources?.[key];
    if (value !== null && (typeof value !== "string" || !value.trim())) {
      throw new Error(`Deployment resource ${key} must be null or a non-empty string.`);
    }
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
export function generateConfigs(config, accountId, bases) {
  validateConfig(config);
  if (!/^[a-f\d]{32}$/i.test(accountId)) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID must be a 32-character hexadecimal account ID.");
  }

  const context = setCommon(bases.context, accountId, config.workers.context);
  context.kv_namespaces = [{
    binding: "CONTEXT_COLLECTIONS",
    ...(config.resources.contextKvNamespaceId ? { id: config.resources.contextKvNamespaceId } : {}),
  }];

  const scheduler = setCommon(bases.scheduler, accountId, config.workers.scheduler);

  const backend = setCommon(bases.backend, accountId, config.workers.backend);
  backend.vars = {
    ...backend.vars,
    ADMINS: config.auth.admins,
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
  ];
  backend.kv_namespaces = [
    {
      binding: "BLUEPRINTS",
      ...(config.resources.blueprintsKvNamespaceId
        ? { id: config.resources.blueprintsKvNamespaceId }
        : {}),
    },
    {
      binding: "AVATARS",
      ...(config.resources.avatarsKvNamespaceId
        ? { id: config.resources.avatarsKvNamespaceId }
        : {}),
    },
  ];
  backend.r2_buckets = [{
    binding: "BLUEPRINT_CONTENT",
    ...(config.resources.blueprintContentBucket
      ? { bucket_name: config.resources.blueprintContentBucket }
      : {}),
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
  ];

  return { context, scheduler, backend, router };
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
    "@gadgets/workshop-frontend",
    "@gadgets/workshop-backend",
    "@gadgets/router",
  ]) {
    run(["--filter", packageName, "build"]);
  }
}

async function main() {
  const config = validateConfig(await readJsonc(join(root, "deployment/workers-dev.jsonc")));
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const generated = generateConfigs(config, accountId, {
    router: await readJsonc(join(packageDirs.router, "wrangler.jsonc")),
    backend: await readJsonc(join(packageDirs.backend, "wrangler.jsonc")),
    context: await readJsonc(join(packageDirs.context, "wrangler.jsonc")),
    scheduler: await readJsonc(join(packageDirs.scheduler, "wrangler.jsonc")),
  });

  try {
    await Promise.all(Object.entries(generated).map(([name, value]) =>
      writeFile(generatedPaths[name], `${JSON.stringify(value, null, 2)}\n`)
    ));
    build();

    const deployArgs = process.argv.includes("--check") ? ["--dry-run"] : [];
    for (const name of ["context", "scheduler", "backend", "router"]) {
      run(["exec", "wrangler", "deploy", "--config", generatedName, ...deployArgs], packageDirs[name]);
    }
  } finally {
    await Promise.all(Object.values(generatedPaths).map((path) => rm(path, { force: true })));
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
