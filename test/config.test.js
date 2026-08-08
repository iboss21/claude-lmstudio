import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveConfig, DEFAULTS, normalizerOptions } from '../src/config.js';

test('defaults are used when nothing is supplied', () => {
  const config = resolveConfig([], {});
  assert.equal(config.port, DEFAULTS.port);
  assert.equal(config.upstream, 'http://127.0.0.1:1234');
  assert.equal(config.autoRepair, true);
});

test('both --flag value and --flag=value are accepted', () => {
  assert.equal(resolveConfig(['--port', '9000'], {}).port, 9000);
  assert.equal(resolveConfig(['--port=9000'], {}).port, 9000);
});

test('--no-<flag> turns booleans off', () => {
  const config = resolveConfig(['--no-auto-repair', '--no-hoist-images'], {});
  assert.equal(config.autoRepair, false);
  assert.equal(config.hoistImages, false);
});

test('a bare boolean flag turns it on', () => {
  assert.equal(resolveConfig(['--strict-params'], {}).strictParams, true);
  assert.equal(resolveConfig(['--strict-params', '--port', '1'], {}).strictParams, true);
});

test('CLI flags beat environment variables', () => {
  const config = resolveConfig(['--port', '3000'], {
    CLAUDE_LMSTUDIO_PORT: '4000',
    CLAUDE_LMSTUDIO_UPSTREAM: 'http://127.0.0.1:2126',
  });
  assert.equal(config.port, 3000);
  assert.equal(config.upstream, 'http://127.0.0.1:2126');
});

test('a bare host:port upstream gets a scheme, and trailing slashes are dropped', () => {
  assert.equal(resolveConfig(['--upstream', '127.0.0.1:2126'], {}).upstream, 'http://127.0.0.1:2126');
  assert.equal(resolveConfig(['--upstream', 'http://localhost:1234/'], {}).upstream, 'http://localhost:1234');
});

test('bad input is rejected with a useful message rather than silently ignored', () => {
  assert.throws(() => resolveConfig(['--nope'], {}), /unknown option --nope/);
  assert.throws(() => resolveConfig(['--port', 'abc'], {}), /expects a number/);
  assert.throws(() => resolveConfig(['--upstream'], {}), /expects a value/);
});

test('normalizer options carry the schema clamps through', () => {
  const opts = normalizerOptions(resolveConfig(['--max-string-length', '500'], {}));
  assert.equal(opts.limits.maxStringLength, 500);
  assert.equal(opts.coerceToolResults, true);
});

test('max_tokens is clamped only when a ceiling is configured', async () => {
  const { normalizeRequest } = await import('../src/normalize/index.js');
  const body = { model: 'local', max_tokens: 32_000, messages: [{ role: 'user', content: 'hi' }] };

  assert.equal(normalizeRequest(body).body.max_tokens, 32_000);
  assert.equal(normalizeRequest(body, { maxOutputTokens: 8_000 }).body.max_tokens, 8_000);
  // A request already under the ceiling is left alone.
  assert.equal(
    normalizeRequest({ ...body, max_tokens: 4_000 }, { maxOutputTokens: 8_000 }).body.max_tokens,
    4_000
  );
});
