import Papa from 'papaparse';
import { countryCode } from './countries.js';

const BUILTIN_FIELDS = ['id', 'parentId', 'name', 'title', 'department', 'email', 'phone', 'imageUrl', 'country'];

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

export function exportJson(nodes, departments = {}, customFields = []) {
  // v3 format: object with nodes, department colours and custom-field schema.
  // v2 (no customFields) and the bare-array form are still accepted on import.
  const payload = { version: 3, nodes, departments, customFields };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const ts = new Date().toISOString().slice(0, 10);
  downloadBlob(blob, `org-chart-${ts}.json`);
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

export async function importJson(file: File) {
  const text = await readFileAsText(file);
  const parsed: any = JSON.parse(text);
  // v2/v3 object format: { nodes, departments, customFields? }
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.nodes)) {
    return {
      nodes: parsed.nodes.map(normalize).filter((n) => n.id && n.name),
      departments:
        parsed.departments && typeof parsed.departments === 'object' ? parsed.departments : {},
      customFields: Array.isArray(parsed.customFields) ? parsed.customFields : [],
    };
  }
  // Legacy: bare array of nodes
  if (Array.isArray(parsed)) {
    return {
      nodes: parsed.map(normalize).filter((n) => n.id && n.name),
      departments: {},
      customFields: [],
    };
  }
  // Legacy: nested tree
  if (parsed && typeof parsed === 'object' && parsed.name) {
    return { nodes: flattenTree(parsed), departments: {}, customFields: [] };
  }
  throw new Error('Unerwartetes JSON-Format. Erwartet wird ein Objekt {nodes, departments, customFields}, ein flaches Array oder ein Baum mit "children".');
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
