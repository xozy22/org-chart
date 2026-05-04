/**
 * Live auto-import: watches the chart directory for files dropped in by
 * hand (e.g. `cp acme.json data/charts/`) and feeds them through
 * `reconcileFromDisk()` so they show up in the workspace UI without a
 * container restart.
 *
 * Strategy:
 *   - On startup the server already runs one synchronous reconcile pass.
 *     This watcher only handles changes that happen *afterwards*.
 *   - `add` (new file) and `unlink` (deletion) events trigger a debounced
 *     reconcile. Multiple events within ~700 ms collapse into a single
 *     pass — important when a user drops 10 files at once with `cp`.
 *   - We don't react to `change` events: the running backend overwrites
 *     payload files itself on every PUT, and reacting to those would
 *     create a feedback loop. External edits to active charts are
 *     intentionally out of scope.
 *   - Self-writes via the REST API are safe: by the time chokidar fires
 *     `add` for a freshly created chart the index already contains it,
 *     so `reconcileFromDisk()` no-ops on it.
 */

import chokidar, { type FSWatcher } from 'chokidar';

import { getChartDir, reconcileFromDisk } from './storage.js';

const DEBOUNCE_MS = 700;

let watcher: FSWatcher | null = null;
let debounceTimer: NodeJS.Timeout | null = null;
let inFlight = false;
let pendingTrailing = false;

async function runReconcile(): Promise<void> {
  if (inFlight) {
    // Another reconcile is already running — queue exactly one trailing
    // pass so the very last filesystem event still gets observed.
    pendingTrailing = true;
    return;
  }
  inFlight = true;
  try {
    const result = await reconcileFromDisk();
    if (result.imported.length || result.renamed.length || result.skipped.length) {
      console.log(
        `[auto-import] live reconcile: imported=${result.imported.length} renamed=${result.renamed.length} skipped=${result.skipped.length}`,
      );
      for (const it of result.imported) {
        console.log(`[auto-import]   + ${it.name}  (${it.from} → ${it.id})`);
      }
      for (const sk of result.skipped) {
        console.warn(`[auto-import]   ! skipped ${sk.file}: ${sk.reason}`);
      }
    }
  } catch (err) {
    console.error('[auto-import] reconcile failed:', err);
  } finally {
    inFlight = false;
    if (pendingTrailing) {
      pendingTrailing = false;
      void runReconcile();
    }
  }
}

function scheduleReconcile(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void runReconcile();
  }, DEBOUNCE_MS);
}

/** Start watching the chart directory. Idempotent — calling twice is a no-op. */
export function startAutoImportWatcher(): void {
  if (watcher) return;
  const dir = getChartDir();

  watcher = chokidar.watch(dir, {
    persistent: true,
    ignoreInitial: true, // initial scan is handled by the boot reconcile
    depth: 0, // only direct children of CHART_DIR
    ignored: /(^|[\\/])\.|\.tmp-/, // dotfiles + half-written rename targets
    awaitWriteFinish: {
      stabilityThreshold: 400,
      pollInterval: 100,
    },
  });

  watcher.on('add', (filePath) => {
    if (!filePath.toLowerCase().endsWith('.json')) return;
    scheduleReconcile();
  });
  watcher.on('unlink', (filePath) => {
    if (!filePath.toLowerCase().endsWith('.json')) return;
    // Deletions don't trigger reconcile (we keep stale index entries
    // around so a transient mount-glitch doesn't lose data), but log it.
    console.log(`[auto-import] file disappeared from disk: ${filePath}`);
  });
  watcher.on('error', (err) => {
    console.warn('[auto-import] watcher error:', err);
  });

  console.log(`[auto-import] watching ${dir} for new JSON files`);
}

/** Stop the watcher (used by tests). */
export async function stopAutoImportWatcher(): Promise<void> {
  if (!watcher) return;
  await watcher.close();
  watcher = null;
}
