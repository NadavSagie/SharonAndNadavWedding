import { h } from '../util/dom.js';

export function siteFooter() {
  return h('footer', { class: 'site-footer' },
    h('p', { class: 'mark' }, 'with love, N & S'),
    h('p', { class: 'note' },
      'Faces were grouped automatically on a private computer. No face data is stored '
      + 'on this website. If you would like your photos removed, ',
      h('a', { href: 'mailto:nadav.sagie@bagirasys.com?subject=Wedding%20gallery%20%E2%80%94%20please%20remove%20me' }, 'email us'),
      '.'));
}
