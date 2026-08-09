/** One person: their face, their name, and only their photos. */

import { h } from '../util/dom.js';
import { getPhotos, getPeople, photoById, displayName } from '../data.js';
import { coverSrc } from '../util/img.js';
import { gallery } from '../components/gallery.js';
import { setHeader } from '../components/appHeader.js';
import { siteFooter } from '../components/footer.js';
import { notFoundView } from './notFound.js';

export async function personView({ id, photo }) {
  const [, data] = await Promise.all([getPhotos(), getPeople()]);
  const person = data.byId.get(id);

  if (!person) {
    return notFoundView({
      heading: 'We couldn’t find that person',
      body: 'They may have been merged into someone else, or the index was rebuilt.',
      href: '#/people',
      cta: 'Back to everyone',
    });
  }

  const name = displayName(person);
  setHeader({ visible: true, title: name });

  // Photos strictly from the face index — never the whole gallery.
  const photos = person.photos.map(photoById).filter(Boolean);

  const heading = h('h1', { tabindex: '-1' }, name);
  const grid = gallery(photos, { context: 'person', personId: person.id });

  const head = h('div', { class: 'person-head' },
    h('img', { src: coverSrc(person.id), alt: '', width: 96, height: 96 }),
    heading,
    h('p', { class: 'count' }, `in ${photos.length} ${photos.length === 1 ? 'photo' : 'photos'}`),
    !person.name && h('a', {
      class: 'claim',
      href: `mailto:nadav.sagie@bagirasys.com?subject=${encodeURIComponent(`Wedding gallery — ${name} is me`)}`
        + `&body=${encodeURIComponent(`Hi! ${name} (id ${person.id}) is me. My name is:`)}`,
    }, 'Is this you? Tell us your name'));

  return {
    title: name,
    el: h('div', { class: 'page' }, head, h('hr', { class: 'hairline' }), grid.el, siteFooter()),
    mounted() {
      heading.focus({ preventScroll: true });
      grid.mounted();
      if (photo) openDeepLinked(photos, photo, person.id);
    },
    unmount() { grid.unmount(); },
  };
}

async function openDeepLinked(photos, photoId, personId) {
  const idx = photos.findIndex((p) => p.id === photoId);
  if (idx < 0) return;
  const { openLightbox } = await import('../components/lightbox.js');
  openLightbox(photos, idx, { context: 'person', personId });
}
