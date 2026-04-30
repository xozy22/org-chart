# Org-Chart Builder

[![Build & Publish Container](https://github.com/xozy22/org-chart/actions/workflows/docker.yml/badge.svg)](https://github.com/xozy22/org-chart/actions/workflows/docker.yml)

A browser-based organisational chart builder. Vanilla JS + [d3-org-chart](https://github.com/bumbeishvili/org-chart), served from a tiny nginx container.

![Org-Chart Builder screenshot](docs/screenshot-app.png)

---

## Features

| Area | What it does |
|---|---|
| **Cards** | Avatar (image or initials), name, title, department, email, phone, country flag |
| **CRUD** | Add / edit / delete nodes; cascading or re-parenting on delete |
| **Drag & Drop** | Re-parent any node by dragging it onto another card (built-in to d3-org-chart) |
| **Multiple roots** | Several top-level nodes per chart; each subtree gets its own colour container with a `ROOT` badge — descendants inherit the colour for top-stripe and avatar ring |
| **Departments** | Auto-suggest dropdown of all known departments + 11-colour palette + custom colour picker. Colour is shared by every card in that department |
| **Country flag icons** | 59 countries via [`flag-icons`](https://github.com/lipis/flag-icons), with name/code datalist autocomplete |
| **Search & Filter** | Free-text search plus structured filter dropdowns (department, country, root). Non-matching cards dim while keeping the hierarchy intact |
| **Persistence** | Auto-save to `localStorage`; manual JSON / CSV import & export |
| **Image export** | High-quality PNG (2× pixel ratio), self-contained SVG, A4 PDF — every CSS rule and every flag image is inlined so the export looks identical to the live view |

![Edit modal](docs/screenshot-edit-modal.png)

![Filter view](docs/screenshot-filter.png)

---

## Quick start (development)

```bash
npm install
npm run dev
```

Then open <http://localhost:5173>. Vite hot-reloads source changes.

```bash
npm run build      # produce a production build in ./dist
npm run preview    # serve ./dist locally for a smoke check
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
to the browser's `localStorage` under two keys:

| Key | Contents |
|---|---|
| `orgchart.data.v1` | The flat array of nodes |
| `orgchart.departments.v1` | The map of explicit department colours |

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
[*Data format*](#data-format). Either the bare-array form or the v2
object form (`{ nodes, departments }`) works.

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

### Flat JSON (recommended)

```json
{
  "version": 2,
  "nodes": [
    { "id": "1", "parentId": null, "name": "Anna Müller", "title": "CEO",
      "department": "Vorstand", "email": "anna@beispiel.de",
      "phone": "+49 89 1000 0001", "country": "de", "imageUrl": "" }
  ],
  "departments": {
    "Vorstand": "#dc2626"
  }
}
```

The bare-array form (`[ {...}, {...} ]`) is still accepted on import for backwards compatibility.

### CSV

Header row: `id,parentId,name,title,department,email,phone,imageUrl,country`. Empty cells are allowed; `parentId` of the root node is left blank.

### Multiple roots

Any number of nodes can have `parentId: null`. Internally a virtual super-root is injected so [`d3.stratify`](https://d3js.org/d3-hierarchy/stratify) sees a single tree, then hidden in the rendered chart.

---

## Project structure

```
.
├── Dockerfile              # multi-stage build → nginx
├── nginx.conf              # SPA fallback, gzip, asset caching
├── .github/workflows/      # CI: build & push to GHCR
├── public/sample-data.json # demo dataset
└── src/
    ├── main.js             # bootstrap
    ├── chart.js            # OrgChart instance, virtual-root logic, node template
    ├── store.js            # state + localStorage + departments map
    ├── crud.js             # add/edit/delete modal logic
    ├── filters.js          # search + filter (dept / country / root) + dimming
    ├── exporter.js         # PNG / SVG / PDF export with inlined CSS & flags
    ├── io.js               # JSON / CSV import & export
    ├── countries.js        # ISO-3166 list + name resolver
    ├── departments.js      # hash-color helper + WCAG text colour
    └── styles.css          # Fortinet-inspired theme
```

---

## License

MIT — see [LICENSE](LICENSE).
