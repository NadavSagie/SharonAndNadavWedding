/** All photos. Secondary to face discovery, but it must always work — this is
 *  the view the whole site falls back to when there is no face index. */

import { h } from '../util/dom.js';
import { getPhotos } from '../data.js';
import { gallery } from '../components/gallery.js';
import { setHeader } from '../components/appHeader.js';
import { siteFooter } from '../components/footer.js';
import { consumeDeepLinkSuppression } from '../util/navGuard.js';

export async function photosView({ photo } = {}) {
  setHeader({ visible: true, title: 'All photos', showPhotosLink: false });

  const photos = await getPhotos();
  const heading = h('h1', { tabindex: '-1' }, 'All photos');
  const grid = gallery(photos, { context: 'photos' });

  return {
    title: 'All photos',
    el: h('div', { class: 'page' },
      h('div', { class: 'page-intro' },
        heading,
        h('p', { class: 'meta' }, `${photos.length} photos`)),
      grid.el,
      siteFooter()),
    mounted() {
      heading.focus({ preventScroll: true });
      grid.mounted();
      // Always consume: this hashchange might be the lightbox unwinding its
      // own history after a swipe-then-close, not a genuine deep link.
      const suppressed = consumeDeepLinkSuppression();
      if (photo && !suppressed) openDeepLinked(photos, photo);
    },
    unmount() { grid.unmount(); },
  };
}

async function openDeepLinked(photos, photoId) {
  const idx = photos.findIndex((p) => p.id === photoId);
  if (idx < 0) return;
  const { openLightbox } = await import('../components/lightbox.js');
  openLightbox(photos, idx, { context: 'photos' });
}
