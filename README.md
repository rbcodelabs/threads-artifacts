# Design for Agent Threads

Desktop-only peer plugin that adds UI design artifacts to Agent Threads: simple static HTML pages, or full Next.js app prototypes that can be exported back to static HTML.

## Requirements

- Agent Threads v0.43.0 or later, with public API v1 and the `threads.beginProvisional` capability
- Obsidian or Geode desktop with a local filesystem vault

Interactive preview and screenshot capture require Geode's artifact runtime. In Obsidian, Preview reveals the artifact source in the file manager instead.

Enable Agent Threads first, then enable **Design for Agent Threads**. The plugin registers:

- `/design [--nextjs] <brief>` in existing-thread and new-thread composers
- the `EnterDesignMode` agent tool (`brief`, optional `mode`, optional `runtime`)
- presentation, preview, capture, and source-reveal actions for `design-static` and `design-app` artifacts
- an **Export static HTML** action for `design-app` artifacts

Designs are stored in a visible vault folder chosen by the host, by default `<vault>/Artifacts/<plugin>/<title-slug>/`. The root folder is configurable on the host side, and the host derives the per-plugin namespace from the caller; this plugin passes its own plugin id as `owner` (from which the host derives the namespace) but no namespace or folder root, and hard-codes no folder name. The plugin asks the host for visible storage (`allocateStorage(..., { location: 'visible', folderName })`), where `folderName` is a lowercase kebab-case ASCII slug of the design title (at most 60 characters, falling back to the artifact id). The host sanitizes the name and adds `-2`, `-3`, … on collision, and the plugin always uses the path the host returns. The folder name is only a label: a design's identity is the `id` and `createdByThreadId` in its `artifact.json`, so you can rename the folder in the vault without breaking anything the plugin looks up by identity.

Fallback: a host that does not support visible storage ignores the request and returns a path beneath `.geode/artifacts/`. Design uses that path unchanged, with no error.

Migration: on load, Design moves each of its existing designs from `.geode/artifacts/` into the visible folder the host allocates and updates the stored artifact paths. It is idempotent and non-fatal. It never overwrites existing files (a folder that would collide is left alone), skips silently when the host has no visible storage, and leaves the original folder in place and working if a move or metadata update fails.

A failed new-thread preparation rolls back both the provisional thread and allocated storage. Once preparation commits, a later agent-session failure keeps the artifact intact and is reported to the user.

New artifacts start with a compact loading state that matches the host's current light or dark palette and interface font. This theme snapshot is captured only at creation; existing artifacts and agent-authored styles are preserved.

## Modes

A mode changes the instructions for one design turn. It does not create a new artifact kind: each thread keeps its single design artifact, and `artifact.json` is unchanged. Start the brief with a mode keyword and a colon (case-insensitive):

- `/design wireframe: a billing settings page` produces a grayscale, low-fidelity wireframe that focuses on layout, hierarchy, and flows. If the thread already has a design, the wireframe reduces it to its structure.
- `/design states: the plan-picker card` builds a component state sheet. It covers default, hover, focus-visible, pressed, disabled, loading, empty, error, and overflow states, in light and dark themes.
- `/design variations: a pricing page` produces three distinct directions (four if the brief asks), labeled A–D. Each is a full page snapshot in `variations/<letter>/`, and the root page becomes a comparison board that previews them side by side.
- `/design pick: B` promotes direction B to the root page and builds it out fully. Notes may follow the letter, for example `/design pick: B, but use A's navigation`. The `variations/` folder is kept, so you can pick again. Pick only works in a thread that already has a design. It cannot start a new thread.
- `/design spec: the pricing page` adds a toggleable redline overlay to the existing design without changing it. Press `S` or click the floating "Show spec" button to reveal spacing, type, and color-token annotations, in both the desktop and mobile layouts. Spec only works in a thread that already has a design; it cannot start a new thread.
- `/design storyboard: the signup flow` (or a video brief) builds an ordered frame board that the agent infers is a product flow or a video. Frames live in `storyboard.json` (mirrored to `storyboard.js`, since the artifact CSP blocks fetch) and render as a numbered grid with captions and notes. Flows add trigger and branch labels between frames. Videos add duration, shot, and voiceover plus a total runtime. Reorder frames by drag or arrow keys and edit captions inline; those edits are page-only and are not saved. A `storyboard.md` shot list is written alongside and regenerated on re-run. It can start a new thread.
- `/design report: quarterly revenue analysis` builds a local, document-style HTML report with a summary first, a contents list, prose sections, assumptions, and SVG charts (stacked bar, grouped bar, line) that each have a legend, hover tooltips, and a data table beneath as the accessible fallback. It can start a new thread. See [Report mode](#report-mode).

The colon is required, so `/design states of the union dashboard` is an ordinary brief. In a thread that already has a design, a bare `/design wireframe:`, `/design states:`, `/design variations:`, `/design spec:`, `/design storyboard:`, or `/design report:` runs that mode against the existing design. `EnterDesignMode` accepts the same modes through its optional `mode` argument. In an Agent Threads host version that supports argument-completion suggestions, typing `/design ` offers the mode keywords as autocomplete.

### Report mode

Use `report` for any request for a report, analysis, summary document, or charts. The result is a plain HTML file in the same host-allocated artifacts folder as other designs, so it lives in the vault, syncs with it, and opens in Geode's artifact preview. Nothing is uploaded: the `EnterDesignMode` tool description tells the agent to prefer `report` over cloud doc connectors (Claude Docs, Google Docs), which makes it the right place for personal or financial data.

The scaffold writes `index.html` (the document), `styles.css`, `report.js`, and `data.js`:

- `data.js` sets `window.REPORT_DATA`: the title, subtitle, byline, and a `charts` map. Each chart is `{ type, title, caption, categories, series: [{ name, values }], format: { prefix, suffix, decimals } }` with `type` of `stacked-bar`, `grouped-bar`, or `line`. It is the single source of truth for numbers, loaded by a script tag because the artifact CSP (`connect-src 'none'`) blocks `fetch`.
- `index.html` holds the prose. A `<figure class="chart" data-chart="key"></figure>` is replaced at load time by the chart, its legend, and its data table.
- `report.js` is a dependency-free SVG chart library with no inline script and no network access. Series colors come from an eight-color categorical palette with separate light and dark variants.
- `styles.css` uses the host theme captured at creation, swaps palettes under `prefers-color-scheme`, and has print rules.

Chart marks are built for the element picker: every bar and point carries `data-series` and `data-category` (and keeps its tooltip `<title>`), each line has a `<title>` with its series name, legend items and swatches carry `data-series`, x tick labels carry `data-category` (the tick text is its own label, with no nested title), and each figure and svg has a stable id (`chart-<key>`, `chart-<key>-svg`). When you pick one of these in Geode, the source hints point at the datum in `data.js` (the series name, the `categories` entry, the chart block, or the `data-report-field` key) ahead of any css match; table cells map their row and column to the category and series. Existing report artifacts keep their old `report.js` and `index.html`, because scaffold files are written only when missing: their marks lack these attributes and ids, and the hints fall back to matching the pick's text against `data.js` (still useful, a little less precise). Create a new report to get the new marks.

Follow-up requests in the same thread (for example "show bonus vs salary") edit `data.js` and the relevant section in place; a repeat `EnterDesignMode` call reopens the same artifact (`created: false`) and never makes a second document. As the last step, if the vault uses daily notes (the agent checks the daily-notes settings file or an existing `Daily/` folder), the agent adds, or updates without duplicating, a link under a `## Claude Sessions` heading in today's daily note, creating the heading if missing. If the vault has no daily notes it skips this step and does not create one. The plugin does not write to the vault itself, so this step is agent-driven. Report mode is static-only and returns an error for a Next.js design. If a thread already has a static design, `report:` adds `report.js` and `data.js` and asks the agent to rebuild `index.html` as the report.

Steering is advisory, because a plugin cannot hide or deny other MCP tools. For a hard guarantee that report data never reaches a cloud connector, deny the connector in the host: add `mcp__claude_ai_Claude_Docs` to `permissions.deny` in `~/.claude/settings.json`, or to the Agent Threads `disallowedTools` setting. Optionally add a rule to your global CLAUDE.md: "Reports, analyses and charts: use EnterDesignMode with mode report (a local vault artifact). Never use the Claude Docs connector for these, and never send personal or financial data to a cloud connector."

## Runtimes

| Runtime | Kind | Files | Preview | `permissions.network` |
| --- | --- | --- | --- | --- |
| `static` (default) | `design-static` | `index.html`, `styles.css`, `app.js` | file-backed secure artifact view | `none` |
| `nextjs` | `design-app` | Next.js 16 (webpack) App Router, TypeScript, Tailwind CSS v4 | local dev server on `127.0.0.1` | `loopback` |

Pick the runtime with `/design --nextjs <brief>` (also `--static`, `--runtime=nextjs`) or the tool's `runtime` argument. Flags go before the mode and brief and compose with modes: `/design --nextjs wireframe: a CRM`. The tool description steers the agent to `nextjs` for multi-page flows, client state, or complete app designs. A thread has one design artifact and its runtime cannot change afterwards. Next.js artifacts live in the same host-allocated artifacts folder as static ones (see storage above); the export goes to `exports/` inside it.

Modes on Next.js: `wireframe:` and `states:` work (the mode instructions are mapped onto `app/page.tsx` and friends). `variations:`, `pick:`, `spec:`, `storyboard:`, and `report:` depend on static multi-file snapshots, inline-script-free overlays, JSON script mirrors, and the report chart library, so they are static-only and return a clear error for a Next.js design.

### Manifest versions

`artifact.json` `schemaVersion` is **2** for new artifacts (adds `runtime: "nextjs"` and `network: "loopback"`). Version **1** (static-only) artifacts are still read, validated (`parseDesignManifest`), previewed, and revised unchanged.

### Next.js artifacts

The scaffold writes `package.json`, `next.config.mjs` (`output: 'export'`, `trailingSlash`, unoptimized images), `tsconfig.json`, Tailwind/PostCSS config, `app/layout.tsx`, `app/page.tsx`, and an `AGENTS.md` telling the design agent the export rules: mock data and client state only; no route handlers, middleware, Server Actions, `cookies()`/`headers()`, or dynamic segments without `generateStaticParams()`.

Dependencies are not installed per artifact. The pinned set (Next.js 16.4.3) is installed once into a shared cache at `<vault>/.geode/cache/design-nextjs/<hash>/` (the first Next.js design needs network access and takes a while) and each artifact gets a `node_modules` symlink to it. Dev and build run with `--webpack` because Turbopack rejects the symlinked shared `node_modules`. Changing the pinned versions in `src/nextjsTemplate.ts` creates a new cache entry.

**Preview and capture.** A dev-server manager starts `next dev --webpack` on a free `127.0.0.1` port the first time an artifact is previewed or captured, reuses it afterwards, and waits for it to answer HTTP. It stops every server on plugin unload, and any server left idle for 20 minutes (the host contract has no artifact-close event). Startup failures (missing npm, port, compile errors) come back as action warnings with the dev server output. The preview view receives `{ root, url, runtime: 'nextjs' }`; if the host cannot place it, the source is revealed instead.

**Export static HTML.** The card action:

1. scans `app/` for route handlers, middleware, `'use server'`, and dynamic segments missing `generateStaticParams`, and stops with the list if any are found;
2. runs `next build --webpack` in a throwaway copy of the artifact (so the live dev server is not disturbed);
3. verifies `out/index.html`, then copies the site to `<artifact>/exports/site/` and zips it to `<artifact>/exports/<id>-static.zip` (`zip`, falling back to `tar -a`; a missing archiver is only a warning);
4. reveals the folder.

Build failures report the `next build` output tail and the likely cause (server features). The exported pages reference `/_next/...` from the site root, so serve the folder from a web server root (for example `npx serve exports/site`) rather than opening `index.html` from `file://`.

## Element comments (Geode only)

In a static design, Geode's artifact view can offer a **Pick** button: select an element on the page, type a comment, and **Send**. Design turns that into one message in the design's own thread, so the agent edits the right place.

Requirement: a Geode build that implements the artifact feedback contract (version 1, ADR 0006: `Plugin.registerArtifactFeedbackHandler` plus `app.artifactFeedback`). On Geode builds without it, and in Obsidian, Design registers nothing, stays silent, and everything else works as before. Only static (`design-static`) designs created by Design are supported in this release; Next.js designs are not.

What happens on Send:

- The plugin re-validates the whole payload (schema, size caps, key allowlist) and maps the artifact folder to the thread that created it (`createdByThreadId` in `artifact.json`), rejecting folders outside the host's artifact storage.
- It writes `.threads-design/selections/<id>.json` (the full payload) and `<id>.png` (an element screenshot) inside the design folder, atomically and without following symlinks. Designs with `permissions.vault: "read"` never get a screenshot, and their selections are re-redacted (element text, most attribute values and the landmark are dropped). Only the newest 50 selections per design are kept; older ones are removed.
- The thread receives a short summary line, your comment, and an element block clearly fenced as untrusted page data with up to five heuristic source hints (file, line, confidence). Page text cannot forge the fence, and the `/escalate` keyword is neutralized so it cannot switch the thread's model.
- The element title and every other page or manifest value sit inside the fenced block; only your comment is outside it. A `/escalate` (or the configured escalation keyword) typed in your comment is kept as plain text, because the host would otherwise rewrite the whole message, and the status text tells you so.
- If the agent is busy, one comment per design waits in memory and sends automatically when the run finishes. A second comment while one is waiting is refused until the first has sent. A waiting comment expires after 30 minutes, and a plugin reload drops it with a notice.
- The agent is told never to edit `.threads-design/`; the plugin owns that folder.
- A design is only accepted when its thread's artifact record names a storage folder that resolves to the picked folder inside the vault (so a renamed visible artifact folder works).

Known limitations: idempotency is in memory, so if Geode times out a send that did go through and Design is reloaded before you press Retry, the retry can send the comment a second time (the prompt boundary token is per session). The Pick button is offered only for static designs whose `artifact.json` is a Design manifest; the full check happens on Send.

## Installation

This repository is private; downloading releases requires repository access.

1. Download `main.js` and `manifest.json` from the [latest release](https://github.com/rbcodelabs/threads-design/releases/latest).
2. Put both files in `<vault>/.geode/plugins/threads-design/` for Geode, or `<vault>/.obsidian/plugins/threads-design/` for Obsidian.
3. Update and enable Agent Threads first, then enable **Design for Agent Threads** in the host's plugin settings. Restart the host if the new plugin is not listed.
4. Start a new conversation and submit `/design a simple settings page` to check the installation. Geode opens the interactive preview; Obsidian reveals the generated source.

Existing design artifacts do not need to be moved. Without this plugin, Agent Threads v0.43.0 retains source access to legacy artifacts but no longer supplies `/design` or `EnterDesignMode` itself.

## DESIGN.md

To keep feature and UX designs faithful to an existing product, add a `DESIGN.md` to the project. Design looks for the nearest one starting at the thread's working directory and walking up to the repo root (the first directory containing `.git`). In each directory the order is `DESIGN.md`, then `.claude/DESIGN.md`, then `docs/DESIGN.md`; the nearest match wins. Content is capped at 12,000 characters and marked `[truncated]` beyond that. When found, it is injected into the design kickoff as authoritative guidance and the generic "distinctive visual direction" instruction is replaced. If the host does not expose the thread's working directory, the agent is told to look for these files itself.

Good things to put in it:

- A fidelity rule: match the existing UI; do not invent new colors, type, spacing, radii or component styles.
- Design tokens (colors, type scale, spacing, radii, shadows).
- Component conventions (buttons, forms, tables, navigation, empty and error states).
- Pointers to source files and screenshots that show the canonical look.
- Variations should differ only in layout, flow, hierarchy and interaction, not visual styling.

An explicit brief that asks for a new look overrides the file.

## Development

```sh
npm test
npm run typecheck
npm run build
```
