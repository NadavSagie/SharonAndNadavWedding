/** The sticky header shown on every route except home (home stays a poster). */

import { navigate } from '../router.js';

const el = () => document.getElementById('app-header');

export function initHeader() {
  const header = el();
  document.getElementById('hdr-back')?.addEventListener('click', () => {
    // history.back() keeps the natural feel; the fallback covers deep links
    // opened in a fresh tab, where there is nothing to go back to.
    if (history.length > 1) history.back();
    else navigate('/people');
  });

  const onScroll = () => {
    header.dataset.scrolled = window.scrollY > 8 ? '1' : '0';
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

export function setHeader({ visible, title = '', showPhotosLink = true }) {
  const header = el();
  if (!header) return;
  header.hidden = !visible;
  document.getElementById('hdr-title').textContent = title;
  const link = document.getElementById('hdr-photos');
  if (link) link.style.visibility = showPhotosLink ? 'visible' : 'hidden';
}
