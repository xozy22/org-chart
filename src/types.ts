/**
 * Central type definitions used across the org-chart codebase.
 *
 * Keep this file dependency-free: every other module pulls types from
 * here, so circular imports would be painful.
 */

export type NodeId = string;

/** ISO 3166-1 alpha-2 country code, lowercase (e.g. `de`, `us`). */
export type CountryCode = string;

/** Single user-defined custom field schema entry. */
export interface CustomField {
  key: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'url' | 'email';
  showOnCard: boolean;
}

/**
 * A single org-chart node. Built-in fields are typed; user-defined custom
 * field values land directly on the same object via `[customKey]: unknown`.
 */
export interface OrgNode {
  id: NodeId;
  parentId: NodeId | null;
  name: string;
  title?: string;
  department?: string;
  email?: string;
  phone?: string;
  imageUrl?: string;
  /** ISO-2 lowercase country code, or `''` when unset. */
  country?: CountryCode | '';

  // Internal markers added by withVirtualRoot — not persisted.
  _virtual?: boolean;
  _isRoot?: boolean;
  _rootColor?: string;

  // Any additional keys are user-defined custom-field values.
  [key: string]: unknown;
}

/** Layout mode — `auto` lets d3-org-chart compute positions, `free` lets the
 *  user place each card manually on a grid. */
export type LayoutMode = 'auto' | 'free';

/** Cartesian position used to override the auto-layout in free mode. */
export interface Position {
  x: number;
  y: number;
}

/** Persistent snapshot used by the undo/redo history. */
export interface Snapshot {
  nodes: OrgNode[];
  departments: Record<string, string>;
  customFields?: CustomField[];
  layoutMode?: LayoutMode;
  manualPositions?: Record<string, Position>;
}

/** Result of the filter+search apply step. */
export interface FilterValues {
  query: string;
  department: string;
  country: string;
  rootId: string;
  rootDescendants?: Set<string> | null;
}

/** Metadata of a chart in the backend index — never includes the heavy payload. */
export interface ChartIndexEntry {
  id: string;
  name: string;
  tags: string[];
  default: boolean;
  createdAt: string;
  updatedAt: string;
  etag: string;
  nodeCount: number;
  departmentCount: number;
}

/** Full chart payload as it travels over the wire / sits in the store. */
export interface ChartPayload {
  nodes: OrgNode[];
  departments: Record<string, string>;
  customFields: CustomField[];
}

/** Error returned by the API client when something goes wrong. */
export interface ApiError {
  status: number;
  message: string;
  /** When `status === 412`, contains the server-side current entry. */
  conflict?: ChartIndexEntry;
}

/** Result of `computeStats` in stats.ts. */
export interface ChartStats {
  total: number;
  roots: { id: NodeId; name: string; count: number; maxDepth: number }[];
  departments: { name: string; count: number }[];
  countries: { code: CountryCode; count: number }[];
  withEmail: number;
  withPhone: number;
  withCountry: number;
  maxDepth: number;
  avgDepth: number;
}
