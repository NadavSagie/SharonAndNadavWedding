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
 * with population diversity the way average-linkage does.
 *
 * Two independent paths into the same auto-merge decision, both bounded by
 * IDENTITY_CONSOLIDATION_REVIEW_MAX (never wider than the existing review
 * band — see config.mjs for the full calibration story):
 *   (a) strict — centroid <= IDENTITY_CONSOLIDATION_THRESHOLD, corroborated by
 *       at least one genuinely close RAW face pair (stops two clusters' means
 *       coincidentally aligning with no individual pair actually resembling
 *       each other).
 *   (b) strong-pair — centroid anywhere in the review band, but with >=2
 *       independent close raw pairs, each from a DISTINCT (non-burst) photo
 *       pairing. This is what recovers a person whose fragments never clear
 *       the strict centroid bar no matter how large they grow, as long as the
 *       fragments keep producing multiple genuinely-close individual matches.
 * Neither path loosens the other's numbers; (b) exists because the strict
 * path had NO route to auto-merge anything in the review band at all, however
 * much raw evidence supported it — see config.mjs for how that gap was found.
 *
 * Pairs in the gray zone that clear neither path are reported, never silently
 * merged.
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

/** Raw evidence between two clusters: the closest single pair, how many
 *  DISTINCT dupe-photo-group pairings produce a pair at or below `strongMax`
 *  — counting group pairings rather than raw face pairings so a single burst
 *  of near-identical frames can't manufacture "multiple" corroboration on its
 *  own — and, on EACH side, which of that side's own groups took part in at
 *  least one strong pairing.
 *
 * That last part exists because a cluster can be internally impure — tier 1
 * occasionally average-links two different people into one cluster when
 * they happen to co-occur (matching hairstyles, always photographed side by
 * side). If only a MINORITY of one side's own appearances ever produce a
 * strong pairing, the "strong" evidence is really evidence about a slice of
 * that cluster, not the whole thing — merging the whole cluster on that
 * basis drags an unrelated person's photos along with it. Confirmed on this
 * dataset: a cluster later found to contain a second, already independently
 * identified person had corroboration touching only ~1/4 of its own groups. */
function rawEvidence(membersA, membersB, faces, dim, groupOf, strongMax) {
  let minRaw = Infinity;
  const strongGroupPairs = new Set();
  const coveredA = new Set();
  const coveredB = new Set();
  for (const i of membersA) {
    const a = faces[i].descriptor;
    const ga = groupOf(faces[i].photoId);
    for (const j of membersB) {
      const d = dist(a, faces[j].descriptor, dim);
      if (d < minRaw) minRaw = d;
      if (d <= strongMax) {
        const gb = groupOf(faces[j].photoId);
        strongGroupPairs.add(ga < gb ? `${ga}|${gb}` : `${gb}|${ga}`);
        coveredA.add(ga);
        coveredB.add(gb);
      }
    }
  }
  return { minRaw, strongCount: strongGroupPairs.size, coveredA: coveredA.size, coveredB: coveredB.size };
}

function distinctGroupCount(photos, groupOf) {
  const s = new Set();
  for (const p of photos) s.add(groupOf(p));
  return s.size;
}

export function consolidateIdentities(faces, clusters, cfg, dupeGroups, onProgress = () => {}) {
  if (clusters.length < 2) return { clusters, mergeCount: 0, identityReviewPairs: [] };
  const dim = faces[0].descriptor.length;
  const groupOf = (photoId) => dupeGroups?.get(photoId) ?? photoId;

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

  // Pairs evaluated for the strong-pair path and found ineligible for BOTH
  // paths. Blocked permanently rather than re-checked every iteration:
  // eligibility is based on raw descriptors, which never change, so a failed
  // check can only be revisited by NEW faces arriving via a merge on either
  // side — a real but rare second-order case; erring toward requiring an
  // explicit human decision here is consistent with this project's "prefer
  // over-segmentation" stance, not a bug.
  const blocked = new Set();

  function strictEligible(i, j) {
    const minRaw = minRawPairDistance(nodes[i].members, nodes[j].members, faces, dim);
    return minRaw <= cfg.IDENTITY_CONSOLIDATION_MIN_RAW_PAIR;
  }

  function strongEligible(i, j) {
    const { strongCount, coveredA, coveredB } = rawEvidence(
      nodes[i].members, nodes[j].members, faces, dim, groupOf, cfg.IDENTITY_CONSOLIDATION_STRONG_PAIR,
    );
    const groupsI = distinctGroupCount(nodes[i].photos, groupOf);
    const groupsJ = distinctGroupCount(nodes[j].photos, groupOf);
    // Coverage is measured on the SMALLER side: that's the one at risk of
    // being a minority slice dragged in by a majority-unrelated cluster (see
    // rawEvidence's doc comment).
    const coverage = groupsI <= groupsJ ? coveredA / groupsI : coveredB / groupsJ;
    return strongCount >= cfg.IDENTITY_CONSOLIDATION_MIN_STRONG_PAIRS
      && coverage >= cfg.IDENTITY_CONSOLIDATION_MIN_STRONG_COVERAGE;
  }

  let mergeCount = 0;
  let iterations = 0;
  const maxIterations = nodes.length * nodes.length + nodes.length; // generous, finite bound

  for (;;) {
    iterations++;
    if (iterations > maxIterations) break; // defensive; should never trigger

    const cens = allCentroids();

    // Phase 1: the strict path, exactly as it behaves alone — smallest
    // centroid distance <= IDENTITY_CONSOLIDATION_THRESHOLD, corroborated.
    // Every round exhausts this BEFORE phase 2 gets a look, so nothing the
    // strict path alone would have merged (in whatever order it would have
    // merged it) is ever pre-empted by a phase-2 merge reshaping a centroid
    // first — the strong-pair path only ever fills in what strict has
    // nothing left to offer, this round or any later one.
    let bestI = -1;
    let bestJ = -1;
    let bestD = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      if (!nodes[i]) continue;
      for (let j = i + 1; j < nodes.length; j++) {
        if (!nodes[j]) continue;
        const d = dist(cens[i], cens[j], dim);
        if (d > cfg.IDENTITY_CONSOLIDATION_THRESHOLD || d >= bestD) continue;
        if (strictEligible(i, j)) { bestD = d; bestI = i; bestJ = j; }
      }
    }

    // Phase 2: nothing left for the strict path anywhere in the graph this
    // round — see whether the strong-pair path can do better than "give up".
    if (bestI < 0) {
      for (let i = 0; i < nodes.length; i++) {
        if (!nodes[i]) continue;
        for (let j = i + 1; j < nodes.length; j++) {
          if (!nodes[j] || blocked.has(`${i},${j}`)) continue;
          const d = dist(cens[i], cens[j], dim);
          if (d > cfg.IDENTITY_CONSOLIDATION_REVIEW_MAX || d >= bestD) continue;
          if (strongEligible(i, j)) { bestD = d; bestI = i; bestJ = j; } else { blocked.add(`${i},${j}`); }
        }
      }
    }

    if (bestI < 0) break;

    // Commit the merge: a absorbs b.
    const a = nodes[bestI];
    const b = nodes[bestJ];
    for (const i of b.members) a.members.push(i);
    for (let k = 0; k < dim; k++) a.sum[k] += b.sum[k];
    for (const p of b.photos) a.photos.add(p);
    nodes[bestJ] = null;
    mergeCount++;
    onProgress('consolidate', mergeCount, nodes.length);
  }

  // Final pass: report gray-zone pairs among whatever remains, for optional
  // manual merging. A pair blocked above (evaluated, qualified for neither
  // path) is exactly a "no-corroborating-evidence" pair; anything else in the
  // band was never even evaluated (its centroid never got close enough to be
  // the best candidate in any iteration) and is a plain "gray-zone" report.
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
        reason: blocked.has(`${i},${j}`) ? 'no-corroborating-evidence' : 'gray-zone',
      });
    }
  }
  identityReviewPairs.sort((p, q) => p.d - q.d);

  const outClusters = alive.map((i) => ({ members: nodes[i].members, photos: nodes[i].photos }));
  return { clusters: outClusters, mergeCount, identityReviewPairs };
}
