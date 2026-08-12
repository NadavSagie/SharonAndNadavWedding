/**
 * Single source of truth for every tunable in the face-indexing pipeline.
 * CLI flags overlay this object in cli.mjs — nothing else mutates it.
 *
 * Distances are euclidean over 128-d face-api descriptors unless noted.
 */

import os from 'node:os';

export const CONFIG = {
  // ---------------------------------------------------------------- input
  PHOTOS_DIR: 'assets/images',
  /** Only files matching this are wedding photos. Excludes banner/ blog/ work/
   *  template art (they live in subfolders, and we never recurse) and t-58-preview.jpg. */
  PHOTO_PATTERN: /^t-(\d+)\.jpg$/i,
  EXCLUDE_FILES: ['t-58-preview.jpg'],
  MAX_INPUT_PIXELS: 500_000_000,
  INCLUDE_TAKEN_AT: true,

  // ------------------------------------------------------- decode / detect
  /** Decode size is a COST lever, not a quality lever: SSD-MobileNetV1 resizes
   *  whatever you hand it to 512x512 internally. One decode per photo, reused
   *  for the full-frame pass and every tile. */
  DECODE_LONG_EDGE: 4096,
  /** Full-frame detection pass resolution. */
  DETECT_LONG_EDGE: 1600,

  /* Detection is deliberately PERMISSIVE and the real gates are applied later,
   * at cluster time. Keeping the gates out of the detection fingerprint means
   * retuning them is a seconds-long `--from=cluster` instead of a full re-detect. */
  DETECT_MIN_CONFIDENCE: 0.3,
  DETECT_MIN_SIZE: 40,
  MAX_FACES_PER_PHOTO: 60,

  /* ---- keep gates (cluster time, cheap to retune) ----
   * Measured on this set: face scores are bimodal — real faces sit at 0.87+
   * (median), while the bottom quartile below ~0.58 is overwhelmingly flowers,
   * phone backs, ears and hair. 0.62 sits in that valley. */
  MIN_FACE_CONFIDENCE: 0.62,
  /** Minimum face width in ORIGINAL-image pixels. Below ~110 px in a 40 MP frame
   *  the descriptor is too unstable to cluster reliably. */
  MIN_FACE_SIZE: 110,
  /** Backs of heads and ears score ~0 here and produce meaningless descriptors
   *  that clump into junk clusters. Low enough to keep genuine profiles. */
  MIN_FACE_FRONTALITY: 0.12,

  /** Tiling is the actual QUALITY lever — it is what recovers guests at tables. */
  TILING_ENABLED: true,
  TILE_TARGET_PX: 1400,
  TILE_OVERLAP: 0.18,
  /** Photos whose long edge is below this get no tile pass (nothing to gain). */
  TILING_MIN_LONG_EDGE: 2200,
  /** IoU above which two detections from different passes are the same face. */
  MERGE_IOU: 0.35,

  // ------------------------------------------------- embedding refinement
  /** Faces narrower than REFINE_BELOW_PX get their descriptor recomputed from a
   *  native-resolution crop instead of an upscaled patch. Large accuracy win. */
  REFINE_SMALL_FACES: true,
  REFINE_BELOW_PX: 140,
  REFINE_CROP_PADDING: 0.6,
  REFINE_CROP_SIZE: 384,
  REFINE_MIN_CONFIDENCE: 0.2,

  // ------------------------------------------------------------ clustering
  /** Tighter than face-api's ~0.6 verification convention: with thousands of
   *  faces there are far more adversarial pairs. Bias to over-segmentation —
   *  an extra cluster costs one line in overrides.json, a false merge is silent. */
  /* Tuned on this set. At 0.50 two junk clusters formed by merging unreliable
   * profile/sunglasses descriptors; 0.46 splits them apart at the cost of ~10
   * more unsorted faces, and cuts borderline pairs by ~28%. Below ~0.40 real
   * people start fragmenting into singletons and drop out entirely. */
  FACE_SIMILARITY_THRESHOLD: 0.46,
  /** Two clusters that already share a photo may still merge (mirrors, photos of
   *  photos) but must clear a much tighter bar. NOT a hard cannot-link. */
  SAME_PHOTO_MERGE_THRESHOLD: 0.34,
  LINKAGE: 'average',
  /** Cluster pairs within this margin above the threshold go to review.json. */
  MERGE_REVIEW_MARGIN: 0.12,
  /** Above this many faces, pre-group very-confident pairs into micro-clusters
   *  first so the O(m^2) linkage matrix stays small. Exact average-linkage sums
   *  are still accumulated per micro-cluster pair, so this changes memory, not
   *  the arithmetic. ~78 photos gives ~700 faces; ~2000 photos gives ~18k. */
  EXACT_CLUSTER_MAX_FACES: 4000,
  /** Threshold for that pre-grouping. Deliberately far tighter than the real
   *  clustering threshold — these merges must be beyond doubt. */
  MICRO_CLUSTER_THRESHOLD: 0.4,
  /** Clusters spanning fewer distinct (de-duplicated) photos than this are parked
   *  as "unsorted" rather than shown as people. */
  MIN_CLUSTER_PHOTOS: 2,
  MIN_CLUSTER_FACES: 2,
  /** Mean composite quality a cluster must reach to be shown as a person.
   *  Individually-plausible but poor faces (blurred bystanders, half-occluded
   *  heads behind a raised phone) cluster together into junk "people"; their
   *  descriptors are noise, so they land near each other. Gating on the mean
   *  removes them as a class instead of blacklisting ids per dataset. */
  MIN_CLUSTER_QUALITY: 0.72,
  /** Overlap coefficient (|A∩B| / min(|A|,|B|)) of face-ID sets required to reuse
   *  a person ID from the ledger. Deliberately not Jaccard: a person's cluster
   *  can grow 5-10x when hundreds of new photos are added while still fully
   *  containing their old faces, and Jaccard's union-based denominator would
   *  crater the score for that growth and silently orphan the id. */
  LEDGER_MATCH_MIN_OVERLAP: 0.25,

  // ------------------------------------------------- quality / representative
  QUALITY_WEIGHTS: { size: 0.3, detection: 0.25, frontality: 0.2, sharpness: 0.15, centrality: 0.1 },
  QUALITY_SIZE_SATURATION_PX: 400,
  /** Laplacian sigma at which a crop counts as fully sharp. The worker stores the
   *  RAW sigma so this stays a cluster-time knob. */
  SHARPNESS_SATURATION_SIGMA: 42,

  // -------------------------------------------------- near-duplicate photos
  /** Hamming distance over a 64-bit aHash below which two photos are burst frames. */
  PHASH_HAMMING_DUPE: 6,

  // ----------------------------------------------------------- derivatives
  OUTPUT_FORMAT: 'webp',
  THUMB_LONG_EDGE: 640,
  THUMB_QUALITY: 70,
  PHOTO_LONG_EDGE: 1600,
  PHOTO_QUALITY: 76,
  COVER_CROP_SIZE: 320,
  COVER_QUALITY: 85,
  FACE_CROP_PADDING: 0.4,
  WEBP_EFFORT: 5,
  /** GitHub Pages has a HARD 1 GB published-site limit. Warn well before it. */
  SIZE_BUDGET_MB: 850,

  // --------------------------------------------------------------- runtime
  BACKEND_PREFERENCE: ['tensorflow', 'wasm', 'cpu'],
  ENGINE: 'faceapi',
  /** Analysis workers. wasm tfjs is single-threaded, so throughput comes from
   *  processes, not threads-within-tfjs. Leave headroom for sharp's libvips pool. */
  WORKER_COUNT: Math.max(1, Math.min(8, os.cpus().length - 2)),
  DERIV_CONCURRENCY: 3,
  /** Abort with a non-zero exit if more than this fraction of photos failed. */
  FAIL_RATIO_ABORT: 0.2,

  // ----------------------------------------------------------------- paths
  CACHE_DIR: '.face-cache',
  OUT_DIR: 'face-index',
  DERIV_DIR: 'assets/gallery',
  DATA_DIR: 'data',
};

/** Distance semantics are engine-specific; this must not become a magic number
 *  when the ONNX/ArcFace path lands (ArcFace uses L2-normalised 512-d embeddings). */
export const ENGINE_THRESHOLDS = { faceapi: 0.5, arcface: 0.62 };

/**
 * Changing any of these invalidates cached DETECTION results.
 * Deliberately excludes clustering, quality and derivative constants so that
 * retuning a threshold or a thumbnail size never forces a re-detection.
 */
export const DETECTION_FINGERPRINT_KEYS = [
  'DECODE_LONG_EDGE',
  'DETECT_LONG_EDGE',
  'DETECT_MIN_CONFIDENCE',
  'DETECT_MIN_SIZE',
  'MAX_FACES_PER_PHOTO',
  'TILING_ENABLED',
  'TILE_TARGET_PX',
  'TILE_OVERLAP',
  'TILING_MIN_LONG_EDGE',
  'MERGE_IOU',
  'REFINE_SMALL_FACES',
  'REFINE_BELOW_PX',
  'REFINE_CROP_PADDING',
  'REFINE_CROP_SIZE',
  'ENGINE',
];

export function detectionFingerprint(cfg) {
  const parts = DETECTION_FINGERPRINT_KEYS.map((k) => `${k}=${JSON.stringify(cfg[k])}`);
  return `v1|${parts.join('|')}`;
}
