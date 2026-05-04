/**
 * Org-chart backend bootstrap.
 *
 * Tiny Express server that exposes a CRUD REST API over a file-based store.
 * Designed to run as a sidecar container behind the nginx-served frontend
 * (which proxies `/api/` to this process).
 */

import cors from 'cors';
import express from 'express';
import type { ErrorRequestHandler } from 'express';

import { chartsRouter } from './routes/charts.js';

const PORT = Number(process.env.PORT ?? 3000);
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? '*';

const app = express();

// Limits raised to 10 MB so large hierarchy JSONs go through.
app.use(express.json({ limit: '10mb' }));
app.use(
  cors({
    origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN.split(',').map((s) => s.trim()),
    exposedHeaders: ['ETag', 'X-New-Default'],
  }),
);

app.get('/api/healthz', (_req, res) => {
  res.json({ ok: true, version: '0.1.0' });
});

app.use('/api', chartsRouter);

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal server error' });
};
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`org-chart-backend listening on :${PORT}`);
});
