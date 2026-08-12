/**
 * Fullscreen photo viewer.
 *
 * Gesture model deliberately mirrors Google Photos / Instagram, because that is
 * what guests already have in their fingers:
 *   - horizontal swipe: prev/next, image tracking the finger 1:1 (only at 1x)
 *   - vertical drag down: dismiss, image scaling and backdrop fading (only at 1x)
 *   - double-tap: 1x <-> 2.5x about the tap point, either direction
 *   - two-finger pinch: continuous zoom (1x-4x) about the pinch midpoint
 *   - single-finger drag while zoomed: pans instead of swiping/dismissing
 * attachGestures() (util/gestures.js) owns which of these is active at any
 * moment; this module only reacts to its callbacks.
 *
 * History: opening pushes one entry, next/prev REPLACE it. So Android back
 * closes the viewer instead of unwinding thirty swipes, and any open photo is
 * a shareable link. Closing after swiping calls history.back() to unwind that
 * one entry — see util/navGuard.js for why that needs a suppression flag, not
 * just a bare history.back().
 */

import { h, icon, announce } from '../util/dom.js';
import { photoSrc, thumbSrc, coverSrc, preload, withFallback } from '../util/img.js';
import { suppressNextDeepLink } from '../util/navGuard.js';
import { attachGestures } from '../util/gestures.js';
import { trapFocus, lockScroll } from '../util/focusTrap.js';
import { getPhotoFaces, getPeople, displayName } from '../data.js';
import { navigate } from '../router.js';

const ICONS = {
  close: 'M6 6l12 12M18 6L6 18',
  left: 'M15 5l-7 7 7 7',
  right: 'M9 5l7 7-7 7',
  download: ['M12 3v12', 'M7.5 10.5L12 15l4.5-4.5', 'M4 20h16'],
  share: ['M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7', 'M12 3v13', 'M8 7l4-4 4 4'],
  faces: ['M4 4h4M4 4v4M20 4h-4M20 4v4M4 20h4M4 20v-4M20 20h-4M20 20v-4'],
};

const DOUBLE_TAP_ZOOM = 2.5;
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const CHROME_IDLE_MS = 3000;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

let state = null;

function isIOS() {
  return /iP(hone|ad|od)/.test(navigator.platform)
    || (navigator.userAgent.includes('Mac') && 'ontouchend' in document);
}

export function isLightboxOpen() { return state != null; }

export function openLightbox(photos, index, { context = 'photos', personId = null } = {}) {
  if (state) closeLightbox({ history: false });

  const unlock = lockScroll();
  let i = index;
  let zoom = 1;
  let panX = 0; let panY = 0;
  let dragging = null;
  let chromeTimer = null;
  let facesData = null;
  let peopleData = null;
  let showBoxes = false;

  const img = h('img', { class: 'lb-img', alt: '', draggable: false });
  const stage = h('div', { class: 'lb-stage' }, img);
  const boxLayer = h('div', { class: 'lb-boxes' });

  const counter = h('span', { class: 'lb-counter' });
  const btnClose = h('button', { class: 'lb-btn lb-close', type: 'button', 'aria-label': 'Close (Esc)', onClick: () => closeLightbox() }, icon(ICONS.close));
  const btnPrev = h('button', { class: 'lb-btn lb-prev', type: 'button', 'aria-label': 'Previous photo', onClick: () => go(-1) }, icon(ICONS.left));
  const btnNext = h('button', { class: 'lb-btn lb-next', type: 'button', 'aria-label': 'Next photo', onClick: () => go(1) }, icon(ICONS.right));

  const chips = h('div', { class: 'lb-chips' });
  const btnBoxes = h('button', { class: 'lb-btn', type: 'button', 'aria-label': 'Show face outlines', onClick: () => { showBoxes = !showBoxes; drawBoxes(); } }, icon(ICONS.faces));
  const btnDownload = h('a', { class: 'lb-btn', 'aria-label': 'Download this photo', download: '' }, icon(ICONS.download));
  const btnShare = h('button', { class: 'lb-btn', type: 'button', 'aria-label': 'Share this photo', onClick: share }, icon(ICONS.share));
  const actions = h('div', { class: 'lb-actions' }, btnBoxes, btnDownload, btnShare);
  const bar = h('div', { class: 'lb-bar' }, chips, actions);

  const chrome = h('div', { class: 'lb-chrome' }, counter, btnClose, btnPrev, btnNext, bar);
  const root = h('div', {
    class: 'lb', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Photo viewer',
    dataset: { open: '0', chrome: '1' },
  }, stage, boxLayer, chrome);

  document.body.append(root);
  requestAnimationFrame(() => { root.dataset.open = '1'; });

  const main = document.getElementById('main');
  main?.setAttribute('inert', '');
  main?.setAttribute('aria-hidden', 'true');

  const releaseFocus = trapFocus(root);
  btnClose.focus({ preventScroll: true });

  // ---- rendering ----------------------------------------------------------

  function applyTransform(extraX = 0, extraY = 0, scale = zoom, opacity = 1) {
    img.style.transform = `translate(${panX + extraX}px, ${panY + extraY}px) scale(${scale})`;
    root.style.opacity = String(opacity);
  }

  /** Keep a zoomed image from drifting fully off-screen. Computed from the
   *  image's natural aspect ratio against the viewport rather than measuring
   *  the live (already-transformed) box, so it's correct mid-gesture. */
  function clampPan() {
    if (!img.naturalWidth) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const fit = Math.min(vw / img.naturalWidth, vh / img.naturalHeight);
    const halfW = (img.naturalWidth * fit * zoom) / 2;
    const halfH = (img.naturalHeight * fit * zoom) / 2;
    const maxX = Math.max(0, halfW - vw / 2);
    const maxY = Math.max(0, halfH - vh / 2);
    panX = clamp(panX, -maxX, maxX);
    panY = clamp(panY, -maxY, maxY);
  }

  function show(idx, { announceIt = true } = {}) {
    i = ((idx % photos.length) + photos.length) % photos.length;
    const p = photos[i];
    zoom = 1; panX = 0; panY = 0;
    img.classList.remove('settling');
    applyTransform();

    img.src = photoSrc(p.id);
    withFallback(img, p.id);
    img.alt = altFor(p);
    counter.textContent = `${i + 1} / ${photos.length}`;
    btnDownload.href = photoSrc(p.id);
    btnDownload.setAttribute('download', `${p.id}.webp`);

    btnPrev.disabled = photos.length < 2;
    btnNext.disabled = photos.length < 2;

    // exactly two neighbours: more wastes cellular data, fewer feels laggy
    if (photos.length > 1) {
      preload(photoSrc(photos[(i + 1) % photos.length].id));
      preload(photoSrc(photos[(i - 1 + photos.length) % photos.length].id));
    }

    syncHistory();
    renderChips();
    drawBoxes();
    if (announceIt) announce(`Photo ${i + 1} of ${photos.length}`);
    wakeChrome();
  }

  function altFor(p) {
    const base = `Wedding photo ${i + 1} of ${photos.length}`;
    const list = facesData?.[p.id];
    if (!list?.length || !peopleData) return base;
    const names = list.map((f) => {
      const person = peopleData.byId.get(f.p);
      return person ? displayName(person) : null;
    }).filter(Boolean);
    return names.length ? `${base}, showing ${names.join(', ')}` : base;
  }

  function go(delta) {
    if (photos.length < 2) return;
    show(i + delta);
  }

  // ---- face chips ---------------------------------------------------------

  async function loadFaces() {
    [facesData, peopleData] = await Promise.all([getPhotoFaces(), getPeople()]);
    renderChips();
    drawBoxes();
    img.alt = altFor(photos[i]);
  }

  function renderChips() {
    chips.replaceChildren();
    const list = facesData?.[photos[i].id];
    if (!list?.length || !peopleData?.ok) return;
    const seen = new Set();
    for (const f of list) {
      if (seen.has(f.p)) continue;
      seen.add(f.p);
      const person = peopleData.byId.get(f.p);
      if (!person) continue;
      chips.append(h('button', {
        class: 'lb-chip', type: 'button',
        onClick: () => {
          // Close WITHOUT history.back(): that fires popstate asynchronously and
          // would undo the navigation below. Replacing the lightbox's own entry
          // also means Back returns to the grid, not to this photo.
          closeLightbox({ history: false });
          navigate(`/people/${person.id}`, { replace: true });
        },
      },
      h('img', { src: coverSrc(person.id), alt: '', loading: 'lazy' }),
      displayName(person)));
    }
  }

  function drawBoxes() {
    boxLayer.replaceChildren();
    if (!showBoxes) return;
    const list = facesData?.[photos[i].id];
    if (!list?.length) return;
    const r = img.getBoundingClientRect();
    Object.assign(boxLayer.style, {
      left: `${r.left}px`, top: `${r.top}px`,
      width: `${r.width}px`, height: `${r.height}px`,
    });
    for (const f of list) {
      const [x, y, w, hh] = f.b;
      boxLayer.append(h('div', {
        class: 'lb-box',
        style: {
          left: `${x * 100}%`, top: `${y * 100}%`,
          width: `${w * 100}%`, height: `${hh * 100}%`,
        },
      }));
    }
  }

  // ---- chrome auto-hide ---------------------------------------------------

  function wakeChrome() {
    root.dataset.chrome = '1';
    clearTimeout(chromeTimer);
    if (matchMedia('(hover: none)').matches) {
      chromeTimer = setTimeout(() => { root.dataset.chrome = '0'; }, CHROME_IDLE_MS);
    }
  }

  // ---- share / download ---------------------------------------------------

  async function share() {
    const url = `${location.origin}${location.pathname}#${hashFor()}`;
    try {
      if (navigator.share) await navigator.share({ title: 'Nadav & Sharon', url });
      else {
        await navigator.clipboard.writeText(url);
        toast('Link copied');
      }
    } catch { /* user cancelled */ }
  }

  function toast(text) {
    const t = h('div', { class: 'lb-hint' }, text);
    root.append(t);
    setTimeout(() => t.remove(), 1800);
  }

  // WhatsApp/Instagram webviews on iOS swallow the download attribute.
  if (isIOS()) {
    btnDownload.addEventListener('click', () => toast('Press and hold the photo to save'));
  }

  // ---- history ------------------------------------------------------------

  function hashFor() {
    return personId ? `/people/${personId}/${photos[i].id}` : `/photos/${photos[i].id}`;
  }

  let pushed = false;
  function syncHistory() {
    const target = `#${hashFor()}`;
    if (!pushed) {
      history.pushState({ lb: true }, '', target);
      pushed = true;
    } else {
      history.replaceState({ lb: true }, '', target);
    }
  }

  const onPop = () => { closeLightbox({ history: false }); };
  window.addEventListener('popstate', onPop);

  // ---- keyboard -----------------------------------------------------------

  const onKey = (e) => {
    switch (e.key) {
      case 'Escape': e.preventDefault(); closeLightbox(); break;
      case 'ArrowRight': case ' ': e.preventDefault(); go(1); break;
      case 'ArrowLeft': e.preventDefault(); go(-1); break;
      case 'Home': e.preventDefault(); show(0); break;
      case 'End': e.preventDefault(); show(photos.length - 1); break;
      case 'd': btnDownload.click(); break;
      default: return;
    }
    wakeChrome();
  };
  document.addEventListener('keydown', onKey);

  // ---- gestures -----------------------------------------------------------

  // Static (zoom=1, pan=0) on-screen centre of the image, cached for the
  // duration of a pinch. The centre point is invariant under scale (default
  // transform-origin is the element's own centre), so it can be recovered
  // from the CURRENT rect by subtracting the CURRENT pan, and then reused for
  // every subsequent pinch-move frame without re-reading layout each time.
  let pinchCenterX = 0;
  let pinchCenterY = 0;

  const detach = attachGestures(root, {
    isZoomed: () => zoom > 1,
    onTap: () => {
      if (root.dataset.chrome === '0') wakeChrome();
      else if (matchMedia('(hover: none)').matches) root.dataset.chrome = '0';
    },
    onDoubleTap: (e) => {
      if (zoom > 1) { zoom = 1; panX = 0; panY = 0; }
      else {
        zoom = DOUBLE_TAP_ZOOM;
        const r = img.getBoundingClientRect();
        panX = (r.left + r.width / 2 - e.clientX) * (DOUBLE_TAP_ZOOM - 1);
        panY = (r.top + r.height / 2 - e.clientY) * (DOUBLE_TAP_ZOOM - 1);
        clampPan();
      }
      img.classList.add('settling');
      applyTransform();
      drawBoxes();
    },
    onPanStart: () => { img.classList.remove('settling'); },
    onPanMove: (dx, dy) => {
      panX += dx;
      panY += dy;
      applyTransform();
      drawBoxes();
    },
    onPanEnd: () => {
      img.classList.add('settling');
      clampPan();
      applyTransform();
    },
    onPinchStart: () => {
      img.classList.remove('settling');
      const r = img.getBoundingClientRect();
      pinchCenterX = r.left + r.width / 2 - panX;
      pinchCenterY = r.top + r.height / 2 - panY;
    },
    onPinchMove: (ratio, cx, cy) => {
      const next = clamp(zoom * ratio, MIN_ZOOM, MAX_ZOOM);
      const r = next / zoom; // actual ratio actually applied, after clamping
      if (r === 1) return;
      panX = panX * r + (cx - pinchCenterX) * (1 - r);
      panY = panY * r + (cy - pinchCenterY) * (1 - r);
      zoom = next;
      applyTransform();
      drawBoxes();
    },
    onPinchEnd: () => {
      img.classList.add('settling');
      if (zoom <= MIN_ZOOM + 0.02) { zoom = MIN_ZOOM; panX = 0; panY = 0; }
      else clampPan();
      applyTransform();
      drawBoxes();
    },
    onDragStart: (axis) => { dragging = axis; root.dataset.dragging = '1'; img.classList.remove('settling'); },
    onDragX: (dx) => {
      // rubber-band at the ends so the collection feels finite
      const atEnd = (dx > 0 && i === 0) || (dx < 0 && i === photos.length - 1);
      applyTransform(atEnd && photos.length > 1 ? dx * 0.35 : dx, 0);
    },
    onDragY: (dy) => {
      if (dy < 0) return;
      const k = Math.min(1, dy / 320);
      applyTransform(0, dy, 1 - k * 0.14, 1 - k * 0.6);
    },
    onDragEnd: (axis, delta, commit) => {
      root.dataset.dragging = '0';
      dragging = null;
      img.classList.add('settling');
      if (axis === 'x' && commit && photos.length > 1) { go(-commit); return; }
      if (axis === 'y' && commit) { closeLightbox(); return; }
      applyTransform();
      root.style.opacity = '1';
    },
  });

  const onResize = () => drawBoxes();
  window.addEventListener('resize', onResize);

  state = {
    destroy({ history: useHistory = true } = {}) {
      detach();
      releaseFocus();
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('resize', onResize);
      clearTimeout(chromeTimer);
      main?.removeAttribute('inert');
      main?.removeAttribute('aria-hidden');
      root.dataset.open = '0';
      setTimeout(() => root.remove(), 200);
      unlock();
      if (useHistory && pushed) {
        // If the guest swiped before closing, the current hash still carries
        // the ORIGINAL deep-linked photo id (opening pushed once; every swipe
        // since only replaced that same entry). back() lands there, and
        // without this flag the router would treat that hashchange as a
        // fresh deep link and reopen a stale lightbox instead of closing.
        suppressNextDeepLink();
        history.back();
      }
    },
  };

  show(i, { announceIt: false });
  loadFaces();
}

export function closeLightbox(opts) {
  const s = state;
  state = null;
  s?.destroy(opts);
}
