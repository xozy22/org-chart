import { countryName } from './countries.js';

/**
 * Combined filter + search controller.
 *
 * Free-text search and the three structured filters (department, country,
 * root subtree) are combined with AND-logic. Matching nodes are highlighted
 * via the OrgChart API; non-matching nodes simply don't get the highlight.
 *
 * The dropdowns are populated from the live store so they only ever offer
 * values that actually appear in the chart.
 *
 * Filter state is mirrored into the URL hash (`#q=…&dept=…&country=…&root=…`)
 * so the current view can be shared verbatim — opening such a link
 * pre-applies the filters on bootstrap.
 */

function $(sel) {
  return document.querySelector(sel);
}

function descendantsOf(rootId, nodes) {
  const ids = new Set([String(rootId)]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of nodes) {
      if (ids.has(String(n.parentId)) && !ids.has(String(n.id))) {
        ids.add(String(n.id));
        grew = true;
      }
    }
  }
  return ids;
}

/* -------------------------------------------------------------------- */
/*  URL-hash sync                                                       */
/* -------------------------------------------------------------------- */

const URL_KEYS = { query: 'q', department: 'dept', country: 'country', rootId: 'root' };

/** Read filter values from `location.hash` (e.g. `#q=foo&dept=Technik`). */
function readHash() {
  const out = { query: '', department: '', country: '', rootId: '' };
  const raw = (location.hash || '').replace(/^#/, '');
  if (!raw) return out;
  for (const part of raw.split('&')) {
    if (!part) continue;
    const [k, v = ''] = part.split('=');
    const decoded = (() => {
      try {
        return decodeURIComponent(v.replace(/\+/g, ' '));
      } catch {
        return '';
      }
    })();
    for (const [field, key] of Object.entries(URL_KEYS)) {
      if (k === key) out[field] = decoded;
    }
  }
  return out;
}

function buildHash(filters) {
  const parts = [];
  if (filters.query) parts.push(`${URL_KEYS.query}=${encodeURIComponent(filters.query)}`);
  if (filters.department) parts.push(`${URL_KEYS.department}=${encodeURIComponent(filters.department)}`);
  if (filters.country) parts.push(`${URL_KEYS.country}=${encodeURIComponent(filters.country)}`);
  if (filters.rootId) parts.push(`${URL_KEYS.rootId}=${encodeURIComponent(filters.rootId)}`);
  return parts.length ? '#' + parts.join('&') : '';
}

/** Replace the URL hash without polluting the back/forward history. */
function writeHash(filters) {
  const hash = buildHash(filters);
  const target = location.pathname + location.search + hash;
  // Use replaceState so each keystroke in the search field doesn't
  // produce a new history entry; the user can still bookmark or copy
  // the URL at any time and back/forward only reflects the apply step
  // when navigated externally.
  history.replaceState(null, '', target);
}

function nodeMatches(node, filters) {
  if (filters.query) {
    const haystack = [node.name, node.title, node.department, node.email, node.phone]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(filters.query)) return false;
  }
  if (filters.department && node.department !== filters.department) return false;
  if (filters.country && (node.country || '').toLowerCase() !== filters.country) return false;
  if (filters.rootDescendants && !filters.rootDescendants.has(String(node.id))) return false;
  return true;
}

export function setupFilters({ chart, store }) {
  const searchInput = $('#search-input');
  const deptSelect = $('#filter-department');
  const countrySelect = $('#filter-country');
  const rootSelect = $('#filter-root');
  const rootWrap = $('#filter-root-wrap');
  const resetBtn = $('#filter-reset');
  const summary = $('#filter-summary');

  // Tracks the currently-matching node IDs so we can re-apply the dimming
  // after d3-org-chart rebuilds DOM nodes (e.g. when the user expands or
  // collapses a subtree, which discards our `.filter-dimmed` classes).
  let currentMatchIds = null;

  /** Re-fill all dropdown lists from the current store. Idempotent. */
  function refreshDropdowns() {
    // Departments
    const depts = store.listDepartments();
    const prevDept = deptSelect.value;
    deptSelect.innerHTML =
      '<option value="">Alle Abteilungen</option>' +
      depts.map((d) => `<option value="${d.replace(/"/g, '&quot;')}">${d}</option>`).join('');
    if (depts.includes(prevDept)) deptSelect.value = prevDept;

    // Countries — only ones in use
    const countriesInUse: string[] = ([
      ...new Set(store.get().map((n: any) => ((n.country as string) || '').toLowerCase()).filter(Boolean)),
    ] as string[]).sort((a, b) => countryName(a).localeCompare(countryName(b), 'de'));
    const prevCountry = countrySelect.value;
    countrySelect.innerHTML =
      '<option value="">Alle Länder</option>' +
      countriesInUse
        .map((c) => `<option value="${c}">${c.toUpperCase()} — ${countryName(c) || c}</option>`)
        .join('');
    if (countriesInUse.includes(prevCountry)) countrySelect.value = prevCountry;

    // Roots — only when there is more than one
    const realRoots = store.get().filter((n) => n.parentId == null || n.parentId === '');
    const prevRoot = rootSelect.value;
    if (realRoots.length > 1) {
      rootSelect.innerHTML =
        '<option value="">Alle Wurzeln</option>' +
        realRoots.map((r) => `<option value="${String(r.id)}">${r.name || `Wurzel ${r.id}`}</option>`).join('');
      if (realRoots.some((r) => String(r.id) === prevRoot)) rootSelect.value = prevRoot;
      rootWrap.hidden = false;
    } else {
      rootSelect.value = '';
      rootWrap.hidden = true;
    }
  }

  function readFilters() {
    const rootId = rootSelect.value || '';
    return {
      query: (searchInput?.value || '').trim().toLowerCase(),
      department: deptSelect.value || '',
      country: (countrySelect.value || '').toLowerCase(),
      rootId,
      rootDescendants: rootId ? descendantsOf(rootId, store.get()) : null,
    };
  }

  function describe(filters, hits) {
    const parts = [];
    if (filters.query) parts.push(`Suche „${filters.query}"`);
    if (filters.department) parts.push(`Abteilung „${filters.department}"`);
    if (filters.country) parts.push(`Land ${filters.country.toUpperCase()}`);
    if (filters.rootId) {
      const r = store.byId(filters.rootId);
      parts.push(`Wurzel „${r?.name ?? filters.rootId}"`);
    }
    if (parts.length === 0) return '';
    return `${hits} Treffer · ${parts.join(' · ')}`;
  }

  /**
   * Apply / remove a `.filter-dimmed` class on each rendered card so non-matches
   * fade out — much clearer than relying on highlight alone, and keeps the
   * hierarchy intact (no layout shift).
   *
   * Also remembers the active match set so the dimming can be re-applied
   * automatically when d3-org-chart rebuilds its DOM (e.g. on expand/collapse).
   */
  function applyDimming(matchIds) {
    currentMatchIds = matchIds;
    const cards = document.querySelectorAll('#chart .node-card');
    if (!matchIds) {
      cards.forEach((c) => c.classList.remove('filter-dimmed'));
      return;
    }
    cards.forEach((card) => {
      const id = card.getAttribute('data-id');
      if (!id) return;
      card.classList.toggle('filter-dimmed', !matchIds.has(id));
    });
  }

  function apply() {
    const filters = readFilters();
    const isActive = !!(filters.query || filters.department || filters.country || filters.rootId);

    // Mirror state into the URL so the current filtered view is shareable.
    writeHash(filters);

    chart.clearHighlighting();

    if (!isActive) {
      summary.textContent = '';
      applyDimming(null);
      chart.fit();
      return;
    }

    const hits = store.get().filter((n) => nodeMatches(n, filters));
    const matchIds = new Set(hits.map((h) => String(h.id)));

    hits.forEach((n) => {
      try {
        chart.setHighlighted(n.id);
      } catch {
        /* node may currently be collapsed */
      }
    });

    if (hits.length > 0) {
      try {
        // Expand the path to the first hit so the user sees something useful.
        chart.setExpanded(hits[0].id).render();
        chart.fit();
      } catch {
        /* ignore */
      }
    }

    // Apply dimming after the chart re-renders (`render()` rebuilds the DOM).
    requestAnimationFrame(() => applyDimming(matchIds));

    summary.textContent = describe(filters, hits.length);
  }

  function clearAll() {
    if (searchInput) searchInput.value = '';
    deptSelect.value = '';
    countrySelect.value = '';
    rootSelect.value = '';
    apply();
  }

  // Wiring -----------------------------------------------------------------

  let searchTimer;
  searchInput?.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(apply, 150);
  });
  deptSelect.addEventListener('change', apply);
  countrySelect.addEventListener('change', apply);
  rootSelect.addEventListener('change', apply);
  resetBtn.addEventListener('click', clearAll);

  refreshDropdowns();

  /* ------------------------------------------------------------------ */
  /*  Apply URL hash on bootstrap so deep-links pre-populate the filter */
  /* ------------------------------------------------------------------ */
  const initial = readHash();
  let hadInitialHash = false;
  if (searchInput && initial.query) {
    searchInput.value = initial.query;
    hadInitialHash = true;
  }
  if (initial.department && [...deptSelect.options].some((o) => o.value === initial.department)) {
    deptSelect.value = initial.department;
    hadInitialHash = true;
  }
  if (initial.country && [...countrySelect.options].some((o) => o.value === initial.country)) {
    countrySelect.value = initial.country;
    hadInitialHash = true;
  }
  if (initial.rootId && [...rootSelect.options].some((o) => o.value === initial.rootId)) {
    rootSelect.value = initial.rootId;
    hadInitialHash = true;
  }
  if (hadInitialHash) {
    // Defer one tick so the chart has finished rendering before we try
    // to highlight matching nodes via setHighlighted().
    setTimeout(apply, 0);
  }

  // React to manual hash edits or back/forward navigation.
  window.addEventListener('hashchange', () => {
    const h = readHash();
    if (searchInput) searchInput.value = h.query;
    deptSelect.value = h.department;
    countrySelect.value = h.country;
    rootSelect.value = h.rootId;
    apply();
  });

  // Re-apply dimming whenever d3-org-chart mutates the chart DOM. The most
  // common trigger is the user expanding or collapsing a subtree via the
  // pill button — which rebuilds <foreignObject> children and therefore
  // wipes our `.filter-dimmed` classes.
  const chartHost = document.getElementById('chart');
  if (chartHost) {
    let pending;
    const observer = new MutationObserver(() => {
      if (!currentMatchIds) return;             // no active filter → nothing to do
      clearTimeout(pending);
      pending = setTimeout(() => applyDimming(currentMatchIds), 30);
    });
    // Only watch for added/removed nodes — `attributes: false` keeps us from
    // recursively triggering when our own toggleClass call mutates the cards.
    observer.observe(chartHost, { childList: true, subtree: true });
  }

  return { refreshDropdowns, apply, clearAll };
}
