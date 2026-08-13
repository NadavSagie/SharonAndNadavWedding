/**
 * Home. The hero markup lives inline in index.html so it is the LCP and paints
 * before this module runs; on first render we adopt that node rather than
 * rebuilding it. Everything below the fold is added here.
 */

import { h } from '../util/dom.js';
import { getPhotos, getPeople } from '../data.js';
import { setHeader } from '../components/appHeader.js';
import { siteFooter } from '../components/footer.js';

let heroNode = null;
export function adoptHero(node) { heroNode = node; }

export async function homeView() {
  setHeader({ visible: false });

  const [photos, people] = await Promise.all([getPhotos(), getPeople()]);

  const hero = heroNode ?? h('section', { class: 'hero' });

  // If the indexer has not run (or found nobody), the primary CTA must not send
  // guests to an empty People page.
  const cta = hero.querySelector('#hero-cta');
  const label = hero.querySelector('#hero-cta-label');
  if (cta && !people.ok) {
    cta.setAttribute('href', '#/photos');
    if (label) label.textContent = 'View the Gallery';
  } else if (cta) {
    cta.setAttribute('href', '#/people');
    if (label) label.textContent = 'Find My Photos';
  }

  const altLink = hero.querySelector('.hero-alt');
  if (altLink) altLink.firstChild.textContent = `or browse all ${photos.length} photos `;

  const cue = hero.querySelector('#hero-cue');
  const onScroll = () => { if (cue) cue.dataset.hidden = window.scrollY > 40 ? '1' : '0'; };
  window.addEventListener('scroll', onScroll, { passive: true });

  const el = h('div', null, hero, siteFooter());

  return {
    el,
    title: null,
    unmount() { window.removeEventListener('scroll', onScroll); },
  };
}
