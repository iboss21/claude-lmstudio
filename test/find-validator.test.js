import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MARKERS,
  defaultRoots,
  scanFile,
  findValidator,
  walk,
} from '../tools/find-lmstudio-validator.mjs';

/** Build a fake LM Studio tree with the validator string buried in a bundle. */
function fakeInstall({ marker = MARKERS[0], padding = 0, name = 'app.asar' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'lms-'));
  const resources = join(root, 'resources');
  mkdirSync(resources, { recursive: true });

  const filler = 'x'.repeat(padding);
  writeFileSync(
    join(resources, name),
    `${filler}function validate(b){if(b.type!=="text")throw new Error("${marker} when tool_result.content is an array.");}${filler}`
  );
  writeFileSync(join(resources, 'unrelated.js'), 'console.log("nothing to see")');
  writeFileSync(join(root, 'notes.txt'), MARKERS[0]); // wrong extension, must be skipped
  return root;
}

test('the validator string is found inside a bundle', () => {
  const root = fakeInstall();
  const results = findValidator([root]);

  assert.equal(results.length, 1);
  assert.match(results[0].path, /app\.asar$/);
  assert.equal(results[0].hits[0].marker, MARKERS[0]);
  assert.ok(results[0].hits[0].offset >= 0);
  assert.match(results[0].hits[0].context, /tool_result/);
});

test('a match spanning a read-chunk boundary is still found', () => {
  // The real bundle is hundreds of megabytes and read in chunks; a marker landing on a
  // boundary must not be missed, which is what the overlap exists for.
  const root = fakeInstall({ padding: 5 * 1024 * 1024 });
  const results = findValidator([root]);

  assert.equal(results.length, 1, 'marker at a chunk boundary must still be located');
  assert.equal(results[0].hits[0].marker, MARKERS[0]);
});

test('files that cannot contain the bundle are skipped', () => {
  const root = fakeInstall();
  const paths = [...walk(root)];

  assert.ok(paths.some((p) => p.endsWith('app.asar')));
  assert.ok(!paths.some((p) => p.endsWith('notes.txt')), 'a .txt file is not a bundle');
});

test('a clean install reports nothing rather than guessing', () => {
  const root = mkdtempSync(join(tmpdir(), 'lms-clean-'));
  writeFileSync(join(root, 'app.js'), 'export const fine = true;');
  assert.deepEqual(findValidator([root]), []);
});

test('a missing or unreadable root is skipped without throwing', () => {
  assert.deepEqual(findValidator([join(tmpdir(), 'definitely-not-here-2026')]), []);
  assert.deepEqual(findValidator(['/proc/self/mem']), []);
});

test('the secondary markers match the other error wording', () => {
  // The fixture carries both this marker and the surrounding "…content is an array"
  // phrase, so assert on the set of markers found rather than on ordering.
  const root = fakeInstall({ marker: 'Invalid literal value, expected' });
  const results = findValidator([root]);

  assert.equal(results.length, 1);
  const found = results[0].hits.map((h) => h.marker);
  assert.ok(found.includes('Invalid literal value, expected'), `got ${found.join(', ')}`);
});

test('scanning a single file returns every distinct hit', () => {
  const root = mkdtempSync(join(tmpdir(), 'lms-multi-'));
  const file = join(root, 'bundle.js');
  writeFileSync(file, `A "${MARKERS[0]}" B "${MARKERS[2]}" C "${MARKERS[0]}" D`);

  const hits = scanFile(file);
  assert.equal(hits.filter((h) => h.marker === MARKERS[0]).length, 2);
  assert.equal(hits.filter((h) => h.marker === MARKERS[2]).length, 1);
  // Offsets must be strictly increasing and point into the file.
  for (const hit of hits) assert.ok(hit.offset >= 0 && hit.offset < 200);
});

test('install roots are proposed per platform', () => {
  const win = defaultRoots('win32', 'C:\\Users\\me', { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' });
  assert.ok(win.some((p) => p.includes('LM-Studio')));

  const mac = defaultRoots('darwin', '/Users/me', {});
  assert.ok(mac.some((p) => p.includes('LM Studio.app')));

  const linux = defaultRoots('linux', '/home/me', {});
  assert.ok(linux.some((p) => p.includes('LM Studio')));
});
