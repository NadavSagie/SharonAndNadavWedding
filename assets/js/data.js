/**
 * Data access.
 *
 * Three files, fetched independently:
 *   photos.json       required
 *   people.json       optional overlay — absent means "no face search yet",
 *                     and the site must still be a complete gallery
 *   photo-faces.json  fetched lazily, only when the lightbox first opens
 *
 * No localStorage: a stale face index after a re-run is a far worse bug than
 * re-fetching a few KB. GitHub Pages sends ETags; HTTP revalidation is right.
 */

const cacheOf = new Map();

function once(key, loader) {
  if (!cacheOf.has(key)) cacheOf.set(key, loader());
  return cacheOf.get(key);
}

async function getJson(path) {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
}

let photosIndex = null;

export function getPhotos() {
  return once('photos', async () => {
    const raw = await getJson('data/photos.json');
    const photos = raw.photos ?? [];
    photosIndex = new Map(photos.map((p, i) => [p.id, { ...p, i }]));
    return photos;
  });
}

export function photoById(id) {
  return photosIndex?.get(id) ?? null;
}

/** Never rejects: a missing/broken people.json degrades to "no face data". */
export function getPeople() {
  return once('people', async () => {
    try {
      const raw = await getJson('data/people.json');
      const people = (raw.people ?? []).filter((p) => p.photos?.length);
      return {
        ok: people.length > 0,
        people,
        byId: new Map(people.map((p) => [p.id, p])),
      };
    } catch {
      return { ok: false, people: [], byId: new Map() };
    }
  });
}

export function getPhotoFaces() {
  return once('faces', async () => {
    try {
      const raw = await getJson('data/photo-faces.json');
      return raw.faces ?? {};
    } catch {
      return {};
    }
  });
}

export function displayName(person) {
  return person?.name ?? `Guest ${person?.ordinal ?? '?'}`;
}

/** Featured (the couple) first, then by photo count, then by stable ordinal. */
export function sortPeople(people) {
  return [...people].sort((a, b) => {
    if (Boolean(a.featured) !== Boolean(b.featured)) return a.featured ? -1 : 1;
    if (b.photoCount !== a.photoCount) return b.photoCount - a.photoCount;
    return (a.ordinal ?? 0) - (b.ordinal ?? 0);
  });
}
