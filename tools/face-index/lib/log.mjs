/** Console output: styled, progress-aware, and it keeps a tally for the summary. */

import { styleText } from 'node:util';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (styles, s) => (useColor ? styleText(styles, s) : s);

export const tally = { warnings: [], errors: [] };

let verbose = false;
export const setVerbose = (v) => { verbose = v; };

let progressActive = false;
function clearProgress() {
  if (progressActive && process.stdout.isTTY) {
    process.stdout.write('\r[K');
    progressActive = false;
  }
}

export function stage(n, total, name, detail = '') {
  clearProgress();
  const tag = paint(['dim'], `[${n}/${total}]`);
  console.log(`${tag} ${paint(['bold'], name.padEnd(12))} ${detail}`);
}

export function info(msg) {
  clearProgress();
  console.log(`      ${msg}`);
}

export function warn(subject, msg) {
  clearProgress();
  tally.warnings.push(`${subject}: ${msg}`);
  console.log(`      ${paint(['yellow'], 'warn')}   ${paint(['dim'], String(subject).padEnd(8))} ${msg}`);
}

export function error(subject, msg) {
  clearProgress();
  tally.errors.push(`${subject}: ${msg}`);
  console.log(`      ${paint(['red'], 'error')}  ${paint(['dim'], String(subject).padEnd(8))} ${msg}`);
}

export function review(msg) {
  clearProgress();
  console.log(`      ${paint(['cyan'], 'review')} ${msg}`);
}

export function debug(msg) {
  if (!verbose) return;
  clearProgress();
  console.log(`      ${paint(['dim'], msg)}`);
}

export function ok(msg) {
  clearProgress();
  console.log(`      ${paint(['green'], 'ok')}     ${msg}`);
}

export function fail(msg) {
  clearProgress();
  console.log(`      ${paint(['red'], 'FAIL')}   ${msg}`);
}

/** Single-line progress bar. Falls back to periodic lines when not a TTY. */
export function progress(done, total, extra = '') {
  const width = 24;
  const frac = total ? done / total : 0;
  const filled = Math.round(frac * width);
  if (!process.stdout.isTTY) {
    if (done === total || done % 25 === 0) console.log(`      ${done}/${total} ${extra}`);
    return;
  }
  const bar = paint(['cyan'], '█'.repeat(filled)) + paint(['dim'], '░'.repeat(width - filled));
  process.stdout.write(`\r[K      ${bar}  ${String(done).padStart(String(total).length)}/${total}  ${extra}`);
  progressActive = true;
  if (done === total) {
    process.stdout.write('\n');
    progressActive = false;
  }
}

export function endProgress() { clearProgress(); }

export function rule() {
  clearProgress();
  console.log(paint(['dim'], '─'.repeat(64)));
}

export function heading(msg) {
  clearProgress();
  console.log(`\n${paint(['bold'], msg)}`);
}

export const c = {
  dim: (s) => paint(['dim'], s),
  bold: (s) => paint(['bold'], s),
  green: (s) => paint(['green'], s),
  yellow: (s) => paint(['yellow'], s),
  red: (s) => paint(['red'], s),
  cyan: (s) => paint(['cyan'], s),
};

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return `${m}m ${String(r).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
