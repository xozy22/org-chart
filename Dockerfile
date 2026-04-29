# syntax=docker/dockerfile:1.7

# ─────────────────────────────────────────────────────────────
#  Stage 1 — Build the Vite SPA
# ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

# Install dependencies first so this layer is cached when only source changes.
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

# Copy source and produce the production build.
COPY . .
RUN npm run build

# ─────────────────────────────────────────────────────────────
#  Stage 2 — Serve the static build via nginx
# ─────────────────────────────────────────────────────────────
FROM nginx:1.27-alpine AS runtime

# Custom nginx config: SPA fallback, gzip, long-lived asset cache.
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Static build output.
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1

CMD ["nginx", "-g", "daemon off;"]
