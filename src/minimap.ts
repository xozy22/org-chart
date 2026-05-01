/**
 * Minimap — a small canvas overview of the entire chart pinned to the
 * bottom-right corner.
 *
 *  - Each node is drawn as a tiny rectangle filled with its subtree
 *    colour (or neutral grey for single-root charts).
 *  - Parent → child connections are stroked as straight lines.
 *  - The user's currently-visible region in the main chart is overlaid
 *    as a translucent red rectangle.
 *  - Clicking inside the minimap re-centres the main chart on the
 *    closest node, using d3-org-chart's `setCentered()` API.
 *
 * Re-rendering is throttled via requestAnimationFrame and triggered
 * either by a MutationObserver on the chart container or by an
 * explicit `redraw()` call.
 */

const W = 240;
const H = 160;
const PADDING = 8;

export function createMinimap({ chart, host }) {
  const canvas = document.createElement('canvas');
  canvas.width = W * window.devicePixelRatio;
  canvas.height = H * window.devicePixelRatio;
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  canvas.className = 'minimap-canvas';
  host.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

  /** Latest projection cached for click handling. */
  let projection = null;

  function project(visibleNodes, transform, svgEl) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of visibleNodes) {
      const nw = n.width ?? 240;
      const nh = n.height ?? 150;
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.x + nw > maxX) maxX = n.x + nw;
      if (n.y + nh > maxY) maxY = n.y + nh;
    }
    // Include the visible viewport rectangle so the highlight stays
    // within the minimap when the user pans far away.
    const k = transform?.k ?? 1;
    const svgW = svgEl?.clientWidth ?? 800;
    const svgH = svgEl?.clientHeight ?? 600;
    const vx = -((transform?.x ?? 0) / k);
    const vy = -((transform?.y ?? 0) / k);
    const vw = svgW / k;
    const vh = svgH / k;
    if (vx < minX) minX = vx;
    if (vy < minY) minY = vy;
    if (vx + vw > maxX) maxX = vx + vw;
    if (vy + vh > maxY) maxY = vy + vh;

    const layoutW = Math.max(1, maxX - minX);
    const layoutH = Math.max(1, maxY - minY);
    const innerW = W - PADDING * 2;
    const innerH = H - PADDING * 2;
    const scale = Math.min(innerW / layoutW, innerH / layoutH);
    const offsetX = PADDING + (innerW - layoutW * scale) / 2 - minX * scale;
    const offsetY = PADDING + (innerH - layoutH * scale) / 2 - minY * scale;

    return {
      scale,
      offsetX,
      offsetY,
      // helper to convert layout → minimap coords
      toMini: (lx, ly) => ({ x: lx * scale + offsetX, y: ly * scale + offsetY }),
      // inverse for click handling
      toLayout: (mx, my) => ({ x: (mx - offsetX) / scale, y: (my - offsetY) / scale }),
      viewport: { x: vx, y: vy, w: vw, h: vh },
    };
  }

  function draw() {
    const state = chart.getChartState?.();
    if (!state) return;
    // Only render the *currently visible* slice of the tree. d3-org-chart
    // hides a collapsed subtree by detaching it from `node.children` (the
    // ancestors keep it under `node._children`), so traversing the live
    // root hierarchy automatically skips collapsed nodes — using
    // `state.allNodes` instead would always render every node, even when
    // the user has just collapsed a root subtree.
    const root = state.root;
    const sourceNodes = root && typeof root.descendants === 'function'
      ? root.descendants()
      : (state.allNodes ?? []);
    const visible = sourceNodes.filter((n) => !n?.data?._virtual);
    ctx.clearRect(0, 0, W, H);

    if (!visible.length) {
      projection = null;
      return;
    }

    const transform = state.lastTransform;
    const svgEl = state.svg?.node?.();
    const proj = project(visible, transform, svgEl);
    projection = proj;

    // Background
    ctx.fillStyle = '#FAFBFC';
    ctx.fillRect(0, 0, W, H);

    // Connections
    ctx.strokeStyle = 'rgba(15, 17, 21, 0.22)';
    ctx.lineWidth = 0.6;
    for (const n of visible) {
      const p = n.parent;
      if (!p || p.data?._virtual) continue;
      const pw = p.width ?? 240;
      const ph = p.height ?? 150;
      const nw = n.width ?? 240;
      const nh = n.height ?? 150;
      const a = proj.toMini(p.x + pw / 2, p.y + ph / 2);
      const b = proj.toMini(n.x + nw / 2, n.y + nh / 2);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    // Node rectangles
    for (const n of visible) {
      const w = (n.width ?? 240) * proj.scale;
      const h = (n.height ?? 150) * proj.scale;
      const { x, y } = proj.toMini(n.x, n.y);
      ctx.fillStyle = n.data?._rootColor || '#6b7280';
      ctx.globalAlpha = 0.85;
      ctx.fillRect(x, y, Math.max(2, w), Math.max(2, h));
    }
    ctx.globalAlpha = 1;

    // Viewport rectangle
    const v = proj.viewport;
    const vTopLeft = proj.toMini(v.x, v.y);
    const vw = v.w * proj.scale;
    const vh = v.h * proj.scale;
    ctx.strokeStyle = '#DA291C';
    ctx.lineWidth = 1.4;
    ctx.fillStyle = 'rgba(218, 41, 28, 0.10)';
    ctx.fillRect(vTopLeft.x, vTopLeft.y, vw, vh);
    ctx.strokeRect(vTopLeft.x, vTopLeft.y, vw, vh);
  }

  /** Re-centre on the closest node when the user clicks the minimap. */
  function handleClick(ev) {
    if (!projection) return;
    const state = chart.getChartState?.();
    if (!state) return;
    const rect = canvas.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    const my = ev.clientY - rect.top;
    const { x: lx, y: ly } = projection.toLayout(mx, my);

    const root = state.root;
    const sourceNodes = root && typeof root.descendants === 'function'
      ? root.descendants()
      : (state.allNodes ?? []);
    const visible = sourceNodes.filter((n) => !n?.data?._virtual);
    if (!visible.length) return;
    let best = visible[0];
    let bestD = Infinity;
    for (const n of visible) {
      const cx = n.x + (n.width ?? 240) / 2;
      const cy = n.y + (n.height ?? 150) / 2;
      const d = (cx - lx) ** 2 + (cy - ly) ** 2;
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    try {
      chart.setCentered(best.data.id).render();
    } catch {
      /* ignore — older d3-org-chart versions may not have setCentered */
    }
  }
  canvas.addEventListener('click', handleClick);

  // requestAnimationFrame loop with a dirty flag — keeps the minimap
  // smooth during pan/zoom without burning CPU when nothing changed.
  let dirty = true;
  function schedule() {
    dirty = true;
  }
  function tick() {
    if (dirty) {
      try {
        draw();
      } catch (err) {
        console.warn('minimap draw failed', err);
      }
      dirty = false;
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  // React to any DOM mutation or transform attribute change in the chart.
  const chartHost = document.getElementById('chart');
  if (chartHost) {
    const observer = new MutationObserver(schedule);
    observer.observe(chartHost, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['transform'],
    });
  }

  return { redraw: schedule };
}
