# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project shape

This is a **two-package TypeScript monorepo without a workspace tool** — frontend at the repo root, backend in `backend/`. Each has its own `package.json`, its own `tsconfig.json`, its own `node_modules`. Run `npm install` in **both** when setting up.

Production deploys as a **single Docker container, single port**: the Express backend serves both `/api/*` and the compiled SPA bundle from `/app/public`. There is no nginx, no separate frontend server.

## Commands

### Frontend (repo root)
```bash
npm run dev          # Vite on :5173, proxies /api → :3000
npm run build        # tsc --noEmit + vite build → ./dist
npm run type-check   # standalone tsc --noEmit
```

### Backend (`cd backend`)
```bash
npm run dev          # tsx watch src/server.ts on :3000
npm run build        # tsc -p . → backend/dist
npm run start        # node dist/server.js (production)
npm run type-check   # tsc -p . --noEmit
```

### Docker
```bash
docker compose up -d                      # full stack on :8080 → container :3000
docker build -t org-chart:local .         # 3-stage multi-arch build
```

There is **no test runner and no linter configured**. `npm run type-check` in both packages is the closest thing to CI verification — run it after non-trivial changes.

To point the Vite dev server at a non-local backend: `BACKEND_URL=http://host:3000 npm run dev`.

## Architecture

### Two-mode frontend (API mode + offline mode)

`src/main.ts` boots and pings `/api/healthz`. From that single check it decides:

- **API mode** — talks to backend, supports multiple charts, optimistic locking via ETag (`src/api.ts`), conflict resolution (`src/conflict.ts`), workspace switcher (`src/workspaces.ts`).
- **Offline mode** — `localStorage`-only, single chart. Same UI, same store, no network calls.

Most code is mode-agnostic. The mode switch lives in `main.ts` and `api.ts`; everywhere else, code reads/writes through `store.ts` and the persistence layer chooses the right backend.

### Shared state in `src/store.ts`

Plain mutable object + subscriber list — no framework. All edits go through helper functions that mutate `store`, then call `notify()`. The renderer (`chart.ts`), filters, minimap, stats, and free-layout all subscribe.

Per-chart browser-local state (free-layout positions, layout mode `auto`/`free`) is keyed by `currentChartId` so each chart gets its own viewer-specific overlay on top of the shared payload.

### Multi-root via virtual super-root

d3-org-chart only renders one root. To support multiple `parentId: null` nodes, `chart.ts` injects a `VIRTUAL_ROOT_ID` node and reparents every real root to it. The virtual root is hidden via CSS. Code that walks the tree must filter `_virtual === true` nodes; code that "collapses all" must keep the virtual root expanded (see `collapseAllSubtrees` in `chart.ts` for the gotcha).

### Backend storage (`backend/src/storage.ts`)

File-based, per-chart JSON files under `<DATA_DIR>/charts/<uuid>.json` plus a single `charts.index.json` listing metadata + ETags.

- ETags are **7-char SHA-1 prefixes over the canonical payload**. Clients send them back as `If-Match` for optimistic locking; mismatch returns 412.
- A **process-wide async mutex** serialises writes — never write to the JSON files outside `storage.ts`.
- `reconcileFromDisk()` runs at boot to heal index drift.
- `autoImport.ts` uses chokidar to watch `<DATA_DIR>/charts/` for drop-in JSON files; non-UUID filenames are renamed in place to `<uuid>.json` and the original filename becomes the chart's display name.
- Filesystem errors (`EACCES`/`EPERM`/`EROFS`) are translated to HTTP 503 with an actionable hint instead of crashing.

### Avatar pipeline

Upload (`POST /api/images`) → multer → sharp → smart compression in `backend/src/routes/images.ts`:
- Resize to fit within `IMAGE_MAX_DIMENSION` (default 500 px), aspect ratio preserved, never upscale
- Strip EXIF
- Format-aware re-encode: opaque PNG → JPEG, transparent PNG → palette quantisation, JPEG/WebP/GIF keep format, SVG passes through
- If the optimised buffer is larger than the input, the original is kept

JSON export inlines `/api/images/...` URLs as `data:` URIs (parallel fetch); JSON import re-uploads `data:` URIs to the new host's backend. This is what makes JSON exports portable across deployments — see `src/io.ts`.

### Undo/redo (`src/history.ts`)

50-step snapshot stack. Every mutating action wraps itself in a snapshot push. When adding new edit operations, hook them through the history layer so `Ctrl+Z` works.

### Free-layout mode (`src/freeLayout.ts`)

When `layoutMode === 'free'`, manual `{x, y}` overrides on a 20-px grid replace d3-org-chart's tree positions. Links are redrawn manually because d3-org-chart's built-in link logic doesn't follow user-placed nodes. Positions are stored per-chart in localStorage, **not** in the JSON payload — they're viewer-specific.

## Conventions worth knowing

- **All UI text is in German.** New strings, toasts, modal labels, error messages — German. Code identifiers stay English.
- TypeScript with `module: "ESNext"`, `.js` import suffixes (NodeNext-style) — keep using `.js` in import paths even though the source is `.ts`.
- The `dist/` directory at the repo root is checked in but is the build output; don't hand-edit it.
- `*.png` files in the repo root are throwaway debugging screenshots from past sessions; new permanent screenshots belong in `docs/`.
- The CSS theme in `src/styles.css` is "Fortinet-inspired" — a single global stylesheet, no CSS modules, no Tailwind.

## Configuration env vars

Backend reads (defaults in brackets): `PORT` (3000), `DATA_DIR` (`/app/data`), `STATIC_DIR` (`/app/public`), `CORS_ORIGIN` (`*`), `IMAGE_MAX_BYTES` (5 MB), `IMAGE_MAX_DIMENSION` (500), `IMAGE_QUALITY` (85). Setting `STATIC_DIR=` empty runs API-only.
