/**
 * Tier-2 identity consolidation.
 *
 * Runs AFTER clusterFaces() (tier 1, average-linkage) has already formed clean
 * clusters. Tier 1 is left completely unchanged — this is an independent pass
 * that fixes a specific, diagnosed failure mode: the same person split across
 * several clusters because average-linkage's distance to a large, appearance-
 * diverse cluster inflates with that cluster's own internal heterogeneity,
 * regardless of whether a new fragment genuinely belongs to it.
 *
 * Method: compare CENTROIDS (mean embeddings) of already-formed clusters, not
 * raw pairwise distances. A centroid built from many corroborating faces is a
 * multi-reference-embedding representation of a person and does not inflate
 * with population diversity the way average-linkage does. Every accepted merge
 * additionally requires a genuine close RAW face-to-face pair between the two
 * clusters (see IDENTITY_CONSOLIDATION_MIN_RAW_PAIR) — this stops two clusters'
 * means from being accepted purely because they coincidentally align with no
 * individual pair of faces actually resembling each other.
 *
 * The auto-merge threshold is deliberately far tighter than tier 1's — see the
 * calibration note in config.mjs. Pairs in the gray zone between the merge
 * threshold and the review ceiling are reported, never silently merged.
 */

function dist(a, b, dim) {
  let s = 0;
  for (let k = 0; k < dim; k++) { const d = a[k] - b[k]; s += d * d; }
  return Math.sqrt(s);
}

function minRawPairDistance(membersA, membersB, faces, dim) {
  let best = Infinity;
  for (const i of membersA) {
    const a = faces[i].descriptor;
    for (const j of membersB) {
      const d = dist(a, faces[j].descriptor, dim);
      if (d < best) best = d;
      if (best === 0) return 0;
    }
  }
  return best;
}

export function consolidateIdentities(faces, clusters, cfg, onProgress = () => {}) {
  if (clusters.length < 2) return { clusters, mergeCount: 0, identityReviewPairs: [] };
  const dim = faces[0].descriptor.length;

  const sumOf = (members) => {
    const s = new Float64Array(dim);
    for (const i of members) {
      const d = faces[i].descriptor;
      for (let k = 0; k < dim; k++) s[k] += d[k];
    }
    return s;
  };

  const nodes = clusters.map((c) => ({
    members: [...c.members],
    photos: new Set(c.photos),
    sum: sumOf(c.members),
  }));

  function allCentroids() {
    return nodes.map((n) => {
      if (!n) return null;
      const c = new Float64Array(dim);
      for (let k = 0; k < dim; k++) c[k] = n.sum[k] / n.members.length;
      return c;
    });
  }

  // Pairs whose centroids qualified but failed raw-face corroboration. Blocked
  // permanently rather than re-checked: corroboration is based on raw
  // descriptors, which never change, so a failed check can only be revisited by
  // NEW faces arriving via a merge on either side — a real but rare second-order
  // case; erring toward requiring an explicit human decision here is consistent
  // with this project's "prefer over-segmentation" stance, not a bug.
  const blocked = new Set();

  let mergeCount = 0;
  let iterations = 0;
  const maxIterations = nodes.length * nodes.length + nodes.length; // generous, finite bound

  for (;;) {
    iterations++;
    if (iterations > maxIterations) break; // defensive; should never trigger

    const cens = allCentroids();
    let bestI = -1;
    let bestJ = -1;
    let bestD = Infinity;

    for (let i = 0; i < nodes.length; i++) {
      if (!nodes[i]) continue;
      for (let j = i + 1; j < nodes.length; j++) {
        if (!nodes[j] || blocked.has(`${i},${j}`)) continue;
        const d = dist(cens[i], cens[j], dim);
        if (d < bestD) { bestD = d; bestI = i; bestJ = j; }
      }
    }

    if (bestI < 0 || bestD > cfg.IDENTITY_CONSOLIDATION_THRESHOLD) break;

    const a = nodes[bestI];
    const b = nodes[bestJ];
    const minRaw = minRawPairDistance(a.members, b.members, faces, dim);
    if (minRaw > cfg.IDENTITY_CONSOLIDATION_MIN_RAW_PAIR) {
      // Centroids align, but no individual face pair corroborates it — exactly
      // the coincidental-mean case the guard exists for. Skip permanently and
      // let the next iteration find the next-best (still-eligible) pair.
      blocked.add(`${bestI},${bestJ}`);
      continue;
    }

    // Commit the merge: a absorbs b.
    for (const i of b.members) a.members.push(i);
    for (let k = 0; k < dim; k++) a.sum[k] += b.sum[k];
    for (const p of b.photos) a.photos.add(p);
    nodes[bestJ] = null;
    mergeCount++;
    onProgress('consolidate', mergeCount, nodes.length);
  }

  // Final pass: report gray-zone pairs among whatever remains, for optional
  // manual merging. Covers both "never reached threshold" and "reached
  // threshold but failed raw-pair corroboration" — inferring which from the
  // final distance value alone is correct, since any pair still <= threshold
  // at this point was necessarily blocked by corroboration (real candidates
  // were already committed above).
  const alive = nodes.map((n, i) => (n ? i : -1)).filter((i) => i >= 0);
  const finalCentroids = allCentroids();
  const identityReviewPairs = [];
  for (let x = 0; x < alive.length; x++) {
    const i = alive[x];
    for (let y = x + 1; y < alive.length; y++) {
      const j = alive[y];
      const d = dist(finalCentroids[i], finalCentroids[j], dim);
      if (d > cfg.IDENTITY_CONSOLIDATION_REVIEW_MAX) continue;
      identityReviewPairs.push({
        d: Number(d.toFixed(4)),
        faceA: faces[nodes[i].members[0]].id,
        faceB: faces[nodes[j].members[0]].id,
        reason: d <= cfg.IDENTITY_CONSOLIDATION_THRESHOLD ? 'no-corroborating-face-pair' : 'gray-zone',
      });
    }
  }
  identityReviewPairs.sort((p, q) => p.d - q.d);

  const outClusters = alive.map((i) => ({ members: nodes[i].members, photos: nodes[i].photos }));
  return { clusters: outClusters, mergeCount, identityReviewPairs };
}
