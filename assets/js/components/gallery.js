/**
 * Photo grid.
 *
 * Round-robin column masonry: column = index % columnCount. Because every photo
 * in this set is 3:2 or 2:3, that gives exact left-to-right reading order AND
 * column heights within one photo of balanced — with no measurement, no
 * observer and no reflow.
 *   (CSS `columns` would scramble chronological order into vertical snakes;
 *    shortest-column packing reorders photos; square crops cut off faces, which
 *    is unacceptable in a face-first gallery.)
 *
 * Chunked rendering keeps 2000 photos viable while preserving native lazy
 * loading, in-page find and scroll restoration — all of which true
 * virtualisation would break.
 */

import { h } from '../util/dom.js';
import { gridSrcset, thumbSrc, GRID_SIZES, withFallback } from '../util/img.js';
import { openLightbox } from './lightbox.js';

const CHUNK = 150;
const EAGER = 4;

function columnsFor(width) {
  if (width >= 1440) return 5;
  if (width >= 1024) return 4;
  if (width >= 600) return 3;
  return 2;
}

function tile(photo, index, total, onOpen) {
  const img = h('img', {
    src: thumbSrc(photo.id),
    srcset: gridSrcset(photo.id),
    sizes: GRID_SIZES,
    width: photo.w,
    height: photo.h,
    alt: '',
    decoding: 'async',
    loading: index < EAGER ? 'eager' : 'lazy',
    fetchpriority: index < EAGER ? 'high' : 'auto',
    style: { aspectRatio: `${photo.w} / ${photo.h}` },
  });
  withFallback(img, photo.id);
  if (img.complete) img.classList.add('is-loaded');
  else img.addEventListener('load', () => img.classList.add('is-loaded'), { once: true });

  return h('button', {
    class: 'tile',
    type: 'button',
    style: { background: photo.c || 'var(--c-paper-sunk)' },
    'aria-label': `Open photo ${index + 1} of ${total}`,
    onClick: () => onOpen(index),
  }, img);
}

export function gallery(photos, { context = 'photos', personId = null } = {}) {
  const grid = h('div', { class: 'gallery' });
  const status = h('p', { class: 'gallery-more' });
  const sentinel = h('div', { class: 'gallery-sentinel' });
  const root = h('div', null, grid, sentinel, status);

  let cols = 0;
  let rendered = 0;
  let colEls = [];

  const open = (i) => openLightbox(photos, i, { context, personId });

  const buildColumns = () => {
    cols = columnsFor(window.innerWidth);
    colEls = Array.from({ length: cols }, () => h('div', { class: 'gallery-col' }));
    grid.replaceChildren(...colEls);
    rendered = 0;
  };

  const renderChunk = () => {
    const end = Math.min(rendered + CHUNK, photos.length);
    for (let i = rendered; i < end; i++) {
      colEls[i % cols].append(tile(photos[i], i, photos.length, open));
    }
    rendered = end;
    status.textContent = rendered < photos.length
      ? `${rendered} of ${photos.length}`
      : '';
  };

  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting) && rendered < photos.length) renderChunk();
  }, { rootMargin: '800px' });

  // Only rebuild when the COLUMN COUNT changes, not on every resize pixel.
  let resizeTimer = null;
  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (columnsFor(window.innerWidth) === cols) return;
      const had = rendered;
      buildColumns();
      while (rendered < had && rendered < photos.length) renderChunk();
    }, 150);
  };

  buildColumns();
  renderChunk();

  return {
    el: root,
    mounted() {
      io.observe(sentinel);
      window.addEventListener('resize', onResize);
    },
    unmount() {
      io.disconnect();
      window.removeEventListener('resize', onResize);
      clearTimeout(resizeTimer);
    },
  };
}
