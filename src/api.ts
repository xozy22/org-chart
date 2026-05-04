/**
 * Fetch-based API client for the org-chart backend.
 *
 * The base URL is taken from `VITE_API_BASE` (build-time, default `/api`).
 * If the build was made without a backend, set the env var to an empty
 * string and `isApiConfigured()` returns false — the app falls back to
 * pure-localStorage mode.
 *
 * Each `getChart()` response surfaces the `ETag` header so callers can
 * round-trip it on `putChart()` for optimistic locking.
 */

import type {
  ApiError,
  ChartIndexEntry,
  ChartPayload,
} from './types.js';

const RAW_BASE = ((import.meta as any).env?.VITE_API_BASE ?? '/api') as string;
const BASE = RAW_BASE.replace(/\/+$/, '');

export function isApiConfigured(): boolean {
  return BASE.length > 0;
}

function url(path: string): string {
  return `${BASE}${path.startsWith('/') ? path : '/' + path}`;
}

async function parseError(res: Response): Promise<ApiError> {
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* ignore non-JSON */
  }
  const err: ApiError = {
    status: res.status,
    message: body?.error ?? `HTTP ${res.status}`,
  };
  if (res.status === 412 && body?.current) {
    err.conflict = body.current as ChartIndexEntry;
  }
  return err;
}

/** Liveness probe for the backend. Used at bootstrap to choose API mode. */
export async function healthz(timeoutMs = 1500): Promise<boolean> {
  if (!isApiConfigured()) return false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url('/healthz'), { signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

export async function listCharts(): Promise<ChartIndexEntry[]> {
  const res = await fetch(url('/charts'));
  if (!res.ok) throw await parseError(res);
  const data = (await res.json()) as { charts: ChartIndexEntry[] };
  return data.charts;
}

export async function getChart(
  id: string,
): Promise<{ entry: ChartIndexEntry; payload: ChartPayload; etag: string }> {
  const res = await fetch(url(`/charts/${encodeURIComponent(id)}`));
  if (!res.ok) throw await parseError(res);
  const data = (await res.json()) as {
    entry: ChartIndexEntry;
    payload: ChartPayload;
  };
  // ETag header is preferred; fall back to entry.etag if exposed-headers
  // wasn't configured on the backend's CORS config.
  const etag = (res.headers.get('ETag') ?? data.entry.etag).replace(/^"|"$/g, '');
  return { ...data, etag };
}

export interface CreateChartInput {
  name: string;
  tags?: string[];
  payload?: Partial<ChartPayload>;
}

export async function createChart(input: CreateChartInput): Promise<ChartIndexEntry> {
  const res = await fetch(url('/charts'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as ChartIndexEntry;
}

/**
 * Replace a chart's payload with optimistic locking via `If-Match`.
 * Throws an `ApiError` with `status: 412` and `conflict` set on stale ETag,
 * `status: 404` if the chart no longer exists.
 */
export async function putChart(
  id: string,
  ifMatch: string,
  payload: ChartPayload,
): Promise<{ entry: ChartIndexEntry; etag: string }> {
  const res = await fetch(url(`/charts/${encodeURIComponent(id)}`), {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'If-Match': ifMatch,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw await parseError(res);
  const entry = (await res.json()) as ChartIndexEntry;
  const etag = (res.headers.get('ETag') ?? entry.etag).replace(/^"|"$/g, '');
  return { entry, etag };
}

export interface PatchInput {
  name?: string;
  tags?: string[];
  default?: boolean;
}

export async function patchChart(
  id: string,
  patch: PatchInput,
): Promise<ChartIndexEntry> {
  const res = await fetch(url(`/charts/${encodeURIComponent(id)}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as ChartIndexEntry;
}

export async function deleteChart(
  id: string,
): Promise<{ newDefault?: string }> {
  const res = await fetch(url(`/charts/${encodeURIComponent(id)}`), {
    method: 'DELETE',
  });
  if (!res.ok) throw await parseError(res);
  const newDefault = res.headers.get('X-New-Default') ?? undefined;
  return { newDefault };
}
