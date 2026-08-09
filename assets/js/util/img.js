/** Derivative URLs are DERIVED from the id, never stored in the index —
 *  that keeps photos.json tiny (and relocating the folders a one-line change). */

const BASE = 'assets/gallery';

export const thumbSrc = (id) => `${BASE}/thumbs/${id}.webp`;
export const photoSrc = (id) => `${BASE}/photos/${id}.webp`;
export const coverSrc = (personId) => `${BASE}/covers/${personId}.webp`;
/** Only exists locally (originals are gitignored); used purely as an onerror
 *  fallback so a partially-run indexer still shows every photo. */
export const originalSrc = (id) => `assets/images/${id}.jpg`;

export function gridSrcset(id) {
  return `${thumbSrc(id)} 640w, ${photoSrc(id)} 1600w`;
}

export const GRID_SIZES =
  '(min-width: 1440px) 20vw, (min-width: 1024px) 25vw, (min-width: 600px) 33vw, 50vw';

/** Swap to the original if a derivative is missing, then give up quietly. */
export function withFallback(img, id) {
  img.addEventListener('error', () => {
    if (img.dataset.fellBack) return;
    img.dataset.fellBack = '1';
    img.removeAttribute('srcset');
    img.src = originalSrc(id);
  }, { once: true });
}

export function preload(src) {
  const i = new Image();
  i.decoding = 'async';
  i.src = src;
  return i;
}
