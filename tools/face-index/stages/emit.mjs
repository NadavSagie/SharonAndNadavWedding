/**
 * Write the public data files.
 *
 * PRIVACY CONTRACT — the files written here are published to the open internet:
 *   - NO face descriptors / embeddings (biometric data; they stay in .face-cache)
 *   - NO landmark coordinates
 *   - NO EXIF, no capture times, no GPS, no camera serial
 *   - hidden people appear nowhere, including in photoFaces attribution
 *
 * Split into three files because a single index would be ~2.5 MB at 2000 photos:
 *   photos.json      required, small, loaded first
 *   people.json      optional overlay; absent => site degrades to a plain gallery
 *   photo-faces.json fetched lazily, only on the first lightbox open
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import * as log from '../lib/log.mjs';
import { normaliseBox } from '../lib/geometry.mjs';

async function writeJson(file, obj) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(obj), 'utf8');
  const { size } = await fs.stat(file);
  return size;
}

export async function emit(cfg, root, photos, analysis, result, meta) {
  const dataDir = path.join(root, cfg.DATA_DIR);
  const outDir = path.join(root, cfg.OUT_DIR);
  const generatedAt = new Date().toISOString();

  // ---- photos.json --------------------------------------------------------
  const photoList = [];
  for (const p of photos) {
    const r = analysis.get(p.id);
    if (!r) continue; // failed to analyse -> not shippable
    photoList.push({
      id: p.id,
      w: r.width,
      h: r.height,
      c: r.colour,
      dg: result.dupeGroups.get(p.id) ?? 0,
    });
  }
  const photosBytes = await writeJson(path.join(dataDir, 'photos.json'), {
    v: 1, generatedAt, photos: photoList,
  });

  // ---- people.json --------------------------------------------------------
  const visible = result.people;
  const peopleOut = visible.map((p) => {
    const photoIds = [...new Set(p.scored.map((s) => s.photoId))]
      .sort((a, b) => photoList.findIndex((x) => x.id === a) - photoList.findIndex((x) => x.id === b));
    return {
      id: p.id,
      ordinal: p.ordinal,
      name: p.name ?? null,
      featured: p.featured || undefined,
      photoCount: photoIds.length,
      photos: photoIds,
    };
  });
  const peopleBytes = await writeJson(path.join(dataDir, 'people.json'), {
    v: 1, generatedAt, people: peopleOut,
  });

  // ---- photo-faces.json ---------------------------------------------------
  // Only faces attributed to a VISIBLE person are published. Unassigned and
  // hidden faces are omitted entirely rather than published as person:null —
  // there is no reason to tell the world where an unidentified face is.
  const personOfFace = new Map();
  for (const p of visible) for (const s of p.scored) personOfFace.set(s.faceId, p.id);

  const facesByPhoto = {};
  for (const p of photos) {
    const r = analysis.get(p.id);
    if (!r) continue;
    const list = [];
    for (const f of r.faces) {
      const pid = personOfFace.get(f.id);
      if (!pid) continue;
      list.push({ p: pid, b: normaliseBox(f.boxPx, r.width, r.height) });
    }
    if (list.length) facesByPhoto[p.id] = list;
  }
  const facesBytes = await writeJson(path.join(dataDir, 'photo-faces.json'), {
    v: 1, generatedAt, faces: facesByPhoto,
  });

  // ---- review.json (local working file, safe to commit: no biometrics) -----
  const nameOf = new Map(visible.map((p) => [p.id, p.name ?? `Guest ${p.ordinal}`]));
  const reviewOut = {
    generatedAt,
    note: 'Borderline cluster pairs worth a human decision, plus run warnings. '
      + 'Resolve them by editing face-index/overrides.json, then run `npm run index-faces:recluster`.',
    thresholds: {
      FACE_SIMILARITY_THRESHOLD: cfg.FACE_SIMILARITY_THRESHOLD,
      SAME_PHOTO_MERGE_THRESHOLD: cfg.SAME_PHOTO_MERGE_THRESHOLD,
      reviewBand: [cfg.FACE_SIMILARITY_THRESHOLD, cfg.FACE_SIMILARITY_THRESHOLD + cfg.MERGE_REVIEW_MARGIN],
    },
    stats: meta.stats,
    mergeCandidates: result.reviewPairs.slice(0, 200).map((r) => ({
      distance: r.d,
      hint: 'if these are the same person, add ["<idA>","<idB>"] to "merge" in overrides.json',
    })),
    people: visible.map((p) => ({
      id: p.id,
      name: nameOf.get(p.id),
      photoCount: new Set(p.scored.map((s) => s.photoId)).size,
      faceCount: p.scored.length,
      cover: p.cover?.faceId ?? null,
      coverQuality: p.cover ? Number(p.cover.q.toFixed(3)) : null,
      samplePhotos: [...new Set(p.scored.map((s) => s.photoId))].slice(0, 12),
    })),
    staleOverrides: result.stale ?? [],
    warnings: log.tally.warnings.slice(0, 400),
    errors: log.tally.errors,
  };
  const reviewBytes = await writeJson(path.join(outDir, 'review.json'), reviewOut);

  log.stage(6, 6, 'emit',
    `photos.json ${log.fmtBytes(photosBytes)}`
    + `  ·  people.json ${log.fmtBytes(peopleBytes)}`
    + `  ·  photo-faces.json ${log.fmtBytes(facesBytes)}`);
  log.info(log.c.dim(`face-index/review.json ${log.fmtBytes(reviewBytes)} — borderline pairs and per-person summary`));

  return { photosBytes, peopleBytes, facesBytes, reviewBytes, photoCount: photoList.length };
}
