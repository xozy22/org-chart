import Papa from 'papaparse';
import { countryCode } from './countries.js';

const BUILTIN_FIELDS = ['id', 'parentId', 'name', 'title', 'department', 'email', 'phone', 'imageUrl', 'country'];

/**
 * How many image fetches/uploads run in parallel during export/import.
 * 8 keeps us comfortably below the browser's per-origin connection limit
 * (~6–10) while still being faster than serial — see README's
 * "Cross-host portability" note for the timing estimates.
 */
const IMAGE_BATCH_SIZE = 8;

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* --------------------------------------------------------------------- */
/*  Cross-host image portability                                         */
/* --------------------------------------------------------------------- */

/** Run `fn` over `items` in parallel batches; report progress per batch. */
async function inBatches<T, R>(
  items: T[],
  batchSize: number,
  fn: (item: T) => Promise<R>,
  onProgress?: (done: number, total: number) => void,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const slice = items.slice(i, i + batchSize);
    const results = await Promise.all(slice.map(fn));
    out.push(...results);
    onProgress?.(out.length, items.length);
  }
  return out;
}

function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function dataUriToBlob(dataUri: string): Blob {
  // data:[<mime>][;base64],<data>
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUri);
  if (!m) throw new Error('Invalid data URI');
  const mime = m[1] || 'application/octet-stream';
  const isBase64 = !!m[2];
  const data = m[3];
  if (isBase64) {
    const bin = atob(data);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }
  return new Blob([decodeURIComponent(data)], { type: mime });
}

/** Fetch an `/api/images/*` URL and convert it to a `data:` URI. Returns
 *  the original URL on any failure (404, network, …) so the export still
 *  produces a valid file even when an image is gone. */
async function inlineImageUrl(url: string): Promise<string> {
  try {
    const res = await fetch(url);
    if (!res.ok) return url;
    const blob = await res.blob();
    return await blobToDataUri(blob);
  } catch {
    return url;
  }
}

/** Decode a `data:` URI and POST it back to `/api/images`, returning the
 *  fresh server-side URL. Throws on backend failure so the caller can
 *  decide whether to keep the data URI or drop the avatar. */
async function uploadDataUri(dataUri: string): Promise<string> {
  const blob = dataUriToBlob(dataUri);
  const extByMime: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
  };
  const ext = extByMime[blob.type] ?? '.bin';
  const fd = new FormData();
  fd.append('image', blob, `imported${ext}`);
  const res = await fetch('/api/images', { method: 'POST', body: fd });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const body: any = await res.json();
      if (body?.error) detail = body.error;
    } catch { /* ignore */ }
    throw new Error(`Image upload failed: ${detail}`);
  }
  const body = (await res.json()) as { url: string };
  return body.url;
}

/**
 * Sanitize a chart name for safe filesystem use:
 *   - strip / \ : * ? " < > | (Windows-illegal) and control chars
 *   - collapse whitespace runs to single underscores
 *   - cap to 80 chars
 *   - fall back to a sensible default when the result is empty
 */
function sanitizeFilename(raw: string | null | undefined): string {
  if (!raw) return 'org-chart';
  const cleaned = String(raw)
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 80)
    .trim();
  return cleaned || 'org-chart';
}

/**
 * Export the chart as a self-contained, portable JSON file.
 *
 * Avatars uploaded via `/api/images/*` are inlined as `data:` URIs so
 * the export survives a move to a different host (different backend,
 * different storage volume). External `https://...` image URLs are
 * left as-is. Failed fetches (e.g. 404 because the image was deleted
 * server-side) keep the original URL — the import side then falls back
 * to the initials avatar.
 */
export async function exportJson(
  nodes,
  departments = {},
  customFields = [],
  chartName: string | null = null,
  onProgress?: (done: number, total: number) => void,
) {
  // Deep-clone so we never mutate the live store array.
  const clones = JSON.parse(JSON.stringify(nodes)) as any[];

  // Inline backend-served images as data: URIs.
  const candidates = clones.filter(
    (n) => typeof n.imageUrl === 'string' && n.imageUrl.startsWith('/api/images/'),
  );
  if (candidates.length > 0) {
    onProgress?.(0, candidates.length);
    const inlined = await inBatches(
      candidates,
      IMAGE_BATCH_SIZE,
      (n) => inlineImageUrl(n.imageUrl),
      (done) => onProgress?.(done, candidates.length),
    );
    candidates.forEach((n, i) => {
      n.imageUrl = inlined[i];
    });
  }

  // v3 format: object with nodes, department colours and custom-field schema.
  // v2 (no customFields) and the bare-array form are still accepted on import.
  const payload = { version: 3, nodes: clones, departments, customFields };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });

  // Build filename: <sanitized-chart-name>_<YYYY-MM-DD>.json. The trailing
  // ".json" is appended in a separate step so it can never be lost in
  // template-string interpolation, and we re-check it explicitly before the
  // download trigger.
  const baseName = sanitizeFilename(chartName);
  const dateStr = new Date().toISOString().slice(0, 10);
  let filename = `${baseName}_${dateStr}.json`;
  if (!filename.toLowerCase().endsWith('.json')) filename = `${filename}.json`;

  downloadBlob(blob, filename);
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

/**
 * Normalise a node: ensure built-in fields have predictable types and the
 * country code is canonical. *Any other key on the input* is treated as a
 * custom-field value and passed through verbatim — that way custom fields
 * survive a round-trip through import/export without the IO layer needing
 * to know the active schema.
 */
function normalize(node) {
  const country = countryCode(node.country) ?? '';
  const out = {
    id: node.id != null ? String(node.id) : null,
    parentId: node.parentId == null || node.parentId === '' ? null : String(node.parentId),
    name: node.name ?? '',
    title: node.title ?? '',
    department: node.department ?? '',
    email: node.email ?? '',
    phone: node.phone ?? '',
    imageUrl: node.imageUrl ?? '',
    country,
  };
  for (const [k, v] of Object.entries(node)) {
    if (BUILTIN_FIELDS.includes(k)) continue;
    if (k.startsWith('_')) continue;          // internal marker (`_virtual`, …)
    if (v == null) continue;
    out[k] = v;
  }
  return out;
}

function flattenTree(tree) {
  const out = [];
  function walk(node, parentId) {
    const id = node.id ?? String(out.length + 1);
    out.push(normalize({ ...node, id, parentId }));
    (node.children || []).forEach((c) => walk(c, id));
  }
  walk(tree, null);
  return out;
}

export async function importJson(
  file: File,
  onProgress?: (done: number, total: number) => void,
) {
  const text = await readFileAsText(file);
  const parsed: any = JSON.parse(text);

  let result: { nodes: any[]; departments: Record<string, string>; customFields: any[] };
  // v2/v3 object format: { nodes, departments, customFields? }
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.nodes)) {
    result = {
      nodes: parsed.nodes.map(normalize).filter((n) => n.id && n.name),
      departments:
        parsed.departments && typeof parsed.departments === 'object' ? parsed.departments : {},
      customFields: Array.isArray(parsed.customFields) ? parsed.customFields : [],
    };
  } else if (Array.isArray(parsed)) {
    // Legacy: bare array of nodes
    result = {
      nodes: parsed.map(normalize).filter((n) => n.id && n.name),
      departments: {},
      customFields: [],
    };
  } else if (parsed && typeof parsed === 'object' && parsed.name) {
    // Legacy: nested tree
    result = { nodes: flattenTree(parsed), departments: {}, customFields: [] };
  } else {
    throw new Error(
      'Unerwartetes JSON-Format. Erwartet wird ein Objekt {nodes, departments, customFields}, ein flaches Array oder ein Baum mit "children".',
    );
  }

  // Re-host inlined images on the local backend so the chart's payload
  // stays small and the images render via cache-friendly /api/images URLs.
  // If the backend is unreachable (offline mode), the data URI is kept —
  // the avatar still displays in the browser.
  const candidates = result.nodes.filter(
    (n) => typeof n.imageUrl === 'string' && n.imageUrl.startsWith('data:image/'),
  );
  if (candidates.length > 0) {
    onProgress?.(0, candidates.length);
    const newUrls = await inBatches(
      candidates,
      IMAGE_BATCH_SIZE,
      async (n) => {
        try {
          return await uploadDataUri(n.imageUrl);
        } catch (err) {
          console.warn(
            `Image re-host failed for "${n.name}" — keeping data URI. ${(err as Error).message}`,
          );
          return n.imageUrl as string; // keep the data: URI as fallback
        }
      },
      (done) => onProgress?.(done, candidates.length),
    );
    candidates.forEach((n, i) => {
      n.imageUrl = newUrls[i];
    });
  }

  return result;
}

/**
 * CSV header is the union of built-in fields and the active custom-field
 * keys. Any column we don't know about is still preserved by `normalize`,
 * so importing a CSV produced by a peer with extra columns just works.
 */
export function importCsv(file: File, customFields: any[] = []): Promise<any> {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (result) => {
        try {
          const customKeys = customFields.map((f) => f.key);
          const allFields = [...BUILTIN_FIELDS, ...customKeys];
          const rows = (result.data as any[]).map((row) => {
            const obj: Record<string, any> = {};
            allFields.forEach((k) => {
              if (k in row) obj[k] = row[k];
            });
            return normalize(obj);
          });
          const valid = rows.filter((r) => r.id && r.name);
          if (valid.length === 0) {
            reject(new Error('Keine gültigen Zeilen gefunden. Pflichtspalten: id, name. Header: ' + allFields.join(', ')));
            return;
          }
          resolve({ nodes: valid, departments: {}, customFields: [] });
        } catch (err) {
          reject(err);
        }
      },
      error: (err) => reject(err),
    });
  });
}
