# Templates

Templates let a user share a gadget's source code so that others can create their own gadget instances from it. A template captures the code but not the chat history, SQLite storage, or credentials. Each gadget created from a template gets its own bindings, storage, and chat history.

This is analogous to a template: the template author publishes a reusable gadget design, and anyone with the link can stamp out their own copy, pointing it at their own resources.

## Key Properties

- A single gadget can have **multiple templates**, potentially at different code versions (e.g. a "stable" and a "latest" template of the same gadget).
- Each template has a **128-bit random hex ID**, generated server-side. Templates bundled with a deployment are the exception: they carry stable, readable IDs (see [Output Formats and Bundled Templates](#output-formats-and-bundled-templates)).
- Templates are shared via link: `https://<host>/template/<template-id>` (for example, a random hex ID or a bundled ID such as `format.document`).
- Anyone with the link can **view** the template's metadata (title, description, author, required bindings) without authenticating. **Creating a gadget** from a template requires authentication.
- A template is always owned by the gadget's owner, regardless of which collaborator creates it. Bundled templates have no owning user at all.
- The template author can **update** a template to reflect newer code, incrementing its version number. Old code versions are retained in storage to avoid race conditions during concurrent instantiation.
- Templates can be exported to a `.template` file and imported into a different Workshop instance.

## What a Template Captures

A template captures:

- **Source code** -- a snapshot of the gadget's committed Yjs document, stripped of edit history. The snapshot contains only the final file contents (one insert operation per file), producing a minimal encoding.
- **Binding requirements** -- a description of each named binding the gadget uses, including what type of connection is needed (gatekeeper, AI model, or agent spawner) and how to configure it. The template does not include any credentials or live connections.
- **Metadata** -- title, description, optional screenshot metadata, author info, version number, and timestamps.

A template does **not** capture:

- The gadget's SQLite storage contents.
- AI chat history or edit history.
- Live connections or credentials. Only the *shape* of each binding (its type, gatekeeper name, URL pattern, etc.) is recorded.

## Binding Annotations

Before creating a template, the author can optionally add **template annotations** for the gadget's named bindings. This user-provided metadata controls how each required connection appears to someone creating a gadget from the template:

- **Name** -- a friendly connection name shown to template consumers. It defaults to the current resource title, while the binding name remains the stable key used by code.
- **Description** -- optional helper text that tells the template consumer what kind of resource to connect.
- **Suggest value** -- optionally includes the specific resource URL or model name as a suggestion. This is useful when the template author intends all instances to use the same resource, but it remains a suggestion rather than a requirement.

All named bindings are included in the template. Annotations are configured in the **Template** modal opened from the gadget editor header. The annotation is stored on the `GatekeeperRecord` as the `templateAnnotation` field.

## Binding Types

Templates support three types of bindings, matching the three types of gatekeepers:

1. **Gatekeeper** (`type: "gatekeeper"`) -- an external resource connection (e.g. Google Drive, a REST API). The template records the gatekeeper adapter name and a URL pattern describing what kind of resource is expected. When instantiating, the user picks a connected account and configures a matching resource.

2. **AI Model** (`type: "aiModel"`) -- a language model binding. The template may suggest a specific provider/model. When instantiating, the user picks from their own configured models.

3. **Agent Spawner** (`type: "agentSpawner"`) -- an agent spawner binding. The template carries over the spawner configuration (prompt types, env restrictions) from the source gadget. The user only needs to choose which model the spawner should use (or no model).

## Storage Architecture

Template data is stored in three places, with one-way propagation: Gadget DO -> User DO -> Workers KV.

1. **Gadget DO** (`templates` collection) -- the authoritative source. Stores `TemplateGadgetRecord` including full metadata, the code version that was exported, and a `dirty` flag for tracking propagation failures.

2. **User DO** (`templates` collection) -- a denormalized copy for efficient listing. Stores `TemplateUserRecord` with metadata and a reference to the source gadget. This allows a user to audit and manage their templates even if the source gadget has been deleted.

3. **Workers KV** (`TEMPLATES` namespace) -- the public-facing lookup store. Stores `TemplateKvRecord` keyed by template hex ID. This is what `PublicApi.getTemplate()` reads from.

Template **code content** is stored separately in an **R2 bucket** (`TEMPLATE_CONTENT`). The R2 key is `<templateId>/<version>`. Content is stored as a Yjs V2-encoded document (the full state, not incremental updates). When a template is updated, old versions are retained to avoid race conditions. When a template is deleted, all its R2 versions are cleaned up.

The `dirty` flag handles propagation failures gracefully: it is set to `true` before propagation begins and cleared only after all writes succeed. If a failure leaves it set, the UI shows a warning with a "Retry" button.

## Explore

The Explore page (`/explore`) is a place where users can discover featured templates. Goal is to show users what is possible and to give them place to start.

Admins have the ability to "feature" templates. This is what determines what is on this page.

## Templates on home page

The home page has a templates tab which shows a list of templates that they have published plus what is in their library.

Users can pin templates to keep them at the top of the home Templates tab. Pinning a public template that is not already in the user's library adds it to the library first, then pins it.

Library entries come in two forms:

- **Saved by reference** -- created by `addTemplateToLibrary()`. The entry stores a cached copy of the template's public metadata for list rendering, but the actual template remains owned by the original publisher. Removing it only deletes your personal library entry.
- **Uploaded** -- created by `importTemplate()` from a `.template` archive. This creates a new local template ID on the current deployment, stores the snapshot in this deployment's R2/KV, and records it in your library with `uploaded: true`. Removing one of these entries deletes the imported template content as well.

## Export / Import Format

Templates can be downloaded from `/template/<id>` as `.template` files and uploaded from the home templates tab into another Workshop instance.

The `.template` format is a simple internal binary container:

- 8-byte magic number: `0xec2e2d3a2300e317`
- 4-byte format version (`1`)
- 4-byte JSON metadata length
- 8-byte raw content length
- JSON-encoded `TemplateMetadata`
- Raw template content bytes copied from `TEMPLATE_CONTENT/<templateId>/<version>`

Imports are validated before publication. Metadata is capped at 64 KiB and the stored snapshot payload is capped at 32 MiB so a malformed archive cannot force unbounded allocation in the worker.

Only `TemplateMetadata` is included in the file, not the full KV record. In particular, the archive does not include `ownerId`, `gadgetId`, or screenshot bytes. Imported archives clear any screenshot marker because screenshots are stored separately from the archive content.

The trailing content bytes are the same gzip-compressed Yjs snapshot that is already stored in R2 for the template's current version. Import/export streams these bytes directly to and from R2 using `pipeTo()` rather than buffering the whole archive in memory on the server.

## Admin Features and Featured Templates

Deployments can optionally configure a set of admin usernames through the backend worker's `ADMINS` binding as an array of usernames.

Admins get access to two extra RPCs:

- `AuthenticatedApi.adminIsTemplateFeatured()` returns whether a published template is currently featured.
- `AuthenticatedApi.adminSetTemplateFeatured()` marks or unmarks a template as featured.

Only gadget-backed published templates are featureable. Uploaded/imported library templates are intentionally excluded.

Featured template state is split across two stores:

- The authoritative `featured` bit lives in the owning user's `templates` record inside their User DO.
- The `AdminSettings` durable object is a singleton (`getByName("")`) that mirrors the current public metadata for featured templates and writes a KV snapshot consumed by `AuthenticatedApi.listFeaturedTemplates()`.

## Output Formats and Bundled Templates

A **format** is an ordinary template the deployment has promoted, so that "New Doc" or "New Slides" appears in the composer's `+` menu and in the list the agent is told to prefer. Promotion is admin curation (`AdminConfig.formats`, managed in the admin **Formats** panel); nothing about the template itself changes.

What a template may declare is `TemplateMetadata.output`: a grouping `id`, a `noun` and `plural` ("Doc"/"Docs"), and an `icon` from the closed `OUTPUT_ICONS` set. A gadget instantiated from the template inherits it, and that is what the workspace tab, chat cards and the Outputs page draw. Declaring it is presentation only and grants nothing -- any user can publish a template calling itself a Document. Being *offered* as one of the deployment's standard formats is the separate, admin-curated decision. An admin can override any of these fields (`FormatCuration.overrides`), and the override is applied on every instantiation path, so a rename reaches gadgets the agent builds as well as ones made from the menu.

A deployment can also ship templates as data. `packages/workshop-backend/format-templates/` holds a `<name>.template` archive plus a `<name>.json` sidecar for each, and `scripts/build-format-templates.mjs` bundles that directory (overridable with `FORMAT_TEMPLATES_DIR`, so a fork can ship its own set) into a generated module. These differ from published templates in three ways:

- Their IDs are **stable and readable** (`format.document`, not a random hex ID), because both installation and promotion are keyed on them. Renaming one after deploy orphans the old entry rather than moving it.
- They have **no owning User DO**. `AdminSettings` writes them straight into the featured mirror, because there is no publishing user whose `featured` bit could be authoritative.
- Their `output` lives in the sidecar rather than the archive, so the deployment's presentation has a single source of truth.

The first `/api` request a deployment serves installs any whose manifest fingerprint has changed. The fingerprint covers its title, description, author, revision, and output presentation; `revision` represents changes to the archive bytes. Each bundled template is promoted only once ever -- an upgrade never undoes an admin's later removal or overrides.

## Creating and Managing Templates

Templates are managed through the **Template** button in the gadget editor header. The UI allows:

- **Creating** a new template from the gadget's current committed code, with a title, optional description, and optional screenshot.
- **Describing** the required connections with optional per-binding helper text and suggested values.
- **Listing** existing templates with their title, description, version, and code version date.
- **Editing** a template's title, description, screenshot, and connection guidance through the same form used to create a template.
- **Updating** a template to the gadget's current code (increments the version).
- **Copying** the template's share link to the clipboard.
- **Deleting** a template (with confirmation).
- **Retrying** a failed publish when the dirty flag is set.

On the backend, the Overseer handles template lifecycle through `createTemplate`, `updateTemplate`, `deleteTemplate`, and `retryTemplatePublish`. Template creation generates a random ID, collects binding metadata from all annotated gatekeepers (via `collectBindingMetadata`), snapshots the code (via `snapshotCode`), and propagates to all three storage locations (via `propagateTemplate`).

## Instantiating a Template

When someone opens a template link (`/template/<id>`), they see the **Template Landing Page**:

1. The page fetches metadata via `PublicApi.getTemplate()` (unauthenticated -- knowing the ID is sufficient since a template is just data).
2. It displays the title, description, optional screenshot, author, version, and a summary of required bindings.
3. If the user is not logged in, they see a "Log in to create a gadget" button.
4. Once authenticated, the user enters **configure mode**, where they assign each required binding:
   - For gatekeeper bindings: pick a connected account and configure the matching resource.
   - For AI model bindings: pick from their configured models.
   - For agent spawner bindings: pick a model (or none).
5. Clicking "Create Gadget" calls `AuthenticatedApi.newGadgetFromTemplate()`, which:
   - Reads the template from KV and its code from R2.
   - Creates a new Overseer DO and initializes it with the template's code via `initializeFromTemplate`.
   - Creates gatekeepers from the user's binding assignments (pipelined for performance).
   - Returns the new Overseer stub, and the UI redirects to the new gadget.

The new gadget is independent from the template source: it has its own storage, chat history, and bindings. There is currently no mechanism for automatic updates from the template to existing instances (though the Yjs-based storage format could support this in the future).

### Instantiation by the agent

The AI agent can also instantiate a template as an *additional* gadget within an existing workspace:

- The `listTemplates` tool lists the templates available to the workspace owner (the deployment's standard formats, listed first and marked as preferred, then their own published templates, their library, and the deployment's featured set) as formatted text; there is no search index, so the model scans the list itself.
- Passing a `templateId` to the `createGadget` tool creates the new gadget from the template's code instead of empty. The gadget is provisional to the chat like any agent-created gadget, and the template's files are copied into the chat's proposed changes (recorded in the same `changes` message as the creation), so accepting or reverting the chat's changes covers the files and the creation together.
- Bindings are not auto-assigned on this path: the tool result describes the bindings the template expects, and the agent wires them up itself under the same names (via `setGadgetBinding`, requesting connections as needed), or asks the user to add AI-model / agent-spawner bindings from the Connections panel.

When a `.template` file is uploaded, the target instance creates a new local template ID, stores the uploaded code snapshot in its own R2 bucket, writes the imported metadata to its own KV namespace, and records the template under the importing user's account. The original template author metadata is preserved, but ownership of the imported copy belongs to the importing user on the new instance.

## Orphaned Templates

A template can outlive its source gadget. If a gadget is deleted, its templates remain accessible via KV and R2. The user can manage orphaned templates through `AuthenticatedApi.listOwnTemplates()` (which reads from the User DO) and delete them via `deleteOrphanedTemplate()` (which cleans up KV, R2, and the User DO record directly, bypassing the now-deleted Gadget DO).

## Creation Specs

To support template metadata derivation, each gatekeeper stores a `GatekeeperCreationSpec` that records how it was originally created. This includes the vendor ID (for gatekeeper bindings), provider and model name (for AI model bindings), or the full spawner config (for agent spawner bindings). The creation spec, combined with the template annotation, is used by `collectBindingMetadata` to produce the `TemplateBinding` records stored in the template.
