/**
 * Composite face-quality score in [0,1], used for ranking and for choosing the
 * cover crop that represents a person on the People page.
 *
 * No single term works alone:
 *   - largest        -> a huge motion-blurred face wins
 *   - highest score  -> SSD scores saturate at 0.99 for dozens of faces
 *   - nearest centroid -> centroids drift toward whichever pose is
 *                       over-represented, so this is a VETO term, weighted
 *                       lowest, guarding against picking a misassigned face
 */

export function faceQuality(face, centrality, cfg) {
  const w = cfg.QUALITY_WEIGHTS;
  const size = Math.min(1, face.nativeWidth / cfg.QUALITY_SIZE_SATURATION_PX);
  // sharpness is stored as a raw Laplacian sigma; -1 means it could not be measured.
  const sharp = face.sharpness < 0
    ? 0.5
    : Math.min(1, face.sharpness / cfg.SHARPNESS_SATURATION_SIGMA);
  const q = w.size * size
    + w.detection * face.score
    + w.frontality * face.frontality
    + w.sharpness * sharp
    + w.centrality * centrality;
  return Math.max(0, Math.min(1, q));
}

/** Group photos into burst/near-duplicate sets by perceptual-hash distance.
 *  Returns a Map photoId -> groupIndex. Burst frames otherwise inflate a
 *  person's apparent photo count and drag their cluster centroid toward one
 *  moment of the evening. */
export function groupNearDuplicates(photos, hamming, maxDistance) {
  const groups = new Map();
  const reps = []; // { hash, index }
  for (const p of photos) {
    if (!p.phash) { groups.set(p.id, reps.length); reps.push({ hash: null, index: reps.length }); continue; }
    let found = -1;
    for (const r of reps) {
      if (r.hash && hamming(r.hash, p.phash) <= maxDistance) { found = r.index; break; }
    }
    if (found >= 0) {
      groups.set(p.id, found);
    } else {
      groups.set(p.id, reps.length);
      reps.push({ hash: p.phash, index: reps.length });
    }
  }
  return groups;
}

/** How many distinct non-burst moments a cluster spans. This, not raw face
 *  count, is what "photoCount" should rank on. */
export function distinctGroups(photoIds, dupeGroups) {
  const s = new Set();
  for (const id of photoIds) s.add(dupeGroups.get(id) ?? id);
  return s.size;
}
