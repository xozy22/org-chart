/**
 * Clipboard utilities for the org-chart app.
 *
 * - `copyText` writes a string to the clipboard with a graceful fallback
 *   for non-secure contexts (HTTP deployments where `navigator.clipboard`
 *   isn't available).
 * - `formatNodeAsText` produces a human-readable plain-text block of all
 *   relevant fields of a single OrgNode, ready to paste into mails/chats.
 * - `formatNodeAsVCard` produces an RFC-6350 vCard 3.0 string, ready to
 *   import into address books like Outlook, Apple Contacts, or Google.
 */
import type { OrgNode } from './types.js';
import { store } from './store.js';
import { countryName } from './countries.js';

/**
 * Write `text` to the clipboard. Prefers `navigator.clipboard.writeText`
 * (Async Clipboard API, requires Secure Context), falls back to a hidden
 * `<textarea>` + `document.execCommand('copy')` for plain-HTTP deployments.
 *
 * @returns true on success, false on failure.
 */
export async function copyText(text: string): Promise<boolean> {
  // Modern path: works in HTTPS / localhost / Electron.
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to legacy path
  }
  // Legacy fallback for http://lan-ip:8080-style deployments.
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** Build a multi-line text representation of a node. */
export function formatNodeAsText(node: OrgNode): string {
  const lines: string[] = [];
  const name = (node.name || '').trim();
  if (name) lines.push(name);

  // Title · Department on one line if both present, else whichever exists.
  const parts: string[] = [];
  if (node.title) parts.push(String(node.title).trim());
  if (node.department) parts.push(String(node.department).trim());
  if (parts.length) lines.push(parts.join(' · '));

  if (node.email) lines.push(`✉ ${String(node.email).trim()}`);
  if (node.phone) lines.push(`☎ ${String(node.phone).trim()}`);

  if (node.country) {
    const code = String(node.country).toLowerCase();
    const label = countryName(code) || code.toUpperCase();
    lines.push(`📍 ${label}`);
  }

  // Custom fields — include every defined field that has a value, regardless
  // of `showOnCard` (the user is copying full data, not just the card view).
  const cfs = store.customFields || [];
  for (const f of cfs) {
    const raw = node[f.key];
    if (raw == null || raw === '') continue;
    lines.push(`${f.label}: ${String(raw)}`);
  }

  return lines.join('\n');
}

/** Escape per RFC 6350 §3.4: backslash, comma, semicolon, newline. */
function vcardEscape(value: string): string {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

/** Sanitize a name for use as a filename — same rules as io.ts. */
function sanitizeForFilename(raw: string | null | undefined): string {
  if (!raw) return 'contact';
  const cleaned = String(raw)
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 80)
    .trim();
  return cleaned || 'contact';
}

/**
 * Trigger a `<name>.vcf` download for the given node. Uses an in-memory
 * Blob + temporary anchor — works in every modern browser without needing
 * a server round-trip.
 */
export function downloadVCard(node: OrgNode): void {
  const vcard = formatNodeAsVCard(node);
  // BOM helps some Windows apps detect UTF-8.
  const blob = new Blob(['﻿', vcard], { type: 'text/vcard;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${sanitizeForFilename(node.name)}.vcf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Build a vCard 3.0 representation of a node — importable by most apps. */
export function formatNodeAsVCard(node: OrgNode): string {
  const lines: string[] = [];
  lines.push('BEGIN:VCARD');
  lines.push('VERSION:3.0');

  const name = (node.name || '').trim() || '—';
  // Split the display name into "Family Given" for the structured N field;
  // we only have a single name string so put it all into the Family slot
  // and leave the rest empty — apps display FN anyway.
  lines.push(`N:${vcardEscape(name)};;;;`);
  lines.push(`FN:${vcardEscape(name)}`);

  if (node.title) lines.push(`TITLE:${vcardEscape(String(node.title))}`);
  if (node.department) lines.push(`ORG:${vcardEscape(String(node.department))}`);
  if (node.email) {
    lines.push(`EMAIL;TYPE=INTERNET,WORK:${vcardEscape(String(node.email))}`);
  }
  if (node.phone) {
    lines.push(`TEL;TYPE=WORK,VOICE:${vcardEscape(String(node.phone))}`);
  }
  if (node.country) {
    const code = String(node.country).toLowerCase();
    const label = countryName(code) || code.toUpperCase();
    // Use ADR with only the country slot filled (street;ext;locality;region;postalcode;country).
    lines.push(`ADR;TYPE=WORK:;;;;;${vcardEscape(label)}`);
  }

  // Custom fields → NOTE block (one per line) — most readable across apps.
  const cfs = store.customFields || [];
  const noteLines: string[] = [];
  for (const f of cfs) {
    const raw = node[f.key];
    if (raw == null || raw === '') continue;
    noteLines.push(`${f.label}: ${String(raw)}`);
  }
  if (noteLines.length) {
    lines.push(`NOTE:${vcardEscape(noteLines.join('\n'))}`);
  }

  lines.push('END:VCARD');
  // vCard spec calls for CRLF line endings.
  return lines.join('\r\n');
}
