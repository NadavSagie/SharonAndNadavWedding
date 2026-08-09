/**
 * Per-photo analysis cache. Gitignored, because it holds face DESCRIPTORS —
 * biometric data that must never be committed or published.
 *
 * Written per photo, so a kill -9 loses at most one photo's work.
 * A photo is re-analysed only when its content hash changes or the detection
 * fingerprint changes; retuning clustering or derivative settings does not
 * invalidate detection.
 */

import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class Cache {
  constructor(rootDir) {
    this.root = rootDir;
    this.photosDir = path.join(rootDir, 'photos');
    this.manifestPath = path.join(rootDir, 'manifest.json');
    this.manifest = { version: 1, entries: {} };
  }

  async load() {
    await fs.mkdir(this.photosDir, { recursive: true });
    try {
      this.manifest = JSON.parse(await fs.readFile(this.manifestPath, 'utf8'));
      if (!this.manifest.entries) this.manifest.entries = {};
    } catch {
      this.manifest = { version: 1, entries: {} };
    }
    // A README inside the cache, so nobody is tempted to commit it later.
    await fs.writeFile(
      path.join(this.root, 'DO-NOT-COMMIT.txt'),
      'This folder contains face descriptors (biometric data) for the wedding photos.\n'
      + 'It is gitignored on purpose. Do not commit it and do not upload it anywhere.\n'
      + 'Deleting it is always safe: `npm run index-faces` will regenerate it.\n',
    ).catch(() => {});
  }

  async saveManifest() {
    await fs.writeFile(this.manifestPath, JSON.stringify(this.manifest), 'utf8');
  }

  /** sha1 of file contents, reused from the manifest when size+mtime are unchanged. */
  async hashFile(file, stat) {
    const prev = this.manifest.entries[file];
    if (prev && prev.size === stat.size && prev.mtimeMs === stat.mtimeMs && prev.sha1) {
      return prev.sha1;
    }
    const sha1 = await new Promise((resolve, reject) => {
      const h = crypto.createHash('sha1');
      const s = createReadStream(file);
      s.on('data', (d) => h.update(d));
      s.on('end', () => resolve(h.digest('hex')));
      s.on('error', reject);
    });
    this.manifest.entries[file] = { size: stat.size, mtimeMs: stat.mtimeMs, sha1 };
    return sha1;
  }

  entryPath(sha1) {
    return path.join(this.photosDir, `${sha1}.json`);
  }

  async read(sha1, fingerprint) {
    try {
      const raw = JSON.parse(await fs.readFile(this.entryPath(sha1), 'utf8'));
      if (raw.fingerprint !== fingerprint) return null;
      if (raw.status === 'ok') {
        // Descriptors round-trip as plain arrays; restore the typed form.
        for (const f of raw.result.faces) f.descriptor = Float32Array.from(f.descriptor);
      }
      return raw;
    } catch {
      return null;
    }
  }

  async write(sha1, fingerprint, payload) {
    const serialisable = JSON.parse(JSON.stringify(payload, (k, v) => (
      v instanceof Float32Array ? Array.from(v).map((n) => Number(n.toFixed(5))) : v
    )));
    await fs.writeFile(
      this.entryPath(sha1),
      JSON.stringify({ fingerprint, ...serialisable }),
      'utf8',
    );
  }

  async clear() {
    await fs.rm(this.root, { recursive: true, force: true });
  }
}
