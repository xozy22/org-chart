function matches(node, query) {
  if (!query) return false;
  const haystack = [node.name, node.title, node.department, node.email]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(query);
}

export function setupSearch({ chart, store }) {
  const input = document.getElementById('search-input');
  if (!input) return;

  let lastQuery = '';

  function run() {
    const query = input.value.trim().toLowerCase();
    if (query === lastQuery) return;
    lastQuery = query;

    chart.clearHighlighting();

    if (!query) {
      chart.fit();
      return;
    }

    const hits = store.get().filter((n) => matches(n, query));
    if (hits.length === 0) return;

    hits.forEach((n) => {
      try {
        chart.setHighlighted(n.id);
      } catch {
        /* node may be collapsed; ignore */
      }
    });

    try {
      chart.setExpanded(hits[0].id).render();
      chart.fit();
    } catch {
      /* ignore */
    }
  }

  let t;
  input.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(run, 150);
  });
}
