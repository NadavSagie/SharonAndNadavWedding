/**
 * Turn raw faces into named, stably-identified people.
 *
 *   filter -> cluster -> stable IDs from the ledger -> apply overrides -> rank
 *
 * Overrides are applied in a fixed order (ignore, split, merge, attributes) so
 * the result is deterministic no matter how the file is written.
 */

import * as log from '../lib/log.mjs';
import { clusterFaces, centroid, distanceToCentroid } from '../lib/cluster.mjs';
import { faceQuality, groupNearDuplicates, distinctGroups } from '../lib/quality.mjs';
import { hamming } from '../lib/image.mjs';

export function identify(cfg, photos, analysis, ledger, overrides) {
  // ---- flatten + filter ---------------------------------------------------
  // These gates are the difference between "people" and "flowers, phone backs and
  // ears". Detection runs permissively; this is where quality is actually enforced.
  const ignoreFaces = new Set(overrides.ignoreFaces ?? []);
  const faces = [];
  const rejected = { ignored: 0, confidence: 0, size: 0, frontality: 0 };
  for (const p of photos) {
    const r = analysis.get(p.id);
    if (!r) continue;
    for (const f of r.faces) {
      if (ignoreFaces.has(f.id)) { rejected.ignored++; continue; }
      if (f.score < cfg.MIN_FACE_CONFIDENCE) { rejected.confidence++; continue; }
      if (f.nativeWidth < cfg.MIN_FACE_SIZE) { rejected.size++; continue; }
      if (f.frontality < cfg.MIN_FACE_FRONTALITY) { rejected.frontality++; continue; }
      faces.push({ ...f, photoId: p.id });
    }
  }
  // Deterministic order in, deterministic clusters out.
  faces.sort((a, b) => a.id.localeCompare(b.id));

  const detected = [...analysis.values()].reduce((n, r) => n + r.faces.length, 0);
  const dropped = detected - faces.length;
  log.info(log.c.dim(
    `gates: ${detected} detected → ${faces.length} kept  `
    + `(−${rejected.confidence} low confidence, −${rejected.size} too small, `
    + `−${rejected.frontality} not facing camera${rejected.ignored ? `, −${rejected.ignored} ignored` : ''})`,
  ));

  if (!faces.length) {
    log.stage(3, 6, 'cluster', log.c.yellow('no usable faces — the site will fall back to a plain gallery'));
    return { people: [], unsortedFaces: 0, reviewPairs: [], faces: [], dupeGroups: new Map(), dropped, detected };
  }

  // ---- near-duplicate photo groups ---------------------------------------
  const photoMeta = photos.map((p) => ({ id: p.id, phash: analysis.get(p.id)?.phash ?? null }));
  const dupeGroups = groupNearDuplicates(photoMeta, hamming, cfg.PHASH_HAMMING_DUPE);

  // ---- cluster ------------------------------------------------------------
  const { clusters, reviewPairs } = clusterFaces(faces, cfg, (phase, i, n) => {
    if (n > 2000) log.progress(i, n, log.c.dim(phase));
  });
  log.endProgress();

  // ---- score every face within its cluster -------------------------------
  const clusterInfo = clusters.map((c) => {
    const cen = centroid(faces, c.members);
    const scored = c.members.map((idx) => {
      const f = faces[idx];
      const dc = distanceToCentroid(f.descriptor, cen);
      const centrality = Math.max(0, 1 - Math.min(1, dc / cfg.FACE_SIMILARITY_THRESHOLD));
      return { idx, faceId: f.id, photoId: f.photoId, q: faceQuality(f, centrality, cfg) };
    });
    return { members: c.members, photos: c.photos, scored };
  });

  // ---- park thin clusters -------------------------------------------------
  const keep = [];
  let unsortedFaces = 0;
  const parked = { thin: 0, lowQuality: 0 };
  for (const c of clusterInfo) {
    const groups = distinctGroups(c.photos, dupeGroups);
    if (groups < cfg.MIN_CLUSTER_PHOTOS || c.members.length < cfg.MIN_CLUSTER_FACES) {
      unsortedFaces += c.members.length;
      parked.thin++;
      continue;
    }
    const meanQ = c.scored.reduce((s, x) => s + x.q, 0) / c.scored.length;
    if (meanQ < cfg.MIN_CLUSTER_QUALITY) {
      unsortedFaces += c.members.length;
      parked.lowQuality++;
      log.debug(`parked low-quality cluster: ${c.scored.length} faces, meanQ ${meanQ.toFixed(3)} `
        + `(${c.scored.slice(0, 3).map((s) => s.photoId).join(', ')})`);
      continue;
    }
    keep.push({ ...c, distinctGroups: groups, meanQuality: meanQ });
  }

  log.stage(3, 6, 'cluster',
    `${log.c.bold(String(faces.length))} faces → ${log.c.bold(String(keep.length))} people`
    + log.c.dim(`  ·  ${unsortedFaces} faces unsorted (${parked.thin} too thin, `
      + `${parked.lowQuality} low quality)  ·  ${reviewPairs.length} review pairs`));

  // ---- stable IDs ---------------------------------------------------------
  const forLedger = keep.map((c) => ({ faceIds: c.scored.map((s) => s.faceId) }));
  const { ids, reused, allocated } = ledger.assign(forLedger, cfg.LEDGER_MATCH_MIN_JACCARD);

  let people = keep.map((c, i) => ({
    id: ids[i],
    faceIds: c.scored.map((s) => s.faceId),
    scored: c.scored,
    photoIds: [...c.photos],
    distinctGroups: c.distinctGroups,
  }));

  // ---- overrides ----------------------------------------------------------
  const byId = new Map(people.map((p) => [p.id, p]));
  const stale = [];

  // split: pull named faces out into another person
  for (const [fromId, spec] of Object.entries(overrides.split ?? {})) {
    const from = byId.get(fromId);
    if (!from) { stale.push(`split source ${fromId}`); continue; }
    const move = new Set(spec.moveFaces ?? []);
    const moved = from.scored.filter((s) => move.has(s.faceId));
    if (!moved.length) { stale.push(`split ${fromId} matched no faces`); continue; }
    from.scored = from.scored.filter((s) => !move.has(s.faceId));
    from.faceIds = from.scored.map((s) => s.faceId);
    from.photoIds = [...new Set(from.scored.map((s) => s.photoId))];

    const toId = spec.to ?? ledger.allocate(moved.map((s) => s.faceId));
    ledger.refresh(toId, moved.map((s) => s.faceId));
    const target = byId.get(toId) ?? { id: toId, scored: [], faceIds: [], photoIds: [], distinctGroups: 0 };
    target.scored.push(...moved);
    target.faceIds = target.scored.map((s) => s.faceId);
    target.photoIds = [...new Set(target.scored.map((s) => s.photoId))];
    if (!byId.has(toId)) { byId.set(toId, target); people.push(target); }
  }

  // merge: union into the FIRST id, which becomes canonical
  for (const group of overrides.merge ?? []) {
    const [canonical, ...rest] = group;
    const target = byId.get(canonical);
    if (!target) { stale.push(`merge target ${canonical}`); continue; }
    for (const other of rest) {
      const src = byId.get(other);
      if (!src) { stale.push(`merge source ${other}`); continue; }
      target.scored.push(...src.scored);
      byId.delete(other);
      people = people.filter((p) => p !== src);
      // Record the alias so a later re-cluster cannot resurrect the absorbed id.
      ledger.addAlias(other, canonical);
    }
    target.faceIds = target.scored.map((s) => s.faceId);
    target.photoIds = [...new Set(target.scored.map((s) => s.photoId))];
    target.distinctGroups = distinctGroups(target.photoIds, dupeGroups);
    ledger.refresh(canonical, target.faceIds);
  }

  // attributes + hidden
  const attrs = overrides.people ?? {};
  for (const pid of Object.keys(attrs)) {
    if (!byId.has(pid)) stale.push(`people.${pid}`);
  }

  const hidden = [];
  people = people.filter((p) => {
    const a = attrs[p.id];
    if (a?.hidden) { hidden.push(p.id); return false; }
    return true;
  });

  for (const p of people) {
    const a = attrs[p.id] ?? {};
    p.name = a.name ?? null;
    p.featured = Boolean(a.featured);
    p.order = a.order ?? null;
    p.ordinal = ledger.ordinalOf(p.id);
    p.distinctGroups = p.distinctGroups || distinctGroups(p.photoIds, dupeGroups);

    // Cover: explicit override wins, else best composite quality, penalised for
    // coming from an over-represented burst so we don't always pick one moment.
    const groupSize = new Map();
    for (const s of p.scored) {
      const g = dupeGroups.get(s.photoId);
      groupSize.set(g, (groupSize.get(g) ?? 0) + 1);
    }
    let cover = null;
    if (a.cover) cover = p.scored.find((s) => s.faceId === a.cover) ?? null;
    if (!cover) {
      cover = [...p.scored].sort((x, y) => {
        const px = x.q / (groupSize.get(dupeGroups.get(x.photoId)) ?? 1) ** 0.25;
        const py = y.q / (groupSize.get(dupeGroups.get(y.photoId)) ?? 1) ** 0.25;
        return py - px;
      })[0];
    }
    p.cover = cover;
  }

  // ---- rank ---------------------------------------------------------------
  people.sort((a, b) => {
    if (a.featured !== b.featured) return a.featured ? -1 : 1;
    if (a.order != null || b.order != null) {
      return (a.order ?? Infinity) - (b.order ?? Infinity);
    }
    if (b.distinctGroups !== a.distinctGroups) return b.distinctGroups - a.distinctGroups;
    return a.ordinal - b.ordinal;
  });

  const named = people.filter((p) => p.name).length;
  log.stage(4, 6, 'identify',
    `${log.c.bold(String(people.length))} people`
    + log.c.dim(`  ·  ${named} named  ·  ${reused} ids reused  ·  ${allocated} new`)
    + (hidden.length ? log.c.dim(`  ·  ${hidden.length} hidden`) : ''));

  for (const s of stale) log.warn('overrides', `stale reference: ${s}`);

  return { people, unsortedFaces, reviewPairs, faces, dupeGroups, dropped, detected, stale, hidden };
}
