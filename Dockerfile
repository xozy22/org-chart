# syntax=docker/dockerfile:1.7
#
# All-in-one image for Org-Chart Builder:
#   - Vite SPA is built and dropped into /app/public
#   - Express backend is compiled and dropped into /app/dist
#   - One Node process serves both on :3000
#
# The image runs as a non-root user. Mount a host directory at /app/data
# for persistent chart storage. See README → "Storage & volume mount".

# ─────────────────────────────────────────────────────────────
#  Stage 1 — Build the Vite SPA
# ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS frontend-builder
WORKDIR /src

# Install frontend deps first so this layer is cached when only sources change.
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build
# Output → /src/dist (static SPA bundle)

# ─────────────────────────────────────────────────────────────
#  Stage 2 — Compile the Express backend
# ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS backend-builder
WORKDIR /src

COPY backend/package.json backend/package-lock.json* ./
RUN npm ci --no-audit --no-fund

COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npm run build && \
    npm prune --omit=dev
# Output → /src/dist (compiled JS) + /src/node_modules (prod deps only)

# ─────────────────────────────────────────────────────────────
#  Stage 3 — Slim runtime
# ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

# `su-exec` is a tiny (~20 KB) replacement for `gosu` — used by the
# entrypoint to drop privileges from root → app after fixing volume
# ownership.
RUN apk add --no-cache su-exec

# Compiled backend + production node_modules
COPY --from=backend-builder /src/node_modules ./node_modules
COPY --from=backend-builder /src/dist ./dist
COPY --from=backend-builder /src/package.json ./

# Built SPA bundle — served by the same Node process
COPY --from=frontend-builder /src/dist ./public

# Pre-create the non-root `app` user. The entrypoint chowns /app/data to
# this user at startup so bind-mounts with arbitrary host ownership Just
# Work™.
RUN addgroup -S app && adduser -S app -G app && \
    mkdir -p /app/data && \
    chown -R app:app /app

# Entrypoint script: as root, fix /app/data ownership, then exec as app.
COPY --chmod=755 docker-entrypoint.sh /docker-entrypoint.sh

ENV PORT=3000 \
    DATA_DIR=/app/data \
    STATIC_DIR=/app/public \
    NODE_ENV=production

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/healthz >/dev/null 2>&1 || exit 1

# Container starts as root so the entrypoint can chown the data volume,
# then drops to `app`. Users who explicitly pass `--user UID:GID` skip
# the chown and run directly.
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
