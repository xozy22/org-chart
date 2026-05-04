import { OrgChart } from 'd3-org-chart';
import { countryName } from './countries.js';
import { softBackground } from './departments.js';
import { store } from './store.js';
import { applyManualPositions } from './freeLayout.js';

export const VIRTUAL_ROOT_ID = '__virtual_root__';

/**
 * "Collapse all" needs to leave the virtual super-root expanded — otherwise
 * the real roots become hidden children of the invisible super-root and the
 * canvas appears empty.
 *
 * d3-org-chart's built-in `collapseAll()` collapses *everything* including
 * the virtual root and the subsequent `setExpanded(virtualId, true)` call
 * does not always reliably restore the children-array swap it performed.
 * Instead we walk every node and set its expanded flag explicitly:
 *   - virtual root  → expanded (so the real roots stay rendered)
 *   - everything else → collapsed (so subtrees are hidden, but each real
 *     root is itself still visible because root nodes are always shown).
 */
export function collapseAllSubtrees(chart) {
  try {
    const state = chart.getChartState();
    const all = state?.allNodes || [];
    for (const node of all) {
      const data = node?.data;
      if (!data) continue;
      const shouldExpand = data._virtual === true;
      chart.setExpanded(data.id, shouldExpand);
    }
    chart.render();
    chart.fit();
  } catch (err) {
    console.warn('collapseAllSubtrees failed, falling back', err);
    chart.collapseAll().fit();
  }
}

/**
 * Vivid, distinct colours used to highlight individual root subtrees when
 * the chart contains multiple top-level nodes. Stable assignment by index.
 */
const ROOT_COLORS = [
  '#DA291C', // Fortinet red
  '#2563eb', // cobalt blue
  '#16a34a', // strong green
  '#7c3aed', // violet
  '#ea580c', // orange
  '#0d9488', // teal
  '#db2777', // pink
  '#475569', // slate
];

function escapeHtml(value) {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function initials(name) {
  if (!name) return '?';
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

/**
 * Hex color → "rgba(r,g,b,alpha)" so we can build soft tints from a hex value.
 */
function hexAlpha(hex, alpha) {
  if (!hex) return `rgba(0,0,0,${alpha})`;
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Detect roots in the flat node list and, if there is more than one, splice
 * in a synthetic super-root so d3-stratify gets a single tree. Real roots
 * are tagged with `_isRoot` plus a `_rootColor` so the renderer can give
 * each subtree its own visual container.
 *
 * Returns the original list unchanged when there is at most one root.
 */
export function withVirtualRoot(nodes: any[]): any[] {
  const roots = nodes.filter((n) => n.parentId == null || n.parentId === '');
  if (roots.length <= 1) {
    // No virtual root needed → no per-subtree colour, default red accents apply.
    return nodes;
  }

  // Stable per-root colour assignment — based on the order roots appear in
  // the array. Adding/removing non-root nodes won't reshuffle colours.
  const rootColorById = new Map();
  roots.forEach((r, i) => {
    rootColorById.set(String(r.id), ROOT_COLORS[i % ROOT_COLORS.length]);
  });

  // Walk the parent chain for every node and resolve which root it belongs
  // to, then carry that root's colour down so descendants can pick it up
  // for their own accent (top stripe / avatar ring / connection cue).
  const idToNode = new Map(nodes.map((n) => [String(n.id), n]));
  const idToRootColor = new Map();
  function resolveRootColor(id, seen = new Set()) {
    if (idToRootColor.has(id)) return idToRootColor.get(id);
    if (seen.has(id)) return null;
    seen.add(id);
    const node = idToNode.get(id);
    if (!node) return null;
    const isRoot = node.parentId == null || node.parentId === '';
    const color = isRoot
      ? rootColorById.get(id)
      : resolveRootColor(String(node.parentId), seen);
    idToRootColor.set(id, color);
    return color;
  }
  nodes.forEach((n) => resolveRootColor(String(n.id)));

  const out = [
    {
      id: VIRTUAL_ROOT_ID,
      parentId: null,
      _virtual: true,
      name: '',
    },
    ...nodes.map((n) => {
      const id = String(n.id);
      const isRoot = n.parentId == null || n.parentId === '';
      const rootColor = idToRootColor.get(id);
      if (isRoot) {
        return {
          ...n,
          parentId: VIRTUAL_ROOT_ID,
          _isRoot: true,
          _rootColor: rootColor,
        };
      }
      return { ...n, _rootColor: rootColor };
    }),
  ];

  return out;
}

/** Render every custom field that has `showOnCard: true` and a non-empty
 *  value as a small key/value row at the bottom of the card. */
function renderCustomFieldsOnCard(data) {
  const fields = store.customFields || [];
  if (!fields.length) return '';
  const rows = [];
  for (const f of fields) {
    if (!f.showOnCard) continue;
    const raw = data[f.key];
    if (raw == null || raw === '') continue;
    let display = raw;
    if (f.type === 'url') {
      const safe = escapeHtml(raw);
      display = `<a href="${safe}" target="_blank" rel="noopener noreferrer">${safe}</a>`;
    } else if (f.type === 'email') {
      const safe = escapeHtml(raw);
      display =
        `<a class="node-card-link" href="mailto:${safe}">${safe}</a>` +
        `<button type="button" class="node-field-copy" data-action="copy-field"` +
        ` data-value="${safe}" data-label="${escapeHtml(f.label)}"` +
        ` title="${escapeHtml(f.label)} kopieren" aria-label="${escapeHtml(f.label)} kopieren">📋</button>`;
    } else {
      display = escapeHtml(raw);
    }
    rows.push(
      `<div class="node-card-cfrow" title="${escapeHtml(f.label)}: ${escapeHtml(raw)}"><span class="node-card-cflabel">${escapeHtml(f.label)}</span> ${display}</div>`,
    );
  }
  return rows.join('');
}

function renderDeptBadge(rawName) {
  const name = String(rawName || '').trim();
  if (!name) return '';
  const color = store.getDepartmentColor(name) || '#9ca3af';
  const bg = softBackground(color);
  const text = color;
  return `<div class="node-card-dept" style="background:${bg};color:${text};border:1px solid ${color}33;">${escapeHtml(name)}</div>`;
}

function renderNodeCard(d) {
  const data = d.data ?? {};

  // Synthetic super-root: render an invisible placeholder. d3-org-chart
  // still asks us for content so we must return *something*.
  if (data._virtual) {
    return '<div class="virtual-root" aria-hidden="true"></div>';
  }

  const name = escapeHtml(data.name || '—');
  const title = escapeHtml(data.title || '');
  const department = escapeHtml(data.department || '');
  const email = escapeHtml(data.email || '');
  const phone = escapeHtml(data.phone || '');
  const imageUrl = escapeHtml(data.imageUrl || '');
  const country = (data.country || '').toLowerCase();
  const countryLabel = country ? countryName(country) || country.toUpperCase() : '';
  const flag = country
    ? `<span class="node-flag fi fi-${escapeHtml(country)}" title="${escapeHtml(countryLabel)}" aria-label="${escapeHtml(countryLabel)}"></span>`
    : '';

  const avatar = imageUrl
    ? `<img class="node-avatar node-avatar--clickable" src="${imageUrl}" alt="${escapeHtml(data.name || '')}" data-action="view-image" data-image-src="${imageUrl}" title="Bild vergrößern" referrerpolicy="no-referrer" crossorigin="anonymous" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'node-avatar node-avatar--initials',textContent:'${escapeHtml(initials(data.name))}'}))" />`
    : `<div class="node-avatar node-avatar--initials">${escapeHtml(initials(data.name))}</div>`;

  // Subtree colouring:
  //   - real roots get a heavy coloured frame, soft tint and a ROOT badge
  //   - their descendants only inherit the colour as a CSS variable so the
  //     top stripe and avatar ring follow suit while the rest of the card
  //     stays neutral.
  const isRoot = !!data._isRoot;
  const rootColor = data._rootColor;
  let cardStyle = '';
  if (rootColor) {
    cardStyle = `--root-color:${rootColor};`;
    if (isRoot) {
      cardStyle +=
        `border-color:${rootColor};` +
        `box-shadow:0 0 0 2px ${hexAlpha(rootColor, 0.18)}, 0 6px 18px rgba(15,17,21,0.10);` +
        `background:linear-gradient(180deg, ${hexAlpha(rootColor, 0.07)} 0%, #fff 60%);`;
    }
  }
  // Root nodes are already visually distinct via the heavy coloured frame,
  // soft tint and accent strip — no extra ROOT badge needed.
  return `
    <div class="node-card${isRoot ? ' is-root' : ''}" data-id="${escapeHtml(data.id)}" style="${cardStyle}">
      <div class="node-card-top">
        ${avatar}
        <div class="node-card-meta">
          <div class="node-card-name" title="${name}">
            <span class="node-card-name-text">${name}</span>
            ${flag}
          </div>
          ${title ? `<div class="node-card-title" title="${title}">${title}</div>` : ''}
        </div>
      </div>
      ${department ? renderDeptBadge(data.department) : ''}
      ${email
        ? `<div class="node-card-email" title="${email}">` +
          `<a class="node-card-link" href="mailto:${email}" data-noselect>` +
          `<span class="node-card-link-icon" aria-hidden="true">✉</span>` +
          `<span class="node-card-link-text">${email}</span>` +
          `</a>` +
          `<button type="button" class="node-field-copy" data-action="copy-field"` +
          ` data-value="${email}" data-label="E-Mail"` +
          ` title="E-Mail kopieren" aria-label="E-Mail kopieren">📋</button>` +
          `</div>`
        : ''}
      ${phone
        ? `<div class="node-card-phone" title="${phone}">` +
          `<a class="node-card-link" href="tel:${phone}" data-noselect>` +
          `<span class="node-card-link-icon" aria-hidden="true">☎</span>` +
          `<span class="node-card-link-text">${phone}</span>` +
          `</a>` +
          `<button type="button" class="node-field-copy" data-action="copy-field"` +
          ` data-value="${phone}" data-label="Telefon"` +
          ` title="Telefon kopieren" aria-label="Telefon kopieren">📋</button>` +
          `</div>`
        : ''}
      ${renderCustomFieldsOnCard(data)}
      <div class="node-card-actions">
        <button type="button" class="node-action node-action--add" data-action="add" data-id="${escapeHtml(data.id)}" title="Untergeordneten Knoten hinzufügen">+</button>
        <button type="button" class="node-action node-action--edit" data-action="edit" data-id="${escapeHtml(data.id)}" title="Bearbeiten">✎</button>
        <button type="button" class="node-action node-action--copy" data-action="copy-node" data-id="${escapeHtml(data.id)}" title="Knoten-Daten kopieren">📋</button>
        <button type="button" class="node-action node-action--delete" data-action="delete" data-id="${escapeHtml(data.id)}" title="Löschen">🗑</button>
      </div>
    </div>
  `;
}

export function createChart(
  container: HTMLElement,
  rawData: any[],
  handlers: { onNodeClick?: (id: string) => void } = {},
) {
  const data = withVirtualRoot(rawData);
  const chart = new OrgChart()
    .container(container)
    .data(data)
    .nodeWidth((d) => (d.data._virtual ? 1 : 270))
    .nodeHeight((d) => {
      if (d.data._virtual) return 1;
      // Reserve ~16px of vertical space for each custom field rendered
      // on the card so the layout doesn't crop them.
      const visible = (store.customFields || []).filter((f) => f.showOnCard).length;
      const visibleOnThisNode = visible > 0
        ? (store.customFields || []).filter(
            (f) => f.showOnCard && d.data?.[f.key] != null && d.data?.[f.key] !== '',
          ).length
        : 0;
      // Long names wrap to 2 lines (line-clamp:2 in styles.css) and need
      // a little extra vertical room. Header column is ~190 px wide.
      const nameLen = String(d.data?.name || '').length;
      const longName = nameLen > 22;
      return 150 + (longName ? 18 : 0) + visibleOnThisNode * 16;
    })
    .childrenMargin((d) => (d.data?._virtual ? 0 : 60))
    .compactMarginBetween(() => 35)
    .compactMarginPair(() => 30)
    .neighbourMargin(() => 25)
    .siblingsMargin(() => 25)
    .nodeContent(renderNodeCard)
    .buttonContent(({ node }) => {
      // No expand pill for the virtual root — it would be visually noisy
      if (node.data._virtual) return '<div style="display:none"></div>';
      const expanded = !node.children;
      const sym = expanded ? '+' : '−';
      const total = node.data._directSubordinates ?? 0;
      return `<div class="expand-btn">${sym}${total ? ` <span>${total}</span>` : ''}</div>`;
    })
    .nodeUpdate(function (d) {
      if (d.data._virtual && this) {
        this.style.opacity = '0';
        this.style.pointerEvents = 'none';
      }
      // In free layout mode, override the transform that d3-org-chart just
      // computed with the saved manual position. Done per-node here because
      // a global post-render pass races with d3-org-chart's transitions.
      if (store.layoutMode === 'free' && !d.data?._virtual && this) {
        const pos = store.manualPositions[String(d.data.id)];
        if (pos) {
          d.x = pos.x;
          d.y = pos.y;
          const w = d.width ?? 240;
          this.setAttribute('transform', `translate(${pos.x - w / 2},${pos.y})`);
        }
      }
    })
    .linkUpdate(function (d) {
      // Hide link segments that originate from the virtual root.
      const fromVirtual = d?.parent?.data?._virtual === true;
      if (this) this.style.display = fromVirtual ? 'none' : '';
    })
    .onNodeClick((nodeOrEvent) => {
      const id = nodeOrEvent?.data?.id ?? nodeOrEvent;
      if (id === VIRTUAL_ROOT_ID) return;
      handlers.onNodeClick?.(id);
    });

  chart.render();

  // In free mode we override the auto-layout transforms after every render.
  // d3-org-chart animates transforms with a ~750 ms transition, so we
  // re-stamp the positions twice: once immediately (catches the case where
  // there is no transition), and once after the transition has finished
  // (catches every other case). The render call itself isn't blocked.
  const originalRender = chart.render.bind(chart);
  chart.render = function patchedRender(...args: any[]) {
    const result = originalRender(...args);
    if (store.layoutMode === 'free') {
      requestAnimationFrame(() => applyManualPositions(chart, store));
      setTimeout(() => applyManualPositions(chart, store), 800);
    }
    return result;
  };

  // Initial paint in free mode (page-load case where the user had `free`
  // saved in localStorage from a previous session).
  if (store.layoutMode === 'free') {
    requestAnimationFrame(() => applyManualPositions(chart, store));
    setTimeout(() => applyManualPositions(chart, store), 800);
  }

  return chart;
}
