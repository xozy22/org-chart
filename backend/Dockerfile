# syntax=docker/dockerfile:1.7

# ─────────────────────────────────────────────────────────────
#  Stage 1 — Compile TypeScript
# ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && \
    npm prune --omit=dev

# ─────────────────────────────────────────────────────────────
#  Stage 2 — Slim runtime
# ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

# Only the production dependencies + compiled output.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

# Non-root user
RUN addgroup -S app && adduser -S app -G app && \
    mkdir -p /app/data && \
    chown -R app:app /app
USER app

ENV PORT=3000 \
    DATA_DIR=/app/data \
    NODE_ENV=production
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/healthz >/dev/null 2>&1 || exit 1

CMD ["node", "dist/server.js"]
