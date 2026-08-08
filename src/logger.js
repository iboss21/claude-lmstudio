import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

let level = LEVELS.info;
let dumpDir = null;
let dumpSeq = 0;

export function configureLogger(opts) {
  level = LEVELS[opts.logLevel] ?? LEVELS.info;
  dumpDir = opts.dumpDir || null;
  if (dumpDir) mkdirSync(dumpDir, { recursive: true });
}

function stamp() {
  return new Date().toISOString().slice(11, 23);
}

function emit(lvl, tag, ...args) {
  if (level < LEVELS[lvl]) return;
  const stream = lvl === 'error' || lvl === 'warn' ? process.stderr : process.stdout;
  stream.write(`${stamp()} ${tag} ${args.map(fmt).join(' ')}\n`);
}

function fmt(v) {
  return typeof v === 'string' ? v : JSON.stringify(v);
}

export const log = {
  error: (...a) => emit('error', '[err ]', ...a),
  warn: (...a) => emit('warn', '[warn]', ...a),
  info: (...a) => emit('info', '[info]', ...a),
  debug: (...a) => emit('debug', '[dbg ]', ...a),
};

/**
 * Persist a request/response pair when something goes wrong, so an unknown
 * incompatibility can be diagnosed from a single artifact instead of a rerun.
 * Returns the path written, or null when dumping is disabled.
 */
export function dump(name, payload) {
  if (!dumpDir) return null;
  const file = join(dumpDir, `${String(++dumpSeq).padStart(4, '0')}-${name}.json`);
  try {
    writeFileSync(file, JSON.stringify(payload, null, 2));
    return file;
  } catch (err) {
    log.warn('could not write dump', file, err.message);
    return null;
  }
}
