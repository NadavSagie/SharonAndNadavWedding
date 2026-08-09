/**
 * Detect + describe faces across all photos, using a pool of worker threads.
 *
 * Robustness contract: one bad photo NEVER aborts the run. Failures are recorded
 * in the cache (and retried next run unless --skip-failed), logged with the file
 * and reason, and the pipeline continues.
 */

import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as log from '../lib/log.mjs';
import { detectionFingerprint } from '../config.mjs';

const WORKER_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../worker.mjs');

export async function analyze(cfg, cache, photos, opts = {}) {
  const fingerprint = detectionFingerprint(cfg);
  const results = new Map();
  const failed = [];
  let fromCache = 0;

  // ---- cache pass ---------------------------------------------------------
  const todo = [];
  for (const p of photos) {
    if (opts.force) { todo.push(p); continue; }
    const hit = await cache.read(p.sha1, fingerprint);
    if (hit?.status === 'ok') {
      results.set(p.id, hit.result);
      fromCache++;
    } else if (hit?.status === 'failed' && opts.skipFailed) {
      failed.push({ id: p.id, error: hit.error });
    } else {
      todo.push(p);
    }
  }

  log.stage(2, 6, 'analyze',
    todo.length
      ? `${log.c.bold(String(todo.length))} to process` + (fromCache ? log.c.dim(`  ·  ${fromCache} from cache`) : '')
        + log.c.dim(`  ·  ${Math.min(cfg.WORKER_COUNT, todo.length)} workers`)
      : log.c.green(`all ${fromCache} photos already cached`));

  if (!todo.length) return { results, failed, fromCache, backend: opts.knownBackend ?? 'cache' };

  // ---- worker pool --------------------------------------------------------
  const workerCount = Math.max(1, Math.min(cfg.WORKER_COUNT, todo.length));
  const queue = [...todo];
  let done = 0;
  let backend = null;
  const started = Date.now();
  const durations = [];

  await new Promise((resolve, reject) => {
    let liveWorkers = 0;
    let settled = false;

    const finishIfIdle = () => {
      if (liveWorkers === 0 && !settled) { settled = true; resolve(); }
    };

    for (let i = 0; i < workerCount; i++) {
      const worker = new Worker(WORKER_PATH, { workerData: { cfg } });
      liveWorkers++;

      const pump = () => {
        const next = queue.shift();
        if (!next) {
          worker.postMessage({ type: 'shutdown' });
          return;
        }
        worker.postMessage({ type: 'photo', photo: { id: next.id, path: next.path, sha1: next.sha1 } });
      };

      worker.on('message', async (msg) => {
        if (msg.type === 'ready') {
          backend ??= msg.backend;
          pump();
          return;
        }
        if (msg.type === 'fatal') {
          if (!settled) { settled = true; reject(new Error(msg.error)); }
          return;
        }

        const photo = todo.find((p) => p.id === msg.id);
        if (msg.type === 'done') {
          results.set(msg.id, msg.result);
          for (const w of msg.result.warnings ?? []) log.warn(msg.id, w);
          if (!msg.result.faces.length) log.warn(msg.id, 'no faces detected');
          if (msg.leak > 20) log.warn(msg.id, `LEAK: ${msg.leak} tensors above baseline`);
          await cache.write(photo.sha1, fingerprint, { status: 'ok', result: msg.result });
        } else if (msg.type === 'error') {
          failed.push({ id: msg.id, error: msg.error });
          log.error(msg.id, msg.error);
          await cache.write(photo.sha1, fingerprint, { status: 'failed', error: msg.error });
        }

        done++;
        durations.push(msg.ms);
        const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
        const remaining = ((todo.length - done) * avg) / workerCount;
        log.progress(done, todo.length,
          log.c.dim(`${(avg / 1000).toFixed(1)}s/img  eta ${log.fmtDuration(remaining)}`));

        pump();
      });

      worker.on('error', (err) => {
        log.error('worker', String(err.message).split('\n')[0]);
        liveWorkers--;
        finishIfIdle();
      });
      worker.on('exit', () => {
        liveWorkers--;
        finishIfIdle();
      });
    }
  });

  log.endProgress();
  const faceTotal = [...results.values()].reduce((n, r) => n + r.faces.length, 0);
  log.info(log.c.dim(
    `backend ${backend}  ·  ${faceTotal} faces  ·  ${log.fmtDuration(Date.now() - started)}`,
  ));

  return { results, failed, fromCache, backend };
}
