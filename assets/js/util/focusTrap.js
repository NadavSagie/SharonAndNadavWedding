/** Keep Tab inside a dialog, and restore focus (and scroll position) on close. */

const SELECTOR = 'a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])';

export function trapFocus(container) {
  const previous = document.activeElement;

  const onKey = (e) => {
    if (e.key !== 'Tab') return;
    const items = [...container.querySelectorAll(SELECTOR)].filter((el) => el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  container.addEventListener('keydown', onKey);

  return function release({ restore = true } = {}) {
    container.removeEventListener('keydown', onKey);
    if (restore && previous && document.contains(previous)) {
      previous.focus({ preventScroll: true });
      previous.scrollIntoView({ block: 'nearest' });
    }
  };
}

/**
 * Lock body scroll without losing position.
 * iOS Safari silently scrolls the page behind a modal unless you pin it with
 * position:fixed, so closing the viewer would otherwise dump guests at photo 1.
 */
export function lockScroll() {
  const y = window.scrollY;
  const { body } = document;
  body.classList.add('lb-open');
  body.style.position = 'fixed';
  body.style.top = `-${y}px`;
  body.style.width = '100%';
  return function unlock() {
    body.classList.remove('lb-open');
    body.style.position = '';
    body.style.top = '';
    body.style.width = '';
    window.scrollTo(0, y);
  };
}
