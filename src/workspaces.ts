/**
 * Workspaces modal — manages the list of charts living on the backend.
 *
 *   ┌───────────────────────────────────────────────────────────┐
 *   │  Charts verwalten                                   [×]   │
 *   ├───────────────────────────────────────────────────────────┤
 *   │  🔍 [Suche…]            Tags: [Vertrieb][HR][Test] +      │
 *   ├───────────────────────────────────────────────────────────┤
 *   │  ★  Acme Corp.       Vertrieb,HR    vor 2 h    [⋯]       │
 *   │     EU Operations    Operations     gestern    [⋯]       │
 *   │     Sandbox          Test           vor 3 Tg.  [⋯]       │
 *   ├───────────────────────────────────────────────────────────┤
 *   │                                       [+ Neuer Chart]    │
 *   └───────────────────────────────────────────────────────────┘
 */

import * as api from './api.js';
import type { ChartIndexEntry } from './types.js';

function $(sel: string): HTMLElement | null {
  return document.querySelector(sel);
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Format an ISO timestamp as a relative human-readable string. */
function formatRelative(iso: string): string {
  const d = new Date(iso);
  const ms = Date.now() - d.getTime();
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'gerade eben';
  if (min < 60) return `vor ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `vor ${h} h`;
  const days = Math.round(h / 24);
  if (days < 7) return `vor ${days} Tg.`;
  return d.toLocaleDateString('de-DE');
}

export interface WorkspacesController {
  open(): Promise<void>;
  close(): void;
  refresh(): Promise<void>;
}

export interface WorkspacesOptions {
  store: any;
  /** Called when the user picked a chart to load (may be the active one). */
  onLoadChart: (id: string) => Promise<void> | void;
  /** Called after a destructive backend op so the host can re-render the
   *  toolbar / current-chart name etc. */
  onIndexChanged?: () => void;
  toast: (msg: string, kind?: 'info' | 'error') => void;
}

export function setupWorkspaces(opts: WorkspacesOptions): WorkspacesController {
  const modal = $('#workspaces-modal');
  const body = $('#workspaces-body');
  const searchInput = $('#workspaces-search') as HTMLInputElement | null;
  const tagFilterContainer = $('#workspaces-tag-filter');
  const newBtn = $('#workspaces-new');
  const openBtn = $('#btn-workspaces');

  if (!modal || !body) {
    console.warn('Workspaces modal markup missing');
    return {
      open: async () => {},
      close: () => {},
      refresh: async () => {},
    };
  }

  let charts: ChartIndexEntry[] = [];
  let searchQuery = '';
  let activeTags: Set<string> = new Set();

  function close(): void {
    modal!.hidden = true;
  }

  modal.addEventListener('click', (ev) => {
    const t = ev.target;
    if (t instanceof HTMLElement && t.hasAttribute('data-close')) close();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !modal!.hidden) close();
  });

  /** Loads the index from the backend and re-renders. */
  async function refresh(): Promise<void> {
    try {
      charts = await api.listCharts();
      render();
    } catch (err: any) {
      opts.toast('Charts konnten nicht geladen werden: ' + (err?.message ?? err), 'error');
    }
  }

  function allTags(): string[] {
    const set = new Set<string>();
    for (const c of charts) for (const t of c.tags) set.add(t);
    return [...set].sort((a, b) => a.localeCompare(b, 'de'));
  }

  function visibleCharts(): ChartIndexEntry[] {
    const q = searchQuery.toLowerCase().trim();
    return charts.filter((c) => {
      if (q) {
        const hay = (c.name + ' ' + c.tags.join(' ')).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (activeTags.size > 0) {
        const present = c.tags.map((t) => t.toLowerCase());
        for (const t of activeTags) {
          if (!present.includes(t.toLowerCase())) return false;
        }
      }
      return true;
    });
  }

  function render(): void {
    const tagsHtml = allTags()
      .map((t) => {
        const active = activeTags.has(t);
        return `<button type="button" class="ws-tag${active ? ' is-active' : ''}" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</button>`;
      })
      .join('');
    if (tagFilterContainer) {
      tagFilterContainer.innerHTML = tagsHtml || '<span class="ws-tag-empty">Keine Tags</span>';
    }

    const rows = visibleCharts().map((c) => {
      const isActive = c.id === opts.store.currentChartId;
      return `
        <tr class="${isActive ? 'is-current' : ''}" data-id="${escapeHtml(c.id)}">
          <td>
            <button type="button" class="ws-default-toggle ${c.default ? 'is-default' : ''}"
                    data-action="toggle-default" data-id="${escapeHtml(c.id)}"
                    title="${c.default ? 'Standard-Chart' : 'Als Standard festlegen'}">★</button>
          </td>
          <td class="ws-name">
            <button type="button" class="ws-name-link" data-action="open" data-id="${escapeHtml(c.id)}">
              ${escapeHtml(c.name)}
              ${isActive ? '<span class="ws-active-pill">aktiv</span>' : ''}
            </button>
          </td>
          <td class="ws-tags">${c.tags.map((t) => `<span class="ws-tag-chip">${escapeHtml(t)}</span>`).join('')}</td>
          <td class="ws-meta">${escapeHtml(`${c.nodeCount} Knoten`)}</td>
          <td class="ws-meta" title="${escapeHtml(new Date(c.updatedAt).toLocaleString('de-DE'))}">${escapeHtml(formatRelative(c.updatedAt))}</td>
          <td class="ws-actions">
            <button type="button" class="ws-action" data-action="rename"    data-id="${escapeHtml(c.id)}" title="Umbenennen">✎</button>
            <button type="button" class="ws-action" data-action="tags"      data-id="${escapeHtml(c.id)}" title="Tags bearbeiten">🏷</button>
            <button type="button" class="ws-action" data-action="duplicate" data-id="${escapeHtml(c.id)}" title="Duplizieren">⎘</button>
            <button type="button" class="ws-action ws-action-danger" data-action="delete" data-id="${escapeHtml(c.id)}" title="Löschen">🗑</button>
          </td>
        </tr>
      `;
    }).join('');

    body!.innerHTML = `
      <table class="ws-table">
        <thead>
          <tr>
            <th></th><th>Name</th><th>Tags</th><th>Größe</th><th>Aktualisiert</th><th></th>
          </tr>
        </thead>
        <tbody>${rows || '<tr><td colspan="6" class="ws-empty">Keine Charts vorhanden</td></tr>'}</tbody>
      </table>
    `;
  }

  /* ------------------------------------------------------------------ */
  /*  Event delegation                                                  */
  /* ------------------------------------------------------------------ */

  searchInput?.addEventListener('input', () => {
    searchQuery = searchInput.value;
    render();
  });

  tagFilterContainer?.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement | null;
    if (!t || !t.classList.contains('ws-tag')) return;
    const tag = t.getAttribute('data-tag');
    if (!tag) return;
    if (activeTags.has(tag)) activeTags.delete(tag);
    else activeTags.add(tag);
    render();
  });

  body.addEventListener('click', async (ev) => {
    const t = ev.target as HTMLElement | null;
    if (!t) return;
    const btn = t.closest('[data-action]') as HTMLElement | null;
    if (!btn) return;
    const action = btn.getAttribute('data-action');
    const id = btn.getAttribute('data-id');
    if (!id) return;
    const entry = charts.find((c) => c.id === id);
    if (!entry) return;

    try {
      switch (action) {
        case 'open':
          await opts.onLoadChart(id);
          close();
          break;
        case 'toggle-default':
          await api.patchChart(id, { default: !entry.default });
          await refresh();
          opts.onIndexChanged?.();
          break;
        case 'rename': {
          const next = window.prompt('Neuer Name', entry.name);
          if (next == null) break;
          const trimmed = next.trim();
          if (!trimmed || trimmed === entry.name) break;
          await api.patchChart(id, { name: trimmed });
          await refresh();
          opts.onIndexChanged?.();
          break;
        }
        case 'tags': {
          const next = window.prompt(
            'Tags (kommagetrennt)',
            entry.tags.join(', '),
          );
          if (next == null) break;
          const tags = next
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
          await api.patchChart(id, { tags });
          await refresh();
          break;
        }
        case 'duplicate': {
          const full = await api.getChart(id);
          const created = await api.createChart({
            name: entry.name + ' (Kopie)',
            tags: entry.tags,
            payload: full.payload,
          });
          await refresh();
          opts.toast(`„${created.name}" angelegt`);
          break;
        }
        case 'delete': {
          const ok = window.confirm(
            `„${entry.name}" wirklich löschen? Diese Aktion ist nicht rückgängig zu machen.`,
          );
          if (!ok) break;
          const result = await api.deleteChart(id);
          if (id === opts.store.currentChartId) {
            // Active chart was just deleted — load the new default if any.
            const list = await api.listCharts();
            const next = list.find((c) => c.default) ?? list[0];
            if (next) await opts.onLoadChart(next.id);
            else opts.toast('Letzter Chart gelöscht — Workspace ist leer', 'info');
          }
          await refresh();
          opts.onIndexChanged?.();
          if (result.newDefault) {
            opts.toast('Standard-Chart wurde automatisch übertragen');
          }
          break;
        }
      }
    } catch (err: any) {
      opts.toast('Aktion fehlgeschlagen: ' + (err?.message ?? err), 'error');
    }
  });

  newBtn?.addEventListener('click', async () => {
    const name = window.prompt('Name für neuen Chart');
    if (name == null) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const created = await api.createChart({ name: trimmed });
      await opts.onLoadChart(created.id);
      await refresh();
      opts.onIndexChanged?.();
      opts.toast(`„${created.name}" angelegt`);
      close();
    } catch (err: any) {
      opts.toast('Erstellen fehlgeschlagen: ' + (err?.message ?? err), 'error');
    }
  });

  openBtn?.addEventListener('click', () => {
    void open();
  });

  async function open(): Promise<void> {
    modal!.hidden = false;
    await refresh();
  }

  return { open, close, refresh };
}
