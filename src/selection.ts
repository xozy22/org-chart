/**
 * Multi-select state for the org chart.
 *
 * Maintains a `Set<string>` of selected node IDs and keeps the rendered
 * `.node-card` elements visually in sync via a `.is-selected` class.
 *
 * The chart's DOM is rebuilt on every expand/collapse/data change, so we
 * re-apply the class via a MutationObserver — the same pattern the
 * filter module uses for `.filter-dimmed`.
 */

export function createSelection({ chartHost, onChange }) {
  /** @type {Set<string>} */
  const selected = new Set();

  function applyVisual() {
    if (!chartHost) return;
    chartHost.querySelectorAll('.node-card').forEach((card) => {
      const id = card.getAttribute('data-id');
      card.classList.toggle('is-selected', !!id && selected.has(id));
    });
  }

  function notify() {
    applyVisual();
    onChange?.({ size: selected.size, ids: [...selected] });
  }

  function add(id) {
    if (id == null) return;
    selected.add(String(id));
    notify();
  }
  function remove(id) {
    selected.delete(String(id));
    notify();
  }
  function toggle(id) {
    if (id == null) return;
    const s = String(id);
    if (selected.has(s)) selected.delete(s);
    else selected.add(s);
    notify();
  }
  function clear() {
    if (selected.size === 0) return;
    selected.clear();
    notify();
  }
  function has(id) {
    return selected.has(String(id));
  }
  function getAll() {
    return [...selected];
  }
  function size() {
    return selected.size;
  }

  // Re-apply visuals when d3-org-chart rebuilds the chart DOM.
  if (chartHost) {
    let pending;
    const observer = new MutationObserver(() => {
      if (selected.size === 0) return;
      clearTimeout(pending);
      pending = setTimeout(applyVisual, 30);
    });
    observer.observe(chartHost, { childList: true, subtree: true });
  }

  return { add, remove, toggle, clear, has, getAll, size, applyVisual };
}
