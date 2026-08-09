/** The People page — the heart of the app. */

import { h, icon, announce } from '../util/dom.js';
import { getPhotos, getPeople, displayName, sortPeople } from '../data.js';
import { coverSrc } from '../util/img.js';
import { setHeader } from '../components/appHeader.js';
import { siteFooter } from '../components/footer.js';

function personTile(person) {
  const name = person.name
    ? h('span', { class: 'person-name' }, person.name)
    : h('span', { class: 'person-name' }, 'Guest ', h('span', { class: 'n' }, String(person.ordinal)));

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

  // People in a single photo go behind a disclosure so the main grid stays
  // scannable — but they are never hidden. At a wedding, the guest who appears
  // in exactly one photo is emotionally the most important case of all.
  const main = rest.filter((p) => p.photoCount > 1);
  const tail = rest.filter((p) => p.photoCount === 1);

  const grid = h('div', { class: 'people-grid' }, main.map(personTile));

  const heading = h('h1', { tabindex: '-1' }, 'Who are you?');

  const parts = [
    h('div', { class: 'page-intro' },
      heading,
      h('p', { class: 'sub' }, 'Tap your face to see every photo you’re in.'),
      h('p', { class: 'meta' },
        `${sorted.length} ${sorted.length === 1 ? 'person' : 'people'} · ${photos.length} photos`)),
  ];

  // A search box that can never match anything is worse than no search box.
  const anyNamed = sorted.some((p) => p.name);
  if (anyNamed) {
    const input = h('input', {
      type: 'search', placeholder: 'Search by name', 'aria-label': 'Search people by name',
      autocomplete: 'off', inputmode: 'search', enterkeyhint: 'search',
    });
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      let shown = 0;
      grid.replaceChildren(...main.filter((p) => {
        const hit = !q
          || (p.name?.toLowerCase().includes(q))
          || `guest ${p.ordinal}`.includes(q);
        if (hit) shown++;
        return hit;
      }).map(personTile));
      announce(q ? `${shown} people match` : `${main.length} people`);
    });
    parts.push(h('div', { class: 'people-search' },
      icon(['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M20 20l-4.2-4.2']),
      input));
  }

  if (featured.length) {
    parts.push(h('p', { class: 'couple-label' }, 'The couple'));
    parts.push(h('div', { class: 'couple-row' }, featured.map(personTile)));
  }

  parts.push(grid);

  if (tail.length) {
    parts.push(h('details', { class: 'people-tail' },
      h('summary', null, `Faces in only one photo (${tail.length})`),
      h('div', { class: 'people-grid' }, tail.map(personTile))));
  }

  parts.push(h('div', { class: 'people-foot' },
    h('a', { href: '#/photos' }, `Not finding yourself? Browse all ${photos.length} photos →`),
    h('p', { class: 'privacy' },
      'Faces were grouped automatically on a private computer, not by a cloud service. '
      + 'Grouping is not perfect — the same person can appear more than once.')));

  parts.push(siteFooter());

  return {
    title: 'Find your photos',
    el: h('div', { class: 'page' }, parts),
    mounted() { heading.focus({ preventScroll: true }); },
  };
}
