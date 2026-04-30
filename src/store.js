import { defaultDepartmentColor } from './departments.js';

const STORAGE_KEY = 'orgchart.data.v1';
const DEPT_KEY = 'orgchart.departments.v1';

export const store = {
  nodes: [],
  /** Map of explicit department → hex color overrides. Falls back to a stable hash. */
  departments: {},

  /** Subscribers notified on every mutation that changes persistent state.
   *  Used by the history module to record snapshots for undo/redo. */
  _listeners: [],
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
  snapshot() {
    return {
      nodes: JSON.parse(JSON.stringify(this.nodes)),
      departments: JSON.parse(JSON.stringify(this.departments)),
    };
  },

  /** Replace state from a snapshot WITHOUT firing change listeners.
   *  Persists to localStorage so a reload picks up the restored state.
   *  Used by undo/redo so applying a history entry doesn't push a new one. */
  restore(snap) {
    if (!snap) return;
    this.nodes = JSON.parse(JSON.stringify(snap.nodes || []));
    this.departments = JSON.parse(JSON.stringify(snap.departments || {}));
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.nodes));
      localStorage.setItem(DEPT_KEY, JSON.stringify(this.departments));
    } catch (err) {
      console.warn('localStorage persist failed', err);
    }
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
    return nodes;
  },

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.nodes));
      localStorage.setItem(DEPT_KEY, JSON.stringify(this.departments));
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
      const d = (n.department || '').trim();
      if (d) set.add(d);
    }
    for (const k of Object.keys(this.departments)) {
      if (k) set.add(k);
    }
    return [...set].sort((a, b) => a.localeCompare(b, 'de'));
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
    if (reparentChildren) {
      this.nodes.forEach((n) => {
        if (String(n.parentId) === String(id)) n.parentId = target.parentId;
      });
      this.nodes = this.nodes.filter((n) => String(n.id) !== String(id));
    } else {
      const toDelete = new Set([String(id)]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const n of this.nodes) {
          if (toDelete.has(String(n.parentId)) && !toDelete.has(String(n.id))) {
            toDelete.add(String(n.id));
            grew = true;
          }
        }
      }
      this.nodes = this.nodes.filter((n) => !toDelete.has(String(n.id)));
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
