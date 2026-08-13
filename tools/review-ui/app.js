/** Duplicate-identity manual review — vanilla JS, no build step (matches the
 *  rest of this project). Talks to tools/review-server.mjs over /api/*. */

const state = {
  pairs: [],
  people: {},
  decisions: {},
  index: 0,
  filterUndecided: false,
};

const el = {
  app: document.getElementById('app'),
  progress: document.getElementById('progress'),
  summary: document.getElementById('summary'),
  pairTemplate: document.getElementById('pair-template'),
  btnPrev: document.getElementById('btn-prev'),
  btnNext: document.getElementById('btn-next'),
  btnSame: document.getElementById('btn-same'),
  btnDifferent: document.getElementById('btn-different'),
  btnSkip: document.getElementById('btn-skip'),
  btnApply: document.getElementById('btn-apply'),
  filterUndecided: document.getElementById('filter-undecided'),
  applyModal: document.getElementById('apply-modal'),
  applyModalTitle: document.getElementById('apply-modal-title'),
  applyModalBody: document.getElementById('apply-modal-body'),
  applyCancel: document.getElementById('apply-cancel'),
  applyConfirm: document.getElementById('apply-confirm'),
};

function pairKey(a, b) { return [a, b].sort().join('|'); }
function decisionFor(pair) { return state.decisions[pairKey(pair.a, pair.b)] ?? null; }

function visiblePairs() {
  if (!state.filterUndecided) return state.pairs;
  return state.pairs.filter((p) => !decisionFor(p) || decisionFor(p).decision === 'skip');
}

// -------------------------------------------------------------- data load

async function loadData() {
  const res = await fetch('/api/data');
  const data = await res.json();
  if (!data.ready) {
    el.app.innerHTML = `<div class="empty-state">${escapeHtml(data.message)}</div>`;
    el.progress.textContent = '';
    return;
  }
  state.pairs = data.pairs;
  state.people = data.people;
  computeDisplayNames(state.people);
  state.decisions = data.decisions;
  state.index = Math.min(state.index, Math.max(0, visiblePairs().length - 1));
  render();
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** review.json names unnamed people "Guest N" using the indexer's internal
 *  ordinal, but the live site numbers unnamed guests by photo count rank
 *  (assets/js/data.js's assignGuestNumbers) — a different scheme. Recompute
 *  the same rank here so this tool's "Guest N" always matches what a guest
 *  actually sees on the site, instead of confusingly disagreeing with it.
 *  The exact person id is always shown alongside it regardless, so nothing
 *  is ambiguous even if this heuristic (spot a fallback name by its shape)
 *  ever misses. */
function computeDisplayNames(people) {
  const list = Object.values(people);
  const unnamed = list.filter((p) => /^Guest \d+$/.test(p.name ?? ''));
  unnamed.sort((a, b) => (b.photoCount - a.photoCount) || (a.id < b.id ? -1 : 1));
  unnamed.forEach((p, i) => { p.displayName = `Guest ${i + 1}`; });
  for (const p of list) if (!p.displayName) p.displayName = p.name;
}

// ---------------------------------------------------------------- render

function renderSummary() {
  const total = state.pairs.length;
  let same = 0; let different = 0; let skip = 0;
  for (const p of state.pairs) {
    const d = decisionFor(p);
    if (!d) continue;
    if (d.decision === 'same') same++;
    else if (d.decision === 'different') different++;
    else if (d.decision === 'skip') skip++;
  }
  const undecided = total - same - different - skip;
  el.summary.innerHTML = `
    <span>Total: <b>${total}</b></span>
    <span class="s-same">Same person: <b>${same}</b></span>
    <span class="s-different">Different people: <b>${different}</b></span>
    <span>Skipped: <b>${skip}</b></span>
    <span>Undecided: <b>${undecided}</b></span>
  `;
}

function personCard(id) {
  const p = state.people[id];
  if (!p) return { id, name: `Guest (${id})`, photoCount: 0, cover: null, samplePhotos: [] };
  return p;
}

function render() {
  renderSummary();
  const list = visiblePairs();

  if (!list.length) {
    el.app.innerHTML = `<div class="empty-state">${
      state.filterUndecided
        ? 'Nothing left to decide — every pair has a decision. Uncheck "Undecided only" to review again, or Apply your decisions below.'
        : 'No possible-duplicate pairs in review.json right now.'
    }</div>`;
    el.progress.textContent = state.pairs.length ? `${state.pairs.length} / ${state.pairs.length}` : '';
    updateActionButtons(null);
    return;
  }

  if (state.index >= list.length) state.index = list.length - 1;
  if (state.index < 0) state.index = 0;
  const pair = list[state.index];
  const a = personCard(pair.a);
  const b = personCard(pair.b);

  el.progress.textContent = `Reviewing ${state.index + 1} / ${list.length}`;

  const frag = el.pairTemplate.content.cloneNode(true);
  frag.querySelector('.pair-distance').textContent = `Embedding distance: ${pair.distance.toFixed(4)} (lower = more likely the same person)`;
  frag.querySelector('.pair-reason').textContent = pair.reason === 'gray-zone'
    ? 'Never reached the auto-merge bar.'
    : 'Reached the review band, but had no corroborating raw-face evidence.';

  fillGuestCard(frag.querySelector('[data-side="a"]'), a);
  fillGuestCard(frag.querySelector('[data-side="b"]'), b);

  const decision = decisionFor(pair);
  const stateEl = frag.querySelector('#decision-state');
  if (decision) {
    stateEl.classList.add(`dec-${decision.decision}`);
    stateEl.textContent = decision.decision === 'same' ? 'You marked this: Same Person'
      : decision.decision === 'different' ? 'You marked this: Different People'
        : 'You marked this: Skipped — review later';
  } else {
    stateEl.textContent = 'Not yet decided.';
  }

  el.app.innerHTML = '';
  el.app.appendChild(frag);
  updateActionButtons(decision?.decision ?? null);

  el.btnPrev.disabled = state.index === 0;
  el.btnNext.disabled = state.index === list.length - 1;
}

function fillGuestCard(cardEl, person) {
  const img = cardEl.querySelector('.guest-cover');
  img.src = coverUrl(person.id);
  img.alt = person.displayName ?? person.name ?? person.id;
  cardEl.querySelector('.guest-name').textContent = person.displayName ?? person.name ?? person.id;
  cardEl.querySelector('.guest-count').textContent = `${person.photoCount ?? 0} photo${(person.photoCount ?? 0) === 1 ? '' : 's'} · ${person.id}`;

  const grid = cardEl.querySelector('.sample-grid');
  grid.innerHTML = '';
  const samples = (person.samplePhotos ?? []).slice(0, 8);
  for (const photoId of samples) {
    const im = document.createElement('img');
    im.src = thumbUrl(photoId);
    im.alt = `${person.name ?? person.id} — ${photoId}`;
    im.loading = 'lazy';
    im.addEventListener('click', () => openLightbox(photoUrl(photoId)));
    grid.appendChild(im);
  }
}

function coverUrl(id) { return `/gallery/covers/${id}.webp`; }
function thumbUrl(photoId) { return `/gallery/thumbs/${photoId}.webp`; }
function photoUrl(photoId) { return `/gallery/photos/${photoId}.webp`; }

function updateActionButtons(decision) {
  el.btnSame.classList.toggle('active', decision === 'same');
  el.btnDifferent.classList.toggle('active', decision === 'different');
  el.btnSkip.classList.toggle('active', decision === 'skip');
}

// -------------------------------------------------------------- lightbox

let lightboxEl = null;
function openLightbox(src) {
  if (!lightboxEl) {
    lightboxEl = document.createElement('div');
    lightboxEl.className = 'lightbox-backdrop';
    lightboxEl.innerHTML = '<img>';
    lightboxEl.addEventListener('click', () => lightboxEl.classList.remove('open'));
    document.body.appendChild(lightboxEl);
  }
  lightboxEl.querySelector('img').src = src;
  lightboxEl.classList.add('open');
}

// --------------------------------------------------------------- actions

async function decide(decision) {
  const list = visiblePairs();
  if (!list.length) return;
  const pair = list[state.index];
  const a = personCard(pair.a);
  const b = personCard(pair.b);

  const res = await fetch('/api/decision', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ a: pair.a, b: pair.b, decision, nameA: a.displayName ?? a.name, nameB: b.displayName ?? b.name }),
  });
  const body = await res.json();
  if (body.decisions) state.decisions = body.decisions;

  // Move to the next pair automatically, staying within whatever list is
  // currently visible (filtering may shrink the list once this decision lands).
  advanceAfterDecision(pair);
}

function advanceAfterDecision(decidedPair) {
  const list = visiblePairs();
  if (!list.length) { render(); return; }
  // Find the position the just-decided pair would occupy in the (possibly
  // filtered) list; move one past it so the next unreviewed pair comes up.
  const stillPresent = list.findIndex((p) => p.a === decidedPair.a && p.b === decidedPair.b);
  if (stillPresent >= 0) state.index = Math.min(stillPresent + 1, list.length - 1);
  else state.index = Math.min(state.index, list.length - 1);
  render();
}

function goPrev() {
  const list = visiblePairs();
  if (!list.length) return;
  state.index = Math.max(0, state.index - 1);
  render();
}
function goNext() {
  const list = visiblePairs();
  if (!list.length) return;
  state.index = Math.min(list.length - 1, state.index + 1);
  render();
}

el.btnSame.addEventListener('click', () => decide('same'));
el.btnDifferent.addEventListener('click', () => decide('different'));
el.btnSkip.addEventListener('click', () => decide('skip'));
el.btnPrev.addEventListener('click', goPrev);
el.btnNext.addEventListener('click', goNext);
el.filterUndecided.addEventListener('change', () => {
  state.filterUndecided = el.filterUndecided.checked;
  state.index = 0;
  render();
});

document.addEventListener('keydown', (e) => {
  if (el.applyModal.classList.contains('open')) return;
  const k = e.key.toLowerCase();
  if (k === 'y') decide('same');
  else if (k === 'n') decide('different');
  else if (k === 's') decide('skip');
  else if (e.key === 'ArrowLeft') goPrev();
  else if (e.key === 'ArrowRight') goNext();
});

// ----------------------------------------------------------------- apply

el.btnApply.addEventListener('click', () => {
  let same = 0; let different = 0;
  for (const p of state.pairs) {
    const d = decisionFor(p);
    if (d?.decision === 'same') same++;
    else if (d?.decision === 'different') different++;
  }
  el.applyModalTitle.textContent = 'Rebuild identities?';
  el.applyModalBody.innerHTML = `
    <p>This will:</p>
    <ul>
      <li>Back up the current identity data</li>
      <li>Merge <b>${same}</b> confirmed same-person pair(s) into <code>overrides.json</code></li>
      <li>Record <b>${different}</b> confirmed different-people pair(s) as permanent do-not-merge constraints</li>
      <li>Re-run the real face-index pipeline and regenerate the site's data files</li>
    </ul>
    <p>This can take up to a minute. Don't close this page while it runs.</p>
  `;
  el.applyConfirm.disabled = false;
  el.applyConfirm.textContent = 'Yes, rebuild';
  el.applyModal.classList.add('open');
});

el.applyCancel.addEventListener('click', () => el.applyModal.classList.remove('open'));

el.applyConfirm.addEventListener('click', async () => {
  el.applyConfirm.disabled = true;
  el.applyConfirm.textContent = 'Rebuilding…';
  el.applyModalBody.innerHTML = '<p>Running the pipeline — this reuses cached face detection, so it should take well under a minute.</p>';
  try {
    const res = await fetch('/api/apply', { method: 'POST' });
    const body = await res.json();
    if (!res.ok) {
      el.applyModalTitle.textContent = 'Apply failed';
      el.applyModalBody.innerHTML = `<p class="conflict">${escapeHtml(body.error ?? 'Unknown error')}</p>
        <p>Backup: <code>${escapeHtml(body.backupDir ?? '')}</code></p>
        <pre style="white-space:pre-wrap;font-size:11px;max-height:200px;overflow:auto">${escapeHtml(body.output ?? '')}</pre>`;
      el.applyConfirm.textContent = 'Close';
      el.applyConfirm.disabled = false;
      el.applyConfirm.onclick = () => el.applyModal.classList.remove('open');
      return;
    }
    el.applyModalTitle.textContent = 'Rebuild complete';
    const conflictsHtml = body.conflicts.length
      ? `<p class="conflict"><b>${body.conflicts.length} conflict(s) found — please review:</b></p>
         <ul>${body.conflicts.map((c) => `<li class="conflict">${escapeHtml(c)}</li>`).join('')}</ul>`
      : '<p>No conflicts found. ✓</p>';
    el.applyModalBody.innerHTML = `
      <ul>
        <li>Identities before: <b>${body.before.people}</b></li>
        <li>Identities after: <b>${body.after.people}</b></li>
        <li>Confirmed merges applied: <b>${body.mergesApplied}</b></li>
        <li>Confirmed separate identities: <b>${body.confirmedSeparate}</b></li>
        <li>Skipped pairs: <b>${body.skipped}</b></li>
        <li>Photos reassigned: <b>${body.photosReassigned}</b></li>
        <li>Backup saved to: <code>${escapeHtml(body.backupDir)}</code></li>
      </ul>
      ${conflictsHtml}
    `;
    el.applyConfirm.textContent = 'Done';
    el.applyConfirm.disabled = false;
    el.applyConfirm.onclick = () => { el.applyModal.classList.remove('open'); loadData(); };
  } catch (err) {
    el.applyModalTitle.textContent = 'Apply failed';
    el.applyModalBody.innerHTML = `<p class="conflict">${escapeHtml(String(err))}</p>`;
    el.applyConfirm.textContent = 'Close';
    el.applyConfirm.disabled = false;
    el.applyConfirm.onclick = () => el.applyModal.classList.remove('open');
  }
});

loadData();
