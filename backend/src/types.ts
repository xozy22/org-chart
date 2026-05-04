/** Shared backend types — kept tight, no validation library yet. */

export type NodeId = string;

export interface OrgNode {
  id: NodeId;
  parentId: NodeId | null;
  name: string;
  title?: string;
  department?: string;
  email?: string;
  phone?: string;
  imageUrl?: string;
  country?: string;
  [key: string]: unknown;
}

export interface CustomField {
  key: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'url' | 'email';
  showOnCard: boolean;
}

/** Full chart payload — nodes plus user-defined schemas. */
export interface ChartPayload {
  nodes: OrgNode[];
  departments: Record<string, string>;
  customFields: CustomField[];
}

/** Index entry — never includes the heavy nodes list. */
export interface ChartIndexEntry {
  id: string;
  name: string;
  tags: string[];
  default: boolean;
  createdAt: string;       // ISO-8601
  updatedAt: string;       // ISO-8601
  etag: string;            // 7-char SHA-1 of the payload
  nodeCount: number;
  departmentCount: number;
}
