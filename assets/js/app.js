/** Boot. */

import { route, setMount, setNotFound, start } from './router.js';
import { initHeader } from './components/appHeader.js';
import { homeView, adoptHero } from './views/home.js';
import { peopleView } from './views/people.js';
import { personView } from './views/person.js';
import { photosView } from './views/photos.js';
import { notFoundView } from './views/notFound.js';
import { getPhotos } from './data.js';
import { h } from './util/dom.js';

const main = document.getElementById('main');

// Adopt the server-rendered hero so the LCP element is reused, not rebuilt.
adoptHero(document.getElementById('hero'));

initHeader();
setMount(main);
setNotFound(() => notFoundView());

route('/', homeView);
route('/people', peopleView);
route('/people/:id', personView);
route('/people/:id/:photo', personView);
route('/photos', photosView);
route('/photos/:photo', photosView);

start().catch((err) => {
  console.error('[app] boot failed', err);
  main.replaceChildren(h('div', { class: 'state' },
    h('h2', null, 'Something went wrong'),
    h('p', null, 'The gallery could not load. Please refresh, or let us know.'),
    h('a', { class: 'cta cta--accent', href: 'mailto:nadav.sagie@bagirasys.com' }, 'Email us')));
});

// Populate the <noscript> fallback links for completeness when JS is present
// but slow — harmless, and it costs nothing.
getPhotos().then((photos) => {
  const holder = document.getElementById('noscript-links');
  if (!holder) return;
  for (const p of photos) {
    holder.append(h('a', { href: `assets/gallery/photos/${p.id}.webp` }, p.id), ' ');
  }
}).catch(() => {});
