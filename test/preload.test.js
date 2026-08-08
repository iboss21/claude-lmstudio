import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import { buildLoadBody, preloadModel, RECOMMENDED_CONTEXT_LENGTH } from '../src/preload.js';
import { resolveConfig } from '../src/config.js';
import { configureLogger } from '../src/logger.js';

configureLogger({ logLevel: 'silent' });

test('only the fields that were configured are sent', () => {
  assert.deepEqual(buildLoadBody({ preload: 'm' }), { model: 'm', echo_load_config: true });

  assert.deepEqual(
    buildLoadBody({ preload: 'm', contextLength: 32_000, numExperts: 4, flashAttention: true }),
    {
      model: 'm',
      echo_load_config: true,
      context_length: 32_000,
      flash_attention: true,
      num_experts: 4,
    }
  );
});

test('preload is skipped entirely when no model is configured', async () => {
  assert.equal(await preloadModel({ preload: null }), null);
});

test('preload posts to the native REST load endpoint and reads back the context length', async (t) => {
  let seenPath = null;
  let seenBody = null;
  let seenAuth = null;

  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seenPath = req.url;
      seenAuth = req.headers.authorization;
      seenBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          type: 'llm',
          instance_id: 'inst_1',
          status: 'loaded',
          load_time_seconds: 3.2,
          load_config: { context_length: 32_000 },
        })
      );
    });
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => upstream.close());

  const config = resolveConfig(
    [
      '--upstream',
      `http://127.0.0.1:${upstream.address().port}`,
      '--preload',
      'regescore-1.0-35b',
      '--context-length',
      '32000',
      '--num-experts',
      '4',
      '--api-token',
      'secret',
    ],
    {}
  );

  const result = await preloadModel(config);

  assert.equal(seenPath, '/api/v1/models/load');
  assert.equal(seenAuth, 'Bearer secret');
  assert.equal(seenBody.model, 'regescore-1.0-35b');
  assert.equal(seenBody.context_length, 32_000);
  assert.equal(seenBody.num_experts, 4);
  assert.equal(result.context_length, 32_000);
});

test('a failed preload is reported but never fatal', async (t) => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'model not found' }));
    });
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => upstream.close());

  const config = resolveConfig(
    ['--upstream', `http://127.0.0.1:${upstream.address().port}`, '--preload', 'nope'],
    {}
  );

  assert.equal(await preloadModel(config), null);
});

test('an unreachable upstream does not throw out of preload', async () => {
  const config = resolveConfig(['--upstream', 'http://127.0.0.1:1', '--preload', 'm'], {});
  assert.equal(await preloadModel(config), null);
});

test('the recommended context length is above what LM Studio defaults to', () => {
  // LM Studio's default dropped to 8k in 0.4.16 Build 2.
  assert.ok(RECOMMENDED_CONTEXT_LENGTH > 8_192);
});
