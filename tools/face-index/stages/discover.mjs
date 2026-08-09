/** Find the wedding photos and content-hash them (reusing hashes when size+mtime match). */

import fs from 'node:fs/promises';
import path from 'node:path';
import * as log from '../lib/log.mjs';

export async function discover(cfg, cache, root, opts = {}) {
  const dir = path.join(root, cfg.PHOTOS_DIR);
  let entries;
  try {
    // Deliberately NOT recursive: banner/, blog/ and work/ hold leftover
    // template art, never wedding photos.
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    throw new Error(`cannot read photos dir ${dir}: ${err.message}`);
  }

  const excluded = new Set(cfg.EXCLUDE_FILES.map((f) => f.toLowerCase()));
  const ignored = new Set((opts.ignorePhotos ?? []).map((s) => s.toLowerCase()));

  let skippedPattern = 0;
  const candidates = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (excluded.has(e.name.toLowerCase())) { skippedPattern++; continue; }
    const m = cfg.PHOTO_PATTERN.exec(e.name);
    if (!m) { skippedPattern++; continue; }
    const id = path.parse(e.name).name;
    if (ignored.has(id.toLowerCase())) { skippedPattern++; continue; }
    candidates.push({ id, name: e.name, path: path.join(dir, e.name), seq: Number(m[1]) });
  }

  // Sequential export names ARE the chronological order for this set, which is
  // why we never read EXIF capture times.
  candidates.sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));

  let selected = candidates;
  if (opts.only?.length) {
    const want = new Set(opts.only);
    selected = selected.filter((p) => want.has(p.id));
  }
  if (opts.limit) selected = selected.slice(0, opts.limit);

  for (const p of selected) {
    const stat = await fs.stat(p.path);
    p.sha1 = await cache.hashFile(p.path, stat);
    p.bytes = stat.size;
  }
  await cache.saveManifest();

  log.stage(1, 6, 'discover',
    `${log.c.bold(String(selected.length))} photos`
    + (skippedPattern ? log.c.dim(`  ·  ${skippedPattern} non-photo files excluded`) : '')
    + (selected.length !== candidates.length ? log.c.dim(`  ·  ${candidates.length - selected.length} filtered by flags`) : ''));

  if (!selected.length) {
    log.warn('discover', `no files matched ${cfg.PHOTO_PATTERN} in ${cfg.PHOTOS_DIR}`);
  }
  return selected;
}
