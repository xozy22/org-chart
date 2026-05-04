/**
 * Org-chart all-in-one server.
 *
 * Express serves the REST API under `/api/*` AND the compiled frontend
 * bundle for everything else. A SPA-style fallback returns index.html for
 * unknown paths so client-side routing keeps working.
 *
 * Layout inside the production container:
 *   /app/dist/                ← compiled backend (this file → server.js)
 *   /app/public/              ← compiled Vite SPA (index.html, assets/, …)
 *   /app/data/                ← persistent chart storage (host volume)
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

import cors from 'cors';
import express from 'express';
import type { ErrorRequestHandler, Request, Response, NextFunction } from 'express';

import { chartsRouter } from './routes/charts.js';

const PORT = Number(process.env.PORT ?? 3000);
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? '*';

// Resolve the static-file directory.
//   - In production (`node dist/server.js` from /app) the SPA bundle sits at
//     `/app/public` (that's where the Dockerfile drops it).
//   - In dev (`tsx watch src/server.ts`) the user runs Vite separately on
//     :5173, so we don't try to serve static files at all.
//   - The `STATIC_DIR` env var overrides everything for unusual layouts.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_STATIC_DIR = path.resolve(__dirname, '..', 'public');
const STATIC_DIR = process.env.STATIC_DIR ?? DEFAULT_STATIC_DIR;
const STATIC_DIR_EXISTS = existsSync(path.join(STATIC_DIR, 'index.html'));

const app = express();

// Limits raised to 10 MB so large hierarchy JSONs go through.
app.use(express.json({ limit: '10mb' }));
app.use(
  cors({
    origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN.split(',').map((s) => s.trim()),
    exposedHeaders: ['ETag', 'X-New-Default'],
  }),
);

// ── REST API ────────────────────────────────────────────────────────────
app.get('/api/healthz', (_req, res) => {
  res.json({ ok: true, version: '0.2.0' });
});
app.use('/api', chartsRouter);

// ── Static frontend + SPA fallback ──────────────────────────────────────
if (STATIC_DIR_EXISTS) {
  // Hashed Vite assets get a long cache; index.html stays uncached so
  // deploys are picked up immediately.
  app.use(
    '/assets',
    express.static(path.join(STATIC_DIR, 'assets'), {
      immutable: true,
      maxAge: '1y',
    }),
  );
  app.use(
    express.static(STATIC_DIR, {
      index: false, // we'll send index.html ourselves on `/`
      maxAge: '30d',
    }),
  );

  // Anything that isn't an API call falls back to index.html so client-side
  // routing (deep links to filters etc.) works on a hard refresh.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.path.startsWith('/api/')) return next();
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(STATIC_DIR, 'index.html'));
  });
} else {
  console.log(
    `[startup] Static SPA bundle not found at ${STATIC_DIR} — running in API-only mode. ` +
      `Set STATIC_DIR or run \`npm run build\` in the frontend.`,
  );
}

// ── Error handler ───────────────────────────────────────────────────────
const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal server error' });
};
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`org-chart listening on :${PORT}`);
  if (STATIC_DIR_EXISTS) console.log(`  ↳ serving SPA from ${STATIC_DIR}`);
  console.log(`  ↳ data dir: ${process.env.DATA_DIR ?? path.resolve(process.cwd(), 'data')}`);
});
