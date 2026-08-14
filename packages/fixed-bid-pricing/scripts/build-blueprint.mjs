import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { build } from "esbuild";
import * as Y from "yjs";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const target = resolve(
  packageRoot,
  "../workshop-backend/format-blueprints/fixed-bid-pricing.gadget",
);
const sidecarPath = resolve(
  packageRoot,
  "../workshop-backend/format-blueprints/fixed-bid-pricing.json",
);
const MAGIC = 0xec2e2d3a2300e317n;
const ARCHIVE_VERSION = 1;
const PREFIX_BYTES = 24;

const mode = process.argv[2];
if (mode !== "--check" && mode !== "--write") {
  throw new Error("Usage: node scripts/build-blueprint.mjs --check|--write");
}

async function bundle(entryPoint, options) {
  const result = await build({
    entryPoints: [join(packageRoot, entryPoint)],
    bundle: true,
    write: false,
    target: "es2022",
    legalComments: "none",
    sourcemap: false,
    charset: "utf8",
    ...options,
  });
  const output = result.outputFiles[0]?.text;
  if (!output) throw new Error(`esbuild produced no output for ${entryPoint}`);
  return output;
}

function serializeArchive(metadata, content) {
  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
  const bytes = new Uint8Array(PREFIX_BYTES + metadataBytes.byteLength + content.byteLength);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(0, MAGIC);
  view.setUint32(8, ARCHIVE_VERSION);
  view.setUint32(12, metadataBytes.byteLength);
  view.setBigUint64(16, BigInt(content.byteLength));
  bytes.set(metadataBytes, PREFIX_BYTES);
  bytes.set(content, PREFIX_BYTES + metadataBytes.byteLength);
  return bytes;
}

function parseArchive(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getBigUint64(0) !== MAGIC) throw new Error("Generated archive has the wrong magic.");
  if (view.getUint32(8) !== ARCHIVE_VERSION) {
    throw new Error("Generated archive has the wrong version.");
  }
  const metadataLength = view.getUint32(12);
  const contentLength = Number(view.getBigUint64(16));
  const content = bytes.subarray(PREFIX_BYTES + metadataLength);
  if (content.byteLength !== contentLength) throw new Error("Generated archive length is invalid.");
  return {
    metadata: JSON.parse(
      new TextDecoder().decode(bytes.subarray(PREFIX_BYTES, PREFIX_BYTES + metadataLength)),
    ),
    content,
  };
}

const [provenance, sidecar, server, client, readme] = await Promise.all([
  readFile(join(packageRoot, "blueprint.json"), "utf8").then(JSON.parse),
  readFile(sidecarPath, "utf8").then(JSON.parse),
  bundle("gadget/server.ts", {
    platform: "neutral",
    format: "esm",
    external: ["cloudflare:workers"],
  }),
  bundle("gadget/client.ts", { platform: "browser", format: "iife" }),
  readFile(join(packageRoot, "gadget/README.md"), "utf8"),
]);

const sourceFiles = new Map([
  ["README.md", readme],
  ["client.js", client],
  ["server.js", server],
]);
const document = new Y.Doc({ guid: "intimetec-fixed-bid-pricing" });
// Yjs otherwise chooses a random client id, making identical source produce different archives.
document.clientID = 1;
const root = document.getMap();
for (const [name, source] of [...sourceFiles].toSorted(([left], [right]) =>
  left.localeCompare(right))) {
  root.set(name, new Y.Text(source));
}
const update = Y.encodeStateAsUpdateV2(document);
const content = gzipSync(update, { level: 9, mtime: 0 });
const metadata = {
  title: sidecar.title,
  description: sidecar.description,
  author: sidecar.author,
  created: provenance.created,
  version: provenance.version,
  lastUpdated: provenance.lastUpdated,
  bindings: {},
};
const archive = serializeArchive(metadata, content);

// Validate the exact bytes through the inverse path before writing or comparing them.
const parsed = parseArchive(archive);
const roundTrip = new Y.Doc();
Y.applyUpdateV2(roundTrip, gunzipSync(parsed.content));
const roundTripFiles = roundTrip.getMap();
for (const [name, source] of sourceFiles) {
  if (roundTripFiles.get(name)?.toString() !== source) {
    throw new Error(`${name} did not survive the Blueprint archive round trip.`);
  }
}
if (!server.includes("getPricingSummary") || !server.includes("proposeChanges") ||
    !server.includes("approveProposal")) {
  throw new Error("Generated server is missing the agent proposal RPC surface.");
}
if (!client.includes("@media print")) {
  throw new Error("Generated client is missing its PDF/print layout.");
}

const digest = createHash("sha256").update(archive).digest("hex").slice(0, 12);
if (mode === "--write") {
  await writeFile(target, archive);
  console.log(`Wrote ${target} (${archive.byteLength} bytes, ${digest})`);
} else {
  let checkedIn;
  try {
    checkedIn = await readFile(target);
  } catch (caught) {
    if (caught?.code === "ENOENT") {
      throw new Error(
        "Fixed-bid Blueprint archive is missing; run pnpm build:blueprint.",
        {cause: caught},
      );
    }
    throw caught;
  }
  if (!checkedIn.equals(Buffer.from(archive))) {
    throw new Error(
      "Fixed-bid Blueprint archive is stale; run pnpm build:blueprint and commit the result.",
    );
  }
  console.log(`Fixed-bid Blueprint archive matches source (${archive.byteLength} bytes, ${digest})`);
}
