# Nadav &amp; Sharon — Wedding Photo Gallery

A wedding photo gallery whose main feature is **face-based discovery**:

> open the site → tap **Find My Photos** → tap your face → see every photo you're in.

The face grouping is real. Photos are analysed by an actual detection +
embedding + clustering pipeline that runs **locally on your machine**. Nothing is
hardcoded, nothing is derived from filenames, and no photo or face descriptor is
ever sent to a third-party service.

---

## Quick start

```bash
npm install
npm run index-faces:doctor   # pre-flight check — run this first
npm run index-faces          # analyse the photos and build the index
npm run verify               # integrity + privacy checks
npm run serve                # http://localhost:3000
```

The **website itself has no build step**. `index.html` plus static assets are
served exactly as they sit in the repo, so `git push` deploys. Node is only an
authoring tool for the indexer.

> ES modules and `fetch` do not work over `file://`. Use `npm run serve` —
> opening `index.html` directly will show a blank page.

---

## How it works

```
assets/images/t-*.jpg          full-resolution originals (gitignored, local only)
        │
        ▼  npm run index-faces          Node, offline, incremental
        │
        ├─ data/photos.json             every photo: id, dimensions, colour
        ├─ data/people.json             each person: id, name, photo list
        ├─ data/photo-faces.json        face boxes per photo (lazily fetched)
        ├─ assets/gallery/thumbs/       640px WebP grid tiles
        ├─ assets/gallery/photos/       1600px WebP lightbox images
        ├─ assets/gallery/covers/       320px face crop per person
        └─ face-index/review.json       borderline pairs for you to decide on
        │
        ▼  fetch()
   index.html — vanilla ES modules, hash router, zero runtime dependencies
```

### Pipeline stages

1. **discover** — find `t-N.jpg` in `assets/images/` (never recursive), hash each
   file, reusing the hash when size and mtime are unchanged.
2. **analyze** — for each photo, in a pool of worker threads:
   decode once at 4096px → full-frame detection pass → **overlapping tile passes**
   → merge with IoU-NMS → recompute descriptors for small faces from
   native-resolution crops. Results are cached per photo.
3. **cluster** — two tiers:
   - **tier 1**: agglomerative, average linkage, euclidean distance over the
     128-d descriptors. Forms clean clusters, but under-merges a person once
     their cluster grows large and appearance-diverse (see "Why identity
     consolidation matters" below).
   - **tier 2 (identity consolidation)**: compares *centroids* of the tier-1
     clusters and merges pairs that are both centroid-close and corroborated by
     a genuine close raw-face pair. Fixes the same person being split into
     several separate "people" — see `tools/face-index/lib/identity-consolidation.mjs`.
4. **identify** — assign stable person ids from the ledger, apply `overrides.json`,
   choose each person's representative face, rank.
5. **derivatives** — one full-resolution decode per photo produces its thumbnail,
   lightbox image and any cover crops sourced from it.
6. **emit** — write the three public JSON files plus `review.json`.

### Why tiling matters

SSD-MobileNetV1 resizes *any* input to 512×512 internally. A 100px face in a
7716px frame is ~6.6px at the detector and is invisible no matter what resolution
you feed it. Tiling — not a bigger full-frame pass — is what recovers guests
sitting at tables. Concretely: `t-1.jpg` yields **0 faces** from a full-frame pass
and **1** once tiling is on.

### Why identity consolidation matters

Average linkage (tier 1) compares a *candidate* fragment against the *average*
of an existing cluster. That average-linkage distance inflates purely from a
cluster's own internal diversity as it grows — a person with 200+ photos across
many angles, lighting conditions and expressions can end up with an average
distance to a brand-new photo of themselves that is **higher** than the merge
threshold, even though every one of their existing faces is compatible with it.
Measured on this dataset: the groom's cluster overlapped 25-36 of 36 faces with
several of his own genuine fragments, yet average-linkage distance to those
fragments was 0.46-0.71 — comfortably over threshold despite being the same
person. The practical symptom is one real person appearing as many separate
"people" — worse the more photos they're in, so it hits the couple hardest.

Tier 2 fixes this by comparing cluster **centroids** (mean embeddings) instead —
a centroid built from many faces is a multi-reference-embedding representation
of a person and does not inflate with population diversity the way average
linkage does. Every merge additionally requires a genuine close raw face-to-face
pair between the two clusters (`IDENTITY_CONSOLIDATION_MIN_RAW_PAIR`), which
stops two clusters from merging just because their means coincidentally align.
The auto-merge threshold (`IDENTITY_CONSOLIDATION_THRESHOLD = 0.36`) is
deliberately far tighter than tier 1's 0.46 — see config.mjs for the calibration
data (40 manually-audited real pairs across the distance range). Pairs between
the merge threshold and a review ceiling are written to `review.json`'s
`possibleDuplicateIdentities`, never silently merged.

---

## Regenerating the index

**When you add new photos.** Drop them into `assets/images/` as `t-79.jpg`,
`t-80.jpg`, … and run:

```bash
npm run index-faces
```

Only the new photos are analysed — existing results come from `.face-cache/`.
Adding 200 photos re-analyses exactly those 200. Existing person ids are
preserved, so names and merges you have already made keep working.

**When you only changed clustering settings or `overrides.json`:**

```bash
npm run index-faces:recluster    # skips detection entirely — takes seconds
```

**Other commands**

| Command | What it does |
|---|---|
| `npm run index-faces:doctor` | environment check + one-photo smoke test |
| `npm run index-faces:force` | ignore the cache, re-detect everything |
| `npm run index-faces:derivatives` | regenerate images only |
| `npm run verify` | integrity + privacy assertions on the output |
| `node tools/face-index/cli.mjs --help` | all flags |

Useful flags: `--limit=5`, `--photos=t-1,t-2`, `--threshold=0.5`, `--no-tiles`,
`--dry-run`, `--verbose`.

---

## Correcting the results (`face-index/overrides.json`)

Automatic clustering is never perfect, so correcting it is a designed-in step,
not a workaround. **The indexer never writes this file** — it is yours.

Open `face-index/review.json` first: it lists every detected person with their
photo count and sample photos, plus the borderline pairs that are worth a human
decision.

```jsonc
{
  "people": {
    "p-0001": { "name": "Nadav", "featured": true, "order": 1 },
    "p-0012": { "name": "Savta Ruth", "cover": "t-45_2201x0891" },
    "p-0031": { "hidden": true, "note": "blurry faces at the bar" }
  },
  "merge": [["p-0004", "p-0019"]],           // first id wins, rest are absorbed
  "split": { "p-0009": { "moveFaces": ["t-3_1102x0455"], "to": "p-0090" } },
  "ignoreFaces": ["t-77_0201x0033"],
  "ignorePhotos": ["t-58-preview"]
}
```

Applied in a fixed order: `ignore*` → `split` → `merge` → attributes.
`hidden: true` is a real privacy control — it removes the person from the site,
strips their attribution from every photo, and skips writing their face crop.
The photos stay; only the identity link disappears.

Then `npm run index-faces:recluster`.

**Person ids are stable.** `face-index/.people-ledger.json` remembers which faces
belong to which `p-NNNN`, so ids survive re-runs and new photo drops. That is
also why "Guest 7" still means the same person tomorrow — guests screenshot and
share these pages.

---

## Configuration

Every tunable lives in `tools/face-index/config.mjs`. No magic numbers elsewhere.

| Setting | Default | Meaning |
|---|---|---|
| `FACE_SIMILARITY_THRESHOLD` | `0.46` | Euclidean distance below which two clusters merge. Lower = more separate groups. |
| `SAME_PHOTO_MERGE_THRESHOLD` | `0.34` | Tighter bar for clusters already sharing a photo (mirrors, photos-of-photos). |
| `MIN_FACE_CONFIDENCE` | `0.62` | Detector score needed to keep a face. |
| `MIN_FACE_SIZE` | `110` | Minimum face width in original pixels. |
| `MIN_FACE_FRONTALITY` | `0.12` | Rejects backs of heads and ears. |
| `MIN_CLUSTER_QUALITY` | `0.72` | Mean face quality a cluster needs to be shown as a person. |
| `MIN_CLUSTER_PHOTOS` | `2` | Fewer distinct photos than this → parked as unsorted. |
| `IDENTITY_CONSOLIDATION_THRESHOLD` | `0.36` | Centroid distance below which two already-formed clusters auto-merge as the same person (tier 2). Independently calibrated — not the same knob as `FACE_SIMILARITY_THRESHOLD`. |
| `IDENTITY_CONSOLIDATION_REVIEW_MAX` | `0.44` | Centroid distance up to this is reported in `review.json` as a possible duplicate, not auto-merged. |
| `IDENTITY_CONSOLIDATION_MIN_RAW_PAIR` | `0.46` | Corroboration guard: a centroid-eligible merge still needs one genuinely close raw face pair. |
| `PHOTO_LONG_EDGE` / `PHOTO_QUALITY` | `1600` / `76` | Lightbox image size. Lower these if you approach the hosting limit. |
| `SIZE_BUDGET_MB` | `850` | Warn before GitHub Pages' hard 1 GB cap. |

Detection settings are separate from these *keep gates* on purpose: gates are
applied at cluster time, so retuning them costs seconds instead of a full
re-detection.

**Tuning advice.** Prefer over-segmentation. An extra cluster costs one line in
`overrides.json`; a false merge silently files one guest's photos under another
and is hard to even notice. At 0.50 this set produced two junk clusters by
merging unreliable profile/sunglasses descriptors; 0.46 separated them.

---

## Technology, and why

| Choice | Reason |
|---|---|
| **`@vladmandic/face-api` 1.7.15** (SSD-MobileNetV1 + 68 landmarks + 128-d FaceRecognitionNet) | Ships model weights **inside the npm package** — nothing to download, fully offline. Accepts a `tf.Tensor3D` directly, which lets us skip `node-canvas` entirely (historically the #1 install failure on Windows). |
| **tfjs `wasm` backend** | `@tensorflow/tfjs-node` publishes **no NAPI-v10 prebuilt binding**, so it cannot load on Node ≥ 22. The indexer still probes for it and will use it automatically on an older Node. |
| **`worker_threads` pool** | wasm tfjs is single-threaded, so throughput comes from processes. 8 workers on this machine index 78 photos in ~3 minutes. |
| **`sharp`** | Prebuilt binaries, no toolchain. Decodes to raw RGB for the tensor, and does every resize, crop and WebP encode. |
| **Vanilla ES modules + hash router** | GitHub Pages serves from a subpath with no rewrites. The fragment never reaches the server, so deep links work on first load with no `404.html` trick and no `<base href>` — and the same files run on localhost, on the Pages subpath, and on a custom domain with zero config. No build step means `git push` deploys. |

Rejected: Python InsightFace (no wheels for the Python 3.14 on this machine),
MediaPipe (weak embedder for clustering), any cloud face API (privacy).

An ONNX/ArcFace engine would be meaningfully more accurate on candid shots and
is left reachable behind `--engine=onnx`; the engine interface is only
`init/detect/describe/dispose`. It is not in v1 because it needs a ~180 MB manual
model download.

---

## Privacy

- Photos and face descriptors **never leave this machine**. There is no cloud API.
- Descriptors (biometric data) live only in `.face-cache/`, which is **gitignored**.
- The published JSON contains **no descriptors, no landmarks, no EXIF, no GPS,
  no capture times**. EXIF is never even read — display order comes from the
  filename. `npm run verify` asserts all of this.
- Generated images are written without `.withMetadata()`, so sharp strips EXIF.
  Venue GPS dies at the encoder.
- The site sets `robots: noindex, nofollow, noimageindex` and has no sitemap.
- A "remove me" contact is in the footer and on the People page.

> **GitHub Pages is public.** Unlisted is not private: anyone with the URL can
> view the gallery. If that matters, host it somewhere with access control.

---

## Routes

| Route | Page |
|---|---|
| `#/` | Hero, names, **Find My Photos** |
| `#/people` | Everyone detected, as a grid of faces |
| `#/people/:id` | One person: their face, name and only their photos |
| `#/photos` | Every photo |
| `#/photos/:photoId`, `#/people/:id/:photoId` | Lightbox deep links |

If `data/people.json` is missing or empty, the site degrades to a complete plain
gallery: the home CTA becomes "View the Gallery" and `#/people` explains that
face search is not ready yet.

---

## Known limitations

1. **Clustering purity is roughly 85–92%** on candid wedding photos. That is
   inherent to this embedding, not a bug. `review.json` + `overrides.json` exist
   precisely to close the gap — budget some time with them.
2. **The same person can appear more than once.** Sunglasses, strong profiles and
   very different lighting produce descriptors far enough apart to form their own
   cluster. Sunglasses are the worst case: they destroy the eye region the
   descriptor leans on. Tier-2 identity consolidation auto-merges the confident
   cases; genuinely uncertain ones (coloured party lighting, motion blur, a badly
   cropped multi-face detection) land in `review.json`'s `possibleDuplicateIdentities`
   for a quick manual `merge` — expect a handful of these on any real wedding set.
3. **Faces below ~1.5% of frame width are invisible to the detector.** Tiling
   recovers most guests at tables; genuinely tiny background faces are missed.
4. **Close relatives and children cluster together more readily** — the embedding
   encodes family resemblance and age.
5. **People in fewer than 2 distinct photos** are parked as unsorted and get no
   page. Lower `MIN_CLUSTER_PHOTOS` to 1 to include them, at the cost of noise.
6. **Zoom range is 1x-4x.** Two-finger pinch gives continuous zoom, double-tap
   jumps to 2.5x; panning while zoomed is clamped so the image can't drift
   fully off-screen.
7. **Runtime** ≈ 2 s/photo/worker. 78 photos ≈ 3 min at 8 workers; ~2000 photos
   ≈ 25–40 min. Re-runs with no new photos take seconds.
8. **Hosting ceiling.** ~12 MB of derivatives for 78 photos, projecting to
   ~300 MB at 2000. GitHub Pages' hard limit is 1 GB; past ~4000 photos move to
   Cloudflare Pages (no cap).
9. **Full-resolution originals are not deployed** (446 MB). The 1600px WebP is
   what the Download button gives. To offer true originals, link a Drive/Dropbox
   folder from the footer.

---

## Project layout

```
index.html                  the only HTML file (shell + inline hero)
data/                       generated, committed — what the browser fetches
face-index/
  overrides.json            hand-edited corrections
  review.json               generated: who was found, what to review
  .people-ledger.json       stable person ids
.face-cache/                gitignored — face descriptors live here
assets/
  css/                      tokens, base, layout, gallery, people, lightbox
  js/                       app, router, data + views/ components/ util/
  fonts/                    self-hosted woff2
  gallery/                  generated thumbs/, photos/, covers/
  images/                   originals (gitignored) + t-58-preview.jpg
tools/
  verify.mjs                integrity + privacy checks
  face-index/
    cli.mjs  config.mjs  doctor.mjs  worker.mjs
    engine/                 backend ladder, per-photo analysis
    stages/                 discover, analyze, identify, derivatives, emit
    lib/                    cluster, quality, geometry, image, cache, ledger, log
```
