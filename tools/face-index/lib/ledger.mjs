/**
 * Persistent person-ID ledger.
 *
 * Cluster indices shift every time photos are added, so person IDs can never be
 * derived from cluster order or membership hashes. Instead each allocated
 * p-NNNN remembers its anchor face IDs; a new run matches clusters back to
 * ledger entries by Jaccard overlap of those sets.
 *
 * This is what lets overrides.json survive the next photo drop — and what makes
 * "Guest 7" still mean the same person tomorrow, which matters because guests
 * screenshot and share these pages.
 */

import fs from 'node:fs/promises';

export class Ledger {
  constructor(file) {
    this.file = file;
    this.data = { version: 1, nextId: 1, nextOrdinal: 1, people: {}, aliases: {} };
  }

  async load() {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.data = { aliases: {}, ...raw };
    } catch { /* first run */ }
  }

  async save() {
    await fs.writeFile(this.file, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
  }

  /** Resolve an ID through the alias chain (set when overrides merge people). */
  resolve(id) {
    let cur = id;
    const seen = new Set();
    while (this.data.aliases[cur] && !seen.has(cur)) {
      seen.add(cur);
      cur = this.data.aliases[cur];
    }
    return cur;
  }

  allocate(anchors) {
    const id = `p-${String(this.data.nextId).padStart(4, '0')}`;
    this.data.nextId++;
    this.data.people[id] = { anchors, ordinal: this.data.nextOrdinal++ };
    return id;
  }

  addAlias(from, to) {
    if (from !== to) this.data.aliases[from] = to;
  }

  ordinalOf(id) {
    return this.data.people[id]?.ordinal ?? 0;
  }

  refresh(id, anchors) {
    if (!this.data.people[id]) {
      this.data.people[id] = { anchors, ordinal: this.data.nextOrdinal++ };
    } else {
      this.data.people[id].anchors = anchors;
    }
  }

  /**
   * Assign a stable person ID to each cluster.
   * Clusters are matched largest-first so the biggest, most stable groups get
   * first claim on their historical IDs.
   */
  assign(clusters, minJaccard) {
    const order = clusters
      .map((c, i) => ({ i, size: c.faceIds.length }))
      .sort((a, b) => b.size - a.size);

    const taken = new Set();
    const result = new Array(clusters.length);
    let reused = 0;
    let allocated = 0;

    for (const { i } of order) {
      const ids = new Set(clusters[i].faceIds);
      let bestId = null;
      let bestScore = 0;

      for (const [pid, entry] of Object.entries(this.data.people)) {
        if (taken.has(pid)) continue;
        const anchors = entry.anchors ?? [];
        if (!anchors.length) continue;
        let inter = 0;
        for (const a of anchors) if (ids.has(a)) inter++;
        const union = ids.size + anchors.length - inter;
        const jaccard = union ? inter / union : 0;
        if (jaccard > bestScore) { bestScore = jaccard; bestId = pid; }
      }

      let id;
      if (bestId && bestScore >= minJaccard) {
        id = bestId;
        this.refresh(id, clusters[i].faceIds);
        reused++;
      } else {
        id = this.allocate(clusters[i].faceIds);
        allocated++;
      }
      taken.add(id);
      result[i] = id;
    }

    return { ids: result, reused, allocated };
  }
}
