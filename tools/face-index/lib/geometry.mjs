/**
 * Box maths. Boxes are plain {x, y, w, h}.
 *
 * Convention used throughout the pipeline: a detection is converted to
 * ORIGINAL-IMAGE PIXEL space the moment it leaves the detector, and only
 * normalised to 0..1 at emit time. Mixing the two is the classic source of
 * subtly-offset face crops, so the units are named in every function below.
 */

export function iou(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const iw = x2 - x1;
  const ih = y2 - y1;
  if (iw <= 0 || ih <= 0) return 0;
  const inter = iw * ih;
  return inter / (a.w * a.h + b.w * b.h - inter);
}

/**
 * Greedy non-maximum suppression across detection passes.
 * Ranked by `rank` (higher wins) rather than raw score, so a detection found in
 * a high-resolution tile beats the same face found in the squashed full frame —
 * the winner's descriptor is the one we keep.
 */
export function nms(dets, threshold, rank = (d) => d.score) {
  const sorted = [...dets].sort((a, b) => rank(b) - rank(a));
  const kept = [];
  for (const d of sorted) {
    let dup = false;
    for (const k of kept) {
      if (iou(d.box, k.box) > threshold) { dup = true; break; }
    }
    if (!dup) kept.push(d);
  }
  return kept;
}

/** Expand a box to a square about its centre, pad, and clamp inside the image.
 *  Shifts rather than shrinks when it would run off an edge, so face crops keep
 *  a consistent scale near the frame border. Units: pixels. */
export function squarePaddedBox(box, padding, imgW, imgH) {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  let side = Math.max(box.w, box.h) * (1 + padding * 2);
  side = Math.min(side, Math.min(imgW, imgH));
  let x = Math.round(cx - side / 2);
  let y = Math.round(cy - side / 2);
  const s = Math.round(side);
  x = Math.max(0, Math.min(x, imgW - s));
  y = Math.max(0, Math.min(y, imgH - s));
  return { x, y, w: s, h: s };
}

/** Adaptive tile grid with overlap, in decode-buffer pixel space.
 *  Roughly-square tiles also dodge the aspect-squash that the full-frame pass
 *  suffers on 3:2 and 2:3 frames. */
export function tileGrid(width, height, targetPx, overlap) {
  const cols = Math.max(1, Math.ceil(width / targetPx));
  const rows = Math.max(1, Math.ceil(height / targetPx));
  if (cols === 1 && rows === 1) return [];
  const baseW = width / cols;
  const baseH = height / rows;
  const padX = baseW * overlap;
  const padY = baseH * overlap;
  const tiles = [];
  for (let r = 0; r < rows; r++) {
    for (let cIdx = 0; cIdx < cols; cIdx++) {
      const x0 = Math.max(0, Math.floor(cIdx * baseW - padX));
      const y0 = Math.max(0, Math.floor(r * baseH - padY));
      const x1 = Math.min(width, Math.ceil((cIdx + 1) * baseW + padX));
      const y1 = Math.min(height, Math.ceil((r + 1) * baseH + padY));
      const w = x1 - x0;
      const h = y1 - y0;
      if (w > 32 && h > 32) tiles.push({ x: x0, y: y0, w, h });
    }
  }
  return tiles;
}

/** Stable, content-derived face id: photo stem + box centre quantised to 8 px.
 *  Underscore not '#': a '#' in a URL is a fragment delimiter.
 *  Quantising means it survives trivial numeric jitter between runs, and it does
 *  not shift when OTHER photos are added to the set. */
export function faceId(photoId, boxPx) {
  const cx = Math.round((boxPx.x + boxPx.w / 2) / 8) * 8;
  const cy = Math.round((boxPx.y + boxPx.h / 2) / 8) * 8;
  const p = (n) => String(Math.max(0, n)).padStart(4, '0');
  return `${photoId}_${p(cx)}x${p(cy)}`;
}

export function normaliseBox(boxPx, imgW, imgH, dp = 4) {
  const r = (n) => Number(n.toFixed(dp));
  return [
    r(Math.max(0, boxPx.x / imgW)),
    r(Math.max(0, boxPx.y / imgH)),
    r(Math.min(1, boxPx.w / imgW)),
    r(Math.min(1, boxPx.h / imgH)),
  ];
}
