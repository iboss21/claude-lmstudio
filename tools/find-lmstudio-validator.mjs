#!/usr/bin/env node
/**
 * Locate the code inside an LM Studio installation that rejects non-text blocks in
 * `tool_result.content`.
 *
 * READ-ONLY. This never writes to the installation. It tells you which file carries the
 * check and where, so you can decide what to do with that information.
 *
 *   node tools/find-lmstudio-validator.mjs
 *   node tools/find-lmstudio-validator.mjs --dir "C:\\Users\\me\\AppData\\Local\\LM-Studio"
 *   node tools/find-lmstudio-validator.mjs --json
 *
 * Read the "Patching LM Studio directly" section of the README before acting on the
 * output. For images in particular, deleting the check is very unlikely to give you
 * working vision — LM Studio tracks that as an unimplemented feature, not a bug, so the
 * code past the validator has nothing to do with the pixels.
 */

import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, extname } from 'node:path';
import { homedir, platform } from 'node:os';

/** Strings that identify the validator, most specific first. */
export const MARKERS = [
  'Only text tool_result blocks are supported',
  'tool_result.content is an array',
  'Invalid literal value, expected',
];

/** Where LM Studio installs itself, by platform. */
export function defaultRoots(os = platform(), home = homedir(), env = process.env) {
  const local = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
  switch (os) {
    case 'win32':
      return [
        join(local, 'LM-Studio'),
        join(local, 'Programs', 'lm-studio'),
        join(local, 'Programs', 'LM Studio'),
        'C:\\Program Files\\LM Studio',
      ];
    case 'darwin':
      return [
        '/Applications/LM Studio.app',
        join(home, 'Applications', 'LM Studio.app'),
      ];
    default:
      return [
        '/opt/LM Studio',
        '/usr/lib/lm-studio',
        join(home, '.local', 'share', 'LM Studio'),
        join(home, 'squashfs-root'),
      ];
  }
}

const SEARCHABLE = new Set(['.js', '.cjs', '.mjs', '.asar', '.json', '.node']);
const MAX_FILE_BYTES = 400 * 1024 * 1024;
const CHUNK = 4 * 1024 * 1024;

function isSearchable(path) {
  const ext = extname(path).toLowerCase();
  if (SEARCHABLE.has(ext)) return true;
  // Electron bundles are often named app.asar with no extension variance.
  return path.endsWith('app.asar') || path.endsWith('app.asar.unpacked');
}

/** Walk a directory tree, yielding candidate files. Unreadable paths are skipped. */
export function* walk(root, seen = new Set()) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (seen.has(path)) continue;
    seen.add(path);
    try {
      if (entry.isDirectory()) {
        yield* walk(path, seen);
      } else if (entry.isFile() && isSearchable(path)) {
        yield path;
      }
    } catch {
      // Permission denied, broken symlink — keep going.
    }
  }
}

/**
 * Scan one file for the markers, streaming so a 300 MB asar does not land in memory.
 * Chunks overlap by the marker length so a match spanning a boundary is still found.
 *
 * @returns {Array<{marker: string, offset: number, context: string}>}
 */
export function scanFile(path, markers = MARKERS) {
  let size;
  try {
    size = statSync(path).size;
  } catch {
    return [];
  }
  if (size === 0 || size > MAX_FILE_BYTES) return [];

  const overlap = Math.max(...markers.map((m) => m.length)) + 1;
  const hits = [];
  const fd = openSync(path, 'r');

  try {
    const buffer = Buffer.alloc(Math.min(CHUNK, size) + overlap);
    let position = 0;
    let carry = Buffer.alloc(0);

    while (position < size) {
      const toRead = Math.min(CHUNK, size - position);
      carry.copy(buffer, 0);
      const read = readSync(fd, buffer, carry.length, toRead, position);
      if (read <= 0) break;

      const window = buffer.subarray(0, carry.length + read);
      const text = window.toString('latin1');

      for (const marker of markers) {
        let index = text.indexOf(marker);
        while (index !== -1) {
          const absolute = position - carry.length + index;
          if (!hits.some((h) => h.marker === marker && Math.abs(h.offset - absolute) < 4)) {
            hits.push({
              marker,
              offset: absolute,
              context: text.slice(Math.max(0, index - 120), index + marker.length + 200),
            });
          }
          index = text.indexOf(marker, index + 1);
        }
      }

      position += read;
      carry = window.subarray(Math.max(0, window.length - overlap));
    }
  } finally {
    closeSync(fd);
  }

  return hits;
}

/** Search every root, returning one entry per file that matched. */
export function findValidator(roots, markers = MARKERS) {
  const results = [];
  for (const root of roots) {
    try {
      if (!statSync(root).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const path of walk(root)) {
      const hits = scanFile(path, markers);
      if (hits.length) results.push({ path, hits });
    }
  }
  return results;
}

function main(argv) {
  const dirIndex = argv.indexOf('--dir');
  const roots = dirIndex !== -1 && argv[dirIndex + 1] ? [argv[dirIndex + 1]] : defaultRoots();
  const asJson = argv.includes('--json');

  if (!asJson) {
    process.stdout.write(`Searching for the tool_result validator in:\n`);
    for (const root of roots) process.stdout.write(`  ${root}\n`);
    process.stdout.write('\nThis is read-only — nothing is modified.\n\n');
  }

  const results = findValidator(roots);

  if (asJson) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    return results.length ? 0 : 1;
  }

  if (!results.length) {
    process.stdout.write(
      'No match. Either LM Studio is installed somewhere else — pass --dir <path> — or\n' +
        'the bundle is compressed, in which case unpack it first:\n' +
        '  npx @electron/asar extract app.asar app-unpacked\n' +
        'then re-run with --dir app-unpacked.\n'
    );
    return 1;
  }

  for (const { path, hits } of results) {
    process.stdout.write(`${path}\n`);
    for (const hit of hits) {
      process.stdout.write(`  offset ${hit.offset}  "${hit.marker}"\n`);
      process.stdout.write(`  …${hit.context.replace(/\s+/g, ' ').slice(0, 240)}…\n\n`);
    }
  }

  process.stdout.write(
    `Found ${results.length} file(s). Read "Patching LM Studio directly" in the README\n` +
      'before changing anything — for images, removing the check almost certainly will not\n' +
      'give you working vision.\n'
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
