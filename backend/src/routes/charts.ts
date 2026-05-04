/**
 * REST endpoints for chart management.
 *
 *   GET    /api/charts          → list metadata
 *   POST   /api/charts          → create a new chart
 *   GET    /api/charts/:id      → return payload + ETag
 *   PUT    /api/charts/:id      → replace payload (If-Match required)
 *   PATCH  /api/charts/:id      → update metadata (name / tags / default)
 *   DELETE /api/charts/:id      → remove chart (auto-promotes default)
 */

import { Router } from 'express';
import type { Request, Response } from 'express';

import {
  listCharts,
  getChart,
  createChart,
  putChart,
  patchMetadata,
  deleteChart,
} from '../storage.js';
import type { ChartPayload } from '../types.js';

export const chartsRouter: Router = Router();

/* --------- List ------------------------------------------------------- */
chartsRouter.get('/charts', async (_req: Request, res: Response) => {
  const items = await listCharts();
  res.json({ charts: items });
});

/* --------- Create ----------------------------------------------------- */
chartsRouter.post('/charts', async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const name = typeof body.name === 'string' ? body.name : '';
  if (!name.trim()) {
    res.status(400).json({ error: 'Name is required' });
    return;
  }
  const entry = await createChart({
    name,
    tags: Array.isArray(body.tags) ? body.tags : [],
    payload: typeof body.payload === 'object' && body.payload !== null
      ? body.payload
      : undefined,
  });
  res.status(201).set('ETag', entry.etag).json(entry);
});

/* --------- Get one ---------------------------------------------------- */
chartsRouter.get('/charts/:id', async (req: Request, res: Response) => {
  const result = await getChart(req.params.id);
  if (!result) {
    res.status(404).json({ error: 'Chart not found' });
    return;
  }
  res
    .set('ETag', result.entry.etag)
    .json({ entry: result.entry, payload: result.payload });
});

/* --------- Replace payload (PUT, optimistic locking) ----------------- */
chartsRouter.put('/charts/:id', async (req: Request, res: Response) => {
  const ifMatch = req.header('If-Match');
  if (!ifMatch) {
    res.status(428).json({ error: 'If-Match header is required' });
    return;
  }
  const body = req.body ?? {};
  const payload: ChartPayload = {
    nodes: Array.isArray(body.nodes) ? body.nodes : [],
    departments:
      body.departments && typeof body.departments === 'object'
        ? body.departments
        : {},
    customFields: Array.isArray(body.customFields) ? body.customFields : [],
  };

  const result = await putChart(req.params.id, ifMatch, payload);
  if (result === null) {
    res.status(404).json({ error: 'Chart not found' });
    return;
  }
  if ('conflict' in result) {
    res
      .status(412)
      .set('ETag', result.current.etag)
      .json({ error: 'ETag mismatch', current: result.current });
    return;
  }
  res.set('ETag', result.etag).json(result);
});

/* --------- Patch metadata -------------------------------------------- */
chartsRouter.patch('/charts/:id', async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const patch: { name?: string; tags?: string[]; default?: boolean } = {};
  if (typeof body.name === 'string') patch.name = body.name;
  if (Array.isArray(body.tags)) patch.tags = body.tags;
  if (typeof body.default === 'boolean') patch.default = body.default;

  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: 'No metadata fields to update' });
    return;
  }
  const entry = await patchMetadata(req.params.id, patch);
  if (!entry) {
    res.status(404).json({ error: 'Chart not found' });
    return;
  }
  res.set('ETag', entry.etag).json(entry);
});

/* --------- Delete ----------------------------------------------------- */
chartsRouter.delete('/charts/:id', async (req: Request, res: Response) => {
  const result = await deleteChart(req.params.id);
  if (!result) {
    res.status(404).json({ error: 'Chart not found' });
    return;
  }
  if (result.newDefault) res.set('X-New-Default', result.newDefault.id);
  res.status(204).end();
});
