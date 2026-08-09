/**
 * Pointer-Events gesture recogniser: one code path for touch, mouse and pen.
 *
 * Recognises horizontal swipe (prev/next), vertical drag-to-dismiss and
 * double-tap. Axis is locked after the first few pixels so a diagonal finger
 * never does both at once.
 */

const AXIS_LOCK_PX = 10;
const COMMIT_PX = 60;
const COMMIT_VELOCITY = 0.35; // px/ms
const DISMISS_PX = 110;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP = 24;

export function attachGestures(el, handlers) {
  let active = false;
  let id = null;
  let x0 = 0; let y0 = 0; let t0 = 0;
  let axis = null; // 'x' | 'y'
  let lastTap = 0; let lastTapX = 0; let lastTapY = 0;
  let moved = false;

  const onDown = (e) => {
    if (!e.isPrimary) return;
    if (handlers.isZoomed?.()) { handlers.onPanStart?.(e); return; }
    active = true;
    id = e.pointerId;
    x0 = e.clientX; y0 = e.clientY; t0 = performance.now();
    axis = null;
    moved = false;
    el.setPointerCapture?.(id);
  };

  const onMove = (e) => {
    if (!active || e.pointerId !== id) return;
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
  };

  const finish = (e) => {
    if (!active || e.pointerId !== id) return;
    active = false;
    el.releasePointerCapture?.(id);
    const dx = e.clientX - x0;
    const dy = e.clientY - y0;
    const dt = Math.max(1, performance.now() - t0);

    if (!moved) {
      // tap / double-tap
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
