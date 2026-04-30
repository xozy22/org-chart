/**
 * Undo / redo history for the org-chart store.
 *
 * Subscribes to `store.onChange` and records a deep snapshot of the
 * persistent state (`nodes` + `departments`) on every mutation. Pressing
 * undo restores the previous snapshot via `store.restore` (which does
 * NOT re-emit, so we don't create a new history entry while travelling).
 *
 * The cursor model:
 *
 *   stack:  [s0, s1, s2, s3, s4]
 *                       ^
 *                     cursor
 *
 *   undo() decrements the cursor and returns the snapshot at that index.
 *   redo() increments the cursor.
 *   A new mutation while cursor < length-1 truncates the redo tail.
 */

const MAX_HISTORY = 50;

import type { Snapshot } from './types.js';

interface HistoryStatus {
  canUndo: boolean;
  canRedo: boolean;
  size: number;
  cursor: number;
}

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

export function createHistory(
  store: any,
  { onChange }: { onChange?: (s: HistoryStatus) => void } = {},
) {
  let stack: Snapshot[] = [];
  let cursor = -1;
  /** Set to true while we are restoring so the listener ignores the
   *  resulting save() — but we use `restore()` which doesn't emit, so
   *  this guard is belt-and-braces. */
  let suppressing = false;

  function push(snapshot) {
    if (suppressing) return;
    // Drop any redo-future when the user makes a fresh change after undo.
    if (cursor < stack.length - 1) {
      stack = stack.slice(0, cursor + 1);
    }
    stack.push(deepClone(snapshot));
    if (stack.length > MAX_HISTORY) {
      // FIFO drop — keep the cursor pointing at the same logical entry.
      stack.shift();
    } else {
      cursor++;
    }
    onChange?.(getStatus());
  }

  function getStatus() {
    return {
      canUndo: cursor > 0,
      canRedo: cursor < stack.length - 1,
      size: stack.length,
      cursor,
    };
  }

  function undo() {
    if (cursor <= 0) return null;
    cursor--;
    suppressing = true;
    try {
      store.restore(stack[cursor]);
    } finally {
      suppressing = false;
    }
    onChange?.(getStatus());
    return stack[cursor];
  }

  function redo() {
    if (cursor >= stack.length - 1) return null;
    cursor++;
    suppressing = true;
    try {
      store.restore(stack[cursor]);
    } finally {
      suppressing = false;
    }
    onChange?.(getStatus());
    return stack[cursor];
  }

  function reset(initialSnapshot) {
    stack = initialSnapshot ? [deepClone(initialSnapshot)] : [];
    cursor = stack.length ? 0 : -1;
    onChange?.(getStatus());
  }

  // Wire the store: every save() → push a snapshot.
  const unsubscribe = store.onChange((snapshot) => push(snapshot));

  return {
    undo,
    redo,
    reset,
    getStatus,
    destroy: unsubscribe,
  };
}
