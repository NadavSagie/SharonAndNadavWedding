/**
 * tfjs backend selection + model loading.
 *
 * Why the ladder exists, concretely (verified on this machine, Node 24 / Win 11):
 *   - @tensorflow/tfjs-node publishes no NAPI-v10 prebuilt binding. Node 24 reports
 *     NAPI v10, so requiring it throws "The specified module could not be found".
 *     It stays first in the preference list because it IS ~3x faster per thread
 *     wherever it does load (Node <= 20).
 *   - The wasm build works everywhere and needs NO setWasmPaths() call: the node
 *     build's emscripten shim resolves the .wasm via `__dirname + "/"` and
 *     fs.readFileSync, and the .wasm files ship in that same dist folder.
 *     Calling setWasmPaths(absoluteWindowsPath, true) actively BREAKS it, because
 *     it routes a bare `c:\...` path through fetch() -> "unknown scheme".
 *
 * Model weights ship inside the @vladmandic/face-api package, so there is nothing
 * to download and the whole pipeline runs offline.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '../../..');
const require = createRequire(path.join(PKG_ROOT, 'package.json'));

export function modelDir() {
  return path.join(path.dirname(require.resolve('@vladmandic/face-api/package.json')), 'model');
}

export function wasmDistDir() {
  return path.join(path.dirname(require.resolve('@tensorflow/tfjs-backend-wasm/package.json')), 'dist');
}

/** Attempt one backend. Returns {faceapi, backend} or throws. */
function tryBackendSync(name) {
  if (name === 'tensorflow') {
    require('@tensorflow/tfjs-node'); // throws on Node >= 22 (no napi-v10 prebuild)
    return { faceapi: require('@vladmandic/face-api'), needs: 'tensorflow' };
  }
  const faceapi = require('@vladmandic/face-api/dist/face-api.node-wasm.js');
  if (name === 'wasm') {
    // Intentionally NO setWasmPaths — see module header.
    const wasm = require('@tensorflow/tfjs-backend-wasm');
    if (wasm.setThreadsCount) wasm.setThreadsCount(1); // parallelism is per-worker, not per-tfjs
  }
  return { faceapi, needs: name };
}

/**
 * Walk the preference list, returning the first backend that both loads and
 * actually sticks (setBackend can silently no-op if registration failed).
 */
export async function selectBackend(preference, onAttempt = () => {}) {
  const attempts = [];
  for (const name of preference) {
    try {
      const { faceapi } = tryBackendSync(name);
      const tf = faceapi.tf;
      await tf.setBackend(name);
      await tf.ready();
      const active = tf.getBackend();
      if (active !== name) throw new Error(`backend did not stick (active: ${active})`);
      onAttempt(name, true, '');
      attempts.push({ name, ok: true });
      return { faceapi, tf, backend: name, attempts };
    } catch (err) {
      const msg = String(err?.message ?? err).split('\n')[0];
      onAttempt(name, false, msg);
      attempts.push({ name, ok: false, error: msg });
    }
  }
  const detail = attempts.map((a) => `${a.name}: ${a.error}`).join('; ');
  throw new Error(`no usable tfjs backend (${detail})`);
}

/** Load only the three nets we use. Skipping age/gender/expression saves load
 *  time and memory, and we have no use for their outputs. */
export async function loadModels(faceapi) {
  const dir = modelDir();
  const required = [
    'ssd_mobilenetv1_model-weights_manifest.json',
    'face_landmark_68_model-weights_manifest.json',
    'face_recognition_model-weights_manifest.json',
  ];
  const missing = required.filter((f) => !fs.existsSync(path.join(dir, f)));
  if (missing.length) {
    throw new Error(`face-api model files missing from ${dir}: ${missing.join(', ')}`);
  }
  await faceapi.nets.ssdMobilenetv1.loadFromDisk(dir);
  await faceapi.nets.faceLandmark68Net.loadFromDisk(dir);
  await faceapi.nets.faceRecognitionNet.loadFromDisk(dir);
  return dir;
}

export async function createEngine(cfg, onAttempt) {
  if (cfg.ENGINE !== 'faceapi') {
    throw new Error(`unknown engine "${cfg.ENGINE}" (only "faceapi" is implemented; see README for the ONNX/ArcFace upgrade path)`);
  }
  const preference = cfg.BACKEND_PREFERENCE;
  const { faceapi, tf, backend, attempts } = await selectBackend(preference, onAttempt);
  await loadModels(faceapi);
  const baselineTensors = tf.memory().numTensors;
  return { faceapi, tf, backend, attempts, baselineTensors };
}

export { require as pkgRequire, PKG_ROOT };
