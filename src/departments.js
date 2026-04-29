// Department color helpers — stable default color from a name hash,
// with WCAG-aware text color (black/white) chosen for readability.

function djb2(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  }
  return h;
}

function hslToHex(h, s, l) {
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const c = l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    return Math.round(c * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** Stable default color for a department name. */
export function defaultDepartmentColor(name) {
  if (!name) return '#9ca3af';
  const hue = djb2(name) % 360;
  // Tuned for vivid but readable colors that look good as a badge.
  return hslToHex(hue, 62, 48);
}

/** Pick black or white text for a given background hex color (relative luminance). */
export function readableTextColor(hex) {
  if (!hex || typeof hex !== 'string') return '#111111';
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6) return '#111111';
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return L > 0.55 ? '#111111' : '#ffffff';
}

/** Lightened version of a hex color for use as a soft background. */
export function softBackground(hex) {
  if (!hex || typeof hex !== 'string') return 'rgba(0,0,0,0.04)';
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6) return 'rgba(0,0,0,0.04)';
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, 0.14)`;
}
