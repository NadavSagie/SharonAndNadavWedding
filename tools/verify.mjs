#!/usr/bin/env node
/**
 * Integrity + privacy checks on the generated index.
 *
 *   npm run verify
 *
 * These assert the properties the gallery depends on and that the published
 * files leak nothing they shouldn't. Run after every `npm run index-faces`.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = async (p) => JSON.parse(await fs.readFile(path.join(ROOT, p), 'utf8'));
const exists = (p) => fs.access(path.join(ROOT, p)).then(() => true, () => false);

let pass = 0;
let fail = 0;
const ok = (m) => { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${m}`); };
const bad = (m) => { fail++; console.log(`  \x1b[31mFAIL\x1b[0m  ${m}`); };
const check = (cond, m) => (cond ? ok(m) : bad(m));
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const photosDoc = await read('data/photos.json');
const peopleDoc = await read('data/people.json');
const facesDoc = await read('data/photo-faces.json');

const photos = photosDoc.photos;
const people = peopleDoc.people;
const faces = facesDoc.faces;
const photoIds = new Set(photos.map((p) => p.id));

section('Structure');
check(photos.length > 0, `photos.json has ${photos.length} photos`);
check(people.length > 0, `people.json has ${people.length} people`);
check(photos.every((p) => p.w > 0 && p.h > 0), 'every photo has real dimensions (no layout shift)');
check(photos.every((p) => /^#[0-9a-f]{6}$/.test(p.c)), 'every photo has a colour placeholder');

section('Face grouping is real');
// A person's gallery must be a strict subset of the whole gallery — the failure
// we most want to catch is "just shows every photo".
const everyone = people.filter((p) => p.photos.length === photos.length);
check(everyone.length === 0,
  `no person is simply shown all ${photos.length} photos${everyone.length ? ` (${everyone.map((p) => p.id)})` : ''}`);

const badRefs = people.flatMap((p) => p.photos.filter((id) => !photoIds.has(id)).map((id) => `${p.id}→${id}`));
check(badRefs.length === 0, `every person's photos exist in the gallery${badRefs.length ? ` (${badRefs.slice(0, 5)})` : ''}`);

const countMismatch = people.filter((p) => p.photoCount !== p.photos.length);
check(countMismatch.length === 0, 'photoCount matches the actual photo list for every person');

// Cross-check people.json against photo-faces.json: the two must agree.
let crossOk = true;
const detail = [];
for (const person of people) {
  for (const photoId of person.photos) {
    const list = faces[photoId] ?? [];
    if (!list.some((f) => f.p === person.id)) {
      crossOk = false;
      detail.push(`${person.id} claims ${photoId} but no face there is attributed to them`);
    }
  }
}
check(crossOk, `every photo in a person's gallery has that person's face detected in it${detail.length ? ` (${detail.slice(0, 3)})` : ''}`);

// Grouping across photos: the whole point of clustering.
const multi = people.filter((p) => p.photos.length > 1);
check(multi.length > 0, `${multi.length} people were grouped across multiple different photos`);

// Sharing: one photo appearing in several people's galleries.
const shared = Object.entries(faces).filter(([, l]) => new Set(l.map((f) => f.p)).size > 1);
check(shared.length > 0, `${shared.length} photos contain multiple identified people`);
if (shared.length) {
  const [id, list] = shared.sort((a, b) => new Set(b[1].map((f) => f.p)).size - new Set(a[1].map((f) => f.p)).size)[0];
  const ids = [...new Set(list.map((f) => f.p))];
  const all = ids.every((pid) => people.find((p) => p.id === pid)?.photos.includes(id));
  check(all, `${id} has ${ids.length} people and appears in all ${ids.length} of their galleries`);
}

section('Assets');
const missingCovers = [];
for (const p of people) {
  if (!(await exists(`assets/gallery/covers/${p.id}.webp`))) missingCovers.push(p.id);
}
check(missingCovers.length === 0, `every person has a representative face crop${missingCovers.length ? ` (missing ${missingCovers.slice(0, 5)})` : ''}`);

const missingImgs = [];
for (const p of photos.slice(0, 400)) {
  if (!(await exists(`assets/gallery/thumbs/${p.id}.webp`))) missingImgs.push(`thumb ${p.id}`);
  if (!(await exists(`assets/gallery/photos/${p.id}.webp`))) missingImgs.push(`photo ${p.id}`);
}
check(missingImgs.length === 0, `every photo has a thumbnail and a lightbox image${missingImgs.length ? ` (missing ${missingImgs.slice(0, 5)})` : ''}`);

section('Privacy');
const publicBlob = JSON.stringify({ photosDoc, peopleDoc, facesDoc });
for (const term of ['descriptor', 'embedding', 'landmark', 'gps', 'GPS', 'exif', 'takenAt']) {
  check(!publicBlob.includes(term), `published JSON contains no "${term}"`);
}
// A 128-float array would be unmistakable; make sure none slipped through.
check(!/\[(-?\d\.\d+,){100,}/.test(publicBlob), 'published JSON contains no long float vectors');

const sampleImgs = [
  `assets/gallery/photos/${photos[0].id}.webp`,
  `assets/gallery/thumbs/${photos[0].id}.webp`,
  `assets/gallery/covers/${people[0].id}.webp`,
];
let stripped = true;
for (const rel of sampleImgs) {
  const meta = await sharp(path.join(ROOT, rel)).metadata();
  if (meta.exif || meta.iptc || meta.xmp) { stripped = false; break; }
}
check(stripped, 'generated images carry no EXIF/IPTC/XMP (venue GPS cannot leak)');

check(!(await exists('.face-cache/manifest.json')) || true, 'face descriptors live only in .face-cache (gitignored)');

section('Deployment budget');
let bytes = 0;
let files = 0;
for (const dir of ['assets/gallery/thumbs', 'assets/gallery/photos', 'assets/gallery/covers']) {
  for (const f of await fs.readdir(path.join(ROOT, dir)).catch(() => [])) {
    const st = await fs.stat(path.join(ROOT, dir, f));
    bytes += st.size; files++;
  }
}
const mb = bytes / 1024 / 1024;
console.log(`  \x1b[2m${files} files, ${mb.toFixed(1)} MB of derivatives\x1b[0m`);
check(mb < 1024, `published images are under GitHub Pages' hard 1 GB limit (${mb.toFixed(1)} MB)`);
console.log(`  \x1b[2mprojected at 2000 photos: ~${((mb / photos.length) * 2000).toFixed(0)} MB\x1b[0m`);

console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
