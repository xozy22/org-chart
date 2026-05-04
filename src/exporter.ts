import { jsPDF } from 'jspdf';

/**
 * Robust export of the org chart to PNG / SVG / PDF.
 *
 * The pipeline is fully manual because:
 *   - d3-org-chart's built-in exportImg/exportSvg do not embed any of the
 *     application's CSS, so foreignObject-rendered cards lose every style
 *     that comes from a class (.node-card, .node-avatar, .node-flag, …).
 *   - html-to-image's CSS-inliner doesn't reliably traverse SVG/<foreignObject>
 *     subtrees, so the same cards came out unstyled.
 *
 * Steps:
 *   1. Read the bbox of the live `.chart` group so we know the natural
 *      content extent (independent of the user's pan/zoom).
 *   2. Deep-clone the live SVG, strip hover-only UI, reset the outer
 *      pan/zoom transform — keep every per-node translate intact.
 *   3. Sniff every same-origin stylesheet and embed the rules as a
 *      `<style>` element inside the SVG. The browser applies these styles
 *      when it rasterises the SVG-as-image, so foreignObject HTML keeps
 *      its full design.
 *   4. Replace each `.fi-xx` flag's `background-image: url(...)` with a
 *      base64 data-URI inline-style override, so the flags render even
 *      when the SVG is loaded as a same-document image (no extra HTTP).
 *   5. Serialise → Image → Canvas → PNG, or serialise → SVG file.
 */

const PADDING = 60;
const PIXEL_RATIO = 2;
const BG = '#FFFFFF';

const ts = () => new Date().toISOString().slice(0, 10);

function downloadHref(href, filename) {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/* -------------------------------------------------------------------- */
/*  CSS gathering                                                       */
/* -------------------------------------------------------------------- */

const cssCache: { text: string | null } = { text: null };

function collectDocumentCss(): string {
  if (cssCache.text != null) return cssCache.text;
  let css = '';
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList | null = null;
    try {
      rules = sheet.cssRules;
    } catch {
      // Cross-origin (shouldn't happen because we bundle everything via Vite),
      // fall back to nothing for that sheet.
      continue;
    }
    if (!rules) continue;
    for (const rule of Array.from(rules)) {
      css += (rule as CSSRule).cssText + '\n';
    }
  }
  cssCache.text = css;
  return css;
}

/**
 * Read every CSS custom property defined on the live document's `:root`
 * (== `<html>`) and emit them as a CSS rule scoped to `svg`. Without this
 * the rasterised SVG has no `<html>` ancestor, so every `var(--…)` reference
 * inside foreignObject HTML cards resolves to the empty string and cards
 * lose their borders, shadows, accent strip and radii.
 *
 * We also propagate the body's `font-family` so cards keep their type.
 */
function inlineRootCustomProperties(): string {
  const root = document.documentElement;
  const body = document.body;
  const rootStyles = getComputedStyle(root);
  const bodyStyles = getComputedStyle(body);

  const decls: string[] = [];
  for (let i = 0; i < rootStyles.length; i++) {
    const prop = rootStyles.item(i);
    if (!prop.startsWith('--')) continue;
    const value = rootStyles.getPropertyValue(prop).trim();
    if (!value) continue;
    decls.push(`${prop}: ${value};`);
  }

  const fontFamily = bodyStyles.fontFamily || rootStyles.fontFamily;
  if (fontFamily) decls.push(`font-family: ${fontFamily};`);
  const color = bodyStyles.color;
  if (color) decls.push(`color: ${color};`);

  if (!decls.length) return '';
  // Apply on the SVG itself so foreignObject descendants inherit, and on
  // foreignObject HTML roots as a belt-and-braces measure for renderers
  // that don't propagate custom properties through the SVG/HTML boundary.
  return `svg, svg foreignObject > * { ${decls.join(' ')} }\n`;
}

/* -------------------------------------------------------------------- */
/*  Flag-icon inlining                                                  */
/* -------------------------------------------------------------------- */

const flagDataUrlCache = new Map();

async function fetchAsDataUrl(url) {
  if (flagDataUrlCache.has(url)) return flagDataUrlCache.get(url);
  const res = await fetch(url, { cache: 'force-cache' });
  if (!res.ok) throw new Error(`Failed to fetch ${url}`);
  const blob = await res.blob();
  const dataUrl = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
  flagDataUrlCache.set(url, dataUrl);
  return dataUrl;
}

/**
 * Replace every flag's class-driven background-image with an inline
 * data-URI background-image. We resolve the URL by reading the live
 * element's computed style — the live element still has the working
 * stylesheet attached, the clone does not yet have anything but markup.
 */
async function inlineFlagBackgrounds(liveSvg: SVGElement, clonedSvg: SVGElement) {
  const liveFlags = Array.from(liveSvg.querySelectorAll<HTMLElement>('.fi'));
  const cloneFlags = Array.from(clonedSvg.querySelectorAll<HTMLElement>('.fi'));
  await Promise.all(
    liveFlags.map(async (live, i) => {
      const clone = cloneFlags[i];
      if (!clone) return;
      const bg = getComputedStyle(live).backgroundImage;
      const m = bg && bg.match(/url\(["']?(.+?)["']?\)/);
      if (!m) return;
      try {
        const dataUrl = await fetchAsDataUrl(m[1]);
        clone.style.backgroundImage = `url('${dataUrl}')`;
        clone.style.backgroundSize = 'cover';
        clone.style.backgroundPosition = 'center';
        clone.style.backgroundRepeat = 'no-repeat';
      } catch {
        /* ignore — leave the placeholder */
      }
    }),
  );
}

/* -------------------------------------------------------------------- */
/*  Build off-screen export clone                                       */
/* -------------------------------------------------------------------- */

async function prepareExportSvg(chart) {
  const state = chart.getChartState();
  const liveSvg = state.svg.node();
  if (!liveSvg) throw new Error('Chart SVG not ready');

  // d3-org-chart wraps content in a `.chart` group with the pan/zoom
  // transform. Its untransformed bbox is exactly what we want to render.
  const liveChartG = liveSvg.querySelector('g.chart') || liveSvg.querySelector('g');
  let bbox;
  try {
    bbox = liveChartG.getBBox();
  } catch {
    bbox = { x: 0, y: 0, width: liveSvg.clientWidth, height: liveSvg.clientHeight };
  }

  const width = Math.max(1, Math.ceil(bbox.width + PADDING * 2));
  const height = Math.max(1, Math.ceil(bbox.height + PADDING * 2));

  const clone = liveSvg.cloneNode(true);
  clone.querySelectorAll('.node-card-actions').forEach((el) => el.remove());
  clone.querySelectorAll('.expand-btn').forEach((el) => el.remove());

  const chartGroupClone = clone.querySelector('g.chart') || clone.querySelector('g');
  if (chartGroupClone) chartGroupClone.removeAttribute('transform');

  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  clone.setAttribute('viewBox', `${bbox.x - PADDING} ${bbox.y - PADDING} ${width} ${height}`);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');

  // Ensure foreignObject HTML inherits the xhtml namespace.
  clone.querySelectorAll('foreignObject > *').forEach((el) => {
    if (!el.getAttribute('xmlns')) el.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
  });

  // 1. Embed the document CSS so cards keep their styling. The
  //    `inlineRootCustomProperties()` rule re-applies every `--*` custom
  //    property from the live `:root` onto the SVG, because the rasterised
  //    SVG has no `<html>` ancestor — without it every var() reference
  //    inside the foreignObject cards resolves to empty.
  const styleEl = document.createElementNS('http://www.w3.org/2000/svg', 'style');
  styleEl.textContent = `
    /* Solid white background covering the whole canvas */
    svg { background: ${BG}; }
    ${inlineRootCustomProperties()}
    ${collectDocumentCss()}
  `;
  clone.insertBefore(styleEl, clone.firstChild);

  // 2. Inline every flag image
  await inlineFlagBackgrounds(liveSvg, clone);

  return { clone, width, height };
}

/* -------------------------------------------------------------------- */
/*  Serialisation helpers                                               */
/* -------------------------------------------------------------------- */

function serializeSvg(svgEl) {
  const xml = new XMLSerializer().serializeToString(svgEl);
  // Make sure it has the XML declaration for safe consumption.
  return '<?xml version="1.0" standalone="no"?>\n' + xml;
}

function svgStringToDataUrl(svgString) {
  // Use base64 — encodeURIComponent produces strings whose `%` chars trip up
  // some Chromium versions when used as <img src>.
  const utf8 = unescape(encodeURIComponent(svgString));
  return 'data:image/svg+xml;base64,' + btoa(utf8);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e instanceof Error ? e : new Error('Image load failed'));
    img.src = src;
  });
}

async function rasterToPng(svgEl: SVGElement, width: number, height: number): Promise<string> {
  const xml = serializeSvg(svgEl);
  const dataUrl = svgStringToDataUrl(xml);
  const img = await loadImage(dataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * PIXEL_RATIO);
  canvas.height = Math.round(height * PIXEL_RATIO);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img as HTMLImageElement, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}

/* -------------------------------------------------------------------- */
/*  Public API                                                          */
/* -------------------------------------------------------------------- */

export async function exportPng(chart) {
  const ctx = await prepareExportSvg(chart);
  const dataUrl = await rasterToPng(ctx.clone, ctx.width, ctx.height);
  downloadHref(dataUrl, `org-chart-${ts()}.png`);
}

export async function exportSvg(chart) {
  const ctx = await prepareExportSvg(chart);
  const xml = serializeSvg(ctx.clone);
  const blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    downloadHref(url, `org-chart-${ts()}.svg`);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
}

export async function exportPdf(chart) {
  const ctx = await prepareExportSvg(chart);
  const dataUrl = await rasterToPng(ctx.clone, ctx.width, ctx.height);

  const orientation = ctx.width >= ctx.height ? 'landscape' : 'portrait';
  const pdf = new jsPDF({ orientation, unit: 'pt', format: 'a4' });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const margin = 24;
  const usableW = pageW - margin * 2;
  const usableH = pageH - margin * 2;
  const ratio = Math.min(usableW / ctx.width, usableH / ctx.height);
  const w = ctx.width * ratio;
  const h = ctx.height * ratio;
  const x = (pageW - w) / 2;
  const y = (pageH - h) / 2;
  pdf.addImage(dataUrl, 'PNG', x, y, w, h);
  pdf.save(`org-chart-${ts()}.pdf`);
}
