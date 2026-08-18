// Installing the deployment's bundled output-format templates.
//
// The archives and their presentation come from a directory chosen at build time (see
// scripts/build-format-templates.mjs), so a deployment ships its own formats by pointing
// FORMAT_TEMPLATES_DIR at its own tree rather than by editing this repo.
//
// Installation writes an ordinary template -- metadata into TEMPLATES, the code snapshot into
// TEMPLATE_CONTENT -- exactly as publishing does. Nothing downstream knows these are special:
// no reserved id prefix, no fallback branch in the read path. Failure is tolerable: a deployment
// with none installed simply has no standard formats.

import { TemplateMetadata, TemplatePublicInfo } from "@gadgets/workshop-shared/api";
import { TemplateKvRecord, parseTemplateArchive } from "./template-archive.js";
import { BundledFormatTemplate, FORMAT_TEMPLATES } from "./generated/format-templates.js";
import { fingerprint } from "./admin-config.js";
import { createWorkshopLogger } from "./observability";

const logger = createWorkshopLogger("workshop.formats");

type InstallEnv = Pick<Cloudflare.Env, "TEMPLATES" | "TEMPLATE_CONTENT">;

/**
 * Identifies the exact set of bundled templates a deployment has installed, and how. Compared
 * with what was installed last time, so any change here triggers reinstallation.
 *
 * Everything that ends up in the installed metadata contributes, not just `revision`: editing a
 * description would otherwise build, deploy, and change nothing on a deployment that had already
 * installed. `revision` covers the one input this can't see, the archive bytes.
 */
export function formatTemplatesManifestVersion(): string {
  return FORMAT_TEMPLATES
      .map(e => `${e.templateId}@${e.revision}+` +
          fingerprint(JSON.stringify([e.title, e.description, e.author, e.output])))
      .toSorted()
      .join(",");
}

// Install one bundled template, returning its public info for the featured mirror.
async function installOne(env: InstallEnv, entry: BundledFormatTemplate)
    : Promise<TemplatePublicInfo> {
  // Parse through the ordinary archive reader so a corrupt bundled file fails the same way an
  // uploaded one would, rather than producing a half-installed template.
  let {metadata, contentLength, content} = await parseTemplateArchive(
      new Response(Uint8Array.fromBase64(entry.archive) as BufferSource).body!);

  // R2 needs a known length, and the archive is already fully in memory (it came out of the
  // Worker bundle), so buffer rather than plumbing a FixedLengthStream through as the upload path
  // does for genuinely streamed uploads.
  let contentBytes = new Uint8Array(await new Response(content).arrayBuffer());
  if (contentBytes.byteLength !== contentLength) {
    throw new Error(`Archive declares ${contentLength} content bytes but holds ` +
        `${contentBytes.byteLength}.`);
  }

  // The archive supplies what the template does -- code, bindings, and the dates from the
  // workspace it was exported from. How it is presented comes from its sidecar, overwriting
  // whatever the archive carries.
  let installed: TemplateMetadata = {
    ...metadata,
    title: entry.title,
    description: entry.description,
    author: entry.author,
    output: entry.output,
  };

  // Content first: a template whose metadata exists but whose R2 object doesn't is broken, while
  // the reverse is merely an orphaned object that the next install overwrites. The archive's
  // content section is already gzip-compressed, which is exactly what R2 holds.
  await env.TEMPLATE_CONTENT.put(`${entry.templateId}/${installed.version}`, contentBytes);

  let kvRecord: TemplateKvRecord = {metadata: installed};
  await env.TEMPLATES.put(entry.templateId, JSON.stringify(kvRecord));

  return {id: entry.templateId, metadata: installed};
}

/**
 * Install every bundled template, skipping (and logging) any that fail. Returns the public info
 * of those that installed, so the caller can offer them to users.
 */
export async function installFormatTemplates(env: InstallEnv): Promise<TemplatePublicInfo[]> {
  let installed: TemplatePublicInfo[] = [];
  for (let entry of FORMAT_TEMPLATES) {
    try {
      installed.push(await installOne(env, entry));
      logger.info("installed format template", {
        event: "formats.install.ok", templateId: entry.templateId,
      });
    } catch (err) {
      // One bad archive must not deny the deployment the others.
      logger.error("failed to install format template", {
        event: "formats.install.failed", templateId: entry.templateId, error: err,
      });
    }
  }
  return installed;
}
