/**
 * Pre-flight diagnostic. Run this BEFORE the first real index.
 *
 * It exists because the native-dependency situation on Windows + modern Node is
 * genuinely hostile, and finding out in ten seconds beats finding out forty
 * minutes into a run.
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import * as log from './lib/log.mjs';
import { selectBackend, loadModels, modelDir, wasmDistDir, pkgRequire } from './engine/backend.mjs';
import { analyzePhoto } from './engine/analyze-photo.mjs';
import { discover } from './stages/discover.mjs';
import { Cache } from './lib/cache.mjs';

export async function doctor(cfg, root) {
  let problems = 0;
  const bad = (m) => { problems++; log.fail(m); };

  log.heading('Environment');
  log.info(`node          ${process.version}  (NAPI v${process.versions.napi}, modules ${process.versions.modules})`);
  log.info(`platform      ${process.platform} ${process.arch}  ·  ${os.cpus().length} logical cores`);
  log.info(`workers       ${cfg.WORKER_COUNT} analysis workers configured`);

  log.heading('Image pipeline');
  try {
    const sharp = pkgRequire('sharp');
    log.ok(`sharp ${sharp.versions?.sharp ?? '?'}  ·  libvips ${sharp.versions?.vips ?? '?'}`);
    if (!sharp.format?.webp?.output?.buffer) bad('sharp has no WebP output support');
    else log.ok('WebP encoding available');
  } catch (err) {
    bad(`sharp failed to load: ${err.message}`);
  }

  log.heading('Model weights');
  const dir = modelDir();
  const need = [
    'ssd_mobilenetv1_model-weights_manifest.json',
    'face_landmark_68_model-weights_manifest.json',
    'face_recognition_model-weights_manifest.json',
  ];
  if (!fs.existsSync(dir)) {
    bad(`model folder not found: ${dir}`);
  } else {
    const missing = need.filter((f) => !fs.existsSync(path.join(dir, f)));
    if (missing.length) bad(`missing weights: ${missing.join(', ')}`);
    else log.ok(`all 3 nets present, bundled in the npm package (nothing to download)`);
  }

  log.heading('WASM runtime');
  try {
    const wdir = wasmDistDir();
    const wasms = fs.readdirSync(wdir).filter((f) => f.endsWith('.wasm'));
    if (!wasms.length) bad(`no .wasm files in ${wdir}`);
    else log.ok(`${wasms.length} binaries in node_modules (offline-safe): ${wasms.join(', ')}`);
  } catch (err) {
    bad(`tfjs-backend-wasm not resolvable: ${err.message}`);
  }

  log.heading('Backends');
  let engine = null;
  try {
    const res = await selectBackend(cfg.BACKEND_PREFERENCE, (name, okFlag, msg) => {
      if (okFlag) log.ok(`${name.padEnd(11)} loaded and active`);
      else if (name === 'tensorflow') {
        log.info(`${log.c.yellow('skip')}   ${name.padEnd(11)} ${log.c.dim(msg)}`);
        log.info(log.c.dim('                   expected on Node >= 22: tfjs-node publishes no NAPI-v10 prebuild.'));
        log.info(log.c.dim('                   Not a problem — parallelism comes from the worker pool instead.'));
      } else {
        log.info(`${log.c.yellow('skip')}   ${name.padEnd(11)} ${log.c.dim(msg)}`);
      }
    });
    engine = res;
    log.info(`tfjs core ${res.tf.version_core}`);

    const faVersion = res.faceapi.version ?? '?';
    log.info(`face-api ${typeof faVersion === 'string' ? faVersion : JSON.stringify(faVersion)}`);
  } catch (err) {
    bad(`no usable backend: ${err.message}`);
    return { problems, ok: false };
  }

  log.heading('End-to-end smoke test');
  try {
    const t0 = Date.now();
    await loadModels(engine.faceapi);
    log.ok(`models loaded (${Date.now() - t0} ms)`);

    const cache = new Cache(path.join(root, cfg.CACHE_DIR));
    await cache.load();
    const photos = await discover(cfg, cache, root, { limit: 1 });
    if (!photos.length) {
      bad(`no photos matched ${cfg.PHOTO_PATTERN} in ${cfg.PHOTOS_DIR}`);
      return { problems, ok: false };
    }

    const ctx = { cfg, faceapi: engine.faceapi, tf: engine.tf };
    const baseline = engine.tf.memory().numTensors;
    const t1 = Date.now();
    const r = await analyzePhoto(ctx, photos[0]);
    const ms = Date.now() - t1;
    const leaked = engine.tf.memory().numTensors - baseline;

    log.ok(`${photos[0].name}  ${r.width}x${r.height}  →  ${log.c.bold(String(r.faces.length))} faces in ${(ms / 1000).toFixed(1)}s`);
    if (r.faces.length) {
      const f = r.faces[0];
      log.info(log.c.dim(`  best face: score ${f.score.toFixed(3)}  ${f.nativeWidth}px wide  `
        + `frontality ${f.frontality.toFixed(2)}  sharpness ${f.sharpness.toFixed(2)}  `
        + `descriptor ${f.descriptor.length}-d`));
    }
    if (leaked > 0) bad(`${leaked} tensors leaked on a single photo — disposal bug`);
    else log.ok('no tensor leaks');

    const perPhoto = ms / 1000;
    const est = (n) => log.fmtDuration((n * perPhoto * 1000) / cfg.WORKER_COUNT);
    log.info(log.c.dim(`  projected full run: ${est(78)} for 78 photos, ${est(2000)} for 2000 `
      + `(at ${cfg.WORKER_COUNT} workers)`));
  } catch (err) {
    bad(`smoke test failed: ${String(err.message).split('\n')[0]}`);
  }

  log.rule();
  if (problems === 0) {
    log.info(log.c.green('All checks passed. ') + `Run ${log.c.bold('npm run index-faces')}.`);
  } else {
    log.info(log.c.red(`${problems} problem(s) found. `) + 'Fix these before running the full index.');
  }
  log.rule();

  return { problems, ok: problems === 0 };
}
