/**
 * Free-layout mode: lets the user place each card manually on a 20-px grid
 * via drag & drop. d3-org-chart still renders the SVG (cards, links,
 * pills) — we only override the geometric positioning post-render and add
 * a custom drag handler.
 *
 * Architecture:
 *   - Persistent state lives in `store.layoutMode` and
 *     `store.manualPositions[id] = { x, y }`.
 *   - On every render we walk the live hierarchy and stamp the saved
 *     positions onto each `g.node` via a `transform` attribute, then
 *     re-draw all link paths so they connect the moved cards.
 *   - A `d3.drag` handler attached to each `g.node` updates the
 *     in-memory position during the drag (no re-render → smooth) and
 *     persists the snapped final position on `dragend`.
 */

// We pull `drag` and `select` from the umbrella `d3` package, which is
// already a direct dependency. Both are tiny re-exports of d3-drag and
// d3-selection; pulling them here keeps the module self-contained.
import { drag, select } from 'd3';
import type { OrgNode, Position } from './types.js';

export const GRID = 20;

export const snap = (v: number): number => Math.round(v / GRID) * GRID;

/** Half the card width — needed because d3-org-chart positions nodes by
 *  their centre point (the card's `transform` is `translate(x - w/2, y)`). */
function cardOffset(node: any): { dx: number; dy: number } {
  return {
    dx: (node.width ?? 240) / 2,
    dy: 0,
  };
}

/** Per-chart guard so we install the transform-watcher only once. */
const watchedHosts = new WeakSet<Element>();

/**
 * Watch every `g.node` for transform-attribute changes and immediately
 * rewrite them when the user is in free mode. d3-org-chart drives the
 * transform via a 750-ms d3-transition that overwrites whatever we put
 * there during `nodeUpdate` or in a post-render rAF — observing the
 * attribute is the only reliable way to keep our manual positions
 * sticking.
 */
function installTransformWatcher(chart: any, store: any): void {
  const state = chart.getChartState?.();
  const svg: SVGSVGElement | undefined = state?.svg?.node?.();
  if (!svg) return;
  if (watchedHosts.has(svg)) return;
  watchedHosts.add(svg);

  // Re-entrancy guard: when the observer rewrites a transform, that write
  // synchronously fires another mutation record. We swallow exactly one
  // record per element to break the loop.
  const justWrote = new WeakSet<Element>();

  const observer = new MutationObserver((records) => {
    if (store.layoutMode !== 'free') return;
    let changed = false;
    for (const r of records) {
      if (r.type !== 'attributes' || r.attributeName !== 'transform') continue;
      const g = r.target as SVGGElement;
      if (!g.classList.contains('node')) continue;
      if (justWrote.has(g)) {
        justWrote.delete(g);
        continue;
      }
      const d: any = (g as any).__data__;
      if (!d || d.data?._virtual) continue;
      const pos = store.manualPositions[String(d.data.id)];
      if (!pos) continue;
      const w = d.width ?? 240;
      const desired = `translate(${pos.x - w / 2},${pos.y})`;
      const current = g.getAttribute('transform');
      if (current === desired) continue;
      justWrote.add(g);
      g.setAttribute('transform', desired);
      d.x = pos.x;
      d.y = pos.y;
      changed = true;
    }
    if (changed) redrawAllLinks(chart);
  });

  observer.observe(svg, {
    attributes: true,
    attributeFilter: ['transform'],
    subtree: true,
  });
}

/**
 * Walk every visible node and stamp its saved manual position onto the
 * underlying d3-hierarchy node + the rendered `<g class="node">`. Nodes
 * that don't yet have a saved position keep the auto-layout result *and*
 * get that result persisted as their seed position — this is what makes
 * the very first switch from auto → free feel "in place".
 */
export function applyManualPositions(chart: any, store: any): void {
  if (store.layoutMode !== 'free') return;
  // Make sure the transform watcher is in place — guarded so it's a no-op
  // if it was already installed for this chart.
  installTransformWatcher(chart, store);
  const state = chart.getChartState?.();
  const root = state?.root;
  if (!root || typeof root.descendants !== 'function') return;

  const positions = store.manualPositions as Record<string, Position>;
  let dirty = false;
  for (const node of root.descendants()) {
    if (node.data?._virtual) continue;
    const id = String(node.data.id);
    let pos = positions[id];
    if (!pos) {
      // First sighting in free mode — seed from the auto-layout result so
      // cards don't all stack at (0,0).
      pos = { x: snap(node.x), y: snap(node.y) };
      positions[id] = pos;
      dirty = true;
    }
    node.x = pos.x;
    node.y = pos.y;
  }
  if (dirty) {
    // Persist the seeded positions, but don't trigger the change listeners
    // (we'd loop with the history module). save() emits — so use the
    // localStorage-only path manually.
    try {
      localStorage.setItem('orgchart.positions.v1', JSON.stringify(positions));
    } catch {
      /* ignore */
    }
  }

  // Re-stamp the DOM (d3-org-chart's `nodeUpdateTransform` ran *before*
  // this hook fired, so the transforms still point at the auto positions).
  const svg: SVGSVGElement | undefined = state?.svg?.node?.();
  if (!svg) return;
  const groups = svg.querySelectorAll<SVGGElement>('g.node');
  groups.forEach((g) => {
    // d3-org-chart attaches the hierarchy node onto the DOM via __data__.
    const d: any = (g as any).__data__;
    if (!d || d.data?._virtual) return;
    const off = cardOffset(d);
    g.setAttribute('transform', `translate(${d.x - off.dx},${d.y - off.dy})`);
  });

  redrawAllLinks(chart);
}

/**
 * Recompute every link path so it connects the manually-positioned
 * source/target. d3-org-chart's `linkUpdate` callback runs once per render
 * — by which time we've already overridden the node positions — so the
 * built-in `diagonal()` would produce a path against the *new* positions
 * if we just left it alone. The catch: it ran *before* our position
 * override. So we redo the maths here, in identical compact-style.
 */
export function redrawAllLinks(chart: any): void {
  const state = chart.getChartState?.();
  const svg: SVGSVGElement | undefined = state?.svg?.node?.();
  if (!svg) return;
  const links = svg.querySelectorAll<SVGPathElement>('path.link');
  links.forEach((p) => {
    const d: any = (p as any).__data__;
    if (!d || !d.parent) return;
    if (d.parent.data?._virtual) return;
    const path = orthogonalPath(d.parent, d);
    if (path) p.setAttribute('d', path);
  });
}

/** Orthogonal connector identical to d3-org-chart's vertical compact path:
 *  parent-bottom → halfway → child-top. Independent of the library's
 *  `diagonal()` so we can reuse it during drag. */
function orthogonalPath(parent: any, child: any): string | null {
  if (!parent || !child) return null;
  const ph = parent.height ?? 150;
  // d3-org-chart positions the card by its centre on the x-axis, so the
  // vertical connector emerges from that centre.
  const sx = parent.x;
  const sy = parent.y + ph;
  const tx = child.x;
  const ty = child.y;
  const my = (sy + ty) / 2;
  return `M ${sx},${sy} C ${sx},${my} ${tx},${my} ${tx},${ty}`;
}

/**
 * Attach d3-drag to every `g.node` in the chart. The handler is a no-op
 * outside free mode (`filter` short-circuits), so calling this in both
 * modes is safe.
 */
export function bindNodeDrag(chart: any, store: any, onPersist?: () => void): void {
  const state = chart.getChartState?.();
  const svg: SVGSVGElement | undefined = state?.svg?.node?.();
  if (!svg) return;
  const groups = select(svg).selectAll<SVGGElement, any>('g.node');
  groups.call(
    drag<SVGGElement, any>()
      .filter((event: any) => {
        // Only allow drag in free mode, and only when the user grabs the
        // card body — not the action buttons or the expand pill.
        if (store.layoutMode !== 'free') return false;
        const t = event.target as Element | null;
        if (!t) return false;
        if (t.closest?.('[data-action]')) return false;
        if (t.closest?.('.node-button-g')) return false;
        return true;
      })
      .on('start', function () {
        select(this).attr('cursor', 'grabbing');
      })
      .on('drag', function (event, d: any) {
        if (d?.data?._virtual) return;
        d.x += event.dx;
        d.y += event.dy;
        const off = cardOffset(d);
        select(this).attr('transform', `translate(${d.x - off.dx},${d.y - off.dy})`);
        redrawAllLinks(chart);
      })
      .on('end', function (event, d: any) {
        if (d?.data?._virtual) return;
        d.x = snap(d.x);
        d.y = snap(d.y);
        const off = cardOffset(d);
        select(this).attr('cursor', null);
        select(this).attr('transform', `translate(${d.x - off.dx},${d.y - off.dy})`);
        redrawAllLinks(chart);
        store.manualPositions[String(d.data.id)] = { x: d.x, y: d.y };
        store.save(); // triggers the history snapshot via the change listener
        onPersist?.();
      }),
  );
}

/**
 * Compute a sensible starting position for a freshly-created node so it
 * doesn't land at (0,0) in free mode. Goes to the next grid step right of
 * the last sibling (or directly under the parent if it has none).
 */
export function computeNewNodePosition(parentId: string | null, store: any): Position | null {
  if (store.layoutMode !== 'free') return null;
  const positions = store.manualPositions as Record<string, Position>;
  const cardW = 240;
  const cardH = 150;
  const vGap = 60;
  const hGap = 20;

  if (!parentId) {
    // No parent → place to the right of the rightmost root we know about.
    const roots = store.get().filter((n: OrgNode) => n.parentId == null || n.parentId === '');
    if (roots.length === 0) return { x: 0, y: 0 };
    const rightmost = roots
      .map((r: OrgNode) => positions[String(r.id)])
      .filter(Boolean)
      .sort((a: Position, b: Position) => b.x - a.x)[0];
    if (!rightmost) return { x: 0, y: 0 };
    return { x: snap(rightmost.x + cardW + hGap), y: rightmost.y };
  }

  const parentPos = positions[String(parentId)];
  if (!parentPos) return { x: 0, y: 0 };

  const siblings = store.get().filter((n: OrgNode) => String(n.parentId) === String(parentId));
  if (siblings.length === 0) {
    return { x: parentPos.x, y: snap(parentPos.y + cardH + vGap) };
  }
  // Place to the right of the rightmost sibling.
  const rightmost = siblings
    .map((s: OrgNode) => positions[String(s.id)])
    .filter(Boolean)
    .sort((a: Position, b: Position) => b.x - a.x)[0];
  if (!rightmost) {
    return { x: parentPos.x, y: snap(parentPos.y + cardH + vGap) };
  }
  return { x: snap(rightmost.x + cardW + hGap), y: rightmost.y };
}
