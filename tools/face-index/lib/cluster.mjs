/**
 * Agglomerative clustering of face descriptors, average linkage, euclidean.
 *
 * Average linkage on purpose:
 *   - single linkage chains — one ambiguous side-profile can merge two families
 *   - complete linkage is too brittle under pose variation and splits one person
 *     into a "frontal" and a "profile" cluster for no benefit
 *
 * Merging uses the Lance-Williams sum-of-distances identity:
 *     S(A∪B, X) = S(A, X) + S(B, X)
 *     d_avg(A, X) = S(A, X) / (|A| · |X|)
 * so each merge updates the matrix in O(m) rather than recomputing any distances.
 *
 * Scale: the pairwise sums are accumulated between MICRO-CLUSTERS, which are
 * either the individual faces (small sets) or union-find groups formed at a much
 * tighter threshold (large sets). That keeps the m×m matrix small without
 * approximating the linkage arithmetic for everything above the micro level.
 */

function distance(desc, i, j, dim) {
  const a = i * dim;
  const b = j * dim;
  let sum = 0;
  for (let k = 0; k < dim; k++) {
    const d = desc[a + k] - desc[b + k];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

class UnionFind {
  constructor(n) { this.p = new Int32Array(n).map((_, i) => i); }
  find(x) {
    let r = x;
    while (this.p[r] !== r) r = this.p[r];
    while (this.p[x] !== r) { const nx = this.p[x]; this.p[x] = r; x = nx; }
    return r;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.p[rb] = ra;
  }
}

/**
 * @param faces  [{ id, photoId, descriptor: Float32Array }]
 * @returns { clusters: [{ members:int[], photos:Set }], microCount, reviewPairs }
 */
export function clusterFaces(faces, cfg, onProgress = () => {}) {
  const n = faces.length;
  if (n === 0) return { clusters: [], microCount: 0, reviewPairs: [] };

  const dim = faces[0].descriptor.length;
  const desc = new Float32Array(n * dim);
  for (let i = 0; i < n; i++) desc.set(faces[i].descriptor, i * dim);

  // ---- micro-clusters -----------------------------------------------------
  let microOf = new Int32Array(n);
  let m;
  if (n > cfg.EXACT_CLUSTER_MAX_FACES) {
    const uf = new UnionFind(n);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (distance(desc, i, j, dim) < cfg.MICRO_CLUSTER_THRESHOLD) uf.union(i, j);
      }
      if ((i & 511) === 0) onProgress('micro', i, n);
    }
    const remap = new Map();
    for (let i = 0; i < n; i++) {
      const r = uf.find(i);
      if (!remap.has(r)) remap.set(r, remap.size);
      microOf[i] = remap.get(r);
    }
    m = remap.size;
  } else {
    for (let i = 0; i < n; i++) microOf[i] = i;
    m = n;
  }

  // ---- exact pairwise sums between micro-clusters -------------------------
  const S = new Float64Array(m * m);
  const size = new Int32Array(m);
  for (let i = 0; i < n; i++) size[microOf[i]]++;
  for (let i = 0; i < n; i++) {
    const mi = microOf[i];
    for (let j = i + 1; j < n; j++) {
      const mj = microOf[j];
      if (mi === mj) continue;
      const d = distance(desc, i, j, dim);
      S[mi * m + mj] += d;
      S[mj * m + mi] += d;
    }
    if ((i & 255) === 0) onProgress('sums', i, n);
  }

  // ---- cluster state ------------------------------------------------------
  const alive = new Uint8Array(m).fill(1);
  const count = Int32Array.from(size);
  const members = Array.from({ length: m }, () => []);
  for (let i = 0; i < n; i++) members[microOf[i]].push(i);
  const photos = Array.from({ length: m }, () => new Set());
  for (let i = 0; i < n; i++) photos[microOf[i]].add(faces[i].photoId);

  const avg = (a, b) => S[a * m + b] / (count[a] * count[b]);
  const sharePhoto = (a, b) => {
    const [small, big] = photos[a].size < photos[b].size ? [a, b] : [b, a];
    for (const p of photos[small]) if (photos[big].has(p)) return true;
    return false;
  };
  /** Two clusters already sharing a photo must clear a much tighter bar.
   *  NOT a hard cannot-link: mirrors, reflections and photos-of-photos are real,
   *  and their descriptors sit well below this. */
  const limitFor = (a, b) => (sharePhoto(a, b)
    ? cfg.SAME_PHOTO_MERGE_THRESHOLD
    : cfg.FACE_SIMILARITY_THRESHOLD);

  // ---- nearest-allowed-neighbour array ------------------------------------
  const nn = new Int32Array(m).fill(-1);
  const nnd = new Float64Array(m).fill(Infinity);
  const recompute = (a) => {
    let best = -1;
    let bestD = Infinity;
    for (let b = 0; b < m; b++) {
      if (b === a || !alive[b]) continue;
      const d = avg(a, b);
      if (d < bestD && d <= limitFor(a, b)) { bestD = d; best = b; }
    }
    nn[a] = best;
    nnd[a] = bestD;
  };
  for (let a = 0; a < m; a++) {
    if (alive[a]) recompute(a);
    if ((a & 255) === 0) onProgress('nn', a, m);
  }

  const reviewPairs = [];

  // ---- merge --------------------------------------------------------------
  for (;;) {
    let a = -1;
    let bestD = Infinity;
    for (let i = 0; i < m; i++) {
      if (alive[i] && nn[i] >= 0 && nnd[i] < bestD) { bestD = nnd[i]; a = i; }
    }
    if (a < 0) break;
    const b = nn[a];
    if (b < 0 || !alive[b]) { recompute(a); continue; }

    // merge b into a
    for (let x = 0; x < m; x++) {
      if (x === a || x === b || !alive[x]) continue;
      S[a * m + x] += S[b * m + x];
      S[x * m + a] = S[a * m + x];
    }
    count[a] += count[b];
    members[a].push(...members[b]);
    for (const p of photos[b]) photos[a].add(p);
    alive[b] = 0;
    nn[b] = -1;
    nnd[b] = Infinity;

    recompute(a);
    for (let x = 0; x < m; x++) {
      if (alive[x] && (nn[x] === b || nn[x] === a)) recompute(x);
    }
  }

  // ---- borderline pairs worth a human decision ----------------------------
  const liveIdx = [];
  for (let i = 0; i < m; i++) if (alive[i]) liveIdx.push(i);
  const reviewMax = cfg.FACE_SIMILARITY_THRESHOLD + cfg.MERGE_REVIEW_MARGIN;
  for (let i = 0; i < liveIdx.length; i++) {
    for (let j = i + 1; j < liveIdx.length; j++) {
      const d = avg(liveIdx[i], liveIdx[j]);
      if (d > cfg.FACE_SIMILARITY_THRESHOLD && d <= reviewMax) {
        reviewPairs.push({ a: liveIdx[i], b: liveIdx[j], d: Number(d.toFixed(4)) });
      }
    }
  }
  reviewPairs.sort((x, y) => x.d - y.d);

  const clusters = liveIdx.map((i) => ({
    key: i,
    members: members[i],
    photos: photos[i],
  }));

  return { clusters, microCount: m, reviewPairs };
}

/** Mean descriptor of a cluster, for centrality scoring and cover selection. */
export function centroid(faces, memberIdx) {
  const dim = faces[0].descriptor.length;
  const c = new Float64Array(dim);
  for (const i of memberIdx) {
    const d = faces[i].descriptor;
    for (let k = 0; k < dim; k++) c[k] += d[k];
  }
  for (let k = 0; k < dim; k++) c[k] /= memberIdx.length;
  return c;
}

export function distanceToCentroid(descriptor, c) {
  let sum = 0;
  for (let k = 0; k < c.length; k++) {
    const d = descriptor[k] - c[k];
    sum += d * d;
  }
  return Math.sqrt(sum);
}
