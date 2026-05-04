/**
 * Image upload + serve.
 *
 *   POST /api/images          → multipart upload, returns { url: '/api/images/<id>.<ext>' }
 *   GET  /api/images/:filename → serves the file with long-cache headers
 *
 * Storage: <DATA_DIR>/images/<uuid>.<ext>. Files are content-addressed by
 * a fresh UUID — never by the original filename — so two uploads with
 * the same client-side name don't collide.
 *
 * Lifecycle: images are kept indefinitely. We don't delete them when
 * a node is deleted because:
 *   - cheap on disk (a few KB to a few MB per avatar)
 *   - removing them would race chart-edit transactions, risk data loss
 *     when the same image is referenced elsewhere, and complicate
 *     undo/redo (the URL would 404 after a node delete + undo)
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

const DATA_DIR = process.env.DATA_DIR ?? path.resolve(process.cwd(), 'data');
const IMAGE_DIR = path.join(DATA_DIR, 'images');
const MAX_BYTES = Number(process.env.IMAGE_MAX_BYTES ?? 5 * 1024 * 1024);

/** Mapping of allowed MIME types → canonical extension. */
const ALLOWED: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
};

async function ensureDir(): Promise<void> {
  await fs.mkdir(IMAGE_DIR, { recursive: true });
}

// We only run mkdir lazily — the server might start with the volume not
// yet writable, and the entrypoint logs that case clearly.
ensureDir().catch((err) => {
  console.warn('[images] could not create image dir on boot:', (err as Error).message);
});

const upload = multer({
  storage: multer.diskStorage({
    destination: async (_req, _file, cb) => {
      try {
        await ensureDir();
        cb(null, IMAGE_DIR);
      } catch (err) {
        cb(err as Error, IMAGE_DIR);
      }
    },
    filename: (_req, file, cb) => {
      const ext = ALLOWED[file.mimetype] ?? '.bin';
      cb(null, `${randomUUID()}${ext}`);
    },
  }),
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
  // Wrap multer so multer's own errors (e.g. file-too-large) become a
  // proper JSON 400 rather than the default HTML error page.
  (req: Request, res: Response, next: NextFunction) => {
    upload.single('image')(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({
            error: `Image too large — max ${Math.round(MAX_BYTES / 1024 / 1024)} MB`,
          });
        }
        return res.status(400).json({ error: err.message });
      }
      if (err instanceof Error) return res.status(400).json({ error: err.message });
      next();
    });
  },
  ((req: Request, res: Response) => {
    const file = (req as Request & { file?: Express.Multer.File }).file;
    if (!file) {
      res.status(400).json({ error: 'No image uploaded — expected multipart field "image"' });
      return;
    }
    res.status(201).json({
      url: `/api/images/${file.filename}`,
      bytes: file.size,
      type: file.mimetype,
    });
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
