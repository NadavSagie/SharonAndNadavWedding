/**
 * Analysis worker. One tfjs instance + one copy of the models per worker.
 *
 * Parallelism lives here rather than inside tfjs because the wasm backend is
 * single-threaded, and because tfjs-node (the multi-threaded native build)
 * has no NAPI-v10 prebuild and therefore cannot load on Node >= 22.
 * Eight workers on a 22-core box beats one native thread comfortably.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { createEngine } from './engine/backend.mjs';
import { analyzePhoto } from './engine/analyze-photo.mjs';

const cfg = workerData.cfg;
let ctx = null;
let baseline = 0;
let processed = 0;

async function init() {
  const engine = await createEngine(cfg, () => {});
  ctx = { cfg, faceapi: engine.faceapi, tf: engine.tf };
  baseline = engine.baselineTensors;
  parentPort.postMessage({ type: 'ready', backend: engine.backend });
}

parentPort.on('message', async (msg) => {
  if (msg.type === 'photo') {
    const started = Date.now();
    try {
      const result = await analyzePhoto(ctx, msg.photo);
      processed++;
      // A steadily climbing tensor count means a disposal bug; surface it rather
      // than letting the run quietly consume all memory.
      let leak = 0;
      if (processed % 10 === 0) {
        leak = ctx.tf.memory().numTensors - baseline;
      }
      parentPort.postMessage({ type: 'done', id: msg.photo.id, result, ms: Date.now() - started, leak });
    } catch (err) {
      parentPort.postMessage({
        type: 'error',
        id: msg.photo.id,
        error: String(err?.message ?? err).split('\n')[0],
        ms: Date.now() - started,
      });
    }
  } else if (msg.type === 'shutdown') {
    process.exit(0);
  }
});

init().catch((err) => {
  parentPort.postMessage({ type: 'fatal', error: String(err?.message ?? err) });
  process.exit(1);
});
