/**
 * Aggregations over the live store, used by the stats sidebar.
 *
 * All helpers operate on the flat node list; nothing here mutates the
 * store. Roots are detected by `parentId == null`. The "depth" metric
 * is `0` for a real root, `1` for its direct children, and so on.
 */

function depthsByNode(nodes) {
  const idToNode = new Map(nodes.map((n) => [String(n.id), n]));
  const depth = new Map();
  function compute(id, seen = new Set()) {
    if (depth.has(id)) return depth.get(id);
    if (seen.has(id)) return 0; // cycle guard
    seen.add(id);
    const n = idToNode.get(id);
    if (!n) return 0;
    const pid = n.parentId == null || n.parentId === '' ? null : String(n.parentId);
    const d = pid ? compute(pid, seen) + 1 : 0;
    depth.set(id, d);
    return d;
  }
  for (const n of nodes) compute(String(n.id));
  return depth;
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

export function computeStats(nodes) {
  const total = nodes.length;
  if (total === 0) {
    return {
      total: 0,
      roots: [],
      departments: [],
      countries: [],
      withEmail: 0,
      withPhone: 0,
      withCountry: 0,
      maxDepth: 0,
      avgDepth: 0,
    };
  }

  const depths = depthsByNode(nodes);
  let maxDepth = 0;
  let depthSum = 0;
  for (const d of depths.values()) {
    if (d > maxDepth) maxDepth = d;
    depthSum += d;
  }
  const avgDepth = depthSum / total;

  // Aggregate counts
  const deptCount = new Map();
  const countryCount = new Map();
  let withEmail = 0;
  let withPhone = 0;
  let withCountry = 0;
  for (const n of nodes) {
    const d = (n.department || '').trim();
    if (d) deptCount.set(d, (deptCount.get(d) ?? 0) + 1);
    const c = (n.country || '').trim().toLowerCase();
    if (c) {
      countryCount.set(c, (countryCount.get(c) ?? 0) + 1);
      withCountry++;
    }
    if (n.email && String(n.email).trim()) withEmail++;
    if (n.phone && String(n.phone).trim()) withPhone++;
  }

  // Roots — use the array order so the colour palette stays stable.
  const realRoots = nodes.filter((n) => n.parentId == null || n.parentId === '');
  const roots = realRoots.map((r) => {
    const ids = descendantsOf(r.id, nodes);
    let rMax = 0;
    for (const id of ids) {
      const d = depths.get(String(id)) ?? 0;
      if (d > rMax) rMax = d;
    }
    return {
      id: String(r.id),
      name: r.name || `Wurzel ${r.id}`,
      count: ids.size,
      maxDepth: rMax,
    };
  });

  const departments = [...deptCount.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
  const countries = [...countryCount.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count);

  return {
    total,
    roots,
    departments,
    countries,
    withEmail,
    withPhone,
    withCountry,
    maxDepth,
    avgDepth,
  };
}
