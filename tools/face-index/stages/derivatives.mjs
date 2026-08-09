/**
 * Generate the images that actually ship.
 *
 * ONE full-resolution decode per photo serves the thumbnail, the lightbox image
 * and any cover crops sourced from it. Calling sharp(file).extract() per crop
 * would re-decode a 40 MP JPEG every time.
 *
 * Nothing here calls .withMetadata(), so sharp strips EXIF from every output.
 * Venue GPS is the real exposure in a wedding set and it dies at the encoder.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import * as log from '../lib/log.mjs';
import { sharp } from '../lib/image.mjs';
import { squarePaddedBox } from '../lib/geometry.mjs';
import { mapPool } from '../lib/pool.mjs';

const exists = (p) => fs.access(p).then(() => true, () => false);

export async function derivatives(cfg, root, photos, people, analysis, opts = {}) {
  const outThumbs = path.join(root, cfg.DERIV_DIR, 'thumbs');
  const outPhotos = path.join(root, cfg.DERIV_DIR, 'photos');
  const outCovers = path.join(root, cfg.DERIV_DIR, 'covers');
  await fs.mkdir(outThumbs, { recursive: true });
  await fs.mkdir(outPhotos, { recursive: true });
  await fs.mkdir(outCovers, { recursive: true });

  // Which cover crops come from which photo, so we extract them during that
  // photo's single decode.
  const coversByPhoto = new Map();
  for (const p of people) {
    if (!p.cover) continue;
    const list = coversByPhoto.get(p.cover.photoId) ?? [];
    list.push({ personId: p.id, faceId: p.cover.faceId });
    coversByPhoto.set(p.cover.photoId, list);
  }

  const faceBoxById = new Map();
  for (const [photoId, r] of analysis) {
    for (const f of r.faces) faceBoxById.set(f.id, { ...f.boxPx, photoId });
  }

  let written = 0;
  let skipped = 0;
  let coversWritten = 0;
  let bytes = 0;
  let done = 0;

  await mapPool(photos, cfg.DERIV_CONCURRENCY, async (photo) => {
    const thumbPath = path.join(outThumbs, `${photo.id}.webp`);
    const photoPath = path.join(outPhotos, `${photo.id}.webp`);
    const covers = coversByPhoto.get(photo.id) ?? [];

    const needThumb = opts.force || !(await exists(thumbPath));
    const needPhoto = opts.force || !(await exists(photoPath));
    // Covers are cheap and the chosen face can change between runs, so always redo.
    const needCovers = covers.length > 0;

    if (!needThumb && !needPhoto && !needCovers) {
      skipped++;
      done++;
      log.progress(done, photos.length);
      return;
    }

    try {
      const { data, info } = await sharp(photo.path, { failOn: 'none', limitInputPixels: cfg.MAX_INPUT_PIXELS })
        .rotate()
        .removeAlpha()
        .toColourspace('srgb')
        .raw()
        .toBuffer({ resolveWithObject: true });

      const raw = { width: info.width, height: info.height, channels: info.channels };
      const from = () => sharp(data, { raw });

      if (needPhoto) {
        const out = await from()
          .resize({ width: cfg.PHOTO_LONG_EDGE, height: cfg.PHOTO_LONG_EDGE, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: cfg.PHOTO_QUALITY, effort: cfg.WEBP_EFFORT })
          .toFile(photoPath);
        bytes += out.size;
        written++;
      }
      if (needThumb) {
        const out = await from()
          .resize({ width: cfg.THUMB_LONG_EDGE, height: cfg.THUMB_LONG_EDGE, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: cfg.THUMB_QUALITY, effort: cfg.WEBP_EFFORT })
          .toFile(thumbPath);
        bytes += out.size;
        written++;
      }

      for (const cover of covers) {
        const box = faceBoxById.get(cover.faceId);
        if (!box) { log.warn(photo.id, `cover face ${cover.faceId} not found`); continue; }
        try {
          const sq = squarePaddedBox(box, cfg.FACE_CROP_PADDING, info.width, info.height);
          const out = await from()
            .extract({ left: sq.x, top: sq.y, width: sq.w, height: sq.h })
            .resize(cfg.COVER_CROP_SIZE, cfg.COVER_CROP_SIZE, { fit: 'cover' })
            .webp({ quality: cfg.COVER_QUALITY, effort: cfg.WEBP_EFFORT })
            .toFile(path.join(outCovers, `${cover.personId}.webp`));
          bytes += out.size;
          coversWritten++;
        } catch (err) {
          // One bad crop must not cost us the photo's other outputs.
          log.warn(photo.id, `cover crop for ${cover.personId} failed: ${String(err.message).split('\n')[0]}`);
        }
      }
    } catch (err) {
      log.error(photo.id, `derivatives failed: ${String(err.message).split('\n')[0]}`);
    }

    done++;
    log.progress(done, photos.length);
  });

  log.endProgress();

  // Measure the whole deployed image folder, not just this run's writes.
  let totalBytes = 0;
  let totalFiles = 0;
  for (const dir of [outThumbs, outPhotos, outCovers]) {
    for (const f of await fs.readdir(dir).catch(() => [])) {
      const st = await fs.stat(path.join(dir, f)).catch(() => null);
      if (st?.isFile()) { totalBytes += st.size; totalFiles++; }
    }
  }

  log.stage(5, 6, 'derivatives',
    `${log.c.bold(String(written))} images + ${coversWritten} covers`
    + log.c.dim(`  ·  ${skipped} unchanged  ·  ${log.fmtBytes(totalBytes)} total`));

  const budget = cfg.SIZE_BUDGET_MB * 1024 * 1024;
  if (totalBytes > budget) {
    log.warn('size', `${log.fmtBytes(totalBytes)} of derivatives exceeds the ${cfg.SIZE_BUDGET_MB} MB budget.`);
    log.warn('size', 'GitHub Pages has a HARD 1 GB limit for the published site.');
    log.warn('size', `Remedies: lower PHOTO_LONG_EDGE (now ${cfg.PHOTO_LONG_EDGE}) or PHOTO_QUALITY `
      + `(now ${cfg.PHOTO_QUALITY}) in tools/face-index/config.mjs, or move hosting to `
      + 'Cloudflare Pages, which has no such cap.');
  }

  return { written, skipped, coversWritten, totalBytes, totalFiles };
}
