import 'flag-icons/css/flag-icons.min.css';
import { store } from './store.js';
import { createChart, withVirtualRoot, collapseAllSubtrees } from './chart.js';
import { setupModal } from './crud.js';
import { exportJson, importJson, importCsv } from './io.js';
import { setupFilters } from './filters.js';
import { exportPng, exportSvg, exportPdf } from './exporter.js';
import { createHistory } from './history.js';
import { createSelection } from './selection.js';
import { createMinimap } from './minimap.js';
import { setupCustomFieldsUI } from './customFields.js';
import { computeStats } from './stats.js';
import { COUNTRIES, countryName } from './countries.js';

let chart = null;
let modal = null;
let filtersRef = null;
let history = null;
let selection = null;

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
      const { nodes, departments, customFields } = await importJson(file);
      store.set(nodes);
      store.departments = departments || {};
      if (customFields && customFields.length) store.customFields = customFields;
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
    exportJson(store.get(), store.departments, store.customFields);
    toast('JSON heruntergeladen');
  });

  // CSV
  const csvInput = document.getElementById('file-input-csv');
  document.getElementById('btn-import-csv').addEventListener('click', () => csvInput.click());
  csvInput.addEventListener('change', async () => {
    const file = csvInput.files?.[0];
    if (!file) return;
    try {
      const { nodes } = await importCsv(file, store.customFields);
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

  // Ctrl/Cmd-click on any card body toggles its selection. Plain clicks
  // (without modifier) clear the selection — same intuition as a file
  // manager. Action-button clicks (`[data-action]`) bypass this entirely.
  container.addEventListener('click', (ev) => {
    if (!(ev.target instanceof Element)) return;
    if (ev.target.closest('[data-action]')) return;
    const card = ev.target.closest('.node-card[data-id]');
    if (!card) return;
    const id = card.getAttribute('data-id');
    if (ev.ctrlKey || ev.metaKey) {
      ev.preventDefault();
      selection.toggle(id);
      return;
    }
    // Plain click on a card: clear selection (if any), do nothing else.
    if (selection.size() > 0) selection.clear();
  });

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

/* -------------------------------------------------------------------- */
/*  Bulk action bar — appears when ≥ 1 card is multi-selected           */
/* -------------------------------------------------------------------- */
function refreshBulkDropdowns() {
  const deptSel = document.getElementById('bulk-department');
  const countrySel = document.getElementById('bulk-country');
  // Department options pulled from the live store
  const depts = store.listDepartments();
  deptSel.innerHTML =
    '<option value="">Abteilung wählen…</option>' +
    '<option value="__clear__">— Abteilung leeren —</option>' +
    depts.map((d) => `<option value="${d.replace(/"/g, '&quot;')}">${d}</option>`).join('');
  // Country options — full ISO list since you might want to assign a new one
  countrySel.innerHTML =
    '<option value="">Land wählen…</option>' +
    '<option value="__clear__">— Land leeren —</option>' +
    COUNTRIES.map((c) => `<option value="${c.code}">${c.code.toUpperCase()} — ${c.name}</option>`).join('');
}

function syncBulkBar({ size, ids }) {
  const bar = document.getElementById('bulk-bar');
  const count = document.getElementById('bulk-count');
  if (size === 0) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  count.textContent = `${size} ausgewählt`;
  refreshBulkDropdowns();
  // Reset the dropdowns to the placeholder each time selection changes
  document.getElementById('bulk-department').value = '';
  document.getElementById('bulk-country').value = '';
}

function bindBulkBar() {
  const deleteBtn = document.getElementById('bulk-delete');
  const clearBtn = document.getElementById('bulk-clear');
  const deptSel = document.getElementById('bulk-department');
  const countrySel = document.getElementById('bulk-country');

  deleteBtn.addEventListener('click', () => {
    const ids = selection.getAll();
    if (!ids.length) return;
    const ok = window.confirm(
      `${ids.length} Knoten löschen? Untergeordnete Knoten werden eine Ebene nach oben verschoben.`,
    );
    if (!ok) return;
    ids.forEach((id) => store.remove(id, { reparentChildren: true }));
    selection.clear();
    rerender();
    toast(`${ids.length} Knoten gelöscht`);
  });

  clearBtn.addEventListener('click', () => selection.clear());

  deptSel.addEventListener('change', () => {
    const value = deptSel.value;
    if (!value) return;
    const ids = selection.getAll();
    const newDept = value === '__clear__' ? '' : value;
    ids.forEach((id) => store.update(id, { department: newDept }));
    rerender();
    toast(`${ids.length} Knoten zu „${newDept || '(keine Abteilung)'}" zugewiesen`);
    deptSel.value = '';
  });

  countrySel.addEventListener('change', () => {
    const value = countrySel.value;
    if (!value) return;
    const ids = selection.getAll();
    const newCountry = value === '__clear__' ? '' : value;
    ids.forEach((id) => store.update(id, { country: newCountry }));
    rerender();
    const label = newCountry ? countryName(newCountry) : '(kein Land)';
    toast(`${ids.length} Knoten auf „${label}" gesetzt`);
    countrySel.value = '';
  });
}

/* -------------------------------------------------------------------- */
/*  Stats sidebar                                                        */
/* -------------------------------------------------------------------- */

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderBars(items, maxItems = 5) {
  if (items.length === 0) return '<p class="stats-empty">Noch keine Daten.</p>';
  const max = Math.max(1, ...items.map((i) => i.count));
  const top = items.slice(0, maxItems);
  return top
    .map((it) => {
      const w = Math.round((it.count / max) * 100);
      const flag = it.flag ? `<span class="stats-flag fi fi-${escapeHtml(it.flag)}"></span>` : '';
      return `
        <div>
          <div class="stats-bar">
            <span class="stats-bar-label">${flag}<span class="stats-bar-name">${escapeHtml(it.label)}</span></span>
            <span class="stats-bar-count">${it.count}</span>
          </div>
          <div class="stats-bar-track"><div class="stats-bar-fill" style="width:${w}%"></div></div>
        </div>
      `;
    })
    .join('');
}

function renderStats() {
  const sidebar = document.getElementById('stats-sidebar');
  if (!sidebar || sidebar.hidden) return;
  const body = document.getElementById('stats-body');
  if (!body) return;

  const s = computeStats(store.get());

  const kpisHtml = `
    <section class="stats-section">
      <div class="stats-kpis">
        <div class="stats-kpi"><div class="stats-kpi-value">${s.total}</div><div class="stats-kpi-label">Knoten gesamt</div></div>
        <div class="stats-kpi"><div class="stats-kpi-value">${s.roots.length}</div><div class="stats-kpi-label">Wurzelknoten</div></div>
        <div class="stats-kpi"><div class="stats-kpi-value">${s.departments.length}</div><div class="stats-kpi-label">Abteilungen</div></div>
        <div class="stats-kpi"><div class="stats-kpi-value">${s.countries.length}</div><div class="stats-kpi-label">Länder</div></div>
        <div class="stats-kpi"><div class="stats-kpi-value">${s.maxDepth}</div><div class="stats-kpi-label">Max. Tiefe</div></div>
        <div class="stats-kpi"><div class="stats-kpi-value">${s.avgDepth.toFixed(1)}</div><div class="stats-kpi-label">Ø Tiefe</div></div>
      </div>
    </section>
  `;

  const completenessHtml = s.total === 0 ? '' : `
    <section class="stats-section">
      <h3>Vollständigkeit</h3>
      ${renderBars([
        { label: 'mit E-Mail', count: s.withEmail },
        { label: 'mit Telefon', count: s.withPhone },
        { label: 'mit Land', count: s.withCountry },
      ], 3)}
    </section>
  `;

  const rootsHtml = s.roots.length === 0 ? '' : `
    <section class="stats-section">
      <h3>Wurzelknoten</h3>
      ${renderBars(s.roots.map((r) => ({ label: `${r.name} · Tiefe ${r.maxDepth}`, count: r.count })), 8)}
    </section>
  `;

  const deptsHtml = s.departments.length === 0 ? '' : `
    <section class="stats-section">
      <h3>Top-Abteilungen</h3>
      ${renderBars(s.departments.map((d) => ({ label: d.name, count: d.count })), 6)}
    </section>
  `;

  const countriesHtml = s.countries.length === 0 ? '' : `
    <section class="stats-section">
      <h3>Top-Länder</h3>
      ${renderBars(
        s.countries.map((c) => ({
          label: `${c.code.toUpperCase()} — ${countryName(c.code) || c.code}`,
          count: c.count,
          flag: c.code,
        })),
        6,
      )}
    </section>
  `;

  body.innerHTML = kpisHtml + completenessHtml + rootsHtml + deptsHtml + countriesHtml;
}

function setupStatsSidebar() {
  const sidebar = document.getElementById('stats-sidebar');
  const openBtn = document.getElementById('btn-stats');
  const closeBtn = document.getElementById('stats-close');
  if (!sidebar || !openBtn || !closeBtn) return;

  openBtn.addEventListener('click', () => {
    sidebar.hidden = false;
    renderStats();
  });
  closeBtn.addEventListener('click', () => {
    sidebar.hidden = true;
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !sidebar.hidden) sidebar.hidden = true;
  });

  // Re-render whenever the store changes — uses the existing onChange API
  // we wired up for history. Idempotent if the sidebar is hidden.
  store.onChange(() => {
    if (!sidebar.hidden) renderStats();
  });
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
  // Esc clears the selection (works regardless of focus target — since
  // typing in form fields is already filtered out above we never reach
  // here for input contexts; this listener is a no-op outside of forms).
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    if (selection && selection.size() > 0) {
      selection.clear();
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

  // Multi-select state — Ctrl/Cmd-click toggles cards, Esc clears.
  selection = createSelection({
    chartHost: document.getElementById('chart'),
    onChange: syncBulkBar,
  });

  bindToolbar();
  bindNodeActionDelegation();
  bindKeyboardShortcuts();
  bindBulkBar();

  // Minimap — bottom-right overview, click to recentre on the closest node.
  const minimapHost = document.getElementById('minimap');
  if (minimapHost) {
    createMinimap({ chart, host: minimapHost });
    document.getElementById('minimap-toggle').addEventListener('click', () => {
      const collapsed = minimapHost.classList.toggle('is-collapsed');
      const btn = document.getElementById('minimap-toggle');
      btn.textContent = collapsed ? '+' : '−';
    });
  }

  // Custom-fields settings — opens via the toolbar's ⚙ button.
  setupCustomFieldsUI({
    store,
    onChange: () => rerender(),
  });

  // Stats sidebar — opens via the toolbar's 📊 button.
  setupStatsSidebar();

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
