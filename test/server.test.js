import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import { createServer } from '../src/server.js';
import { resolveConfig } from '../src/config.js';

/**
 * A stand-in for LM Studio's Anthropic-compatible endpoint that enforces the one
 * rule that actually breaks Claude Code: `tool_result.content`, when it is an array,
 * may only contain `text` blocks. Both of the error shapes LM Studio has shipped are
 * reproducible so the proxy is tested against each.
 */
function fakeLmStudio({ errorStyle = 'zod', rejectUnknownParam = null, alwaysReject = null } = {}) {
  const seen = [];

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const path = req.url.split('?')[0];

      if (path === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'local-model' }] }));
        return;
      }

      // LM Studio does not implement count_tokens; it answers 200 with a body the
      // client cannot use. Any proxy that forwards this breaks auto-compaction.
      if (path === '/v1/messages/count_tokens') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('Unexpected endpoint or method. Returning 200 anyway');
        return;
      }

      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      seen.push(body);

      // A backend that rejects no matter what the proxy does.
      if (alwaysReject) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: alwaysReject } })
        );
        return;
      }

      // A stricter build that rejects a param the proxy deliberately forwards.
      if (rejectUnknownParam && body[rejectUnknownParam] !== undefined) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message: `request: Unrecognized key(s) in object: '${rejectUnknownParam}'`,
            },
          })
        );
        return;
      }

      const offence = findIllegalToolResult(body);
      if (offence) {
        const message =
          errorStyle === 'zod'
            ? `request.messages.${offence.i}.content.${offence.j}.content.${offence.k}.type: Invalid literal value, expected "text"`
            : 'Only text tool_result blocks are supported when tool_result.content is an array.';
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }));
        return;
      }

      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        send('message_start', {
          type: 'message_start',
          message: { id: 'msg_1', role: 'assistant', content: [], usage: { input_tokens: 4242 } },
        });
        send('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'ok' },
        });
        send('message_stop', { type: 'message_stop' });
        res.end();
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg_1',
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 4242, output_tokens: 2 },
        })
      );
    });
  });

  return { server, seen };
}

function findIllegalToolResult(body) {
  const messages = body.messages ?? [];
  for (let i = 0; i < messages.length; i++) {
    const content = messages[i]?.content;
    if (!Array.isArray(content)) continue;
    for (let j = 0; j < content.length; j++) {
      const block = content[j];
      if (block?.type !== 'tool_result' || !Array.isArray(block.content)) continue;
      for (let k = 0; k < block.content.length; k++) {
        if (block.content[k]?.type !== 'text') return { i, j, k };
      }
    }
  }
  return null;
}

async function withStack(t, { errorStyle, rejectUnknownParam, alwaysReject, proxyArgs = [] } = {}) {
  const upstream = fakeLmStudio({ errorStyle, rejectUnknownParam, alwaysReject });
  upstream.server.listen(0, '127.0.0.1');
  await once(upstream.server, 'listening');
  const upstreamPort = upstream.server.address().port;

  const config = resolveConfig(
    ['--port', '0', '--upstream', `http://127.0.0.1:${upstreamPort}`, '--log-level', 'silent', ...proxyArgs],
    {}
  );
  const proxy = createServer(config);
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const proxyPort = proxy.address().port;

  t.after(async () => {
    proxy.close();
    upstream.server.close();
  });

  return { proxyPort, upstreamPort, seen: upstream.seen };
}

function post(port, path, body, { raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': payload.length },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, headers: res.headers, text, json: raw ? null : safeJson(text) });
        });
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The exact message that wedged the user's session, reduced to its essentials. */
const POISON_REQUEST = {
  model: 'local-model',
  max_tokens: 100,
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'build it' }] },
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'qcQ2QKfYKAnolg8QxsU1syjcyQlJ7Kas', name: 'ToolSearch', input: { query: 'select:Write,Edit,Grep,Bash' } },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'qcQ2QKfYKAnolg8QxsU1syjcyQlJ7Kas',
          content: [
            { type: 'tool_reference', tool_name: 'Write' },
            { type: 'tool_reference', tool_name: 'Edit' },
            { type: 'tool_reference', tool_name: 'Grep' },
            { type: 'tool_reference', tool_name: 'Bash' },
          ],
        },
        { type: 'text', text: 'Tool loaded.\n' },
      ],
    },
  ],
};

test('the request that wedged the real session now succeeds', async (t) => {
  const { proxyPort, seen } = await withStack(t);
  const res = await post(proxyPort, '/v1/messages', POISON_REQUEST);

  assert.equal(res.status, 200);
  assert.equal(res.json.content[0].text, 'ok');
  // Upstream saw one request, already valid — no repair round trip was needed.
  assert.equal(seen.length, 1);
  assert.equal(findIllegalToolResult(seen[0]), null);
});

test('the same request works against the newer guard-style error too', async (t) => {
  const { proxyPort } = await withStack(t, { errorStyle: 'guard' });
  const res = await post(proxyPort, '/v1/messages', POISON_REQUEST);
  assert.equal(res.status, 200);
});

test('a screenshot image inside a tool_result survives as a real image', async (t) => {
  const { proxyPort, seen } = await withStack(t);
  const res = await post(proxyPort, '/v1/messages', {
    model: 'local-model',
    max_tokens: 100,
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'shot', name: 'Screenshot', input: {} }] },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'shot',
            content: [
              { type: 'text', text: 'preview screenshot' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
            ],
          },
        ],
      },
    ],
  });

  assert.equal(res.status, 200);
  const forwarded = seen[0].messages.find((m) => m.role === 'user');
  assert.deepEqual(forwarded.content.map((b) => b.type), ['tool_result', 'image']);
});

test('auto-repair recovers from a rejection the normalizer did not anticipate', async (t) => {
  // Claude Code sends `output_config` and the proxy deliberately forwards it, since
  // LM Studio 0.4.x ignores it. A stricter build rejects it — auto-repair should strip
  // the offending key and retry rather than surfacing a 400 to the user.
  const { proxyPort, seen } = await withStack(t, { rejectUnknownParam: 'output_config' });
  const res = await post(proxyPort, '/v1/messages', {
    ...POISON_REQUEST,
    output_config: { effort: 'xhigh' },
  });

  assert.equal(res.status, 200);
  assert.equal(res.headers['x-claude-lmstudio-repairs'], '1');
  assert.equal(seen.length, 2, 'one rejected attempt, then one repaired retry');
  assert.notEqual(seen[0].output_config, undefined);
  assert.equal(seen[1].output_config, undefined);
});

test('an error with no safe repair is surfaced verbatim, not guessed at', async (t) => {
  const { proxyPort, seen } = await withStack(t, {
    alwaysReject: 'Model context length exceeded (39132 > 32768)',
  });
  const res = await post(proxyPort, '/v1/messages', POISON_REQUEST);

  assert.equal(res.status, 400);
  assert.match(res.json.error.message, /context length exceeded/);
  assert.equal(seen.length, 1, 'must not retry an error it cannot fix');
});

test('repeated repairable rejections terminate at the attempt cap', async (t) => {
  const { proxyPort, seen } = await withStack(t, {
    // Always claims this key is unrecognized, even after it has been removed.
    alwaysReject: "request: Unrecognized key(s) in object: 'metadata'",
    proxyArgs: ['--max-repair-attempts', '2'],
  });
  const res = await post(proxyPort, '/v1/messages', { ...POISON_REQUEST, metadata: { user_id: 'u' } });

  assert.equal(res.status, 400);
  assert.ok(seen.length <= 3, `expected at most 3 upstream calls, saw ${seen.length}`);
  assert.ok(seen.length >= 2, 'should have attempted at least one repair');
});

test('auto-repair can be turned off', async (t) => {
  const { proxyPort, seen } = await withStack(t, {
    rejectUnknownParam: 'output_config',
    proxyArgs: ['--no-auto-repair'],
  });
  const res = await post(proxyPort, '/v1/messages', { ...POISON_REQUEST, output_config: { effort: 'xhigh' } });

  assert.equal(res.status, 400);
  assert.equal(seen.length, 1);
});

test('count_tokens is answered locally instead of forwarding LM Studio garbage', async (t) => {
  const { proxyPort, seen } = await withStack(t);
  const res = await post(proxyPort, '/v1/messages/count_tokens', {
    model: 'local-model',
    messages: [{ role: 'user', content: 'x'.repeat(3500) }],
  });

  assert.equal(res.status, 200);
  assert.equal(typeof res.json.input_tokens, 'number');
  assert.ok(res.json.input_tokens > 500);
  assert.equal(seen.length, 0, 'count_tokens must never reach LM Studio');
});

test('count_tokens is answered on the ?beta=true route Claude Code actually calls', async (t) => {
  const { proxyPort } = await withStack(t);
  const res = await post(proxyPort, '/v1/messages/count_tokens?beta=true', {
    model: 'local-model',
    messages: [{ role: 'user', content: 'hello' }],
  });

  assert.equal(res.status, 200);
  assert.equal(typeof res.json.input_tokens, 'number');
});

test('streaming responses pass through intact', async (t) => {
  const { proxyPort } = await withStack(t);
  const res = await post(proxyPort, '/v1/messages', { ...POISON_REQUEST, stream: true }, { raw: true });

  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/event-stream/);
  assert.match(res.text, /event: message_start/);
  assert.match(res.text, /event: message_stop/);
  assert.match(res.text, /"text":"ok"/);
});

test('unknown routes are proxied through untouched', async (t) => {
  const { proxyPort } = await withStack(t);
  const res = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: proxyPort, path: '/v1/models', method: 'GET' }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => resolve({ status: r.statusCode, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });

  assert.equal(res.status, 200);
  assert.match(res.text, /local-model/);
});

test('the health endpoint reports upstream and calibration state', async (t) => {
  const { proxyPort, upstreamPort } = await withStack(t);
  await post(proxyPort, '/v1/messages', POISON_REQUEST);

  const res = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: proxyPort, path: '/health', method: 'GET' }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
    });
    req.on('error', reject);
    req.end();
  });

  assert.equal(res.ok, true);
  assert.equal(res.upstream, `http://127.0.0.1:${upstreamPort}`);
  assert.equal(res.rewritten, 1);
  // The fake upstream reports 4242 input tokens, so calibration must have moved.
  assert.notEqual(res.calibration, 1);
});

test('an unreachable LM Studio produces a clear, actionable error', async (t) => {
  const config = resolveConfig(['--port', '0', '--upstream', 'http://127.0.0.1:1', '--log-level', 'silent'], {});
  const proxy = createServer(config);
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  t.after(() => proxy.close());

  const res = await post(proxy.address().port, '/v1/messages', POISON_REQUEST);

  assert.equal(res.status, 502);
  assert.match(res.json.error.message, /could not reach LM Studio/);
  assert.match(res.json.error.message, /--upstream/);
});

test('malformed JSON gets an Anthropic-shaped error, not a crash', async (t) => {
  const { proxyPort } = await withStack(t);
  const res = await new Promise((resolve, reject) => {
    const payload = Buffer.from('{ not json', 'utf8');
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: proxyPort,
        path: '/v1/messages',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': payload.length },
      },
      (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => resolve({ status: r.statusCode, json: safeJson(Buffer.concat(chunks).toString()) }));
      }
    );
    req.on('error', reject);
    req.end(payload);
  });

  assert.equal(res.status, 400);
  assert.equal(res.json.error.type, 'invalid_request_error');
});
