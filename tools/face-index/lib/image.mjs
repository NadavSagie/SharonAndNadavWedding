/**
 * sharp helpers. The whole point of this module is that we decode each photo
 * ONCE into a raw RGB buffer and serve the full-frame tensor, every tile, the
 * perceptual hash and the dominant colour from that single buffer.
 *
 * Naively calling sharp(file).extract(...) per face re-decodes a 40 MP JPEG
 * every time, which costs minutes across a real wedding set.
 */

import sharp from 'sharp';

/** Decode to raw RGB, EXIF-orientation baked in. Returns null-safe metadata too. */
export async function decodeRaw(input, longEdge, cfg, rawInput = null) {
  const pipeline = rawInput
    ? sharp(input, { raw: rawInput, limitInputPixels: cfg.MAX_INPUT_PIXELS })
    : sharp(input, { failOn: 'none', limitInputPixels: cfg.MAX_INPUT_PIXELS }).rotate();

  const { data, info } = await pipeline
    .resize({ width: longEdge, height: longEdge, fit: 'inside', withoutEnlargement: true })
    .removeAlpha()
    // Lightroom exports can be AdobeRGB/CMYK; without this the tensor channels lie.
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });

  return { data, info };
}

/** Canonical upright dimensions. sharp's autoOrient reflects EXIF rotation, and
 *  every downstream coordinate lives in THIS space. */
export async function readMetadata(file, cfg) {
  const m = await sharp(file, { failOn: 'none', limitInputPixels: cfg.MAX_INPUT_PIXELS }).metadata();
  const swap = m.orientation && m.orientation >= 5;
  // EXIF is deliberately NOT read or returned. Display order comes from the
  // sequential filename, so there is no reason to touch capture time — and
  // never reading it means venue GPS cannot leak by accident.
  return {
    width: m.autoOrient?.width ?? (swap ? m.height : m.width),
    height: m.autoOrient?.height ?? (swap ? m.width : m.height),
    format: m.format,
  };
}

/** Crop a region out of an already-decoded raw buffer. Units: decode-buffer px. */
export async function extractRaw(buf, info, region) {
  const { data, info: out } = await sharp(buf, {
    raw: { width: info.width, height: info.height, channels: info.channels },
  })
    .extract({
      left: Math.max(0, Math.round(region.x)),
      top: Math.max(0, Math.round(region.y)),
      width: Math.min(info.width - Math.round(region.x), Math.round(region.w)),
      height: Math.min(info.height - Math.round(region.y), Math.round(region.h)),
    })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, info: out };
}

/** Extract a square face region from the raw buffer and resize it — used both for
 *  small-face descriptor refinement and for cover crops. */
export async function extractSquareRaw(buf, info, boxPx, size) {
  const { data, info: out } = await sharp(buf, {
    raw: { width: info.width, height: info.height, channels: info.channels },
  })
    .extract({ left: boxPx.x, top: boxPx.y, width: boxPx.w, height: boxPx.h })
    .resize(size, size, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, info: out };
}

/**
 * Laplacian variance as a blur proxy. convolve() with the 4-neighbour Laplacian
 * then stats().stdev IS sigma of the Laplacian response — high for crisp edges,
 * near zero for a motion-blurred dance-floor frame.
 */
export async function sharpnessScore(buf, info) {
  const stats = await sharp(buf, {
    raw: { width: info.width, height: info.height, channels: info.channels },
  })
    .greyscale()
    .convolve({ width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0] })
    .stats();
  return stats.channels[0]?.stdev ?? 0;
}

/** Average colour of the photo, as a hex placeholder for the grid.
 *  Deliberately a colour and not a base64 blur: 2000 blurs is ~400 KB of JSON,
 *  2000 hex strings is ~14 KB. */
export async function dominantColour(buf, info) {
  try {
    const { data } = await sharp(buf, {
      raw: { width: info.width, height: info.height, channels: info.channels },
    })
      .resize(1, 1, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const hex = (n) => n.toString(16).padStart(2, '0');
    return `#${hex(data[0])}${hex(data[1])}${hex(data[2])}`;
  } catch {
    return '#e5dcd1';
  }
}

/** 64-bit average hash over an 8x8 greyscale reduction, as a 16-char hex string.
 *  Used to group burst frames so they do not inflate a person's photo count. */
export async function aHash(buf, info) {
  const { data } = await sharp(buf, {
    raw: { width: info.width, height: info.height, channels: info.channels },
  })
    .greyscale()
    .resize(8, 8, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  let sum = 0;
  for (let i = 0; i < 64; i++) sum += data[i];
  const avg = sum / 64;
  let hex = '';
  for (let nib = 0; nib < 16; nib++) {
    let v = 0;
    for (let b = 0; b < 4; b++) {
      if (data[nib * 4 + b] >= avg) v |= 1 << (3 - b);
    }
    hex += v.toString(16);
  }
  return hex;
}

export function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}

/** Raw RGB buffer -> Float32Array in 0..255.
 *  NOT 0..1: face-api's NetInput applies its own normalisation, and feeding it
 *  0..1 produces silently empty detections rather than an error. */
export function rawToFloat32(data) {
  const f32 = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) f32[i] = data[i];
  return f32;
}

export { sharp };
