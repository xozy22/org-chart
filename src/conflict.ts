/**
 * Conflict modal shown when a `PUT /api/charts/:id` is rejected with 412.
 *
 * The user picks one of three resolutions:
 *   1) Server-Version laden  (discard local changes, refetch and replace)
 *   2) Eigene Version durchdrücken (force-push by re-PUTting with the new ETag)
 *   3) Abbrechen (do nothing — user can keep editing, save again later)
 */

import * as api from './api.js';
import type { ChartIndexEntry, ChartPayload } from './types.js';

export type ConflictResolution = 'reload-server' | 'force-local' | 'cancel';

export interface ShowConflictOptions {
  serverEntry: ChartIndexEntry;
  /** Local payload as it currently sits in the store. */
  localPayload: ChartPayload;
  /** Local node count for the diff display. */
  localStats: { nodes: number; departments: number };
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.round(ms / 1000);
  if (s < 60) return `vor ${s} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `vor ${min} min`;
  return new Date(iso).toLocaleString('de-DE');
}

/**
 * Show the conflict modal and return the user's choice. Resolves with the
 * fresh server payload + ETag when they pick `reload-server`, or with the
 * pushed-through entry + new ETag when they force-push.
 */
export function showConflict(opts: ShowConflictOptions): Promise<
  | { resolution: 'reload-server'; payload: ChartPayload; etag: string }
  | { resolution: 'force-local'; etag: string }
  | { resolution: 'cancel' }
> {
  const modal = document.getElementById('conflict-modal');
  const body = document.getElementById('conflict-body');
  if (!modal || !body) {
    return Promise.resolve({ resolution: 'cancel' });
  }

  const { serverEntry, localStats } = opts;
  body.innerHTML = `
    <p class="conflict-lead">
      <strong>Anderer Nutzer hat zwischenzeitlich gespeichert.</strong><br>
      Wenn du jetzt speicherst, würden seine Änderungen überschrieben.
    </p>
    <table class="conflict-diff">
      <thead><tr><th></th><th>Server</th><th>Du</th></tr></thead>
      <tbody>
        <tr><th>Knoten</th><td>${serverEntry.nodeCount}</td><td>${localStats.nodes}</td></tr>
        <tr><th>Abteilungen</th><td>${serverEntry.departmentCount}</td><td>${localStats.departments}</td></tr>
        <tr><th>Aktualisiert</th><td>${escapeHtml(formatRelative(serverEntry.updatedAt))}</td><td>jetzt</td></tr>
      </tbody>
    </table>
    <div class="conflict-options">
      <button type="button" class="btn" data-conflict="reload-server">Server-Version laden</button>
      <button type="button" class="btn btn-danger" data-conflict="force-local">Meine Version durchdrücken</button>
      <button type="button" class="btn btn-ghost" data-conflict="cancel">Abbrechen</button>
    </div>
  `;
  modal.hidden = false;

  return new Promise((resolve) => {
    function done(value: any): void {
      modal!.hidden = true;
      body!.innerHTML = '';
      modal!.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
      resolve(value);
    }

    async function onClick(ev: Event): Promise<void> {
      const t = ev.target as HTMLElement | null;
      if (!t) return;
      if (t.hasAttribute('data-close')) {
        done({ resolution: 'cancel' });
        return;
      }
      const action = t.getAttribute('data-conflict');
      if (!action) return;

      try {
        if (action === 'reload-server') {
          const fresh = await api.getChart(serverEntry.id);
          done({
            resolution: 'reload-server',
            payload: fresh.payload,
            etag: fresh.etag,
          });
        } else if (action === 'force-local') {
          // Refetch ETag, then re-PUT with the freshly known one.
          const result = await api.putChart(
            serverEntry.id,
            serverEntry.etag,
            opts.localPayload,
          );
          done({ resolution: 'force-local', etag: result.etag });
        } else {
          done({ resolution: 'cancel' });
        }
      } catch (err: any) {
        // Bubble up so the toast can warn — return cancel so the caller
        // doesn't think the conflict was resolved.
        console.error('Conflict resolution failed', err);
        done({ resolution: 'cancel' });
      }
    }

    function onKey(ev: KeyboardEvent): void {
      if (ev.key === 'Escape') done({ resolution: 'cancel' });
    }

    modal.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
  });
}
