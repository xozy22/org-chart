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
import { bindNodeDrag, applyManualPositions } from './freeLayout.js';
import { COUNTRIES, countryName } from './countries.js';
import * as api from './api.js';
import { setupWorkspaces, type WorkspacesController } from './workspaces.js';
import { showConflict } from './conflict.js';
import {
  copyText,
  formatNodeAsText,
  downloadVCard,
  downloadVCardsAsZip,
} from './clipboard.js';
import type { LayoutMode, ChartPayload, OrgNode } from './types.js';

let chart = null;
let modal = null;
let filtersRef = null;
let history = null;
let selection = null;
let workspaces: WorkspacesController | null = null;

function toast(message: string, kind: 'info' | 'error' = 'info', ms = 2400) {
  const el = document.getElementById('toast') as HTMLElement;
  el.textContent = message;
  el.className = 'toast' + (kind === 'error' ? ' error' : '');
  el.hidden = false;
  clearTimeout((toast as any)._t);
  (toast as any)._t = setTimeout(() => {
    el.hidden = true;
  }, ms);
}

/**
 * Zoom the chart by a multiplicative factor (e.g. 1.25 → +25%, 0.8 → -20%).
 * Re-uses d3-org-chart's internal d3-zoom behavior, which keeps the wheel /
 * pinch interactions and the manual buttons in sync. A short transition
 * gives a smoother feel than an instant snap.
 */
function zoomBy(factor: number) {
  if (!chart) return;
  const state = chart.getChartState?.();
  const svg = state?.svg;
  const zoomBehavior = state?.zoomBehavior;
  if (!svg || !zoomBehavior) return;
  // d3-zoom respects the chart's `scaleExtent` so we don't zoom past
  // the configured limits.
  svg.transition().duration(220).call(zoomBehavior.scaleBy, factor);
}

/**
 * Snapshot which nodes are currently expanded so a re-render can restore
 * the same view.
 *
 * Subtle d3-org-chart detail (see onButtonClick in d3-org-chart.js): when
 * a parent's "+N" pill is clicked, the library walks its newly-revealed
 * CHILDREN and sets `data._expanded = true` on each of them — the
 * expanded flag lives on the visible nodes, NOT on the parent that was
 * clicked. So we capture every node whose own `_expanded` is currently
 * true and re-set the flag on the matching items in the new data array.
 */
function snapshotExpandedIds(): Set<string> {
  const ids = new Set<string>();
  try {
    const state = chart?.getChartState?.();
    const all = state?.allNodes ?? [];
    for (const node of all) {
      if (node?.data?._expanded === true && node.data?.id != null) {
        ids.add(String(node.data.id));
      }
    }
  } catch {
    /* chart not initialised yet — nothing to preserve */
  }
  return ids;
}

function rerender() {
  // Without preserving expansion, every save/edit collapses everything
  // except the root because `chart.data(...).render()` resets d3-org-chart's
  // internal hierarchy state. Two-step preservation:
  //
  //   1. Inject `_expanded: true` directly into the data nodes that were
  //      expanded — d3-org-chart respects this flag during initial render
  //      so the tree comes up already expanded (no flicker).
  //   2. As a safety net (in case data() reset wipes the flag), re-apply
  //      via setExpanded + render after one rAF tick.
  const expandedIds = snapshotExpandedIds();

  const data = withVirtualRoot(store.get()).map((n: any) => {
    if (n._virtual || expandedIds.has(String(n.id))) {
      return { ...n, _expanded: true };
    }
    return n;
  });

  chart.data(data).render();

  // Belt-and-braces: if the data-injection didn't take effect (race with
  // d3-org-chart's first-render reset), explicitly re-expand after the
  // initial render finishes.
  if (expandedIds.size > 0) {
    requestAnimationFrame(() => {
      let touched = false;
      for (const id of expandedIds) {
        try {
          chart.setExpanded(id, true);
          touched = true;
        } catch {
          /* node was removed in this edit — fine */
        }
      }
      if (touched) chart.render();
    });
  }

  // Keep filter dropdowns in sync with the latest data so new departments,
  // countries or roots appear immediately as filter options.
  filtersRef?.refreshDropdowns();
  // In free mode rebind d3-drag because d3-org-chart rebuilds the
  // `<g class="node">` elements from scratch on every render.
  if (store.layoutMode === 'free') {
    requestAnimationFrame(() => bindNodeDrag(chart, store));
  }
}

function syncLayoutToggleUI() {
  // Hidden legacy toolbar button — still used by other code paths so we keep
  // its label in sync, but it isn't rendered in the new menu-driven toolbar.
  const btn = document.getElementById('btn-layout-mode') as HTMLButtonElement | null;
  if (btn) {
    btn.textContent = store.layoutMode === 'free' ? '🔀 Frei' : '🔀 Auto';
    btn.title =
      store.layoutMode === 'free'
        ? 'Auf automatisches Layout zurückwechseln'
        : 'Auf manuelle Anordnung wechseln';
    btn.classList.toggle('btn-primary', store.layoutMode === 'free');
  }

  // Reflect the mode in the new actions menu so the user knows which
  // mode is active without opening the menu twice.
  const menuLabel = document.getElementById('menu-layout-label');
  if (menuLabel) menuLabel.textContent = store.layoutMode === 'free' ? 'Frei' : 'Auto';

  const chartHost = document.getElementById('chart');
  if (chartHost) chartHost.classList.toggle('is-free', store.layoutMode === 'free');

  // Disable expand/collapse controls in free mode — they would shuffle the
  // tree and stomp on the user's manual placement. Zoom + Fit stay live in
  // both modes; in free mode Fit becomes a "view reset" that brings every
  // card back into view without touching their placement.
  const isFree = store.layoutMode === 'free';
  ['btn-expand-all', 'btn-collapse-all'].forEach((id) => {
    const el = document.getElementById(id) as HTMLButtonElement | null;
    if (el) el.disabled = isFree;
  });
  // Mirror the disabled state onto the matching menu items.
  document
    .querySelectorAll('.menu-item[data-menu-action="expand-all"], .menu-item[data-menu-action="collapse-all"]')
    .forEach((el) => {
      if (isFree) el.setAttribute('aria-disabled', 'true');
      else el.removeAttribute('aria-disabled');
    });
}

/* -------------------------------------------------------------------- */
/*  Toolbar dropdown menus (Aktionen / Datei)                           */
/* -------------------------------------------------------------------- */

const MENU_ACTION_TO_BTN_ID: Record<string, string> = {
  'add-root':    'btn-add-root',
  'layout-mode': 'btn-layout-mode',
  'expand-all':  'btn-expand-all',
  'collapse-all': 'btn-collapse-all',
  'settings':    'btn-settings',
  'stats':       'btn-stats',
  'import-json': 'btn-import-json',
  'export-json': 'btn-export-json',
  'import-csv':  'btn-import-csv',
  'export-png':  'btn-export-png',
  'export-svg':  'btn-export-svg',
  'export-pdf':  'btn-export-pdf',
};

function closeAllMenus(): void {
  document.querySelectorAll<HTMLElement>('.menu[data-open="true"]').forEach((m) => {
    m.removeAttribute('data-open');
    const trigger = m.querySelector<HTMLElement>('.menu-trigger');
    trigger?.setAttribute('aria-expanded', 'false');
    const popup = m.querySelector<HTMLElement>('.menu-popup');
    if (popup) popup.hidden = true;
  });
}

function setupToolbarMenus(): void {
  const menus = document.querySelectorAll<HTMLElement>('.menu[data-menu]');
  menus.forEach((menu) => {
    const trigger = menu.querySelector<HTMLElement>('.menu-trigger');
    const popup = menu.querySelector<HTMLElement>('.menu-popup');

    trigger?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const wasOpen = menu.getAttribute('data-open') === 'true';
      closeAllMenus();
      if (!wasOpen) {
        // Refresh dynamic disabled-states right before showing the menu so
        // the user always sees up-to-date affordances even if a selection
        // was changed via keyboard or programmatically.
        syncSelectionMenuItems(selection?.size?.() ?? 0);
        menu.setAttribute('data-open', 'true');
        trigger.setAttribute('aria-expanded', 'true');
        if (popup) popup.hidden = false;
      }
    });

    popup?.addEventListener('click', (ev) => {
      const item = (ev.target as Element | null)?.closest('[data-menu-action]') as HTMLElement | null;
      if (!item) return;
      if (item.getAttribute('aria-disabled') === 'true') return;
      const action = item.getAttribute('data-menu-action');
      closeAllMenus();
      if (action) handleMenuAction(action);
    });
  });

  // Close on outside click + Esc.
  document.addEventListener('click', (ev) => {
    const t = ev.target as Element | null;
    if (t && t.closest('.menu')) return;
    closeAllMenus();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') closeAllMenus();
  });
}

function handleMenuAction(action: string): void {
  // Special-cased actions that don't map to a hidden legacy button.
  if (action === 'copy-selected-text' || action === 'copy-selected-vcard') {
    copySelectedNode(action === 'copy-selected-vcard' ? 'vcard' : 'text');
    return;
  }
  const btnId = MENU_ACTION_TO_BTN_ID[action];
  if (!btnId) return;
  const btn = document.getElementById(btnId) as HTMLButtonElement | null;
  if (!btn) return;
  // Bypass `disabled` checks on the hidden legacy button: the menu has its
  // own aria-disabled gate we already enforced above.
  const wasDisabled = btn.disabled;
  if (wasDisabled) btn.disabled = false;
  btn.click();
  if (wasDisabled) btn.disabled = true;
}

/**
 * Export the currently selected node(s) as text (clipboard) or vCard.
 * Single selection → single .vcf or one node's text; multi-select → ZIP
 * of .vcfs or concatenated text. Falls back to "the only node" if
 * nothing is explicitly selected.
 */
async function copySelectedNode(format: 'text' | 'vcard'): Promise<void> {
  const ids = selection?.getAll?.() ?? [];

  // Resolve the target list of nodes.
  let nodes: OrgNode[] = [];
  if (ids.length > 0) {
    nodes = ids
      .map((id) => store.byId(id) as OrgNode | undefined)
      .filter((n): n is OrgNode => !!n);
  } else {
    // No explicit selection — fall back to the only node, otherwise hint.
    const all = store.get();
    if (all.length === 1) {
      const only = store.byId(String(all[0].id)) as OrgNode | undefined;
      if (only) nodes = [only];
    }
  }

  if (nodes.length === 0) {
    toast('Bitte zuerst einen oder mehrere Knoten markieren (Strg+Klick)', 'info', 2400);
    return;
  }

  // Single node — reuse the per-node export path.
  if (nodes.length === 1) {
    await exportNode(nodes[0], format);
    return;
  }

  // Multi-select.
  if (format === 'vcard') {
    try {
      const zipBase = activeChartName ? `${activeChartName}_vcards` : 'vcards';
      await downloadVCardsAsZip(nodes, zipBase);
      toast(`${nodes.length} vCards als ZIP heruntergeladen`, 'info', 2000);
    } catch (err) {
      toast('ZIP-Download fehlgeschlagen', 'error', 2400);
      console.error('vCard ZIP download failed:', err);
    }
    return;
  }

  // Text → join with separators, then clipboard.
  const blob = nodes.map(formatNodeAsText).join('\n\n— — —\n\n');
  const ok = await copyText(blob);
  if (ok) toast(`${nodes.length} Knoten als Text kopiert`, 'info', 1800);
  else toast('Kopieren fehlgeschlagen', 'error', 2400);
}

/**
 * Export a node — text → clipboard, vCard → download. Used by both the
 * per-card popover and the toolbar's "Auswahl" menu.
 */
async function exportNode(node: OrgNode, format: 'text' | 'vcard'): Promise<void> {
  if (format === 'vcard') {
    try {
      downloadVCard(node);
      toast('vCard heruntergeladen', 'info', 1800);
    } catch (err) {
      toast('Download fehlgeschlagen', 'error', 2400);
      console.error('vCard download failed:', err);
    }
    return;
  }
  const ok = await copyText(formatNodeAsText(node));
  if (ok) toast('Als Text kopiert', 'info', 1800);
  else toast('Kopieren fehlgeschlagen', 'error', 2400);
}

function setLayoutMode(mode: LayoutMode) {
  if (store.layoutMode === mode) return;
  store.layoutMode = mode;
  store.save();
  syncLayoutToggleUI();

  rerender();

  if (mode === 'free') {
    // Free mode contract: every node is on the canvas. Expand the tree
    // *after* the data() call, otherwise d3-org-chart's render rebuilds
    // the hierarchy from `_expanded` flags and ignores our expand call.
    try {
      chart.expandAll();
    } catch {
      /* ignore */
    }
    requestAnimationFrame(() => {
      applyManualPositions(chart, store);
      bindNodeDrag(chart, store);
      chart.fit();
    });
  } else {
    requestAnimationFrame(() => chart.fit());
  }
  toast(mode === 'free' ? 'Freies Layout aktiv' : 'Automatisches Layout aktiv');
}

async function loadInitialData() {
  // Step 1: detect backend
  store.apiAvailable = await api.healthz();

  if (store.apiAvailable) {
    try {
      // Step 2: list charts
      let charts = await api.listCharts();

      if (charts.length === 0) {
        // Step 3a: empty backend → migrate localStorage to backend, or
        // create the demo chart from sample-data.json.
        const local = store.load();
        let payload: ChartPayload;
        if (local && local.length) {
          payload = {
            nodes: store.nodes,
            departments: store.departments,
            customFields: store.customFields,
          };
        } else {
          let nodes: any[] = [];
          try {
            const res = await fetch('/sample-data.json');
            if (res.ok) nodes = await res.json();
          } catch {
            /* ignore */
          }
          payload = { nodes, departments: {}, customFields: [] };
        }
        const created = await api.createChart({ name: 'Mein erster Chart', payload });
        charts = [created];
      }

      // Step 4: pick which chart to load
      const lastId = store.loadCurrentChartId();
      const target =
        (lastId && charts.find((c) => c.id === lastId)) ||
        charts.find((c) => c.default) ||
        charts[0];

      // Step 5: fetch payload + ETag
      const fetched = await api.getChart(target.id);
      store.setCurrentChart(target.id);
      store.loadFromPayload(fetched.payload, fetched.etag);
      // Per-chart user-state (positions / layout-mode) is namespaced and
      // loaded separately; this picks them up after currentChartId is set.
      store.load();
      return store.nodes;
    } catch (err: any) {
      console.warn('API mode failed, falling back to localStorage', err);
      store.apiAvailable = false;
    }
  }

  // Offline / no backend — legacy localStorage path.
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

/* -------------------------------------------------------------------- */
/*  API sync — debounced PUT triggered after every store.save()          */
/* -------------------------------------------------------------------- */

let syncTimer: any = null;
let syncInFlight = false;
let pendingDuringFlight = false;

async function flushApiSync(): Promise<void> {
  if (!store.apiAvailable || !store.currentChartId || !store.currentChartEtag) return;
  if (syncInFlight) {
    pendingDuringFlight = true;
    return;
  }
  syncInFlight = true;
  const payload: ChartPayload = {
    nodes: JSON.parse(JSON.stringify(store.nodes)),
    departments: JSON.parse(JSON.stringify(store.departments)),
    customFields: JSON.parse(JSON.stringify(store.customFields)),
  };
  try {
    const result = await api.putChart(store.currentChartId, store.currentChartEtag, payload);
    store.currentChartEtag = result.etag;
  } catch (err: any) {
    if (err?.status === 412 && err?.conflict) {
      const localStats = {
        nodes: store.nodes.length,
        departments: Object.keys(store.departments).length,
      };
      const resolution = await showConflict({
        serverEntry: err.conflict,
        localPayload: payload,
        localStats,
      });
      if (resolution.resolution === 'reload-server') {
        store.loadFromPayload(resolution.payload, resolution.etag);
        rerender();
        toast('Server-Version geladen');
      } else if (resolution.resolution === 'force-local') {
        store.currentChartEtag = resolution.etag;
        toast('Eigene Version durchgesetzt');
      }
    } else if (err?.status === 404) {
      toast('Dieser Chart existiert nicht mehr — bitte einen anderen wählen.', 'error', 6000);
      store.apiAvailable = false;
    } else {
      console.warn('API sync failed', err);
    }
  } finally {
    syncInFlight = false;
    if (pendingDuringFlight) {
      pendingDuringFlight = false;
      // A new save() came in while we were flying. Schedule the next pass.
      debouncedApiSync();
    }
  }
}

function debouncedApiSync(): void {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(flushApiSync, 500);
}

/** Switch the active chart — fetch payload, swap into store, rerender. */
async function loadChartIntoStore(id: string): Promise<void> {
  if (!store.apiAvailable) return;
  try {
    const fetched = await api.getChart(id);
    // Persist any pending sync before swapping the chart so we don't lose
    // unsaved local changes from the previous chart.
    if (syncTimer) {
      clearTimeout(syncTimer);
      await flushApiSync();
    }
    store.setCurrentChart(id);
    store.loadFromPayload(fetched.payload, fetched.etag);
    // Pick up the per-chart user-state (positions, layout mode).
    store.layoutMode = 'auto';
    store.manualPositions = {};
    store.load();
    rerender();
    history?.reset(store.snapshot());
    syncLayoutToggleUI();
    toast(`„${fetched.entry.name}" geladen`);
    updateCurrentChartLabel(fetched.entry.name);
  } catch (err: any) {
    toast('Chart konnte nicht geladen werden: ' + (err?.message ?? err), 'error');
  }
}

/** Last known display name of the active chart — also used by JSON export
 *  so the downloaded filename includes a meaningful identifier. */
let activeChartName: string | null = null;

function updateCurrentChartLabel(name: string | null): void {
  activeChartName = name;
  const btn = document.getElementById('btn-workspaces') as HTMLButtonElement | null;
  if (!btn) return;
  if (name) btn.innerHTML = `🗂 ${escapeForLabel(name)}`;
  else btn.textContent = '🗂 Charts';
}

function escapeForLabel(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function bindToolbar() {
  document.getElementById('btn-add-root').addEventListener('click', () => {
    modal.openForCreate({ parentId: null });
  });

  document.getElementById('btn-fit').addEventListener('click', () => chart.fit());
  document.getElementById('btn-zoom-in')?.addEventListener('click', () => zoomBy(1.25));
  document.getElementById('btn-zoom-out')?.addEventListener('click', () => zoomBy(1 / 1.25));
  document.getElementById('btn-expand-all').addEventListener('click', () => chart.expandAll().fit());
  document.getElementById('btn-collapse-all').addEventListener('click', () => collapseAllSubtrees(chart));
  document.getElementById('btn-layout-mode')?.addEventListener('click', () => {
    setLayoutMode(store.layoutMode === 'free' ? 'auto' : 'free');
  });

  // Undo / Redo
  const undoBtn = document.getElementById('btn-undo');
  const redoBtn = document.getElementById('btn-redo');
  undoBtn.addEventListener('click', () => doUndo());
  redoBtn.addEventListener('click', () => doRedo());

  // JSON
  const jsonInput = document.getElementById('file-input-json') as HTMLInputElement;
  document.getElementById('btn-import-json').addEventListener('click', () => jsonInput.click());
  jsonInput.addEventListener('change', async () => {
    const file = jsonInput.files?.[0];
    if (!file) return;
    try {
      const { nodes, departments, customFields } = await importJson(file, (done, total) => {
        toast(`Bilder werden hochgeladen (${done} / ${total})…`, 'info', 60000);
      });
      store.set(nodes);
      store.departments = departments || {};
      if (customFields && customFields.length) store.customFields = customFields;
      store.save();
      rerender();
      toast(`${nodes.length} Knoten importiert`);
    } catch (err: any) {
      toast('Import fehlgeschlagen: ' + (err?.message ?? err), 'error', 4000);
    } finally {
      jsonInput.value = '';
    }
  });
  document.getElementById('btn-export-json').addEventListener('click', async () => {
    try {
      await exportJson(
        store.get(),
        store.departments,
        store.customFields,
        activeChartName,
        (done, total) => {
          toast(`Bilder werden inline-kodiert (${done} / ${total})…`, 'info', 60000);
        },
      );
      toast('JSON heruntergeladen');
    } catch (err: any) {
      toast('Export fehlgeschlagen: ' + (err?.message ?? err), 'error', 4000);
    }
  });

  // CSV
  const csvInput = document.getElementById('file-input-csv') as HTMLInputElement;
  document.getElementById('btn-import-csv').addEventListener('click', () => csvInput.click());
  csvInput.addEventListener('change', async () => {
    const file = csvInput.files?.[0];
    if (!file) return;
    try {
      const { nodes } = await importCsv(file, store.customFields);
      store.set(nodes);
      rerender();
      toast(`${nodes.length} Zeilen importiert`);
    } catch (err: any) {
      toast('CSV-Import fehlgeschlagen: ' + (err?.message ?? err), 'error', 4500);
    } finally {
      csvInput.value = '';
    }
  });

  // Export images — wraps the async pipeline so we can show progress and errors.
  async function runExport(label: string, fn: (c: any) => Promise<void> | void) {
    toast(`${label} wird vorbereitet…`, 'info', 8000);
    try {
      await fn(chart);
      toast(`${label} heruntergeladen`);
    } catch (err: any) {
      console.error(err);
      toast(`${label}-Export fehlgeschlagen: ${err?.message ?? err}`, 'error', 5000);
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
    if (!(ev.target instanceof Element)) return;

    // mailto:/tel: anchor — let the browser handle navigation, but stop the
    // event from bubbling up into the card-select handler above.
    const link = ev.target.closest('a.node-card-link') as HTMLAnchorElement | null;
    if (link) {
      ev.stopPropagation();
      return; // do NOT preventDefault — we want the OS handler to fire.
    }

    const target = ev.target.closest('[data-action]');
    if (!target) return;
    ev.stopPropagation();
    const action = target.getAttribute('data-action');

    // Avatar click → open the larger-image viewer modal.
    if (action === 'view-image') {
      ev.preventDefault();
      const src = target.getAttribute('data-image-src') || (target as HTMLImageElement).src;
      const card = target.closest('.node-card[data-id]');
      const nodeId = card?.getAttribute('data-id') || null;
      const node = nodeId ? store.byId(nodeId) : null;
      const caption = node ? [node.name, node.title].filter(Boolean).join(' — ') : '';
      openImageViewer(src, caption);
      return;
    }

    // Per-field copy (email / phone / custom-email): copy the value, toast.
    if (action === 'copy-field') {
      ev.preventDefault();
      const value = target.getAttribute('data-value') || '';
      const label = target.getAttribute('data-label') || 'Wert';
      if (!value) return;
      copyText(value).then((ok) => {
        if (ok) toast(`${label} kopiert`, 'info', 1500);
        else toast('Kopieren fehlgeschlagen', 'error', 2400);
      });
      return;
    }

    // Per-card "copy node data" → opens the format-picker popover.
    if (action === 'copy-node') {
      ev.preventDefault();
      const id = target.getAttribute('data-id');
      if (!id) return;
      openCardCopyPopover(target as HTMLElement, id);
      return;
    }

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

/* -------------------------------------------------------------------- */
/*  Card-copy popover (Als Text / Als vCard)                            */
/* -------------------------------------------------------------------- */

let cardCopyTargetId: string | null = null;

function openCardCopyPopover(anchor: HTMLElement, nodeId: string): void {
  const popover = document.getElementById('card-copy-popover') as HTMLElement | null;
  if (!popover) return;
  cardCopyTargetId = nodeId;
  popover.hidden = false;

  // Position the popover just below-and-to-the-right of the trigger button,
  // clamped to the viewport so it never falls off the edge.
  const rect = anchor.getBoundingClientRect();
  const margin = 6;
  popover.style.visibility = 'hidden';
  popover.style.left = '0px';
  popover.style.top = '0px';
  // Force layout to read dimensions
  const pw = popover.offsetWidth || 160;
  const ph = popover.offsetHeight || 80;
  let left = rect.right - pw;
  let top = rect.bottom + margin;
  // Clamp horizontally
  if (left < 8) left = 8;
  if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
  // Flip above the anchor if it would overflow the viewport bottom.
  if (top + ph > window.innerHeight - 8) {
    top = rect.top - ph - margin;
  }
  popover.style.left = `${Math.round(left)}px`;
  popover.style.top = `${Math.round(top)}px`;
  popover.style.visibility = '';
}

function closeCardCopyPopover(): void {
  const popover = document.getElementById('card-copy-popover') as HTMLElement | null;
  if (!popover) return;
  popover.hidden = true;
  cardCopyTargetId = null;
}

function setupCardCopyPopover(): void {
  const popover = document.getElementById('card-copy-popover') as HTMLElement | null;
  if (!popover) return;

  popover.addEventListener('click', async (ev) => {
    const item = (ev.target as Element | null)?.closest('[data-action]') as HTMLElement | null;
    if (!item) return;
    ev.stopPropagation();
    const action = item.getAttribute('data-action');
    const id = cardCopyTargetId;
    closeCardCopyPopover();
    if (!id) return;
    const node = store.byId(id) as OrgNode | undefined;
    if (!node) return;
    if (action === 'copy-as-text') await exportNode(node, 'text');
    else if (action === 'copy-as-vcard') await exportNode(node, 'vcard');
  });

  // Close on outside-click and Esc — same pattern as the toolbar menus.
  document.addEventListener('click', (ev) => {
    if (popover.hidden) return;
    const t = ev.target as Element | null;
    if (t && (t.closest('#card-copy-popover') || t.closest('[data-action="copy-node"]'))) return;
    closeCardCopyPopover();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') closeCardCopyPopover();
  });
  // Close when the chart re-renders or scrolls.
  window.addEventListener('resize', closeCardCopyPopover);
  window.addEventListener('scroll', closeCardCopyPopover, true);
}

/* -------------------------------------------------------------------- */
/*  Image viewer modal                                                   */
/* -------------------------------------------------------------------- */

function openImageViewer(src: string, caption?: string): void {
  const modal = document.getElementById('image-viewer-modal') as HTMLElement | null;
  const img = document.getElementById('image-viewer-img') as HTMLImageElement | null;
  const cap = document.getElementById('image-viewer-caption') as HTMLElement | null;
  if (!modal || !img || !src) return;
  img.src = src;
  img.alt = caption || '';
  if (cap) {
    cap.textContent = caption || '';
    cap.hidden = !caption;
  }
  modal.hidden = false;
}

function closeImageViewer(): void {
  const modal = document.getElementById('image-viewer-modal') as HTMLElement | null;
  const img = document.getElementById('image-viewer-img') as HTMLImageElement | null;
  if (!modal) return;
  modal.hidden = true;
  // Drop the src so a future open of a different image doesn't briefly
  // flash the previous one before the new one loads.
  if (img) img.src = '';
}

function setupImageViewer(): void {
  const modal = document.getElementById('image-viewer-modal') as HTMLElement | null;
  if (!modal) return;
  // Backdrop / X / clicking the image itself all close the modal.
  modal.addEventListener('click', (ev) => {
    const t = ev.target as Element | null;
    if (t && (t.hasAttribute('data-close') || t.tagName === 'IMG')) {
      closeImageViewer();
    }
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !modal.hidden) closeImageViewer();
  });
}

function syncHistoryButtons(status: { canUndo: boolean; canRedo: boolean }) {
  const undoBtn = document.getElementById('btn-undo') as HTMLButtonElement | null;
  const redoBtn = document.getElementById('btn-redo') as HTMLButtonElement | null;
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
  const deptSel = document.getElementById('bulk-department') as HTMLSelectElement;
  const countrySel = document.getElementById('bulk-country') as HTMLSelectElement;
  // Department options pulled from the live store
  const depts = store.listDepartments();
  deptSel.innerHTML =
    '<option value="">Abteilung wählen…</option>' +
    '<option value="__clear__">— Abteilung leeren —</option>' +
    depts.map((d) => `<option value="${(d as string).replace(/"/g, '&quot;')}">${d}</option>`).join('');
  // Country options — full ISO list since you might want to assign a new one
  countrySel.innerHTML =
    '<option value="">Land wählen…</option>' +
    '<option value="__clear__">— Land leeren —</option>' +
    COUNTRIES.map((c) => `<option value="${c.code}">${c.code.toUpperCase()} — ${c.name}</option>`).join('');
}

function syncBulkBar({ size, ids }) {
  syncSelectionMenuItems(size);

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
  (document.getElementById('bulk-department') as HTMLSelectElement).value = '';
  (document.getElementById('bulk-country') as HTMLSelectElement).value = '';
}

/**
 * Grey out the "Markierte Knoten" submenu items in the Aktionen ▾ dropdown
 * when there's nothing to act on. The handleMenuAction() guard already
 * skips `aria-disabled="true"` items, so this purely controls the visual
 * affordance — users can't trigger the action by clicking a dimmed entry.
 */
function syncSelectionMenuItems(selectionSize: number): void {
  const items = document.querySelectorAll<HTMLElement>(
    '.menu-item[data-menu-action="copy-selected-text"], ' +
      '.menu-item[data-menu-action="copy-selected-vcard"]',
  );
  const disabled = selectionSize === 0;
  items.forEach((item) => {
    if (disabled) {
      item.setAttribute('aria-disabled', 'true');
      item.title = 'Bitte zuerst Knoten markieren (Strg+Klick)';
    } else {
      item.removeAttribute('aria-disabled');
      item.removeAttribute('title');
    }
  });
}

function bindBulkBar() {
  const deleteBtn = document.getElementById('bulk-delete') as HTMLButtonElement;
  const clearBtn = document.getElementById('bulk-clear') as HTMLButtonElement;
  const deptSel = document.getElementById('bulk-department') as HTMLSelectElement;
  const countrySel = document.getElementById('bulk-country') as HTMLSelectElement;

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
  // Initial paint of the "Markierte Knoten" menu items — selection starts empty.
  syncSelectionMenuItems(0);

  bindToolbar();
  setupToolbarMenus();
  setupCardCopyPopover();
  setupImageViewer();
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

  // Workspaces — only enabled when a backend is reachable.
  if (store.apiAvailable) {
    // IMPORTANT — the click handler MUST be bound before the button becomes
    // visible. Earlier we awaited `api.listCharts()` between making the
    // button visible and calling setupWorkspaces, which left a race window
    // (50–500 ms on slow networks) where a quick click would be dropped.
    workspaces = setupWorkspaces({
      store,
      onLoadChart: loadChartIntoStore,
      onIndexChanged: async () => {
        try {
          const list = await api.listCharts();
          const active = list.find((c) => c.id === store.currentChartId);
          if (active) updateCurrentChartLabel(active.name);
        } catch {
          /* ignore */
        }
      },
      toast,
    });
    // Wire the debounced API sync into store.save().
    store._apiSync = debouncedApiSync;

    // Now safe to reveal the button.
    const wsBtn = document.getElementById('btn-workspaces') as HTMLButtonElement | null;
    if (wsBtn) {
      wsBtn.hidden = false;
      // Show the active chart's name on the button (best-effort, async).
      api
        .listCharts()
        .then((list) => {
          const active = list.find((c) => c.id === store.currentChartId);
          if (active) updateCurrentChartLabel(active.name);
        })
        .catch(() => {
          /* ignore — label stays as "🗂 Charts" */
        });
    }
  } else {
    // Backend not reachable — leave the chart-management button hidden,
    // but tell the user once on startup so they know they're offline.
    toast('Offline-Modus — kein Backend erreichbar', 'info', 3000);
  }

  // Layout-mode toggle — initialises the toolbar label, the chart-host
  // class and (if applicable) the drag handler from the persisted state.
  syncLayoutToggleUI();
  if (store.layoutMode === 'free') {
    // Free mode contract: every node visible. Expand the tree on
    // first paint as well (collapse pills are disabled in free mode
    // anyway so the user can't undo it accidentally).
    try {
      chart.expandAll();
    } catch {
      /* ignore */
    }
    requestAnimationFrame(() => {
      applyManualPositions(chart, store);
      bindNodeDrag(chart, store);
      chart.fit();
    });
  }

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
