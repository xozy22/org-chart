import { defaultDepartmentColor } from './departments.js';
import type { OrgNode, NodeId, CustomField, Snapshot, LayoutMode, Position } from './types.js';

const STORAGE_KEY = 'orgchart.data.v1';
const DEPT_KEY = 'orgchart.departments.v1';
const CUSTOM_FIELDS_KEY = 'orgchart.customfields.v1';
const LAYOUT_MODE_KEY = 'orgchart.layoutmode.v1';
const POSITIONS_KEY = 'orgchart.positions.v1';

/** Built-in node fields that user-defined custom fields must not shadow. */
const RESERVED_FIELD_KEYS: Set<string> = new Set([
  'id', 'parentId', 'name', 'title', 'department', 'email', 'phone',
  'imageUrl', 'country',
  // Internal markers used by the renderer for multi-root subtrees
  '_virtual', '_isRoot', '_rootColor',
]);

type Listener = (snap: Snapshot) => void;

export const store = {
  nodes: [] as OrgNode[],
  /** Map of explicit department → hex color overrides. Falls back to a stable hash. */
  departments: {} as Record<string, string>,
  /** User-defined custom fields. Each entry is `{ key, label, type, showOnCard }`.
   *  Values for these fields are stored directly on each node under the same key. */
  customFields: [] as CustomField[],

  /** Active layout mode. `auto` = d3-org-chart's tree layout (default).
   *  `free` = user-placed cards on a 20-px grid. */
  layoutMode: 'auto' as LayoutMode,

  /** Per-node x/y overrides applied in free-layout mode. Keys are node IDs. */
  manualPositions: {} as Record<NodeId, Position>,

  /** Subscribers notified on every mutation that changes persistent state.
   *  Used by the history module to record snapshots for undo/redo. */
  _listeners: [] as Listener[],
  onChange(fn) {
    this._listeners.push(fn);
    return () => {
      this._listeners = this._listeners.filter((l) => l !== fn);
    };
  },
  _emit() {
    for (const fn of this._listeners) {
      try {
        fn(this.snapshot());
      } catch (err) {
        console.error('store listener failed', err);
      }
    }
  },

  /** Deep-cloned snapshot of the persistent state. */
  snapshot(): Snapshot {
    return {
      nodes: JSON.parse(JSON.stringify(this.nodes)),
      departments: JSON.parse(JSON.stringify(this.departments)),
      customFields: JSON.parse(JSON.stringify(this.customFields)),
      layoutMode: this.layoutMode,
      manualPositions: JSON.parse(JSON.stringify(this.manualPositions)),
    };
  },

  /** Replace state from a snapshot WITHOUT firing change listeners.
   *  Persists to localStorage so a reload picks up the restored state.
   *  Used by undo/redo so applying a history entry doesn't push a new one. */
  restore(snap: Snapshot | null | undefined) {
    if (!snap) return;
    this.nodes = JSON.parse(JSON.stringify(snap.nodes || []));
    this.departments = JSON.parse(JSON.stringify(snap.departments || {}));
    if (snap.customFields) {
      this.customFields = JSON.parse(JSON.stringify(snap.customFields));
    }
    if (snap.layoutMode === 'free' || snap.layoutMode === 'auto') {
      this.layoutMode = snap.layoutMode;
    }
    if (snap.manualPositions) {
      this.manualPositions = JSON.parse(JSON.stringify(snap.manualPositions));
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.nodes));
      localStorage.setItem(DEPT_KEY, JSON.stringify(this.departments));
      localStorage.setItem(CUSTOM_FIELDS_KEY, JSON.stringify(this.customFields));
      localStorage.setItem(LAYOUT_MODE_KEY, this.layoutMode);
      localStorage.setItem(POSITIONS_KEY, JSON.stringify(this.manualPositions));
    } catch (err) {
      console.warn('localStorage persist failed', err);
    }
  },

  /* ---------- Custom fields ---------- */

  isReservedFieldKey(key) {
    return RESERVED_FIELD_KEYS.has(String(key));
  },

  addCustomField({ key, label, type = 'text', showOnCard = true }) {
    if (!key || !label) throw new Error('key und label sind Pflicht');
    if (RESERVED_FIELD_KEYS.has(key)) {
      throw new Error(`„${key}" ist ein reservierter Feldname`);
    }
    if (this.customFields.some((f) => f.key === key)) {
      throw new Error(`Feld „${key}" existiert bereits`);
    }
    this.customFields.push({ key, label, type, showOnCard: !!showOnCard });
    this.save();
  },

  updateCustomField(key, patch) {
    const f = this.customFields.find((x) => x.key === key);
    if (!f) return;
    Object.assign(f, patch);
    this.save();
  },

  removeCustomField(key, { keepData = false } = {}) {
    const idx = this.customFields.findIndex((f) => f.key === key);
    if (idx < 0) return;
    this.customFields.splice(idx, 1);
    if (!keepData) {
      // Strip the value from every node so the JSON stays tidy.
      for (const n of this.nodes) {
        if (key in n) delete n[key];
      }
    }
    this.save();
  },

  load() {
    let nodes = null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.nodes = parsed;
          nodes = parsed;
        }
      }
    } catch {
      /* ignore */
    }
    try {
      const rawDept = localStorage.getItem(DEPT_KEY);
      if (rawDept) {
        const parsed = JSON.parse(rawDept);
        if (parsed && typeof parsed === 'object') {
          this.departments = parsed;
        }
      }
    } catch {
      /* ignore */
    }
    try {
      const rawCf = localStorage.getItem(CUSTOM_FIELDS_KEY);
      if (rawCf) {
        const parsed = JSON.parse(rawCf);
        if (Array.isArray(parsed)) {
          this.customFields = parsed.filter(
            (f) => f && f.key && !RESERVED_FIELD_KEYS.has(f.key),
          );
        }
      }
    } catch {
      /* ignore */
    }
    try {
      const rawMode = localStorage.getItem(LAYOUT_MODE_KEY);
      if (rawMode === 'free' || rawMode === 'auto') {
        this.layoutMode = rawMode;
      }
    } catch {
      /* ignore */
    }
    try {
      const rawPos = localStorage.getItem(POSITIONS_KEY);
      if (rawPos) {
        const parsed = JSON.parse(rawPos);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          this.manualPositions = parsed;
        }
      }
    } catch {
      /* ignore */
    }
    return nodes;
  },

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.nodes));
      localStorage.setItem(DEPT_KEY, JSON.stringify(this.departments));
      localStorage.setItem(CUSTOM_FIELDS_KEY, JSON.stringify(this.customFields));
      localStorage.setItem(LAYOUT_MODE_KEY, this.layoutMode);
      localStorage.setItem(POSITIONS_KEY, JSON.stringify(this.manualPositions));
    } catch (err) {
      console.warn('localStorage persist failed', err);
    }
    // Notify subscribers AFTER persistence so anyone listening can
    // rely on localStorage being up to date (e.g. history snapshots).
    this._emit();
  },

  set(nodes) {
    this.nodes = Array.isArray(nodes) ? nodes : [];
    this.save();
    return this.nodes;
  },

  get() {
    return this.nodes;
  },

  /* ---------- Departments ---------- */

  /** All distinct department names currently in use, plus any with custom colors. */
  listDepartments() {
    const set = new Set();
    for (const n of this.nodes) {
      const d = ((n.department as string) || '').trim();
      if (d) set.add(d);
    }
    for (const k of Object.keys(this.departments)) {
      if (k) set.add(k);
    }
    return [...set].sort((a, b) => (a as string).localeCompare(b as string, 'de'));
  },

  /** Hex color for a department — explicit override or stable hash default. */
  getDepartmentColor(name) {
    if (!name) return null;
    const explicit = this.departments[name];
    if (explicit) return explicit;
    return defaultDepartmentColor(name);
  },

  /** Set or clear an explicit department color. Pass null/'' to reset to default. */
  setDepartmentColor(name, hex) {
    if (!name) return;
    if (!hex) {
      delete this.departments[name];
    } else {
      this.departments[name] = hex;
    }
    this.save();
  },

  byId(id) {
    return this.nodes.find((n) => String(n.id) === String(id));
  },

  add(node) {
    this.nodes.push(node);
    this.save();
  },

  update(id, patch) {
    const node = this.byId(id);
    if (!node) return null;
    Object.assign(node, patch);
    this.save();
    return node;
  },

  remove(id, { reparentChildren = true } = {}) {
    const target = this.byId(id);
    if (!target) return;
    const removedIds = new Set<string>();
    if (reparentChildren) {
      this.nodes.forEach((n) => {
        if (String(n.parentId) === String(id)) n.parentId = target.parentId;
      });
      this.nodes = this.nodes.filter((n) => String(n.id) !== String(id));
      removedIds.add(String(id));
    } else {
      removedIds.add(String(id));
      let grew = true;
      while (grew) {
        grew = false;
        for (const n of this.nodes) {
          if (removedIds.has(String(n.parentId)) && !removedIds.has(String(n.id))) {
            removedIds.add(String(n.id));
            grew = true;
          }
        }
      }
      this.nodes = this.nodes.filter((n) => !removedIds.has(String(n.id)));
    }
    // Drop any free-layout positions for the now-deleted node(s) so the
    // map doesn't grow unboundedly across the lifetime of the chart.
    for (const rid of removedIds) {
      delete this.manualPositions[rid];
    }
    this.save();
  },

  reparent(childId, newParentId) {
    const node = this.byId(childId);
    if (!node) return;
    node.parentId = newParentId == null ? null : String(newParentId);
    this.save();
  },

  nextId() {
    const used = new Set(this.nodes.map((n) => String(n.id)));
    let i = this.nodes.length + 1;
    while (used.has(String(i))) i++;
    return String(i);
  },
};
