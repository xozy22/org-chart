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

type RasterOpts = {
  /** Output pixel multiplier vs the SVG's own coordinate system. */
  pixelRatio?: number;
  /** "image/png" (lossless, big) or "image/jpeg" (lossy, much smaller). */
  format?: 'image/png' | 'image/jpeg';
  /** JPEG quality 0..1. Ignored for PNG. */
  quality?: number;
};

async function rasterToDataUrl(
  svgEl: SVGElement,
  width: number,
  height: number,
  opts: RasterOpts = {},
): Promise<string> {
  const { pixelRatio = PIXEL_RATIO, format = 'image/png', quality } = opts;
  const xml = serializeSvg(svgEl);
  const dataUrl = svgStringToDataUrl(xml);
  const img = await loadImage(dataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * pixelRatio));
  canvas.height = Math.max(1, Math.round(height * pixelRatio));
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img as HTMLImageElement, 0, 0, canvas.width, canvas.height);
  return format === 'image/jpeg'
    ? canvas.toDataURL('image/jpeg', quality ?? 0.92)
    : canvas.toDataURL('image/png');
}

/* -------------------------------------------------------------------- */
/*  Public API                                                          */
/* -------------------------------------------------------------------- */

export async function exportPng(chart) {
  const ctx = await prepareExportSvg(chart);
  const dataUrl = await rasterToDataUrl(ctx.clone, ctx.width, ctx.height, {
    format: 'image/png',
  });
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

/* -------------------------------------------------------------------- */
/*  PDF page-size selection                                              */
/* -------------------------------------------------------------------- */

/** ISO 216 A-series in PDF points (1 pt = 1/72 inch), short-edge ascending. */
const A_SERIES_SHORT = { a4: 595, a3: 842, a2: 1191, a1: 1684, a0: 2384 };
const A_SERIES_LONG = { a4: 842, a3: 1191, a2: 1684, a1: 2384, a0: 3370 };
const A_FORMATS = ['a4', 'a3', 'a2', 'a1', 'a0'] as const;
type AFormat = (typeof A_FORMATS)[number];

/** Card width in SVG coordinates — must stay in sync with `nodeWidth` in chart.ts. */
const SVG_CARD_WIDTH = 270;
/** Minimum on-page card width before names become hard to read.
 *  72 pt = 1 inch ≈ 2.54 cm — small but still legible at 200 DPI.
 *  Below this we step up to the next A-size. */
const MIN_CARD_PT = 72;
const PDF_MARGIN_PT = 24;

/**
 * Pick the smallest A-series page size where each card still gets at
 * least MIN_CARD_PT of horizontal real estate. Falls back to A0 for
 * truly enormous charts — at that point the user almost certainly
 * wants a plotter or split exports, but a too-tight A0 is still more
 * useful than a blurry A4.
 */
function pickPdfFormat(svgW: number, svgH: number): {
  format: AFormat;
  orientation: 'landscape' | 'portrait';
  pageW: number;
  pageH: number;
  pageRatio: number;
} {
  const orientation: 'landscape' | 'portrait' =
    svgW >= svgH ? 'landscape' : 'portrait';
  for (const fmt of A_FORMATS) {
    const long = A_SERIES_LONG[fmt];
    const short = A_SERIES_SHORT[fmt];
    const pageW = orientation === 'landscape' ? long : short;
    const pageH = orientation === 'landscape' ? short : long;
    const usableW = pageW - PDF_MARGIN_PT * 2;
    const usableH = pageH - PDF_MARGIN_PT * 2;
    const pageRatio = Math.min(usableW / svgW, usableH / svgH);
    if (SVG_CARD_WIDTH * pageRatio >= MIN_CARD_PT || fmt === 'a0') {
      return { format: fmt, orientation, pageW, pageH, pageRatio };
    }
  }
  // Unreachable — the loop returns on a0 if nothing else matched.
  throw new Error('No PDF format selected');
}

export async function exportPdf(chart) {
  const ctx = await prepareExportSvg(chart);

  // Pick the smallest standard page that keeps cards readable. Most
  // charts fit A4; very large ones step up through A3/A2/A1/A0.
  const { format, orientation, pageW, pageH, pageRatio } = pickPdfFormat(
    ctx.width,
    ctx.height,
  );
  const pdf = new jsPDF({ orientation, unit: 'pt', format });

  const w = ctx.width * pageRatio;
  const h = ctx.height * pageRatio;
  const x = (pageW - w) / 2;
  const y = (pageH - h) / 2;

  // Render the bitmap at the resolution the PDF actually consumes
  // instead of `chart_size × 2`. PDF user units are 1/72 inch, so
  // (w / ctx.width) is the SVG-px → PDF-pt ratio; multiplying by
  // (TARGET_DPI / 72) gives the SVG-px → output-px ratio. At 200 DPI
  // every print fits the page sharply, but the embedded bitmap is a
  // fraction of what the previous 2× pass produced. JPEG @ 0.92 is
  // visually indistinguishable from PNG for this content and another
  // 5–10× smaller on top.
  const TARGET_DPI = 200;
  const pixelRatio = (w / ctx.width) * (TARGET_DPI / 72);
  const dataUrl = await rasterToDataUrl(ctx.clone, ctx.width, ctx.height, {
    pixelRatio,
    format: 'image/jpeg',
    quality: 0.92,
  });

  pdf.addImage(dataUrl, 'JPEG', x, y, w, h, undefined, 'FAST');
  pdf.save(`org-chart-${ts()}.pdf`);
}
