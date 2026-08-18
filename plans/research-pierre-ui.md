# Research: Replacing Monaco with Pierre's diff viewer + file tree

Date: 2026-02 research pass. All package versions verified against the npm registry and the
`pierrecomputer/pierre` GitHub repo at time of writing.

## TL;DR

- **Diff/code rendering**: `@pierre/diffs` (latest **1.3.5**, Apache-2.0), from The Pierre
  Computer Company (pierre.co / pierre.computer). Docs: https://diffs.com. Repo:
  https://github.com/pierrecomputer/pierre (`packages/diffs`). React entry:
  `@pierre/diffs/react` with `File`, `FileDiff`, `MultiFileDiff`, `PatchDiff`, `CodeView`
  components. Built on **Shiki** (`^3 || ^4`) for highlighting; ships `pierre-light` /
  `pierre-dark` themes; renders into **Shadow DOM** with CSS grid; has built-in
  virtualization (`Virtualizer`, `VirtualizedFile(Diff)`, and a pooled virtualizer inside
  `CodeView`).
- **File tree**: `@pierre/trees` (latest **1.0.0-beta.6**, Apache-2.0), same monorepo
  (`packages/trees`). React entry `@pierre/trees/react` exports `<FileTree model={...}/>` +
  `useFileTree` and friends. Path-first API (plain `string[]` of paths), virtualized, search,
  git-status badges, context menus, rename/drag-drop. (Ignore the older `@pierre/file-tree`
  0.0.1-beta.x package — it was the first cut, superseded by `@pierre/trees`.)
- **Read-only plain file view**: yes — `File` (React) renders one syntax-highlighted,
  non-diff file. No need to pair Shiki manually; the package re-exports Shiki's `codeToHtml`
  anyway if ever needed.
- **Peer deps**: `react`/`react-dom` `^18.3.1 || ^19.0.0` for both packages — React 19.2 in
  workshop-frontend is fine. Browser-first; SSR is an optional separate entry we don't need
  in a pure SPA. Tailwind coexists cleanly because all component internals live in Shadow DOM.

---

## 1. `@pierre/diffs` — the diff/code renderer

| Fact | Value |
| --- | --- |
| npm | `@pierre/diffs`, latest `1.3.5` (dist-tags also `beta`, `rc`) — https://www.npmjs.com/package/@pierre/diffs |
| Repo | https://github.com/pierrecomputer/pierre → `packages/diffs` |
| License | Apache-2.0 (LICENSE.md in package and repo root) |
| Docs | https://diffs.com and https://diffs.com/docs |
| Runtime deps | `shiki ^3\|\|^4`, `@shikijs/transformers`, `diff@9`, `hast-util-to-html`, `lru_map`, `@pierre/theme` (Shiki theme), `@pierre/theming` |
| Peer deps | `react ^18.3.1 \|\| ^19.0.0`, `react-dom` same (only if you use the React entry) |
| Module format | ESM only (`"type": "module"`), `sideEffects` limited to the web-components file — tree-shakes well in Vite |

### Entry points

| Entry | Purpose |
| --- | --- |
| `@pierre/diffs` | Vanilla JS classes + parsing utilities (`parseDiffFromFile`, `parsePatchFiles`) |
| `@pierre/diffs/react` | React components: `File`, `FileDiff`, `MultiFileDiff`, `PatchDiff`, `UnresolvedFile`, `CodeView`, `Virtualizer`, `WorkerPoolContextProvider`, hooks |
| `@pierre/diffs/edit` | Optional in-place editor (we will NOT load this — read-only requirement) |
| `@pierre/diffs/ssr` | SSR pre-render utilities (not needed for the SPA) |
| `@pierre/diffs/worker` | Worker-pool utilities to offload Shiki highlighting to background threads |

### Rendering a diff of two file versions (React)

From the official React recipe (repo `skills/diffs/references/recipe-react.md`):

```tsx
import { MultiFileDiff } from '@pierre/diffs/react';

<MultiFileDiff
  oldFile={{ name: 'src/value.ts', contents: oldSource }}
  newFile={{ name: 'src/value.ts', contents: newSource }}
  options={{
    diffStyle: 'split',      // 'unified' | 'split' (split is default)
    theme: 'pierre-dark',
  }}
/>
```

Component selection table (from their docs):

| Input | Component |
| --- | --- |
| One `FileContents` object | `File` |
| Old + new `FileContents` | `MultiFileDiff` |
| Pre-parsed `FileDiffMetadata` | `FileDiff` |
| One unified patch string | `PatchDiff` |
| File with merge conflict markers | `UnresolvedFile` |
| One scroll region with many files/diffs | `CodeView` |

Key data types (`FileContents` is just `{ name, contents, lang?, cacheKey? }`; pass `null`
for a missing side to represent added/deleted files):

```ts
import { parseDiffFromFile } from '@pierre/diffs';
const diff = parseDiffFromFile(oldFile, newFile);   // FileDiffMetadata
const added = parseDiffFromFile(null, newFile);
const deleted = parseDiffFromFile(oldFile, null);
```

Diff options worth knowing (`BaseDiffOptions`, from `packages/diffs/src/types.ts`):
`diffStyle: 'unified' | 'split'` (default split), `diffIndicators` ('classic' | bars),
`hunkSeparators`, `expandUnchanged`, `collapsedContextThreshold`, `lineDiffType`
('word' | 'word-alt' | 'char' | none; default 'word-alt'), `expansionLineCount`,
`disableLineNumbers`, `overflow: 'scroll' | 'wrap'`, `stickyHeader`,
`disableFileHeader`, `unsafeCSS`. IMPORTANT: `MultiFileDiff`/`File` use **reference
equality** on file/option objects to skip re-renders — keep those objects stable
(memoized) across renders.

### Syntax highlighting & theming

- Engine is **Shiki** (v3/v4). Language auto-detected from filename extension; override via
  `lang` (any Shiki language id) or `registerCustomLanguage`.
- Themes: any Shiki theme name works; the bundled Pierre pairs are `pierre-light` /
  `pierre-dark` (plus `-soft`, `-vibrant`, and color-blind-safe variants, from
  `@pierre/theme`). Light/dark pair syntax:
  `theme: { light: 'pierre-light', dark: 'pierre-dark' }` with `themeType: 'system' |
  'light' | 'dark'` (default `system`). There is a `setThemeType()` runtime switch and
  `registerCustomTheme` / `createCSSVariablesTheme` for custom themes — relevant for
  matching Kumo/workshop theming (the frontend already has a `ThemeContext` with
  `resolvedThemeMode`).
- Architecture: all low-level APIs render HTML strings; higher-order components mount them
  into **Shadow DOM + CSS grid** (per their docs "browsers are rather efficient at
  rendering raw HTML"). This is why Tailwind (v4) resets/utilities cannot leak into the
  diff internals, and vice versa.

### Virtualization for large files

Three tiers (see https://pierre.computer/writing/on-rendering-diffs):

1. `Virtualizer` (React component) + `metrics` — wrap one large standalone `File`/`FileDiff`.
2. `VirtualizedFile` / `VirtualizedFileDiff` vanilla classes.
3. `CodeView` — a virtualized list of many files/diffs in one scroll region with sticky
   headers, line selection, scroll-to-line API (`CodeViewHandle.scrollTo({type:'line',...})`),
   and pooled Shadow DOM containers (their 1.3-era rewrite specifically targets large-PR
   perf: container pooling, layout checkpoints, no virtualization blanking).

Optional worker offload for highlighting:

```tsx
import { WorkerPoolContextProvider } from '@pierre/diffs/react';

<WorkerPoolContextProvider
  poolOptions={{
    poolSize: 4,
    workerFactory: () =>
      new Worker(new URL('@pierre/diffs/worker/worker.js', import.meta.url), {
        type: 'module',
      }),
  }}
  highlighterOptions={{
    langs: ['typescript', 'tsx'],
    theme: { light: 'pierre-light', dark: 'pierre-dark' },
  }}
>
  {children}
</WorkerPoolContextProvider>
```

(The `new Worker(new URL(...), {type:'module'})` pattern is natively supported by Vite.)

### Bonus: streaming

`FileStream` + `ShikiStreamTokenizer` (root entry) render a **readable stream of code** as
highlighted rows — directly relevant to our "agent is streaming a file rewrite" UX that
currently rides on Y.Text updates into Monaco.

## 2. `@pierre/trees` — the file tree

| Fact | Value |
| --- | --- |
| npm | `@pierre/trees`, latest `1.0.0-beta.6` (July 2026; actively released) — https://www.npmjs.com/package/@pierre/trees |
| Repo | https://github.com/pierrecomputer/pierre → `packages/trees` |
| License | Apache-2.0 |
| Runtime deps | `preact` (internal renderer inside shadow root — does NOT conflict with React), `preact-render-to-string`, `@pierre/path-store`, `@pierre/theming` |
| Peer deps | `react ^18.3.1 \|\| ^19.0.0` + `react-dom` (React entry only) |
| Size | ~1.4 MB unpacked on npm (icons + sprite included) |

Note: `@pierre/file-tree` (0.0.1-beta.1/2, Jan 2026) is the abandoned first cut; the repo
only contains `packages/trees` now. Use `@pierre/trees`.

Entry points: `@pierre/trees` (vanilla model + mount), `@pierre/trees/react`,
`@pierre/trees/ssr`, `@pierre/trees/web-components`.

### React API (from the package README, verified against source)

```tsx
'use client';
import { FileTree, useFileTree } from '@pierre/trees/react';

export function ProjectFiles({ paths }: { paths: string[] }) {
  const { model } = useFileTree({
    paths,                      // plain string[]; dirs end with '/'
    initialExpansion: 'open',
    search: true,
  });

  return (
    <FileTree
      model={model}
      header={<strong>Project files</strong>}
      renderContextMenu={(item) => <div>Menu for {item.path}</div>}
      style={{ height: '320px' }}
    />
  );
}
```

Exports: `FileTree`, `useFileTree`, `useFileTreeSearch`, `useFileTreeSelection`,
`useFileTreeSelector`. The `model` (a vanilla `FileTree` instance) carries the imperative
API — the pieces that map onto our current `FileSidebar` follow:

- Mutations: `model.add(path)`, `model.remove(path)`, `model.move(from, to)`,
  `model.resetPaths(paths)` (call after the file list changes), `preparePresortedFileTreeInput`
  for large lists.
- Selection: `onSelectionChange(selectedPaths)` option, `initialSelectedPaths`,
  `model.getSelectedPaths()`, `model.scrollToPath(path, { focus })`,
  `useFileTreeSelection(model)`.
- Change badges: `gitStatus` option / `model.setGitStatus(entries)` with
  `GitStatusEntry = { path, status: 'added' | 'deleted' | 'modified' | 'renamed' | 'untracked' | 'ignored' }`
  — a 1:1 fit for our `FileChangeStatus` (`added`/`deleted`/`modified`/`unchanged`) diff-mode
  badges.
- Interactions we can enable later or leave off (read-only!): `renaming: { onRename }`,
  `dragAndDrop: { canDrop, onDropComplete }`, `composition: { contextMenu: { enabled } }`,
  `renderRowDecoration`.
- Rendering: virtualized rows (`itemHeight`, `overscan`, `stickyFolders`,
  `initialVisibleRowCount`), `flattenEmptyDirectories`, icon config (`setIcons`, VS Code
  icon sprite included).
- Theming: shadow-root CSS variables (`--trees-fg-override`, `--trees-selected-bg-override`,
  `--trees-theme-*`), `themeToTreeStyles(shikiOrVsCodeTheme)` to derive tree colors from the
  same Shiki theme the diffs use, and an `unsafeCSS` escape hatch.

Caveat: it is still a **1.0.0-beta**. API surface looks settled (beta.6, monthly releases,
Pierre dogfoods it in their product), but pin the exact version.

## 3. Read-only plain file view

Yes, first-class: the React `File` component renders one non-diff, syntax-highlighted file.

```tsx
import { File } from '@pierre/diffs/react';

<File
  file={{ name: 'gadget.ts', contents: source }}
  options={{
    theme: { light: 'pierre-light', dark: 'pierre-dark' },
    overflow: 'wrap',          // matches our current wordWrap:'on'
    // disableLineNumbers, stickyHeader, disableFileHeader, unsafeCSS ...
  }}
/>
```

`FileProps` (from `packages/diffs/src/react/types.ts`): `file`, `options`,
`lineAnnotations`, `selectedLines`, `renderAnnotation`, `renderCustomHeader`,
`renderHeaderPrefix/FilenameSuffix/Metadata`, `renderGutterUtility`, `className`, `style`,
`metrics` (for virtualization), `disableWorkerPool`, plus `edit`/`editorOptions` we ignore.
No Monaco-style editing surface loads unless you import `@pierre/diffs/edit` and mount an
`EditProvider` — read-only is the default. No separate Shiki wiring is required.

## 4. Constraints: bundle, SSR, peers, Tailwind

- **React**: peer `^18.3.1 || ^19.0.0` on both packages; workshop-frontend is React 19.2.8. OK.
- **ESM-only**, browser-first. `@pierre/diffs/react` components are client components
  (`'use client'` markers exist but are inert in a Vite SPA). The `/ssr` entries are opt-in
  and unnecessary for us.
- **Bundle**: npm unpacked size of `@pierre/diffs` is ~6.9 MB, but that includes all entries
  (edit, ssr, worker) and the wasm/JS Shiki engines; the real browser cost is dominated by
  **Shiki grammars/themes, which load lazily per language**. `sideEffects` is scoped to one
  file, so Vite tree-shakes unused entries. Net vs today: we delete `monaco-editor`
  (~70 MB unpacked, several MB shipped + its own worker files), `@monaco-editor/react`, and
  `y-monaco`. This is a large net reduction.
- **Shiki engine choice**: `preferredHighlighter` option selects the JS or WASM engine;
  the JS engine avoids shipping oniguruma WASM.
- **Tailwind v4**: no conflict. Both libraries render inside Shadow DOM; page-level Tailwind
  cannot restyle rows/tokens. Styling knobs are the Shiki theme, host-element
  `className`/`style` (both components accept them), CSS variables that pierce the shadow
  boundary, and `unsafeCSS` as escape hatch. Kumo components remain usable for headers,
  context menus (`renderContextMenu`, `renderCustomHeader` render React nodes via portals
  into slots).
- **Yjs**: Pierre components take plain strings. We keep Yjs for transport/collab state and
  feed `ytext.toString()` snapshots into props (observe → setState). `y-monaco` goes away
  entirely. Since users no longer edit, one-way Y→string is all we need.

## 5. Migration sketch (workshop-frontend)

Current state (all in `packages/workshop-frontend/src`):

- `CodeEditor.tsx` (134 ln) — Monaco `Editor` + `MonacoBinding(ytext, model)`; already
  read-only when `!isReady`.
- `CodeDiffEditor.tsx` (499 ln) + `CodeDiffEditor.css` + `diff/diffModel.ts` (476 ln) +
  `diff/diffRenderer.ts` (399 ln) — custom diff rendering on Monaco.
- `components/monacoTheme.ts` (+ stray copy at `src/monacoTheme.ts`) — custom theme.
- `FileSidebar.tsx` (449 ln) — hand-rolled flat file list w/ create/rename/delete/download
  menus (Kumo Dialog/DropdownMenu) and change-status badges.
- `GadgetCodeInterface.tsx` — composes the three; holds `activeFileYText`,
  `activeFileModifiedYText`, `isDiffMode`, `changedFiles`, `fileChangeStatuses`.

### Steps

1. **Deps**
   ```bash
   pnpm --filter @gadgets/workshop-frontend add @pierre/diffs @pierre/trees
   pnpm --filter @gadgets/workshop-frontend remove monaco-editor @monaco-editor/react y-monaco
   ```

2. **`CodeEditor.tsx` → `FileView.tsx`** (read-only). Derive a string from Y.Text and render
   `<File>`:
   ```tsx
   import { useMemo, useSyncExternalStore } from 'react'
   import { File } from '@pierre/diffs/react'
   import type * as Y from 'yjs'

   function useYTextString(ytext: Y.Text | null): string {
     return useSyncExternalStore(
       (cb) => { ytext?.observe(cb); return () => ytext?.unobserve(cb) },
       () => ytext?.toString() ?? '',
     )
   }

   export default function FileView({ filename, ytext }: { filename: string; ytext: Y.Text | null }) {
     const contents = useYTextString(ytext)
     const file = useMemo(() => ({ name: filename, contents }), [filename, contents])
     const options = useMemo(() => ({
       theme: { light: 'pierre-light', dark: 'pierre-dark' } as const,
       overflow: 'wrap' as const,
       disableFileHeader: true,   // we have our own chrome
     }), [])
     return <File file={file} options={options} style={{ height: '100%' }} />
   }
   ```
   (Stable `file`/`options` references matter — the components diff by reference.)
   For live agent-streaming polish, `FileStream` from the root entry can later replace the
   per-update snapshot approach.

3. **`CodeDiffEditor.tsx` + `diff/*` → delete (~1,400 lines)**, replace with:
   ```tsx
   import { MultiFileDiff } from '@pierre/diffs/react'

   <MultiFileDiff
     oldFile={originalContents == null ? null : { name: filename, contents: originalContents }}
     newFile={modifiedContents == null ? null : { name: filename, contents: modifiedContents }}
     options={diffOptions /* { diffStyle: 'unified' | 'split', theme, ... } stable ref */}
   />
   ```
   `null` sides give correct added/deleted-file rendering, which `fileChangeStatuses`
   already computes. Accept/reject-per-hunk UI (if wanted later) hangs off
   `renderAnnotation`/`renderGutterUtility` — their annotation framework exists for exactly
   this.

4. **`FileSidebar.tsx` → Pierre `FileTree`**. Keep the surrounding Kumo chrome (create
   dialog, download, toasts) but replace the list body:
   ```tsx
   const { model } = useFileTree({
     paths: files,                    // flat names work; nested paths get a real tree for free
     initialExpansion: 'open',
     onSelectionChange: ([path]) => path && onFileSelect(path),
   })
   // when files or statuses change:
   useEffect(() => { model.resetPaths(files) }, [files, model])
   useEffect(() => {
     model.setGitStatus(
       [...fileChangeStatuses].filter(([, s]) => s !== 'unchanged')
         .map(([path, status]) => ({ path, status })),
     )
   }, [fileChangeStatuses, model])
   return <FileTree model={model} header={header} renderContextMenu={menu} style={{ height: '100%' }} />
   ```
   Context-menu items (rename/delete/download) move into `renderContextMenu`; since only
   agents edit files, the create/rename/delete affordances can also simply be dropped or
   gated.

5. **Theming**: delete `monacoTheme.ts`; map `ThemeContext.resolvedThemeMode` to
   `options.themeType` (`'light' | 'dark'`), keep `theme: { light, dark }` static. Use
   `themeToTreeStyles()` (from `@pierre/trees`) with the same Shiki theme so the tree matches
   the code panes. If Pierre's palette clashes with Kumo, `registerCustomCSSVariableTheme` /
   `createCSSVariablesTheme` lets the highlight colors come from our CSS variables.

6. **Optional perf**: wrap the code area in `WorkerPoolContextProvider` (worker via
   `new URL('@pierre/diffs/worker/worker.js', import.meta.url)`, Vite-native) and preload
   only the languages gadgets use. Use `Virtualizer` around a single large file view if
   needed; `CodeView` only if we ever show all changed files in one scroll (PR-style review).

7. **Cleanup**: `pnpm build` (drops the monaco chunks), verify no `vite.config` monaco
   special-casing remains.

### What we lose / risks

- Monaco affordances: find-in-file, minimap, folding, cursor/selection collab presence.
  Acceptable given files are read-only; Pierre has line selection + annotations but no
  find-in-file UI (browser Ctrl-F works against rendered DOM only for visible/virtualized
  rows — worth a product call if in-file search matters).
- `@pierre/trees` is beta (`1.0.0-beta.6`); pin exactly. `@pierre/diffs` is stable
  (1.x since ~2025, very active: 1.3.5 on 2026-08-07).
- Both render into Shadow DOM: any existing CSS targeting editor internals is dead code;
  E2E selectors need shadow-piercing queries.

## Sources

- https://diffs.com (landing + live docs) and https://diffs.com/docs
- https://www.npmjs.com/package/@pierre/diffs (v1.3.5, Apache-2.0, peer/dep data from registry)
- https://www.npmjs.com/package/@pierre/trees (v1.0.0-beta.6) — and superseded https://www.npmjs.com/package/@pierre/file-tree
- https://github.com/pierrecomputer/pierre — monorepo; `packages/diffs`, `packages/trees`,
  `packages/theme`; agent skills under `skills/diffs/` and `skills/trees/` (API + recipe docs
  quoted above); `packages/diffs/src/types.ts`, `packages/diffs/src/react/types.ts`,
  `packages/trees/src/model/publicTypes.ts`, `packages/trees/README.md`
- https://github.com/pierrecomputer/pierre/releases (`diffs-v1.3.x` release notes; 1.3 = Edit release)
- https://pierre.computer/writing/on-rendering-diffs (virtualization/CodeView architecture)
- Agent skills installable in-repo: `npx skills add pierrecomputer/pierre --skill diffs` (and `--skill trees`)
