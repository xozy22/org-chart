# Org-Chart Builder

[![Build & Publish Container](https://github.com/xozy22/org-chart/actions/workflows/docker.yml/badge.svg)](https://github.com/xozy22/org-chart/actions/workflows/docker.yml)

A browser-based organisational chart builder. TypeScript + [d3-org-chart](https://github.com/bumbeishvili/org-chart), served from a tiny nginx container.

![Org-Chart Builder screenshot](docs/screenshot-app.png)

---

## Features

### Cards & data

| Area | What it does |
|---|---|
| **Card content** | Avatar (image or auto-initials), name, title, department, email, phone, country flag |
| **Custom fields** | User-defined extra fields (text / number / date / url / email) with toggleable visibility on the card; stored alongside the built-ins, shown as an extra key/value row |
| **CRUD** | Add / edit / delete nodes via a modal with department auto-suggest, country flag preview and per-field reset; cascading or re-parenting on delete |
| **Drag & Drop re-parenting** | Re-parent any node by dragging it onto another card (built-in to d3-org-chart) |

### Layout

| Area | What it does |
|---|---|
| **Auto layout** | d3-org-chart's flex-tree algorithm — the default. Expand / collapse pills, auto-fit, perfect for hierarchies. |
| **Free layout** | Toolbar toggle switches to a 20-px grid where every card can be dragged into place. Connecting lines follow live, manual positions persist independently of the auto layout, and the user can flip back to auto without losing them. |
| **Multiple roots** | Several top-level nodes per chart; each subtree gets its own colour container with a `ROOT` badge — descendants inherit the colour for top-stripe and avatar ring |
| **Departments** | Auto-suggest dropdown of all known departments + 11-colour palette + custom colour picker. Colour is shared by every card in that department |

### Discovery

| Area | What it does |
|---|---|
| **Search & Filter** | Free-text search plus structured filter dropdowns (department, country, root). Non-matching cards dim while keeping the hierarchy intact. |
| **URL state** | Active filters mirror to the location hash (`#dept=Technik&country=de`), making any view shareable as a link |
| **Multi-select & bulk** | Ctrl/Cmd-click cards to multi-select; floating bulk bar appears with delete, change-department and change-country actions |
| **Stats sidebar** | KPI tiles + horizontal-bar breakdowns: total / roots / departments / countries / avg & max depth, completeness ratios, top departments and top countries (with flag icons) |
| **Minimap** | Bottom-right canvas overview that mirrors the current tree, dims the off-screen area, and re-centres the main chart on click |
| **Zoom controls** | Bottom-left floating cluster (Google-Maps style): `+`, `−`, `⊕` Fit. Wheel and pinch keep working through d3-zoom. |

### Undo / share / persist

| Area | What it does |
|---|---|
| **Undo / redo** | 50-step history with toolbar buttons + `Ctrl+Z` / `Ctrl+Y` / `Ctrl+Shift+Z`; covers every CRUD edit, drag, bulk action and layout-mode toggle |
| **Country flags** | 59 countries via [`flag-icons`](https://github.com/lipis/flag-icons), datalist autocomplete by name or ISO-2 code |
| **Persistence** | Auto-save to `localStorage`; manual JSON / CSV import & export with a v3 envelope that carries nodes, departments **and** the custom-fields schema |
| **Image export** | High-quality PNG (2× pixel ratio), self-contained SVG, A4 PDF — every CSS rule and every flag image is inlined so the export looks identical to the live view |

![Edit modal](docs/screenshot-edit-modal.png)

![Filter view](docs/screenshot-filter.png)

---

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Ctrl+Z` | Undo last change |
| `Ctrl+Y` / `Ctrl+Shift+Z` | Redo |
| `Esc` | Close any open modal / clear the multi-select |
| `Ctrl+Click` (on a card) | Toggle that card in the multi-selection |

Scrolling the wheel or pinching on the canvas zooms; click-and-drag on empty space pans.

---

## Quick start (development)

```bash
npm install
npm run dev          # Vite dev server with HMR on http://localhost:5173
npm run build        # tsc --noEmit + Vite production build to ./dist
npm run preview      # serve the built bundle locally
npm run type-check   # standalone TypeScript check (CI-friendly)
```

---

## Run with Docker

The published image is multi-stage (Node build → nginx runtime) and tiny — based on `nginx:1.27-alpine`.

```bash
# Pull & run the latest published image
docker run --rm -p 8080:80 ghcr.io/xozy22/org-chart:latest
```

Open <http://localhost:8080>.

### Build the image yourself

```bash
docker build -t org-chart:local .
docker run --rm -p 8080:80 org-chart:local
```

### Multi-arch

The CI publishes both `linux/amd64` and `linux/arm64`, so the image runs unmodified on Apple Silicon and Raspberry Pi 5.

---

## Where is the chart stored?

**Inside the user's browser, not the container.** The container is fully
stateless — it only serves static files. Every chart edit is persisted
to the browser's `localStorage` under five keys:

| Key | Contents |
|---|---|
| `orgchart.data.v1` | The flat array of nodes |
| `orgchart.departments.v1` | The map of explicit department colours |
| `orgchart.customfields.v1` | The user-defined custom-field schema |
| `orgchart.layoutmode.v1` | `auto` or `free` |
| `orgchart.positions.v1` | Per-node `{x, y}` overrides used in free mode |

This means:

- **Restarting the container does nothing to your data** — your browser
  still has it. You can pull a brand-new image, recreate the container,
  even bind-mount a different folder, and your chart is intact.
- **Different browsers / users see different charts.** `localStorage` is
  scoped to *origin × profile*. There is no shared backend.
- **`Ctrl-Shift-Del` / clearing site data wipes the chart.** Use the
  toolbar's `JSON ⬇` button to take a backup, and `JSON ⬆` (or `CSV ⬆`)
  to restore.

If you need a multi-user, server-side store, you'll have to add a
backend — that's intentionally out of scope for this image.

### Provide a default chart at container startup

The static file `sample-data.json` ships inside the image and is loaded
the *first time* a browser opens the app (when `localStorage` is empty).
Mount your own JSON over it to pre-populate every fresh visitor:

```bash
docker run --rm -p 8080:80 \
  -v "$PWD/my-chart.json:/usr/share/nginx/html/sample-data.json:ro" \
  ghcr.io/xozy22/org-chart:latest
```

The file must follow the format documented under
[*Data format*](#data-format). Either the bare-array form or the v2/v3
object form is accepted.

> Existing localStorage data still wins over the seed file — only fresh
> browsers (or after a `Ctrl-Shift-Del`) see the new default.

### docker-compose example

```yaml
services:
  org-chart:
    image: ghcr.io/xozy22/org-chart:latest
    container_name: org-chart
    restart: unless-stopped
    ports:
      - "8080:80"
    volumes:
      # OPTIONAL — provide your own initial chart that fresh visitors
      # see when their localStorage is empty. Leave commented to keep
      # the demo data that ships inside the image.
      - ./my-chart.json:/usr/share/nginx/html/sample-data.json:ro
```

```bash
docker compose up -d
```

---

## Make the published image public

GHCR packages start out **private**. To allow `docker pull
ghcr.io/xozy22/org-chart:latest` without a login, open
<https://github.com/xozy22?tab=packages>, select the `org-chart`
package, then *Package settings → Change visibility → Public*. This is
a one-time step that survives subsequent CI runs.

## Continuous integration

`.github/workflows/docker.yml` builds and pushes the container on every push to `main` and on every tag matching `v*.*.*`. Tags follow the [docker/metadata-action](https://github.com/docker/metadata-action) defaults:

| Trigger | Tags produced |
|---|---|
| Push to `main` | `main`, `latest`, `sha-<short>` |
| Tag `v1.2.3` | `1.2.3`, `1.2`, `latest`, `sha-<short>` |
| Pull request | image is **built but not pushed** (cache stays warm for the merge commit) |

The image is published to GitHub Container Registry — `ghcr.io/<owner>/<repo>` — using the workflow's `GITHUB_TOKEN`. You can also publish to Docker Hub by adding the credentials and a second `docker/login-action` step.

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

The legacy v2 form (`{ nodes, departments }`) and the bare array (`[ {...}, {...} ]`) are still accepted on import. Free-layout positions are *not* part of the JSON envelope — they live in their own localStorage key, scoped to the browser.

### CSV

Default header row: `id,parentId,name,title,department,email,phone,imageUrl,country`. Active custom-field keys are appended to the import header. Empty cells are allowed; `parentId` of a root node is left blank.

### Multiple roots

Any number of nodes can have `parentId: null`. Internally a virtual super-root is injected so [`d3.stratify`](https://d3js.org/d3-hierarchy/stratify) sees a single tree, then hidden in the rendered chart. Each real root receives a stable colour from an 8-entry palette; descendants inherit the colour for their top-stripe and avatar ring.

---

## Project structure

```
.
├── Dockerfile              # multi-stage build → nginx
├── nginx.conf              # SPA fallback, gzip, asset caching
├── docker-compose.yml      # one-shot run with optional seed-volume
├── tsconfig.json           # TypeScript in pragmatic relaxed mode
├── .github/workflows/      # CI: build & push to GHCR
├── public/sample-data.json # demo dataset
└── src/
    ├── main.ts             # bootstrap, toolbar wiring, toasts
    ├── chart.ts            # OrgChart instance, virtual-root logic, node template
    ├── store.ts            # state + localStorage + subscribers (used by undo/redo)
    ├── history.ts          # 50-step undo/redo stack
    ├── types.ts            # OrgNode, CustomField, Snapshot, ChartStats, …
    ├── crud.ts             # add/edit/delete modal logic
    ├── customFields.ts     # custom-field schema editor (settings modal)
    ├── filters.ts          # search + filter (dept/country/root) + dimming
    ├── selection.ts        # multi-select state + visual sync
    ├── freeLayout.ts       # free-mode drag, snap, link redraw, transform watcher
    ├── minimap.ts          # bottom-right canvas overview
    ├── stats.ts            # aggregations (counts, depth, completeness)
    ├── exporter.ts         # PNG / SVG / PDF export with inlined CSS & flags
    ├── io.ts               # JSON / CSV import & export
    ├── countries.ts        # ISO-3166 list + name resolver
    ├── departments.ts      # hash-color helper + WCAG text colour
    └── styles.css          # Fortinet-inspired theme
```

---

## License

MIT — see [LICENSE](LICENSE).
