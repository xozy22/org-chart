import 'flag-icons/css/flag-icons.min.css';
import { store } from './store.js';
import { createChart, withVirtualRoot, collapseAllSubtrees } from './chart.js';
import { setupModal } from './crud.js';
import { exportJson, importJson, importCsv } from './io.js';
import { setupFilters } from './filters.js';
import { exportPng, exportSvg, exportPdf } from './exporter.js';
import { createHistory } from './history.js';

let chart = null;
let modal = null;
let filtersRef = null;
let history = null;

function toast(message, kind = 'info', ms = 2400) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = 'toast' + (kind === 'error' ? ' error' : '');
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.hidden = true;
  }, ms);
}

function rerender() {
  chart.data(withVirtualRoot(store.get())).render();
  // Keep filter dropdowns in sync with the latest data so new departments,
  // countries or roots appear immediately as filter options.
  filtersRef?.refreshDropdowns();
}

async function loadInitialData() {
  const cached = store.load();
  if (cached && cached.length) return cached;

  try {
    const res = await fetch('/sample-data.json');
    if (res.ok) {
      const data = await res.json();
      store.set(data);
      return data;
    }
  } catch (err) {
    console.warn('Konnte sample-data.json nicht laden', err);
  }

  const fallback = [
    { id: '1', parentId: null, name: 'Anna Müller', title: 'CEO', department: 'Vorstand', email: 'anna@beispiel.de', imageUrl: '' },
  ];
  store.set(fallback);
  return fallback;
}

function bindToolbar() {
  document.getElementById('btn-add-root').addEventListener('click', () => {
    modal.openForCreate({ parentId: null });
  });

  document.getElementById('btn-fit').addEventListener('click', () => chart.fit());
  document.getElementById('btn-expand-all').addEventListener('click', () => chart.expandAll().fit());
  document.getElementById('btn-collapse-all').addEventListener('click', () => collapseAllSubtrees(chart));

  // Undo / Redo
  const undoBtn = document.getElementById('btn-undo');
  const redoBtn = document.getElementById('btn-redo');
  undoBtn.addEventListener('click', () => doUndo());
  redoBtn.addEventListener('click', () => doRedo());

  // JSON
  const jsonInput = document.getElementById('file-input-json');
  document.getElementById('btn-import-json').addEventListener('click', () => jsonInput.click());
  jsonInput.addEventListener('change', async () => {
    const file = jsonInput.files?.[0];
    if (!file) return;
    try {
      const { nodes, departments } = await importJson(file);
      store.set(nodes);
      store.departments = departments || {};
      store.save();
      rerender();
      toast(`${nodes.length} Knoten importiert`);
    } catch (err) {
      toast('Import fehlgeschlagen: ' + err.message, 'error', 4000);
    } finally {
      jsonInput.value = '';
    }
  });
  document.getElementById('btn-export-json').addEventListener('click', () => {
    exportJson(store.get(), store.departments);
    toast('JSON heruntergeladen');
  });

  // CSV
  const csvInput = document.getElementById('file-input-csv');
  document.getElementById('btn-import-csv').addEventListener('click', () => csvInput.click());
  csvInput.addEventListener('change', async () => {
    const file = csvInput.files?.[0];
    if (!file) return;
    try {
      const { nodes } = await importCsv(file);
      store.set(nodes);
      rerender();
      toast(`${nodes.length} Zeilen importiert`);
    } catch (err) {
      toast('CSV-Import fehlgeschlagen: ' + err.message, 'error', 4500);
    } finally {
      csvInput.value = '';
    }
  });

  // Export images — wraps the async pipeline so we can show progress and errors.
  async function runExport(label, fn) {
    toast(`${label} wird vorbereitet…`, 'info', 8000);
    try {
      await fn(chart);
      toast(`${label} heruntergeladen`);
    } catch (err) {
      console.error(err);
      toast(`${label}-Export fehlgeschlagen: ${err.message}`, 'error', 5000);
    }
  }
  document.getElementById('btn-export-png').addEventListener('click', () => runExport('PNG', exportPng));
  document.getElementById('btn-export-svg').addEventListener('click', () => runExport('SVG', exportSvg));
  document.getElementById('btn-export-pdf').addEventListener('click', () => runExport('PDF', exportPdf));
}

function bindNodeActionDelegation() {
  const container = document.getElementById('chart');
  container.addEventListener('click', (ev) => {
    const target = ev.target instanceof Element ? ev.target.closest('[data-action]') : null;
    if (!target) return;
    ev.stopPropagation();
    const action = target.getAttribute('data-action');
    const id = target.getAttribute('data-id');
    if (!id) return;

    if (action === 'add') {
      modal.openForCreate({ parentId: id });
    } else if (action === 'edit') {
      modal.openForEdit(id);
    } else if (action === 'delete') {
      const node = store.byId(id);
      if (!node) return;
      const ok = window.confirm(
        `"${node.name}" löschen? Untergeordnete Knoten werden eine Ebene nach oben verschoben.`,
      );
      if (!ok) return;
      store.remove(id, { reparentChildren: true });
      rerender();
    }
  });
}

function syncHistoryButtons(status) {
  const undoBtn = document.getElementById('btn-undo');
  const redoBtn = document.getElementById('btn-redo');
  if (undoBtn) undoBtn.disabled = !status.canUndo;
  if (redoBtn) redoBtn.disabled = !status.canRedo;
}

function doUndo() {
  const snap = history.undo();
  if (!snap) {
    toast('Keine weiteren Schritte zum Rückgängig-Machen', 'info', 1800);
    return;
  }
  rerender();
  toast('Rückgängig gemacht', 'info', 1500);
}

function doRedo() {
  const snap = history.redo();
  if (!snap) {
    toast('Nichts zum Wiederholen', 'info', 1800);
    return;
  }
  rerender();
  toast('Wiederhergestellt', 'info', 1500);
}

function bindKeyboardShortcuts() {
  document.addEventListener('keydown', (ev) => {
    // Ignore when the user is typing in a form field
    const t = ev.target;
    if (t instanceof HTMLElement) {
      const tag = t.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable) {
        return;
      }
    }
    const ctrl = ev.ctrlKey || ev.metaKey;
    if (!ctrl) return;
    const key = ev.key.toLowerCase();
    if (key === 'z' && !ev.shiftKey) {
      ev.preventDefault();
      doUndo();
    } else if ((key === 'z' && ev.shiftKey) || key === 'y') {
      ev.preventDefault();
      doRedo();
    }
  });
}

async function bootstrap() {
  const initialData = await loadInitialData();

  chart = createChart(document.getElementById('chart'), initialData, {
    onNodeClick: (id) => {
      // single click: do nothing — actions are exposed via hover buttons
    },
  });

  modal = setupModal({
    store,
    onChange: () => rerender(),
  });

  // History — must be created AFTER the initial data is loaded so the
  // first snapshot reflects the initial state. Subsequent store mutations
  // automatically push new entries via the onChange subscription.
  history = createHistory(store, { onChange: syncHistoryButtons });
  history.reset(store.snapshot());
  syncHistoryButtons(history.getStatus());

  bindToolbar();
  bindNodeActionDelegation();
  bindKeyboardShortcuts();

  // Filter bar — keeps its dropdowns in sync with the live store after every
  // data mutation so freshly added departments / countries / roots show up.
  const filters = setupFilters({ chart, store });
  filtersRef = filters;

  window.addEventListener('resize', () => chart.fit());
}

bootstrap().catch((err) => {
  console.error(err);
  toast('Fehler beim Start: ' + err.message, 'error', 6000);
});
