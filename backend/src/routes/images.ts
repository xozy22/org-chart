/**
 * Image upload + serve.
 *
 *   POST /api/images          → multipart upload, returns { url, bytes, type }
 *   GET  /api/images/:filename → serves the file with long-cache headers
 *
 * Storage: <DATA_DIR>/images/<uuid>.<ext>. Files are content-addressed by
 * a fresh UUID — never by the original filename — so two uploads with
 * the same client-side name don't collide.
 *
 * Implementation note:
 *   We use multer with memoryStorage() rather than diskStorage(). The
 *   destination callback in diskStorage() runs synchronously; doing
 *   `await fs.mkdir(...)` inside it had subtle timing issues in multer 2.x.
 *   With memoryStorage we get the buffer in `req.file.buffer`, validate
 *   permissions ourselves, write atomically via temp+rename. Cleaner and
 *   gives us better error messages when the data volume is misconfigured.
 *
 * Validation:
 *   - Allowed types: jpg/jpeg, png, gif, webp, svg
 *   - Max size:      5 MB (config: IMAGE_MAX_BYTES)
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { Router } from 'express';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import multer from 'multer';
import sharp from 'sharp';

const DATA_DIR = process.env.DATA_DIR ?? path.resolve(process.cwd(), 'data');
const IMAGE_DIR = path.join(DATA_DIR, 'images');
const MAX_BYTES = Number(process.env.IMAGE_MAX_BYTES ?? 5 * 1024 * 1024);
/** Longest edge in pixels — uploads larger than this are scaled down,
 *  smaller ones are passed through untouched. SVGs are never rasterised. */
const MAX_DIMENSION = Number(process.env.IMAGE_MAX_DIMENSION ?? 500);
/** JPEG / WebP quality (0–100). 85 is the standard "indistinguishable
 *  from original" sweet-spot for photographic content. */
const ENCODE_QUALITY = Number(process.env.IMAGE_QUALITY ?? 85);

/** Mapping of allowed MIME types → canonical extension. */
const ALLOWED: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
};

/**
 * Resize a raster image so its longest edge is at most MAX_DIMENSION,
 * preserving aspect ratio and never upscaling. Re-encodes in the same
 * format with reasonable quality so EXIF metadata + colour profiles
 * are stripped (smaller files, no privacy leaks).
 *
 * SVGs are passed through verbatim — vector content shouldn't be
 * rasterised on upload.
 *
 * Returns the new buffer plus the (possibly normalised) mime type and
 * extension. On any sharp error the original buffer is returned so an
 * unusual file format never blocks the upload entirely.
 */
async function compressImage(
  input: Buffer,
  mimeType: string,
): Promise<{ buffer: Buffer; mimeType: string; ext: string; resized: boolean }> {
  if (mimeType === 'image/svg+xml') {
    return { buffer: input, mimeType, ext: '.svg', resized: false };
  }

  try {
    // `animated: true` keeps multi-frame GIFs / animated WebP intact.
    const pipeline = sharp(input, { animated: mimeType === 'image/gif' || mimeType === 'image/webp' });
    const meta = await pipeline.metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    const needsResize = w > MAX_DIMENSION || h > MAX_DIMENSION;

    // `meta.hasAlpha` reports whether the FORMAT carries an alpha channel,
    // not whether any pixel is actually transparent. A PNG saved from
    // Photoshop with default settings always has an alpha channel even
    // for fully-opaque imagery — and that's the very case we want to
    // route to JPEG. Inspect the actual alpha range to find true
    // transparency.
    let hasAlpha = false;
    if (meta.hasAlpha) {
      try {
        const stats = await sharp(input).stats();
        const alphaCh = stats.channels?.[stats.channels.length - 1];
        hasAlpha = !!alphaCh && alphaCh.min < 255;
      } catch {
        hasAlpha = true; // fail safe: assume transparency, keep PNG
      }
    }

    // PNGs always get re-encoded (palette quantisation for transparent
    // ones, JPEG conversion for opaque ones — PNG is lossless and bloats
    // photographic content 5–10×). For other formats we only run the
    // pipeline when a resize is actually needed; re-encoding small JPEG/
    // WebP/GIF can paradoxically grow the file due to decode-encode
    // round-trip overhead.
    if (!needsResize && mimeType !== 'image/png') {
      return {
        buffer: input,
        mimeType,
        ext: ALLOWED[mimeType] ?? '.bin',
        resized: false,
      };
    }

    const resized = needsResize
      ? pipeline.resize({
          width: MAX_DIMENSION,
          height: MAX_DIMENSION,
          fit: 'inside',
          withoutEnlargement: true,
        })
      : pipeline;

    // Smart format selection — match what image-CDNs (Cloudinary, Imgix)
    // do. The goal is "smallest file for visually identical output":
    //   - opaque PNG  → JPEG (PNG is lossless and bloats photos 5–10×)
    //   - PNG w/alpha → PNG with palette quantisation (preserves transparency, much smaller)
    //   - JPEG        → JPEG re-encoded
    //   - WebP        → WebP re-encoded
    //   - GIF         → GIF re-encoded (animation preserved)

    let buffer: Buffer;
    let outMime = mimeType;
    let outExt = ALLOWED[mimeType] ?? '.bin';

    if (mimeType === 'image/png' && !hasAlpha) {
      buffer = await resized.jpeg({ quality: ENCODE_QUALITY, mozjpeg: true }).toBuffer();
      outMime = 'image/jpeg';
      outExt = '.jpg';
    } else if (mimeType === 'image/png') {
      // Palette PNGs are dramatically smaller than full-RGB at the cost of
      // <=256 colours — fine for icons / logos / UI shots which is what
      // PNGs with transparency usually are.
      buffer = await resized.png({ compressionLevel: 9, palette: true }).toBuffer();
    } else if (mimeType === 'image/webp') {
      buffer = await resized.webp({ quality: ENCODE_QUALITY }).toBuffer();
    } else if (mimeType === 'image/gif') {
      buffer = await resized.gif().toBuffer();
    } else {
      // image/jpeg + fallback for any other raster the filter let through.
      buffer = await resized.jpeg({ quality: ENCODE_QUALITY, mozjpeg: true }).toBuffer();
      outMime = 'image/jpeg';
      outExt = '.jpg';
    }

    // Defensive: if the resize+re-encode somehow produced a larger file
    // than the original, keep the original — never bloat an upload.
    if (buffer.length >= input.length) {
      return {
        buffer: input,
        mimeType,
        ext: ALLOWED[mimeType] ?? '.bin',
        resized: false,
      };
    }

    return { buffer, mimeType: outMime, ext: outExt, resized: needsResize };
  } catch (err) {
    console.warn(
      '[images] sharp failed to process upload, storing original:',
      (err as Error).message,
    );
    return {
      buffer: input,
      mimeType,
      ext: ALLOWED[mimeType] ?? '.bin',
      resized: false,
    };
  }
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(IMAGE_DIR, { recursive: true });
}

// Best-effort warm-up at boot — surfaces a clear hint if the volume is
// not writable, but doesn't crash the server (the user can still browse
// in read-only mode and external image URLs still work).
ensureDir()
  .then(() => console.log(`[images] storage ready at ${IMAGE_DIR}`))
  .catch((err) =>
    console.warn(
      `[images] could not create image dir on boot: ${(err as Error).message} ` +
        `(uploads will fail with 503 until this is fixed)`,
    ),
  );

// In-memory storage — lets us catch all errors in our own handler.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED[file.mimetype]) cb(null, true);
    else cb(new Error(`Unsupported image type: ${file.mimetype}`));
  },
});

export const imagesRouter: Router = Router();

/* --------- Upload ----------------------------------------------------- */
imagesRouter.post(
  '/images',
  // Wrap multer so its own errors (e.g. file-too-large, type-rejected)
  // become JSON instead of HTML error pages.
  (req: Request, res: Response, next: NextFunction) => {
    upload.single('image')(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          res.status(413).json({
            error: `Image too large — max ${Math.round(MAX_BYTES / 1024 / 1024)} MB`,
          });
        } else {
          res.status(400).json({ error: err.message, code: err.code });
        }
        return;
      }
      if (err instanceof Error) {
        res.status(400).json({ error: err.message });
        return;
      }
      if (err) {
        res.status(400).json({ error: 'Upload failed', detail: String(err) });
        return;
      }
      next();
    });
  },
  // Storage handler — compress, write the buffer to disk atomically, and
  // forward all rejections through so they get mapped to a real HTTP code.
  ((req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      try {
        const file = (req as Request & { file?: Express.Multer.File }).file;
        if (!file || !file.buffer) {
          res.status(400).json({
            error: 'No image uploaded — expected multipart field "image"',
          });
          return;
        }

        // Resize / re-encode (skip for SVG). Falls back to the original
        // buffer on any sharp error so weird-but-valid uploads still work.
        const compressed = await compressImage(file.buffer, file.mimetype);

        const filename = `${randomUUID()}${compressed.ext}`;
        const finalPath = path.join(IMAGE_DIR, filename);
        const tmpPath = `${finalPath}.tmp-${Date.now()}`;

        // Write to tmp then rename so partially-written files never appear.
        try {
          await ensureDir();
          await fs.writeFile(tmpPath, compressed.buffer);
          await fs.rename(tmpPath, finalPath);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException)?.code;
          // Volume permission problems → 503 with actionable hint.
          if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
            console.error('[images] storage write failed:', err);
            res.status(503).json({
              error: 'Storage volume is not writable',
              code,
              hint:
                'The container cannot write to the data directory. Fix the host directory ' +
                'permissions (chmod -R a+rwX <data-dir>) or run with --user $(id -u):$(id -g).',
            });
            return;
          }
          // Try to clean up the tmp file but don't worry if it's not there.
          try { await fs.rm(tmpPath, { force: true }); } catch { /* ignore */ }
          throw err;
        }

        // Log the compression ratio so an operator can see at a glance how
        // much disk the resize step is saving (also useful for tuning the
        // MAX_DIMENSION env var to fit a particular dataset).
        if (compressed.resized || compressed.buffer.length !== file.size) {
          const pct = Math.round((compressed.buffer.length / file.size) * 100);
          console.log(
            `[images] ${file.originalname || filename}: ${file.size} → ${compressed.buffer.length} bytes (${pct}%)` +
              (compressed.resized ? ` resized to fit ${MAX_DIMENSION}px` : ' re-encoded'),
          );
        }

        res.status(201).json({
          url: `/api/images/${filename}`,
          bytes: compressed.buffer.length,
          originalBytes: file.size,
          type: compressed.mimeType,
          resized: compressed.resized,
        });
      } catch (err) {
        // Last-resort error path — surface as much detail as we safely can.
        console.error('[images] unexpected upload error:', err);
        next(err);
      }
    })();
  }) as RequestHandler,
);

/* --------- Serve ------------------------------------------------------ */
imagesRouter.get('/images/:filename', (req: Request, res: Response) => {
  // Path-traversal guard: strip directory components, only allow basename.
  const safe = path.basename(req.params.filename);
  if (safe !== req.params.filename || safe.startsWith('.')) {
    res.status(400).json({ error: 'Invalid filename' });
    return;
  }
  const fullPath = path.join(IMAGE_DIR, safe);
  res.sendFile(fullPath, {
    maxAge: '30d',
    immutable: true,
    headers: { 'X-Content-Type-Options': 'nosniff' },
  }, (err) => {
    if (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' && !res.headersSent) {
        res.status(404).json({ error: 'Image not found' });
      } else if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to read image' });
      }
    }
  });
});
