# Thread UI design options (Amp-style, knowledge-work oriented)

Companion to `plans/threads-orbs.md` (phases 3–5). Reference: Amp's thread view screenshot
(sidebar = thread list; center = transcript; right panel = Changes/Portal with Ship • Review •
Sync controls; top bar = thread title, share, visibility, model, orb size).

## What Amp shows, and what it means for knowledge work

| Amp element (screenshot) | What it does (dev work) | Knowledge-work translation |
| --- | --- | --- |
| Sidebar thread list w/ status icons | threads, running/inactive, parent/child nesting | same — Threads w/ status dots + child nesting |
| "Set Up Orbs" banner | .agents/setup onboarding | admin-configured; per-thread banner unnecessary |
| Transcript center pane | agent narration, commands, tool calls | same (we already have this in ChatInterface) |
| **Changes** tab (right) | git diff of repo edits | **Work** panel: artifact files + Pierre diffs |
| **Portal** tab (right) | exposed HTTP ports from orb | **Artifact preview** (our sandboxed iframe UI) |
| Ship button | create PR/commit flow | **Publish/Export** (deliver artifact: doc, email, share link) |
| Review button | code review flow | **Review changes** (accept/revert proposed diffs — exists today) |
| Sync button | amp sync to local machine | **Download/Export files** (no local repo concept) |
| No Changes empty state | no repo edits yet | "Nothing produced yet" empty state |

Constant chrome (all options below share this):
- **Top bar**: thread title (auto-generated, editable inline) · share button + visibility pill
  (Private/Shared — existing ShareModal) · orb status chip (● running / ◐ paused / ○ none, with
  wake-on-click) · model picker.
- **Sidebar**: Threads section with status dot per thread (agent running / awaiting input /
  paused), child threads indented under parent (Amp's thread map, flattened one level), `+ New
  thread` → Home composer.

The question is the **right panel**. Three options:

---

## Option A — "Workbench": three fixed tabs (closest to today's code, Amp-parity)

Right panel keeps fixed tabs, renamed and re-tooled:

```text
┌───────────────────────────────┬──────────────────────────────────────────┐
│  TRANSCRIPT                   │  [Artifact ▾] [Files] [Changes] [⚙]      │
│                               ├──────────────────────────────────────────┤
│  ● Researched Q3 pipeline     │                                          │
│  Ran 2 queries                │   Artifact tab: live artifact iframe     │
│  Explored CRM, 3 searches     │   (GadgetUI — deck/tracker/doc renders   │
│                               │    here, interactive)                    │
│  I built the tracker and      │                                          │
│  filled in 34 accounts…       │   Files tab: Pierre FileTree (left rail) │
│                               │    + read-only Pierre <File> view        │
│  ┌─────────────────────────┐  │                                          │
│  │ ✎ Composer              │  │   Changes tab: Pierre MultiFileDiff of   │
│  └─────────────────────────┘  │    proposed changes + Accept / Revert    │
└───────────────────────────────┴──────────────────────────────────────────┘
      Publish ▸   Review (2 files)   Export ▸        ← action row, top-right
```

- Artifact = today's `app` tab (GadgetUI iframe). Files = FileSidebar+CodeEditor replaced by
  Pierre tree + read-only File. Changes = CodeDiffEditor replaced by Pierre MultiFileDiff.
- Connections moves out of the tab row into a top-bar popover (it's config, not work product).
- Pros: smallest refactor of GadgetEditor (tab enum rename + component swaps); every surface
  reachable at all times; predictable.
- Cons: least Amp-like feel — Amp foregrounds *changes* while work happens, not a static tab
  row; "Files" as a permanent tab overweights code for knowledge workers.

## Option B — "Focus + drawer": artifact IS the right pane; work evidence in a drawer (most knowledge-work)

The right pane is *always the artifact preview* (the thing the user actually asked for). Agent
work evidence (files, diffs, orb activity) lives in a collapsible bottom drawer of that pane,
opening automatically while the agent edits.

```text
┌───────────────────────────────┬──────────────────────────────────────────┐
│  TRANSCRIPT                   │   Q3 Account Tracker          Publish ▸  │
│                               │  ┌────────────────────────────────────┐  │
│  ● Building tracker…          │  │                                    │  │
│                               │  │      ARTIFACT (live iframe)        │  │
│                               │  │                                    │  │
│  ┌─────────────────────────┐  │  └────────────────────────────────────┘  │
│  │ ✎ Composer              │  │  ▾ Working… 3 files changed  [Review]    │ ← drawer
│  └─────────────────────────┘  │    ├ tracker/server.js   +42 −3          │
└───────────────────────────────┴──│    └ data/accounts.md    +120         │
                                   │   (Pierre diff inline on row click)   │
```

- Drawer states: hidden (no changes) → peek bar ("Working… N files changed") while agent edits →
  expanded (Pierre tree + diffs) on click or on Review. After accept, drawer collapses.
- Multi-artifact threads: artifact switcher in the pane header (existing WorkpiecePicker).
- Pros: matches "tool for everyone" — non-dev sees a doc/deck/tracker, never a code surface
  unless they open the drawer; still full Amp-style diff review one click away; mirrors how Amp
  auto-surfaces Changes contextually.
- Cons: biggest layout refactor (drawer mechanics, auto-open heuristics); file browsing while
  the artifact is tall means scrolling contention.

## Option C — "Activity rail": Amp-literal Changes-first panel, artifact as Portal (most Amp-parity)

Copy Amp's structure exactly: right panel defaults to **Changes** (Pierre diffs of everything
the agent did this thread) with **Preview** as the second tab (artifact iframe = our "Portal").

```text
┌───────────────────────────────┬──────────────────────────────────────────┐
│  TRANSCRIPT                   │  [Changes] [Preview]     Publish ▸ Export│
│                               ├──────────────────────────────────────────┤
│  …                            │  ⬡ 3 files changed          Review all   │
│                               │  ┌ tracker/server.js ───────── +42 −3 ┐  │
│                               │  │  Pierre FileDiff (collapsed cards,  │  │
│                               │  │  expand in place)                   │  │
│                               │  └─────────────────────────────────────┘  │
│  ┌─────────────────────────┐  │  ┌ data/accounts.md ─────────── +120 ─┐  │
│  │ ✎ Composer              │  │  └─────────────────────────────────────┘  │
└───────────────────────────────┴──────────────────────────────────────────┘
```

- Empty state = Amp's "No Changes" hexagon.
- Pros: pixel-close to the screenshot; diffs-as-cards is exactly Pierre's CodeView sweet spot
  (virtualized multi-file list); simplest mental model for "what did the agent do".
- Cons: wrong emphasis for knowledge work — a sales ops person wants the *tracker*, not the
  diff of its server.js; artifact demoted to second tab.

---

## Recommendation

**Option B**, with Option C's Changes-card rendering *inside* the drawer. Rationale:
- The product decision (threads-orbs.md §1) is knowledge-work-first: the artifact is the
  deliverable, the diff is evidence. B puts the deliverable front and center and keeps the
  Amp-style evidence one click away.
- B degrades gracefully to A's Files view for the rare power user (drawer expanded = tree +
  read-only file view, same components).
- Amp's own trajectory (auto-surfacing Changes contextually, Portals for live things) is a
  contextual panel, not fixed tabs — B is the same idea with the polarity flipped for our
  audience.

Phasing fit: phase 3 (Pierre swap) can ship Option A mechanically (tab renames + component
swaps), then phase 3.5 restructures to B (drawer). This de-risks the Pierre migration from the
layout redesign.

## Right-panel content by thread state (Option B)

| Thread state | Right pane | Drawer |
| --- | --- | --- |
| New thread, nothing produced | empty state + suggestions | hidden |
| Agent researching (no files) | empty state, live tool-call ticker | hidden |
| Agent editing files | artifact iframe (or skeleton) | peek: "Working… N files" |
| Changes proposed | artifact | expanded: diffs + Accept/Revert |
| Artifact interactive | artifact iframe | hidden |
| Orb exposes a port (later) | second header tab "Portal" appears | — |
