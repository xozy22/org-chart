<p align="center">
  <img src="public/logo.svg" alt="Org-Chart Builder logo" width="112" height="112" />
</p>

<h1 align="center">Org-Chart Builder</h1>

<p align="center">
  <a href="https://github.com/xozy22/org-chart/actions/workflows/docker.yml">
    <img src="https://github.com/xozy22/org-chart/actions/workflows/docker.yml/badge.svg" alt="Build & Publish Container" />
  </a>
</p>

A browser-based organisational chart builder. Self-hosted, single
container, persistent storage on a directory you mount.

![Org-Chart Builder screenshot](docs/screenshot-app.png)

---

## Quick start

```bash
docker run -d --name org-chart \
  -p 8080:3000 \
  -v "$PWD/data":/app/data \
  ghcr.io/xozy22/org-chart:latest

open http://localhost:8080
```

One image, one container, one volume. The mounted directory at
`/app/data` is where charts and uploaded avatars live across
restarts. A ready-made `docker-compose.yml` ships in the repo:

```bash
docker compose up -d        # → http://localhost:8080
```

---

## Features

### Cards & data

| | |
|---|---|
| **Card content** | Avatar (image or auto-initials), name, title, department badge, email, phone, country flag |
| **Avatar upload** | Drag a JPG / PNG / GIF / WebP / SVG onto the upload button. Optional 1:1 cropper for raster files. Server-side smart compression: max 500×500 px, EXIF stripped, format-aware re-encode (opaque PNG → JPEG, transparent PNG → palette quantisation, others kept as-is). Originals preserved if compression would make them larger. |
| **Avatar viewer** | Click any uploaded avatar on a card to see it full size. Esc / backdrop / X / re-click closes. |
| **Clickable contacts** | Email = `mailto:`, phone = `tel:`. Per-field copy icons on hover. |
| **vCard export** | Per-card or per-selection RFC-6350 `.vcf` download (multi-select bundles into a ZIP), ready to import into Apple Contacts / Outlook / Google. |
| **Custom fields** | User-defined extras (text / number / date / url / email) with toggleable card visibility. |
| **Multi-root** | Any number of `parentId: null` nodes. Each subtree gets a stable colour container; descendants inherit the colour as a CSS variable. |
| **Departments** | Auto-suggest dropdown of every known department + 11-colour palette + custom colour picker, shared across cards in the same department. |

### Layout

| | |
|---|---|
| **Auto** | d3-org-chart's flex-tree layout. Expand/collapse pills, auto-fit. |
| **Free** | 20-px grid, drag every card into place. Lines follow live, manual positions persist independently per chart and per browser, switch back to auto without losing them. |
| **Drag-to-reparent** | Drop any card onto another to re-parent. |

### Workspaces (multi-chart)

| | |
|---|---|
| **Multiple charts** | Toolbar shows a `🗂 <chart name>` button. Click to open the workspace modal — every chart with name, tags, size, last-updated. |
| **CRUD** | Create, rename, re-tag, duplicate, delete. ★ flips the default — the chart loaded on the next visit. |
| **Tag filter & search** | Free-text search across name and tag; tag chips toggle as multi-select filters. |
| **Optimistic locking** | Every save sends `If-Match: <etag>`. Concurrent edits surface a conflict modal: load server, force local, or cancel. |
| **Per-user view-state** | Free-layout positions and the `auto`/`free` mode are stored per chart in the browser, so each viewer has their own placement on top of the same shared content. |
| **Drop-in import** | Copy a `*.json` file into `<data>/charts/` — a filesystem watcher picks it up live, no restart needed. |
| **Offline fallback** | If the server isn't reachable, the app silently falls back to single-chart `localStorage` mode. |

### Discovery

| | |
|---|---|
| **Search & filter** | Free-text search plus structured filter dropdowns (department, country, root). Non-matches dim while keeping the hierarchy intact. |
| **URL state** | Active filters mirror to the location hash (`#dept=Technik&country=de`) — every view is shareable as a link. |
| **Multi-select & bulk** | Ctrl/Cmd-click to select; floating bulk bar with delete, change-department, change-country; "Markierte Knoten" submenu copies the selection as text or downloads it as a vCard ZIP. |
| **Stats sidebar** | KPI tiles + bar charts: total / roots / departments / countries / avg & max depth, completeness ratios, top departments and countries. |
| **Minimap** | Bottom-right canvas overview, dims off-screen area, click-to-recentre. |
| **Zoom controls** | Bottom-left FAB cluster (Google-Maps style): `+`, `−`, `⊕` Fit. Wheel and pinch keep working. |

### Edit, share, persist

| | |
|---|---|
| **Undo / redo** | 50-step history with toolbar buttons, `Ctrl+Z` / `Ctrl+Y` / `Ctrl+Shift+Z`. Covers every edit, drag, bulk action and layout-mode toggle. |
| **Country flags** | 59 countries via [`flag-icons`](https://github.com/lipis/flag-icons), datalist autocomplete by name or ISO-2 code. |
| **Image export** | High-quality PNG (2× pixel ratio), self-contained SVG, compact PDF (JPEG @ 200 DPI). Page size auto-scales A4 → A3 → A2 → A1 → A0 so cards stay readable on any chart size; a typical small chart lands at ~150 KB on A4. Every CSS rule, custom property and flag image is inlined so the export matches the live view. |
| **JSON / CSV import & export** | v3 envelope with nodes, departments and custom-fields schema; legacy v2 + bare-array forms still accepted. Avatar uploads are inlined as `data:` URIs on export and re-hosted on import — a JSON exported on one host imports lossless on another. |

![Edit modal](docs/screenshot-edit-modal.png)

![Filter view](docs/screenshot-filter.png)

---

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Ctrl+Z` | Undo |
| `Ctrl+Y` / `Ctrl+Shift+Z` | Redo |
| `Esc` | Close any modal / clear multi-select |
| `Ctrl+Click` on a card | Toggle that card in the multi-selection |

Wheel / pinch on the canvas zooms; click-and-drag on empty space pans.

---

## Storage

The container expects **one directory mounted at `/app/data`**:

```
/app/data/
├── charts.index.json          ← metadata: {id, name, tags, default, etag, …}
├── charts/
│   └── <uuid>.json            ← one file per chart
└── images/
    └── <uuid>.<ext>           ← uploaded avatars
```

The directory is created on first start. Move it to a NAS, an SMB
share or an encrypted volume — anything with read/write access works.

> 💡 **Drop-in import** — any `*.json` file copied into
> `<data>/charts/` is auto-imported on startup *and* live while the
> container runs. Non-UUID filenames are renamed to a fresh
> `<uuid>.json` and the original filename becomes the chart's display
> name.

### Volume options

```yaml
# Bind-mount a host directory (most common)
volumes:
  - /srv/org-chart/data:/app/data

# Or a named Docker volume (recommended for production —
# survives `docker compose down`, only `down -v` deletes it)
volumes:
  - org_chart_data:/app/data
```

### File ownership

The container starts as **root** so the entrypoint can `chown` the
mounted data directory to its in-container user, **then drops
privileges before running Node**. A plain
`docker run -v /any/host/path:/app/data …` Just Works™ regardless of
how the host directory is owned.

To force a specific UID/GID instead (so on-disk files are owned by
*your* user for editing or backups):

```yaml
services:
  org-chart:
    user: "${UID:-1000}:${GID:-1000}"
```

**SELinux** (RHEL / Fedora / CentOS): add `:Z` so the volume gets
relabeled for container access:

```yaml
volumes:
  - /srv/org-chart/data:/app/data:Z
```

If `chown` fails (read-only mount, SMB/NFS without write access,
SELinux mismatch), the entrypoint logs a warning and the app still
starts — every write request returns `503 Storage volume is not
writable` until host permissions are fixed.

### Backup

Just JSON + image files — standard tools work:

```bash
tar -czf data-backup.tgz data/
```

To restore: stop the container, extract the tarball, start again.
The auto-importer reconciles any drift between index and files.

### Cross-host portability

JSON exports are **fully self-contained**: every uploaded avatar is
fetched and inlined as a `data:` URI. On import, the new host detects
each `data:` URI, POSTs it back to its own image endpoint, and
rewrites `imageUrl` to a fresh local URL. A 100-node chart with hand-
uploaded avatars stays around 5–10 MB — email-friendly. Roundtrip
on a local backend: ~1–3 s export, ~2–5 s import.

If a re-host POST fails on import (e.g. server offline), the
`data:` URI stays as the `imageUrl` — the avatar still renders from
the inlined bytes, just less efficiently.

### Default chart for empty installs

`public/sample-data.json` ships inside the image and loads on first
start when the data dir is empty. Replace it by mounting your own:

```yaml
volumes:
  - ${ORG_CHART_DATA:-./data}:/app/data
  - ./my-sample.json:/app/public/sample-data.json:ro
```

---

## Configuration

All knobs are environment variables. Defaults shown in brackets.

| Variable | Effect |
|---|---|
| `PORT` *(`3000`)* | TCP port the Node process listens on inside the container |
| `DATA_DIR` *(`/app/data`)* | Absolute path to the chart-storage directory |
| `STATIC_DIR` *(`/app/public`)* | Path to the compiled SPA bundle. Set empty to run API-only |
| `CORS_ORIGIN` *(`*`)* | Comma-separated allowed origins, or `*` |
| `IMAGE_MAX_BYTES` *(`5242880`)* | Max accepted size for avatar uploads (5 MB) |
| `IMAGE_MAX_DIMENSION` *(`500`)* | Longest edge in pixels for resized avatars |
| `IMAGE_QUALITY` *(`85`)* | JPEG / WebP encode quality (0–100) |
| `NODE_ENV` *(`production`)* | Standard Node env flag |

---

## Data format

### v3 JSON (recommended)

```json
{
  "version": 3,
  "nodes": [
    {
      "id": "1", "parentId": null, "name": "Anna Müller", "title": "CEO",
      "department": "Vorstand", "email": "anna@beispiel.de",
      "phone": "+49 89 1000 0001", "country": "de", "imageUrl": "",
      "office": "Munich HQ"
    }
  ],
  "departments": { "Vorstand": "#dc2626" },
  "customFields": [
    { "key": "office", "label": "Büro", "type": "text", "showOnCard": true }
  ]
}
```

The legacy v2 form (`{ nodes, departments }`) and the bare-array
form (`[ {...}, {...} ]`) are still accepted on import. Free-layout
positions are *not* part of the JSON envelope — they live in the
browser's localStorage, scoped per chart.

### CSV

Default header row: `id,parentId,name,title,department,email,phone,imageUrl,country`.
Active custom-field keys are appended to the export header. Empty
cells are allowed; `parentId` of a root node is left blank.

---

## REST API

All bodies are JSON.

| Method | Path | Notes |
|---|---|---|
| `GET`    | `/api/charts`           | Index — every chart's metadata (no payload) |
| `POST`   | `/api/charts`           | Body `{name, tags?, payload?}` → 201 with new entry |
| `GET`    | `/api/charts/:id`       | Body `{entry, payload}` + `ETag` header |
| `PUT`    | `/api/charts/:id`       | `If-Match: <etag>` required → 200 or 412 (conflict) |
| `PATCH`  | `/api/charts/:id`       | Body `{name?, tags?, default?}` |
| `DELETE` | `/api/charts/:id`       | Auto-promotes oldest as new default if needed; surfaces it via `X-New-Default` header |
| `POST`   | `/api/images`           | Multipart form with field `image` → 201 + `{ url, bytes, originalBytes, type, resized }` |
| `GET`    | `/api/images/:filename` | Serves the uploaded image with 30-day immutable cache headers |
| `GET`    | `/api/healthz`          | Liveness probe |

ETags are 7-char SHA-1 prefixes over the canonical payload — clients
hold the value from the last `GET`/`PUT` and round-trip it as
`If-Match` for optimistic locking.

Filesystem-level errors (`EACCES` / `EPERM` / `EROFS`) are translated
to HTTP 503 with an actionable hint, so a misconfigured volume mount
shows up as a clean response instead of a process crash.

---

## Development

The source is split into two npm packages: a Vite + TypeScript SPA at
the repo root and a small Express server in `backend/`. Production
bundles them into a single Docker image, but for local development
you run them as two processes:

```bash
# Terminal 1 — REST server on :3000
cd backend
npm install
npm run dev          # tsx watch — restart on code change

# Terminal 2 — Vite dev server on :5173, proxies /api → :3000
npm install          # in repo root
npm run dev
```

Open <http://localhost:5173>. Vite hot-reloads the SPA; the server
restarts on save. Charts land in `backend/data/` (gitignored).

```bash
npm run build        # tsc + Vite production build → ./dist
npm run type-check   # standalone TypeScript check (CI-friendly)
```

To override the server URL the Vite dev server proxies to:

```bash
BACKEND_URL=http://192.168.1.10:3000 npm run dev
```

### Build the image yourself

```bash
docker build -t org-chart:local .
docker run --rm -p 8080:3000 -v "$PWD/data":/app/data org-chart:local
```

A 3-stage multi-arch Dockerfile builds the SPA bundle, the Node
server, and bakes both into a single Alpine runtime. CI publishes
both `linux/amd64` and `linux/arm64`, so the same image runs on
Apple Silicon, x86 servers and Raspberry Pi 5.

---

## Continuous integration

`.github/workflows/docker.yml` builds and pushes the image on every
push to `main` and on every tag matching `v*.*.*`:

| Trigger | Tags |
|---|---|
| Push to `main` | `main`, `latest`, `sha-<short>` |
| Tag `v1.2.3` | `1.2.3`, `1.2`, `latest`, `sha-<short>` |
| Pull request | image is **built but not pushed** (cache stays warm) |

The image lands at `ghcr.io/xozy22/org-chart`. To pull without
authentication, set the GHCR package visibility to *Public* once at
<https://github.com/xozy22?tab=packages>.

---

## License

MIT — see [LICENSE](LICENSE).
