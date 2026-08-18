import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const repoRoot = resolve(pkgRoot, "../..");
const entry = resolve(repoRoot, "packages/orb-harness/src/main.ts");
const outFile = resolve(pkgRoot, "src/generated/orb-harness-bundle.ts");

const result = await build({
  absWorkingDir: resolve(repoRoot, "packages/orb-harness"),
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  write: false,
  minify: true,
  logLevel: "silent",
});

const source = new TextDecoder().decode(result.outputFiles[0].contents);
const hash = createHash("sha256").update(source).digest("hex");
const generated =
    `export const ORB_HARNESS_SOURCE = ${JSON.stringify(source)};\n` +
    `export const ORB_HARNESS_HASH = ${JSON.stringify(hash)};\n`;

mkdirSync(dirname(outFile), { recursive: true });
if (!existsSync(outFile) || readFileSync(outFile, "utf8") !== generated) {
  writeFileSync(outFile, generated);
}
