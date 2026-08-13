/** The People page — the heart of the app. */

import { h } from '../util/dom.js';
import { getPhotos, getPeople, displayName, sortPeople } from '../data.js';
import { coverSrc } from '../util/img.js';
import { setHeader } from '../components/appHeader.js';
import { siteFooter } from '../components/footer.js';

function personTile(person) {
  const name = person.name
    ? h('span', { class: 'person-name' }, person.name)
    : h('span', { class: 'person-name' }, 'Guest ', h('span', { class: 'n' }, String(person.guestNumber)));

  return h('a', {
    class: 'person-tile',
    href: `#/people/${person.id}`,
  },
  h('img', {
    class: 'person-face',
    src: coverSrc(person.id),
    alt: '',
    loading: 'lazy',
    decoding: 'async',
    width: 320,
    height: 320,
  }),
  name,
  h('span', { class: 'person-count' },
    `${person.photoCount} ${person.photoCount === 1 ? 'photo' : 'photos'}`));
}

export async function peopleView() {
  setHeader({ visible: true, title: 'Find your photos' });

  const [photos, data] = await Promise.all([getPhotos(), getPeople()]);

  if (!data.ok) {
    return {
      title: 'Find your photos',
      el: h('div', { class: 'page' },
        h('div', { class: 'state' },
          h('h2', null, 'Face search isn’t ready yet'),
          h('p', null, 'We are still sorting the photos by who is in them. '
            + 'In the meantime you can browse the whole gallery.'),
          h('a', { class: 'cta cta--accent', href: '#/photos' }, `Browse all ${photos.length} photos`)),
        siteFooter()),
    };
  }

  const sorted = sortPeople(data.people);
  const featured = sorted.filter((p) => p.featured);
  const rest = sorted.filter((p) => !p.featured);

  const grid = h('div', { class: 'people-grid' }, rest.map(personTile));

  // Visually hidden — not a visible page section, just the per-route focus
  // target every view uses so screen readers announce the new page on nav.
  const heading = h('h1', { class: 'sr-only', tabindex: '-1' }, 'Find your photos');

  const parts = [heading];

  if (featured.length) {
    parts.push(h('p', { class: 'couple-label' }, 'The couple'));
    parts.push(h('div', { class: 'couple-row' }, featured.map(personTile)));
  }

  parts.push(grid);

  parts.push(siteFooter());

  return {
    title: 'Find your photos',
    el: h('div', { class: 'page' }, parts),
    mounted() { heading.focus({ preventScroll: true }); },
  };
}
