#!/usr/bin/env node
/**
 * Face-index CLI.
 *
 *   npm run index-faces                      incremental (the normal command)
 *   npm run index-faces:doctor               pre-flight diagnostic — run this first
 *   npm run index-faces -- --from=cluster    re-cluster + re-emit only (fast)
 *   npm run index-faces -- --limit=5 -v      try a handful of photos
 *
 * Flags: --force --from=<stage> --only=<stage> --photos=a,b --limit=N
 *        --backend=<b> --threshold=<n> --no-tiles --strict --skip-failed
 *        --clean --dry-run --verbose --doctor --help
 */

import { parseArgs } from 'node:util';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { CONFIG, ENGINE_THRESHOLDS } from './config.mjs';
import * as log from './lib/log.mjs';
import { Cache } from './lib/cache.mjs';
import { Ledger } from './lib/ledger.mjs';
import { doctor } from './doctor.mjs';
import { discover } from './stages/discover.mjs';
import { analyze } from './stages/analyze.mjs';
import { identify } from './stages/identify.mjs';
import { derivatives } from './stages/derivatives.mjs';
import { emit } from './stages/emit.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const HELP = `
face-index — build the wedding gallery's face index

  npm run index-faces:doctor          pre-flight checks + one-photo smoke test
  npm run index-faces                 incremental full run
  npm run index-faces:recluster       re-cluster and re-emit (skips detection)

Options
  --doctor              run diagnostics only
  --force               ignore the cache and re-detect everything
  --from=<stage>        start at: analyze | cluster | derivatives | emit
  --only=derivatives    regenerate images only
  --photos=t-1,t-2      restrict to specific photo ids
  --limit=N             process only the first N photos
  --backend=wasm        force a tfjs backend (tensorflow | wasm | cpu)
  --threshold=0.52      override FACE_SIMILARITY_THRESHOLD
  --no-tiles            disable tiled detection (much faster, misses small faces)
  --skip-failed         don't retry photos that failed on a previous run
  --strict              exit non-zero on any failed photo
  --clean               delete the cache first (prompts unless --yes)
  --dry-run             analyse and cluster, but write nothing
  --verbose, -v         extra logging
`;

const STAGES = ['analyze', 'cluster', 'derivatives', 'emit'];

async function loadOverrides(file) {
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    return { version: 1, people: {}, merge: [], split: {}, ignoreFaces: [], ignorePhotos: [], ...raw };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      log.warn('overrides', `could not parse overrides.json (${err.message}) — continuing without it`);
    }
    return { version: 1, people: {}, merge: [], split: {}, ignoreFaces: [], ignorePhotos: [] };
  }
}

/** Seed a documented, empty overrides file so the workflow is discoverable. */
async function ensureOverridesTemplate(file) {
  try {
    await fs.access(file);
  } catch {
    const template = {
      _readme: [
        'Hand-edited. The indexer NEVER writes this file.',
        'After editing, run: npm run index-faces:recluster  (fast, ~seconds)',
        'Applied in order: ignoreFaces/ignorePhotos -> split -> merge -> people attributes.',
        'Person ids are stable across re-runs; see face-index/review.json for candidates.',
      ],
      _example: {
        people: { 'p-0001': { name: 'Nadav', featured: true, order: 1 } },
        merge: [['p-0004', 'p-0019']],
        split: { 'p-0009': { moveFaces: ['t-3_1102x0455'], to: 'p-0090' } },
        ignoreFaces: ['t-77_0201x0033'],
      },
      version: 1,
      people: {},
      merge: [],
      split: {},
      ignoreFaces: [],
      ignorePhotos: [],
    };
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(template, null, 2)}\n`, 'utf8');
  }
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: false,
      options: {
        doctor: { type: 'boolean', default: false },
        force: { type: 'boolean', default: false },
        from: { type: 'string' },
        only: { type: 'string' },
        photos: { type: 'string' },
        limit: { type: 'string' },
        backend: { type: 'string' },
        threshold: { type: 'string' },
        tiles: { type: 'boolean', default: true },
        strict: { type: 'boolean', default: false },
        'skip-failed': { type: 'boolean', default: false },
        clean: { type: 'boolean', default: false },
        yes: { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        verbose: { type: 'boolean', short: 'v', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    console.error(`\n  ${err.message}\n${HELP}`);
    process.exit(2);
  }
  const args = parsed.values;

  if (args.help) { console.log(HELP); return 0; }
  log.setVerbose(args.verbose);

  // ---- config overlay (the ONLY place flags mutate config) ----------------
  const cfg = { ...CONFIG };
  if (args.backend) cfg.BACKEND_PREFERENCE = [args.backend];
  if (args.threshold) {
    const t = Number(args.threshold);
    if (!Number.isFinite(t) || t <= 0 || t > 2) throw new Error(`--threshold must be between 0 and 2, got "${args.threshold}"`);
    cfg.FACE_SIMILARITY_THRESHOLD = t;
  }
  // ENGINE_THRESHOLDS is reference documentation for the ONNX/ArcFace path
  // (different embedding, different distance semantics). CONFIG stays authoritative
  // for the active engine, so tuning happens in exactly one place.
  void ENGINE_THRESHOLDS;
  if (args.tiles === false) cfg.TILING_ENABLED = false;

  console.log(`\n${log.c.bold('face-index')} ${log.c.dim(`· engine ${cfg.ENGINE} · threshold ${cfg.FACE_SIMILARITY_THRESHOLD} · ${ROOT}`)}\n`);

  if (args.doctor) {
    const res = await doctor(cfg, ROOT);
    return res.ok ? 0 : 1;
  }

  const from = args.from ?? 'analyze';
  if (!STAGES.includes(from)) throw new Error(`--from must be one of ${STAGES.join(', ')}`);
  const only = args.only;
  if (only && !STAGES.includes(only)) throw new Error(`--only must be one of ${STAGES.join(', ')}`);
  const runStage = (name) => (only ? only === name : STAGES.indexOf(name) >= STAGES.indexOf(from));

  const cache = new Cache(path.join(ROOT, cfg.CACHE_DIR));
  if (args.clean) {
    if (!args.yes) {
      log.warn('clean', 'refusing to delete the cache without --yes (it costs a full re-detection)');
    } else {
      await cache.clear();
      log.info('cache cleared');
    }
  }
  await cache.load();

  const overridesFile = path.join(ROOT, cfg.OUT_DIR, 'overrides.json');
  await ensureOverridesTemplate(overridesFile);
  const overrides = await loadOverrides(overridesFile);

  const started = Date.now();

  // ---- 1. discover --------------------------------------------------------
  const photos = await discover(cfg, cache, ROOT, {
    limit: args.limit ? Number(args.limit) : 0,
    only: args.photos ? args.photos.split(',').map((s) => s.trim()).filter(Boolean) : null,
    ignorePhotos: overrides.ignorePhotos,
  });
  if (!photos.length) {
    log.error('run', 'nothing to do');
    return 1;
  }

  // ---- 2. analyze ---------------------------------------------------------
  const { results: analysis, failed, fromCache, backend } = await analyze(cfg, cache, photos, {
    force: args.force && runStage('analyze'),
    skipFailed: args['skip-failed'],
  });

  const analysable = photos.filter((p) => analysis.has(p.id));
  if (!analysable.length) {
    log.error('run', 'every photo failed to analyse — see errors above');
    return 1;
  }

  // ---- 3+4. cluster & identify -------------------------------------------
  const ledger = new Ledger(path.join(ROOT, cfg.OUT_DIR, '.people-ledger.json'));
  await ledger.load();
  const result = identify(cfg, analysable, analysis, ledger, overrides);

  for (const r of result.reviewPairs.slice(0, 8)) {
    const a = result.people[r.a];
    const b = result.people[r.b];
    if (a && b) {
      log.review(`${a.id} ↔ ${b.id}  d=${r.d.toFixed(3)}  → possibly the same person`);
    }
  }

  if (args['dry-run']) {
    log.info(log.c.yellow('--dry-run: no files written'));
    return 0;
  }

  await ledger.save();

  // ---- 5. derivatives -----------------------------------------------------
  let deriv = { totalBytes: 0, totalFiles: 0, written: 0, skipped: 0, coversWritten: 0 };
  if (runStage('derivatives')) {
    deriv = await derivatives(cfg, ROOT, analysable, result.people, analysis, { force: args.force });
  } else {
    log.stage(5, 6, 'derivatives', log.c.dim('skipped'));
  }

  // ---- 6. emit ------------------------------------------------------------
  const stats = {
    photosScanned: photos.length,
    photosOk: analysable.length,
    photosFailed: failed.length,
    photosFromCache: fromCache,
    facesDetected: result.detected,
    facesDropped: result.dropped,
    facesKept: result.faces.length,
    facesUnsorted: result.unsortedFaces,
    people: result.people.length,
    peopleNamed: result.people.filter((p) => p.name).length,
    peopleHidden: (result.hidden ?? []).length,
    reviewPairs: result.reviewPairs.length,
  };

  let emitted = { photoCount: 0 };
  if (runStage('emit')) {
    emitted = await emit(cfg, ROOT, analysable, analysis, result, { stats });
  } else {
    log.stage(6, 6, 'emit', log.c.dim('skipped'));
  }

  // ---- summary ------------------------------------------------------------
  const pct = photos.length ? failed.length / photos.length : 0;
  log.rule();
  const row = (k, v) => log.info(`${log.c.dim(k.padEnd(12))}${v}`);
  row('photos', `${photos.length} scanned · ${analysable.length} ok · ${failed.length} failed · ${fromCache} cached`);
  row('faces', `${result.detected} detected · ${result.dropped} below threshold · ${result.faces.length} kept · ${result.unsortedFaces} unsorted`);
  row('people', `${result.people.length} · ${stats.peopleNamed} named · ${stats.peopleHidden} hidden`);
  row('output', `${log.fmtBytes(deriv.totalBytes)} images (${deriv.totalFiles} files) · ${emitted.photoCount} photos in the index`);
  row('backend', `${backend} · ${cfg.WORKER_COUNT} workers`);
  row('duration', log.fmtDuration(Date.now() - started));
  log.rule();

  if (result.people.length) {
    const unnamed = result.people.filter((p) => !p.name).length;
    console.log(`
  ${log.c.bold('Next:')} open ${log.c.cyan('face-index/review.json')} to see each detected person and
  the ${result.reviewPairs.length} borderline pair(s). Name people (start with the couple) and
  merge/split as needed in ${log.c.cyan('face-index/overrides.json')}, then run
  ${log.c.cyan('npm run index-faces:recluster')} — it re-uses cached detection and takes seconds.
  ${log.c.dim(`${unnamed} of ${result.people.length} people are currently shown as "Guest N".`)}
`);
  }

  for (const f of failed) log.warn('failed', `${f.id}: ${f.error}`);

  if (args.strict && failed.length) return 1;
  if (pct >= cfg.FAIL_RATIO_ABORT) {
    log.error('run', `${(pct * 100).toFixed(0)}% of photos failed (limit ${cfg.FAIL_RATIO_ABORT * 100}%)`);
    return 1;
  }
  return 0;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    console.error(`\n  ${log.c.red('fatal')} ${err?.stack ?? err}\n`);
    process.exit(1);
  });
