import { h } from '../util/dom.js';
import { setHeader } from '../components/appHeader.js';
import { siteFooter } from '../components/footer.js';

export function notFoundView({
  heading = 'Page not found',
  body = 'That link doesn’t point anywhere in this gallery.',
  href = '#/',
  cta = 'Back to the start',
} = {}) {
  setHeader({ visible: true, title: '' });
  const h1 = h('h2', { tabindex: '-1' }, heading);
  return {
    title: heading,
    el: h('div', { class: 'page' },
      h('div', { class: 'state' }, h1, h('p', null, body),
        h('a', { class: 'cta cta--accent', href }, cta)),
      siteFooter()),
    mounted() { h1.focus({ preventScroll: true }); },
  };
}
