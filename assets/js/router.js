/**
 * Hash router.
 *
 * Hash rather than the History API because this is served from a GitHub Pages
 * SUBPATH with no server rewrites: the fragment never reaches the server, so
 * every deep link works on first load with no 404.html trick and no <base href>,
 * and the same build runs on localhost, on the Pages subpath and on a future
 * custom domain with zero configuration.
 */

const routes = [];
let current = null;
const scrollMemory = new Map();

export function route(pattern, view) {
  const keys = [];
  const rx = new RegExp(`^${pattern
    .replace(/\/:([^/]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; })
    .replace(/\//g, '\\/')}$`);
  routes.push({ rx, keys, view, pattern });
}

export function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  return raw.startsWith('/') ? raw : `/${raw}`;
}

export function navigate(path, { replace = false } = {}) {
  const target = `#${path}`;
  if (location.hash === target) return;
  if (replace) {
    // replaceState does NOT fire hashchange, so the router would never re-render.
    history.replaceState(null, '', target);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    location.hash = target;
  }
}

export function match(path) {
  for (const r of routes) {
    const m = r.rx.exec(path);
    if (m) {
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { ...r, params, path };
    }
  }
  return null;
}

let notFoundView = null;
export function setNotFound(v) { notFoundView = v; }

let mountEl = null;
export function setMount(el) { mountEl = el; }

let rendering = false;

async function render() {
  const path = parseHash();
  const found = match(path) ?? { view: notFoundView, params: {}, path };

  // Remember where we were, so returning to /people lands on the same row.
  if (current) scrollMemory.set(current.path, window.scrollY);

  if (rendering) return;
  rendering = true;
  try {
    await current?.instance?.unmount?.();
    const instance = await found.view(found.params);
    current = { ...found, instance };

    mountEl.replaceChildren(instance.el);
    document.title = instance.title
      ? `${instance.title} · Nadav & Sharon`
      : 'Nadav & Sharon — Wedding Photos';

    const restore = scrollMemory.get(path);
    // A fresh route starts at the top; a return restores where you were.
    window.scrollTo({ top: restore ?? 0, behavior: 'auto' });

    await instance.mounted?.();
  } catch (err) {
    console.error('[router]', err);
  } finally {
    rendering = false;
  }
}

export function start() {
  window.addEventListener('hashchange', render);
  return render();
}

export function currentPath() { return current?.path ?? parseHash(); }
