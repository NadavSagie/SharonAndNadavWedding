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

  anchorsOf(id) {
    return this.data.people[id]?.anchors ?? [];
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
   *
   * Uses the overlap coefficient (|A∩B| / min(|A|,|B|)), NOT Jaccard
   * (|A∩B| / |A∪B|). Adding hundreds of new photos can grow a person's cluster
   * by 5-10x while still containing every one of their old anchor faces as a
   * subset; Jaccard punishes that growth (union balloons, score craters) and
   * silently orphans the old id, allocating a duplicate and losing whatever
   * name/overrides were attached to it. Overlap coefficient scores a clean
   * subset relationship at ~1.0 regardless of how much the superset grew.
   *
   * @param doNotMerge  [[idA, idB], ...] pairs a human has explicitly decided
   *   are DIFFERENT people (see the manual review tool). Enforced at both
   *   places identities actually get united below — aliasing a runner-up and
   *   folding a fragment — never at direct-match, since recognising a
   *   cluster as an id it already legitimately owns isn't a merge decision.
   * @returns { ids, reused, allocated, folded, foldInto }
   * `foldInto[i]` is the cluster INDEX (into the input `clusters` array) that
   * cluster i's faces should be merged into, or -1 if cluster i keeps its own
   * id (`ids[i]`). A folded cluster's `ids[i]` entry is null.
   */
  assign(clusters, minOverlap, doNotMerge = []) {
    const order = clusters
      .map((c, i) => ({ i, size: c.faceIds.length }))
      .sort((a, b) => b.size - a.size);

    // pid -> Set of ids a human has said pid is NOT the same person as.
    const forbidden = new Map();
    for (const [a, b] of doNotMerge) {
      if (!forbidden.has(a)) forbidden.set(a, new Set());
      if (!forbidden.has(b)) forbidden.set(b, new Set());
      forbidden.get(a).add(b);
      forbidden.get(b).add(a);
    }

    // Snapshot anchors as they were BEFORE this call, and read only from this
    // snapshot for matching. Without it, the moment the biggest cluster for an
    // identity wins its id, refresh() immediately shrinks that id's anchors
    // down to just this run's cluster — erasing the very history a SMALLER,
    // later-processed fragment of the SAME identity needs to fold against.
    // (Concretely: Nadav's ledger entry held faces from 3 small fragments a
    // past run had merged into him; his main cluster claiming p-0001 first
    // and refreshing immediately made those 3 fragments' own re-detected
    // clusters see an anchor set that no longer contained them, so each
    // minted a brand-new id instead of folding back in — resurrecting
    // exactly the duplicates a previous fix had already resolved.)
    const snapshotAnchors = new Map(
      Object.entries(this.data.people).map(([pid, e]) => [pid, e.anchors ?? []]),
    );

    const taken = new Map(); // pid -> cluster index that claimed it
    const result = new Array(clusters.length).fill(null);
    const foldInto = new Array(clusters.length).fill(-1);
    let reused = 0;
    let allocated = 0;
    let folded = 0;

    for (const { i } of order) {
      const ids = new Set(clusters[i].faceIds);
      let bestId = null;
      let bestScore = 0;
      let bestInter = -1;
      // Every OTHER id that also clears minOverlap against this same cluster.
      // Tier-1/tier-2 clustering can merge two clusters that used to be
      // separate, ledger-tracked identities into one BEFORE the ledger ever
      // sees them (it only sees the already-merged result) — so more than
      // one historical id can legitimately match the same cluster here.
      // Without explicitly retiring the runners-up, a matched-but-not-chosen
      // id sits unchanged (never aliased, never refreshed) and can win the
      // SAME cluster outright on a future run purely because its small,
      // untouched anchor set happens to still be a cleaner subset than the
      // real, actively-refreshed id's — silently stealing someone's identity
      // and name. See config.mjs's identity-consolidation notes for how this
      // was actually observed on this dataset.
      const runnersUp = [];

      for (const [pid, anchors] of snapshotAnchors) {
        if (taken.has(pid)) continue;
        // An id that a previous `merge` absorbed into another id must not be a
        // candidate again — otherwise the absorbed fragment (which still holds
        // its old, small, high-overlap anchor set) can win the match ahead of
        // the canonical id it was merged into, resurrecting a name that was
        // explicitly folded away.
        if (this.data.aliases[pid]) continue;
        if (!anchors.length) continue;
        let inter = 0;
        for (const a of anchors) if (ids.has(a)) inter++;
        const overlap = inter / Math.min(ids.size, anchors.length);
        if (overlap < minOverlap) continue;
        runnersUp.push(pid);
        // Rank by ABSOLUTE overlapping face count first, overlap ratio only
        // as a tiebreak. A large, established identity that accounts for
        // most (though maybe not literally 100%) of this cluster is far
        // stronger evidence than a small anchor set that happens to be a
        // perfectly clean subset purely because it never tracked much —
        // ranking by ratio alone let a 22-face zombie id outscore (1.0 vs
        // 0.96) the real 230-of-244-face match and steal the identity.
        if (inter > bestInter || (inter === bestInter && overlap > bestScore)) {
          bestInter = inter; bestScore = overlap; bestId = pid;
        }
      }

      if (bestId && bestScore >= minOverlap) {
        this.refresh(bestId, clusters[i].faceIds);
        taken.set(bestId, i);
        result[i] = bestId;
        // A runner-up that a human has explicitly declared a DIFFERENT person
        // from bestId must never be aliased away, however well its old,
        // untouched anchor set happens to overlap this cluster right now —
        // aliasing is exactly the permanent-merge action the decision forbids.
        for (const pid of runnersUp) {
          if (pid === bestId) continue;
          if (forbidden.get(pid)?.has(bestId)) continue;
          this.addAlias(pid, bestId);
        }
        reused++;
        continue;
      }

      // No live, unclaimed id recognises this cluster directly. Before minting
      // a new one, check whether its faces are already accounted for under an
      // id that ANOTHER (necessarily larger, since we process largest-first)
      // cluster claimed earlier THIS round — reading its PRE-run anchors (the
      // snapshot), not its just-refreshed ones, for exactly the reason in the
      // comment above `snapshotAnchors`. This is what makes a merge decision
      // — human, via overrides.json, or automatic, via identity consolidation —
      // survive future re-runs: once merged, the absorbed fragment's own id is
      // aliased and can never be a direct-match candidate again (see above),
      // but its faces still re-form as their own tiny cluster on every future
      // run. Without this check they'd silently mint a BRAND NEW id every
      // time — undoing the merge and resurfacing the exact duplicate it fixed.
      // Safe by construction: this can only fire when the SAME content-derived
      // face ids already sit in some other id's anchor set, i.e. a face-for-
      // face identical re-detection of a fragment someone already decided
      // belongs there — never a fresh similarity judgement on new faces.
      let foldScore = 0;
      let foldTarget = -1;
      for (const [pid, claimerIdx] of taken) {
        const anchors = snapshotAnchors.get(pid) ?? [];
        if (!anchors.length) continue;
        let inter = 0;
        for (const a of anchors) if (ids.has(a)) inter++;
        const overlap = inter / Math.min(ids.size, anchors.length);
        if (overlap > foldScore) {
          // Folding this cluster into pid unites them exactly as permanently
          // as an alias does — same "a human said these are different
          // people" guard, checked against every id pid must stay apart from.
          const partners = forbidden.get(pid);
          if (partners) {
            let blockedByHuman = false;
            for (const other of partners) {
              const otherAnchors = snapshotAnchors.get(other) ?? [];
              if (otherAnchors.some((a) => ids.has(a))) { blockedByHuman = true; break; }
            }
            if (blockedByHuman) continue;
          }
          foldScore = overlap; foldTarget = claimerIdx;
        }
      }

      if (foldTarget >= 0 && foldScore >= minOverlap) {
        foldInto[i] = foldTarget;
        folded++;
        continue;
      }

      const id = this.allocate(clusters[i].faceIds);
      taken.set(id, i);
      result[i] = id;
      allocated++;
    }

    return { ids: result, reused, allocated, folded, foldInto };
  }
}
