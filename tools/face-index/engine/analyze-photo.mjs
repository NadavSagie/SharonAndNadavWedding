/**
 * Detect + describe every face in ONE photo.
 *
 * Passes, in order:
 *   1. full-frame at DETECT_LONG_EDGE  — catches anything reasonably large
 *   2. adaptive overlapping tiles      — this is what actually recovers guests
 *                                        sitting at tables in a 40 MP frame
 *   3. per-face refinement for faces still small after tiling — recompute the
 *      descriptor from a native-resolution crop rather than an upscaled patch
 *
 * SSD-MobileNetV1 resizes ANY input to 512x512 internally, so a 100 px face in a
 * 7716 px frame is ~6.6 px at the detector and is invisible no matter what
 * resolution you feed it. That is why tiling — not a bigger full-frame pass — is
 * the quality lever here.
 *
 * All coordinates are converted to ORIGINAL-IMAGE PIXELS as soon as they leave
 * the detector; normalisation to 0..1 happens only at emit time.
 */

import {
  decodeRaw, readMetadata, extractRaw, extractSquareRaw,
  rawToFloat32, aHash, dominantColour, sharpnessScore,
} from '../lib/image.mjs';
import { nms, tileGrid, squarePaddedBox, faceId } from '../lib/geometry.mjs';

/** Yaw/roll proxy from the 68-point landmarks. Cheap, no extra model, and the
 *  single best discriminator between a usable portrait and a back-of-head. */
function frontalityFrom(landmarks) {
  try {
    const mean = (pts) => {
      const n = pts.length;
      let x = 0; let y = 0;
      for (const p of pts) { x += p.x; y += p.y; }
      return { x: x / n, y: y / n };
    };
    const le = mean(landmarks.getLeftEye());
    const re = mean(landmarks.getRightEye());
    const nose = mean(landmarks.getNose());
    const interocular = Math.hypot(re.x - le.x, re.y - le.y);
    if (!interocular || !Number.isFinite(interocular)) return 0.5;

    const dL = Math.hypot(nose.x - le.x, nose.y - le.y);
    const dR = Math.hypot(nose.x - re.x, nose.y - re.y);
    const yaw = Math.abs(dL - dR) / interocular;
    const roll = Math.abs(Math.atan2(re.y - le.y, re.x - le.x)) / (Math.PI / 6);
    return Math.max(0, Math.min(1, 1 - 0.8 * yaw - 0.4 * roll));
  } catch {
    return 0.5;
  }
}

/** Run one detection pass over a raw RGB region and return detections mapped
 *  into decode-buffer pixel space. */
async function detectPass(ctx, raw, info, mapToDecode) {
  const { faceapi, tf, cfg } = ctx;
  const out = [];
  tf.engine().startScope();
  let tensor = null;
  try {
    tensor = tf.tensor3d(rawToFloat32(raw), [info.height, info.width, 3], 'float32');
    const results = await faceapi
      .detectAllFaces(
        tensor,
        new faceapi.SsdMobilenetv1Options({
          minConfidence: cfg.DETECT_MIN_CONFIDENCE,
          maxResults: cfg.MAX_FACES_PER_PHOTO,
        }),
      )
      .withFaceLandmarks()
      .withFaceDescriptors();

    for (const r of results) {
      const b = r.detection.box;
      out.push({
        box: mapToDecode({ x: b.x, y: b.y, w: b.width, h: b.height }),
        score: r.detection.score,
        descriptor: Float32Array.from(r.descriptor),
        frontality: frontalityFrom(r.landmarks),
        // Effective resolution of the pass this detection came from, used to
        // pick the better duplicate during cross-pass NMS.
        sourceRes: info.width,
      });
    }
  } finally {
    tensor?.dispose();
    tf.engine().endScope();
  }
  return out;
}

export async function analyzePhoto(ctx, photo) {
  const { cfg, faceapi, tf } = ctx;
  const warnings = [];

  const meta = await readMetadata(photo.path, cfg);
  if (!meta.width || !meta.height) throw new Error('could not read image dimensions');

  const { data: decodeBuf, info: decodeInfo } = await decodeRaw(photo.path, cfg.DECODE_LONG_EDGE, cfg);
  if (decodeInfo.channels !== 3) throw new Error(`unexpected channel count ${decodeInfo.channels}`);

  // decode-buffer px -> original px
  const decodeScale = decodeInfo.width / meta.width;
  const toOriginal = (b) => ({
    x: b.x / decodeScale, y: b.y / decodeScale, w: b.w / decodeScale, h: b.h / decodeScale,
  });

  const [phash, colour] = await Promise.all([
    aHash(decodeBuf, decodeInfo).catch(() => null),
    dominantColour(decodeBuf, decodeInfo),
  ]);

  const detections = [];

  // ---- pass 1: full frame -------------------------------------------------
  {
    const { data, info } = await decodeRaw(decodeBuf, cfg.DETECT_LONG_EDGE, cfg, {
      width: decodeInfo.width, height: decodeInfo.height, channels: decodeInfo.channels,
    });
    const s = info.width / decodeInfo.width;
    detections.push(...await detectPass(ctx, data, info, (b) => ({
      x: b.x / s, y: b.y / s, w: b.w / s, h: b.h / s,
    })));
  }

  // ---- pass 2: overlapping tiles -----------------------------------------
  const longEdge = Math.max(meta.width, meta.height);
  if (cfg.TILING_ENABLED && longEdge >= cfg.TILING_MIN_LONG_EDGE) {
    const tiles = tileGrid(decodeInfo.width, decodeInfo.height, cfg.TILE_TARGET_PX, cfg.TILE_OVERLAP);
    for (const t of tiles) {
      try {
        const { data, info } = await extractRaw(decodeBuf, decodeInfo, t);
        detections.push(...await detectPass(ctx, data, info, (b) => ({
          x: b.x + t.x, y: b.y + t.y, w: b.w, h: b.h,
        })));
      } catch (err) {
        warnings.push(`tile ${t.x},${t.y} failed: ${String(err.message).split('\n')[0]}`);
      }
    }
  }

  // ---- merge across passes ------------------------------------------------
  // Rank by source resolution first: the same face found inside a 1400 px tile
  // has a better descriptor than the one found in the squashed full frame.
  let merged = nms(detections, cfg.MERGE_IOU, (d) => d.sourceRes * 1000 + d.score * 100);

  merged = merged
    .map((d) => ({ ...d, boxPx: toOriginal(d.box) }))
    .filter((d) => d.score >= cfg.DETECT_MIN_CONFIDENCE && d.boxPx.w >= cfg.DETECT_MIN_SIZE)
    .sort((a, b) => b.score - a.score)
    .slice(0, cfg.MAX_FACES_PER_PHOTO);

  // ---- pass 3: refine descriptors for faces that are still small ----------
  const faces = [];
  for (const d of merged) {
    let { descriptor, frontality } = d;
    let refined = false;

    const nativeW = d.boxPx.w;
    if (cfg.REFINE_SMALL_FACES && nativeW < cfg.REFINE_BELOW_PX) {
      try {
        // Crop from the decode buffer (already the highest-resolution copy we hold).
        const decodeBox = {
          x: d.box.x, y: d.box.y, w: d.box.w, h: d.box.h,
        };
        const sq = squarePaddedBox(decodeBox, cfg.REFINE_CROP_PADDING, decodeInfo.width, decodeInfo.height);
        const { data, info } = await extractSquareRaw(decodeBuf, decodeInfo, sq, cfg.REFINE_CROP_SIZE);
        tf.engine().startScope();
        let tensor = null;
        try {
          tensor = tf.tensor3d(rawToFloat32(data), [info.height, info.width, 3], 'float32');
          const r = await faceapi
            .detectSingleFace(tensor, new faceapi.SsdMobilenetv1Options({ minConfidence: cfg.REFINE_MIN_CONFIDENCE }))
            .withFaceLandmarks()
            .withFaceDescriptor();
          if (r?.descriptor) {
            descriptor = Float32Array.from(r.descriptor);
            frontality = frontalityFrom(r.landmarks);
            refined = true;
          }
        } finally {
          tensor?.dispose();
          tf.engine().endScope();
        }
      } catch {
        // Keep the detection-pass descriptor; not worth failing the photo over.
      }
    }

    // Raw Laplacian sigma of the face region, in decode space. Stored unnormalised
    // so the saturation constant stays tunable without a re-detection. Crops are
    // never upscaled — that would manufacture edges and make blur look sharp.
    let sharpness = -1;
    try {
      const sq = squarePaddedBox(d.box, 0.1, decodeInfo.width, decodeInfo.height);
      const size = Math.max(48, Math.min(160, sq.w));
      const { data, info } = await extractSquareRaw(decodeBuf, decodeInfo, sq, size);
      sharpness = await sharpnessScore(data, info);
    } catch { /* leave as -1 = unknown */ }

    faces.push({
      id: faceId(photo.id, d.boxPx),
      boxPx: {
        x: Math.round(d.boxPx.x), y: Math.round(d.boxPx.y),
        w: Math.round(d.boxPx.w), h: Math.round(d.boxPx.h),
      },
      score: Number(d.score.toFixed(4)),
      nativeWidth: Math.round(nativeW),
      frontality: Number(frontality.toFixed(4)),
      sharpness: Number(sharpness.toFixed(4)),
      refined,
      descriptor,
    });
  }

  // Two detections can quantise to the same face id (overlapping tiles on a
  // tiny face). Keep the higher-scoring one so ids stay unique per photo.
  const byId = new Map();
  for (const f of faces) {
    const prev = byId.get(f.id);
    if (!prev || f.score > prev.score) byId.set(f.id, f);
  }

  return {
    id: photo.id,
    width: meta.width,
    height: meta.height,
    phash,
    colour,
    faces: [...byId.values()],
    warnings,
  };
}
