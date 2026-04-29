import Papa from 'papaparse';
import { countryCode } from './countries.js';

const CSV_FIELDS = ['id', 'parentId', 'name', 'title', 'department', 'email', 'phone', 'imageUrl', 'country'];

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

export function exportJson(nodes, departments = {}) {
  // New format: object with both nodes and department colours.
  // The legacy plain-array format is still accepted on import.
  const payload = { version: 2, nodes, departments };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const ts = new Date().toISOString().slice(0, 10);
  downloadBlob(blob, `org-chart-${ts}.json`);
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

function normalize(node) {
  // Accept country code or full name; store the canonical ISO-2 code.
  const country = countryCode(node.country) ?? '';
  return {
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
}

function flattenTree(tree) {
  const out = [];
  function walk(node, parentId) {
    const id = node.id ?? String(out.length + 1);
    out.push(
      normalize({
        id,
        parentId,
        name: node.name,
        title: node.title,
        department: node.department,
        email: node.email,
        phone: node.phone,
        imageUrl: node.imageUrl,
        country: node.country,
      }),
    );
    (node.children || []).forEach((c) => walk(c, id));
  }
  walk(tree, null);
  return out;
}

export async function importJson(file) {
  const text = await readFileAsText(file);
  const parsed = JSON.parse(text);
  // v2 object format: { nodes, departments }
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.nodes)) {
    return {
      nodes: parsed.nodes.map(normalize).filter((n) => n.id && n.name),
      departments: parsed.departments && typeof parsed.departments === 'object' ? parsed.departments : {},
    };
  }
  // Legacy: bare array of nodes
  if (Array.isArray(parsed)) {
    return {
      nodes: parsed.map(normalize).filter((n) => n.id && n.name),
      departments: {},
    };
  }
  // Legacy: nested tree
  if (parsed && typeof parsed === 'object' && parsed.name) {
    return { nodes: flattenTree(parsed), departments: {} };
  }
  throw new Error('Unerwartetes JSON-Format. Erwartet wird ein Objekt {nodes, departments}, ein flaches Array oder ein Baum mit "children".');
}

export function importCsv(file) {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (result) => {
        try {
          const rows = result.data.map((row) => {
            const obj = {};
            CSV_FIELDS.forEach((k) => {
              obj[k] = row[k] ?? '';
            });
            return normalize(obj);
          });
          const valid = rows.filter((r) => r.id && r.name);
          if (valid.length === 0) {
            reject(new Error('Keine gültigen Zeilen gefunden. Pflichtspalten: id, name. Header: ' + CSV_FIELDS.join(', ')));
            return;
          }
          // CSV import never carries department colours.
          resolve({ nodes: valid, departments: {} });
        } catch (err) {
          reject(err);
        }
      },
      error: (err) => reject(err),
    });
  });
}
