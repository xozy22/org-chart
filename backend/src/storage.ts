/**
 * File-based storage for charts.
 *
 *   /data/
 *     charts.index.json   ← list of metadata (no payloads)
 *     charts/<id>.json    ← full chart payload
 *
 * No database. The index file is the single source of truth for metadata
 * (name, tags, default flag, etag, timestamps) and for ordering. Per-chart
 * payloads are serialised once and stamped with a sha1-derived ETag.
 *
 * Concurrency:
 * - Each public function reads/writes atomically; a small in-process Mutex
 *   guards index modifications so two simultaneous create/delete calls
 *   don't corrupt the index.
 * - Per-chart writes use a write-temp-then-rename dance to avoid
 *   half-written files.
 */

import { createHash, randomUUID } from 'node:crypto';
import { promises as fs, constants as fsConst } from 'node:fs';
import path from 'node:path';

import type { ChartIndexEntry, ChartPayload } from './types.js';

const DATA_DIR = process.env.DATA_DIR ?? path.resolve(process.cwd(), 'data');
const INDEX_PATH = path.join(DATA_DIR, 'charts.index.json');
const CHART_DIR = path.join(DATA_DIR, 'charts');

/** Tiny in-process mutex so index reads/writes don't interleave. */
class Mutex {
  private p: Promise<void> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.p.then(fn);
    this.p = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}
const indexMutex = new Mutex();

async function ensureDirs(): Promise<void> {
  await fs.mkdir(CHART_DIR, { recursive: true });
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p, fsConst.F_OK);
    return true;
  } catch {
    return false;
  }
}

function chartPath(id: string): string {
  return path.join(CHART_DIR, `${id}.json`);
}

/** 7-char hex SHA-1, stable across processes — used as ETag value. */
export function computeEtag(payload: ChartPayload): string {
  const canonical = JSON.stringify({
    nodes: payload.nodes,
    departments: payload.departments,
    customFields: payload.customFields,
  });
  return createHash('sha1').update(canonical).digest('hex').slice(0, 7);
}

async function writeJson(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf-8');
  await fs.rename(tmp, file);
}

async function readJson<T>(file: string): Promise<T> {
  const raw = await fs.readFile(file, 'utf-8');
  return JSON.parse(raw) as T;
}

/* --------------------------------------------------------------------- */
/*  Index handling                                                       */
/* --------------------------------------------------------------------- */

async function readIndex(): Promise<ChartIndexEntry[]> {
  if (!(await fileExists(INDEX_PATH))) return [];
  try {
    const arr = await readJson<ChartIndexEntry[]>(INDEX_PATH);
    return Array.isArray(arr) ? arr : [];
  } catch (err) {
    console.warn('charts.index.json unreadable, treating as empty', err);
    return [];
  }
}

async function writeIndex(entries: ChartIndexEntry[]): Promise<void> {
  await ensureDirs();
  await writeJson(INDEX_PATH, entries);
}

/* --------------------------------------------------------------------- */
/*  Public API                                                           */
/* --------------------------------------------------------------------- */

export async function listCharts(): Promise<ChartIndexEntry[]> {
  return indexMutex.run(async () => {
    return await readIndex();
  });
}

export async function getChart(
  id: string,
): Promise<{ entry: ChartIndexEntry; payload: ChartPayload } | null> {
  const index = await indexMutex.run(() => readIndex());
  const entry = index.find((c) => c.id === id);
  if (!entry) return null;
  if (!(await fileExists(chartPath(id)))) return null;
  const payload = await readJson<ChartPayload>(chartPath(id));
  return { entry, payload };
}

export interface CreateChartInput {
  name: string;
  tags?: string[];
  payload?: Partial<ChartPayload>;
}

export async function createChart(input: CreateChartInput): Promise<ChartIndexEntry> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const payload: ChartPayload = {
    nodes: input.payload?.nodes ?? [],
    departments: input.payload?.departments ?? {},
    customFields: input.payload?.customFields ?? [],
  };
  const etag = computeEtag(payload);

  return indexMutex.run(async () => {
    await ensureDirs();
    const index = await readIndex();
    const isFirst = index.length === 0;
    const entry: ChartIndexEntry = {
      id,
      name: input.name.trim() || 'Unbenannt',
      tags: dedupeTags(input.tags),
      default: isFirst,
      createdAt: now,
      updatedAt: now,
      etag,
      nodeCount: payload.nodes.length,
      departmentCount: Object.keys(payload.departments).length,
    };
    index.push(entry);
    await writeJson(chartPath(id), payload);
    await writeIndex(index);
    return entry;
  });
}

/**
 * Replace a chart's payload. The caller must pass the ETag they currently
 * hold; if it doesn't match the on-disk one, returns `null` (caller should
 * respond with 412). On success returns the updated entry with its new ETag.
 */
export async function putChart(
  id: string,
  ifMatch: string,
  payload: ChartPayload,
): Promise<ChartIndexEntry | { conflict: true; current: ChartIndexEntry } | null> {
  return indexMutex.run(async () => {
    const index = await readIndex();
    const idx = index.findIndex((c) => c.id === id);
    if (idx < 0) return null;
    const entry = index[idx]!;
    if (entry.etag !== ifMatch) {
      return { conflict: true, current: entry };
    }
    const newEtag = computeEtag(payload);
    entry.etag = newEtag;
    entry.updatedAt = new Date().toISOString();
    entry.nodeCount = payload.nodes.length;
    entry.departmentCount = Object.keys(payload.departments).length;
    index[idx] = entry;
    await writeJson(chartPath(id), payload);
    await writeIndex(index);
    return entry;
  });
}

export interface PatchMetadataInput {
  name?: string;
  tags?: string[];
  default?: boolean;
}

export async function patchMetadata(
  id: string,
  patch: PatchMetadataInput,
): Promise<ChartIndexEntry | null> {
  return indexMutex.run(async () => {
    const index = await readIndex();
    const idx = index.findIndex((c) => c.id === id);
    if (idx < 0) return null;
    const entry = index[idx]!;
    if (patch.name !== undefined) entry.name = patch.name.trim() || entry.name;
    if (patch.tags !== undefined) entry.tags = dedupeTags(patch.tags);
    if (patch.default === true) {
      // Switch the default flag — exactly one chart at a time may hold it.
      for (const c of index) c.default = false;
      entry.default = true;
    } else if (patch.default === false) {
      entry.default = false;
    }
    entry.updatedAt = new Date().toISOString();
    index[idx] = entry;
    await writeIndex(index);
    return entry;
  });
}

/**
 * Delete a chart. If it was the default, promote the oldest remaining chart
 * so there's always exactly one default (when ≥ 1 chart exists).
 *
 * Returns:
 *   - `null` if the chart didn't exist
 *   - `{ deleted, newDefault? }` on success — `newDefault` is set when we had
 *     to promote a chart (caller forwards via `X-New-Default` header).
 */
export async function deleteChart(
  id: string,
): Promise<{ deleted: ChartIndexEntry; newDefault?: ChartIndexEntry } | null> {
  return indexMutex.run(async () => {
    const index = await readIndex();
    const idx = index.findIndex((c) => c.id === id);
    if (idx < 0) return null;
    const [deleted] = index.splice(idx, 1);
    if (!deleted) return null;

    let newDefault: ChartIndexEntry | undefined;
    if (deleted.default && index.length > 0) {
      // Promote the chart with the oldest createdAt.
      const promoted = [...index].sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      )[0]!;
      promoted.default = true;
      newDefault = promoted;
    }

    if (await fileExists(chartPath(id))) {
      await fs.rm(chartPath(id), { force: true });
    }
    await writeIndex(index);
    return newDefault ? { deleted, newDefault } : { deleted };
  });
}

/* --------------------------------------------------------------------- */
/*  Helpers                                                              */
/* --------------------------------------------------------------------- */

function dedupeTags(tags: string[] | undefined): string[] {
  if (!tags) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const t = String(raw ?? '').trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}
