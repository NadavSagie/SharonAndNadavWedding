/**
 * Pointer-Events gesture recogniser: one code path for touch, mouse and pen.
 *
 * Recognises horizontal swipe (prev/next), vertical drag-to-dismiss, tap /
 * double-tap, two-finger pinch-to-zoom, and single-finger pan while zoomed.
 * Axis is locked after the first few pixels so a diagonal finger never does
 * both a swipe and a dismiss at once.
 *
 * State machine (one active gesture "mode" at a time):
 *   idle   -> no pointers down
 *   single -> exactly one pointer down, image at 1x: swipe / dismiss / tap
 *   pan    -> exactly one pointer down, image zoomed in: pans the image;
 *             still resolves to tap/double-tap if the finger never moved
 *   pinch  -> two (or more) pointers down: scales + pans together
 *
 * A pinch that drops back to one finger hands off to "pan" (or ends outright
 * if the pinch returned to 1x) rather than re-entering "single" — a leftover
 * finger after a pinch must never be reinterpreted as a fresh swipe.
 */

const AXIS_LOCK_PX = 10;
const COMMIT_PX = 60;
const COMMIT_VELOCITY = 0.35; // px/ms
const DISMISS_PX = 110;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP = 24;

// Buttons/links (close, prev, next, download, share, face-chips, ...) sit
// inside the same element this recogniser listens on. setPointerCapture()
// retargets the compatibility mouse events for that pointer — including the
// eventual `click` — to the CAPTURING element instead of the button, so a
// desktop mouse click on any of them silently does nothing once the overlay
// has captured the pointer. Starting a gesture on an interactive control was
// never intentional (swipe/drag/pinch/double-tap only make sense on the photo
// itself), so skip capture entirely when the press starts on one.
const INTERACTIVE_SELECTOR = 'button, a, [role="button"], input, select, textarea';

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

export function attachGestures(el, handlers) {
  const pointers = new Map(); // pointerId -> {x, y}, insertion order preserved
  let mode = 'idle';
  let primaryId = null;
  let x0 = 0; let y0 = 0; let t0 = 0;
  let axis = null; // 'x' | 'y', single-mode only
  let moved = false;
  let lastTap = 0; let lastTapX = 0; let lastTapY = 0;
  let pinchLastDist = 0;

  const onDown = (e) => {
    if (e.target.closest?.(INTERACTIVE_SELECTOR)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    el.setPointerCapture?.(e.pointerId);

    if (pointers.size === 1) {
      primaryId = e.pointerId;
      x0 = e.clientX; y0 = e.clientY; t0 = performance.now();
      axis = null;
      moved = false;
      if (handlers.isZoomed?.()) {
        mode = 'pan';
        handlers.onPanStart?.();
      } else {
        mode = 'single';
      }
    } else if (pointers.size === 2) {
      const [a, b] = pointers.values();
      pinchLastDist = dist(a, b);
      mode = 'pinch';
      moved = true; // a pinch never resolves to a tap, however it ends
      handlers.onPinchStart?.();
    }
    // a 3rd+ simultaneous pointer is tracked (so the up-count stays correct)
    // but does not change the current mode.
  };

  const onMove = (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (mode === 'pinch') {
      const [a, b] = pointers.values();
      const d = dist(a, b);
      if (pinchLastDist > 0 && d > 0) {
        handlers.onPinchMove?.(d / pinchLastDist, (a.x + b.x) / 2, (a.y + b.y) / 2);
      }
      pinchLastDist = d;
      return;
    }

    if (e.pointerId !== primaryId) return;

    if (mode === 'pan') {
      const dx = e.clientX - x0;
      const dy = e.clientY - y0;
      x0 = e.clientX; y0 = e.clientY; // pan reports incremental deltas
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
      handlers.onPanMove?.(dx, dy);
      return;
    }

    if (mode === 'single') {
      const dx = e.clientX - x0;
      const dy = e.clientY - y0;
      if (!axis) {
        if (Math.abs(dx) < AXIS_LOCK_PX && Math.abs(dy) < AXIS_LOCK_PX) return;
        axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
        handlers.onDragStart?.(axis);
      }
      moved = true;
      if (axis === 'x') handlers.onDragX?.(dx);
      else handlers.onDragY?.(dy);
    }
  };

  function resolveTap(e) {
    const now = performance.now();
    const isDouble = now - lastTap < DOUBLE_TAP_MS
      && Math.abs(e.clientX - lastTapX) < DOUBLE_TAP_SLOP
      && Math.abs(e.clientY - lastTapY) < DOUBLE_TAP_SLOP;
    if (isDouble) {
      lastTap = 0;
      handlers.onDoubleTap?.(e);
    } else {
      lastTap = now; lastTapX = e.clientX; lastTapY = e.clientY;
      setTimeout(() => {
        if (lastTap && performance.now() - lastTap >= DOUBLE_TAP_MS - 10) {
          handlers.onTap?.(e);
          lastTap = 0;
        }
      }, DOUBLE_TAP_MS);
    }
  }

  const finish = (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    el.releasePointerCapture?.(e.pointerId);

    if (mode === 'pinch') {
      if (pointers.size >= 2) return; // still pinching with the remaining pointers
      handlers.onPinchEnd?.();
      const remaining = pointers.entries().next().value; // [id, {x,y}] or undefined
      if (remaining && handlers.isZoomed?.()) {
        // Hand off to a pan with the still-down finger — never back to
        // "single", so this leftover finger can never be read as a swipe.
        [primaryId] = remaining;
        x0 = remaining[1].x; y0 = remaining[1].y; t0 = performance.now();
        moved = true;
        mode = 'pan';
        handlers.onPanStart?.();
      } else {
        mode = 'idle';
      }
      return;
    }

    if (e.pointerId !== primaryId) return; // an extra (3rd+) pointer lifting

    if (mode === 'pan') {
      mode = 'idle';
      if (!moved) resolveTap(e); // finger never actually moved: treat as a tap
      handlers.onPanEnd?.();
      return;
    }

    if (mode === 'single') {
      mode = 'idle';
      const dx = e.clientX - x0;
      const dy = e.clientY - y0;
      const dt = Math.max(1, performance.now() - t0);

      if (!moved) {
        resolveTap(e);
        handlers.onDragEnd?.(null, 0, 0);
        return;
      }

      if (axis === 'x') {
        const v = Math.abs(dx) / dt;
        const commit = Math.abs(dx) > COMMIT_PX || v > COMMIT_VELOCITY;
        handlers.onDragEnd?.('x', dx, commit ? Math.sign(dx) : 0);
      } else if (axis === 'y') {
        const v = dy / dt;
        const dismiss = dy > DISMISS_PX || v > COMMIT_VELOCITY;
        handlers.onDragEnd?.('y', dy, dismiss ? 1 : 0);
      }
      axis = null;
    }
  };

  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', finish);

  return () => {
    el.removeEventListener('pointerdown', onDown);
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', finish);
    el.removeEventListener('pointercancel', finish);
  };
}
