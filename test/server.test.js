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
function fakeLmStudio({ errorStyle = 'zod', rejectUnknownParam = null, alwaysReject = null, stallMs = 0 } = {}) {
  const seen = [];

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      // `stallMs` models LM Studio holding its response headers while it ingests a
      // large prompt — the window in which the client's 300s watchdog runs.
      const respond = () => {
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
      };
      if (stallMs > 0) setTimeout(respond, stallMs);
      else respond();
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

async function withStack(t, { errorStyle, rejectUnknownParam, alwaysReject, stallMs, proxyArgs = [] } = {}) {
  const upstream = fakeLmStudio({ errorStyle, rejectUnknownParam, alwaysReject, stallMs });
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

test('upstream error bodies are forwarded byte-for-byte, never re-wrapped', async (t) => {
  // Claude Code's automatic-retry recovery matches on the upstream's error WORDING:
  // it disables the rejected capability and retries after rejections of `thinking`,
  // thinking signatures, and mid-conversation system messages. A gateway that wraps
  // upstream errors in its own envelope breaks that recovery even with the right
  // status code, so the exact bytes have to survive.
  const message = '`thinking` field is not supported by this model';
  const { proxyPort } = await withStack(t, { alwaysReject: message });
  const res = await post(proxyPort, '/v1/messages', POISON_REQUEST, { raw: true });

  assert.equal(res.status, 400);
  assert.equal(
    res.text,
    JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } })
  );
});

test('defer_loading stripping can be turned off to keep the beta pairing intact', async (t) => {
  const { proxyPort, seen } = await withStack(t, { proxyArgs: ['--no-strip-defer-loading'] });
  await post(proxyPort, '/v1/messages', {
    ...POISON_REQUEST,
    tools: [{ name: 'Write', defer_loading: true, input_schema: { type: 'object' } }],
  });

  assert.equal(seen[0].tools[0].defer_loading, true);
});

/**
 * Build a long conversation with the poisoned ToolSearch result buried at `poisonAt`,
 * mirroring the real 463-message transcript rather than a 3-message reduction.
 */
function longHistory(length, poisonAt) {
  const messages = [];
  // Strict user/assistant alternation, matching the captured transcript, which had
  // zero consecutive same-role pairs. The poison pair must land as assistant then
  // user or the proxy will (correctly) merge turns and change the indices.
  const roleAt = (i) => (i % 2 === 0 ? 'user' : 'assistant');
  if (roleAt(poisonAt - 1) !== 'assistant') {
    throw new Error(`poisonAt ${poisonAt} does not land on a user turn`);
  }

  for (let i = 0; i < length; i++) {
    if (i === poisonAt - 1) {
      messages.push({
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'poison', name: 'ToolSearch', input: { query: 'select:Write,Edit,Grep,Bash' } }],
      });
      continue;
    }
    if (i === poisonAt) {
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'poison',
            content: [
              { type: 'tool_reference', tool_name: 'Write' },
              { type: 'tool_reference', tool_name: 'Edit' },
              { type: 'tool_reference', tool_name: 'Grep' },
              { type: 'tool_reference', tool_name: 'Bash' },
            ],
          },
          { type: 'text', text: 'Tool loaded.\n' },
        ],
      });
      continue;
    }
    messages.push({ role: roleAt(i), content: [{ type: 'text', text: `turn ${i}` }] });
  }
  return { model: 'local-model', max_tokens: 100, messages };
}

test('a poisoned block buried deep in a 463-message history is repaired', async (t) => {
  // The Anthropic Messages API is stateless: every turn re-posts the whole
  // conversation, so a rejected block at index 461 is replayed forever. The proxy
  // has to rewrite the entire array on every request, not just the tail.
  const { proxyPort, seen } = await withStack(t);
  const res = await post(proxyPort, '/v1/messages', longHistory(463, 462));

  assert.equal(res.status, 200);
  assert.equal(seen[0].messages.length, 463, 'no turns were lost repairing the block');
  assert.equal(findIllegalToolResult(seen[0]), null);
  assert.deepEqual(seen[0].messages[462].content[0].content, [
    { type: 'text', text: 'Tools loaded: Write, Edit, Grep, Bash' },
  ]);
});

test('the same history keeps working as the conversation grows past it', async (t) => {
  const { proxyPort, seen } = await withStack(t);

  for (const length of [463, 465, 467]) {
    const res = await post(proxyPort, '/v1/messages', longHistory(length, 462));
    assert.equal(res.status, 200, `history of ${length} messages should succeed`);
  }

  assert.equal(seen.length, 3);
  for (const body of seen) assert.equal(findIllegalToolResult(body), null);
});

test('keepalive pings reach the client while upstream is still silent', async (t) => {
  // The failure this guards against: LM Studio holds its SSE headers until the first
  // generated token, so a proxy that only pings after upstream responds sends nothing
  // during prompt ingestion — and Claude Code aborts a stream silent for 300 seconds.
  const { proxyPort } = await withStack(t, {
    stallMs: 400,
    proxyArgs: ['--early-ping-after', '80', '--ping-interval', '40'],
  });

  const res = await post(proxyPort, '/v1/messages', { ...POISON_REQUEST, stream: true }, { raw: true });

  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/event-stream/);

  const firstPing = res.text.indexOf('event: ping');
  const firstReal = res.text.indexOf('event: message_start');
  assert.ok(firstPing !== -1, 'expected at least one ping frame');
  assert.ok(firstReal !== -1, 'expected the real stream to follow');
  assert.ok(firstPing < firstReal, 'pings must arrive before upstream sends anything');
  assert.match(res.text, /event: message_stop/);
});

test('a fast validation error is still a real HTTP 400, not a committed stream', async (t) => {
  // Only genuinely slow requests should be converted into a committed stream. LM Studio
  // returns validation errors in milliseconds, so those must keep their status code —
  // Claude Code's retry logic reads both the status and the wording.
  const message = 'Only text tool_result blocks are supported when tool_result.content is an array.';
  const { proxyPort } = await withStack(t, {
    alwaysReject: message,
    proxyArgs: ['--early-ping-after', '5000'],
  });

  const res = await post(proxyPort, '/v1/messages', { ...POISON_REQUEST, stream: true }, { raw: true });

  assert.equal(res.status, 400);
  assert.equal(res.text, JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }));
});

test('an error after the stream is committed keeps the upstream wording', async (t) => {
  const message = 'Model context length exceeded (39132 > 32768)';
  const { proxyPort } = await withStack(t, {
    alwaysReject: message,
    stallMs: 300,
    proxyArgs: ['--early-ping-after', '60', '--ping-interval', '40'],
  });

  const res = await post(proxyPort, '/v1/messages', { ...POISON_REQUEST, stream: true }, { raw: true });

  assert.equal(res.status, 200, 'headers were already sent as a stream');
  assert.match(res.text, /event: ping/);
  assert.match(res.text, /event: error/);
  assert.ok(res.text.includes(message), 'the upstream wording must survive verbatim');
});

test('early ping can be turned off', async (t) => {
  const { proxyPort } = await withStack(t, {
    stallMs: 200,
    proxyArgs: ['--early-ping-after', '0'],
  });

  const res = await post(proxyPort, '/v1/messages', { ...POISON_REQUEST, stream: true }, { raw: true });

  assert.equal(res.status, 200);
  assert.ok(!res.text.startsWith('event: ping'), 'no ping should precede the upstream stream');
  assert.match(res.text, /event: message_start/);
});

test('a non-streaming request is never converted into a stream', async (t) => {
  const { proxyPort } = await withStack(t, {
    stallMs: 300,
    proxyArgs: ['--early-ping-after', '50'],
  });

  const res = await post(proxyPort, '/v1/messages', POISON_REQUEST);

  assert.equal(res.status, 200);
  assert.equal(res.json.content[0].text, 'ok');
});

test('the tool-search beta value is dropped along with defer_loading', async (t) => {
  // Beta body fields pair with a beta header value, and Anthropic's gateway protocol
  // reference is explicit that splitting the pair is what produces hard 400s.
  let seenBeta;
  const upstream = http.createServer((req, res) => {
    seenBeta = req.headers['anthropic-beta'];
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'm', role: 'assistant', content: [{ type: 'text', text: 'ok' }] }));
    });
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => upstream.close());

  const config = resolveConfig(
    ['--port', '0', '--upstream', `http://127.0.0.1:${upstream.address().port}`, '--log-level', 'silent'],
    {}
  );
  const proxy = createServer(config);
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  t.after(() => proxy.close());

  const payload = Buffer.from(
    JSON.stringify({
      model: 'local-model',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'Write', defer_loading: true, input_schema: { type: 'object' } }],
    })
  );
  await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: proxy.address().port,
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': payload.length,
          'anthropic-beta': 'context-management-2025-06-27,tool-search-tool-2025-10-19',
        },
      },
      (r) => {
        r.resume();
        r.on('end', resolve);
      }
    );
    req.on('error', reject);
    req.end(payload);
  });

  assert.ok(!/tool-search/.test(seenBeta ?? ''), `tool-search beta should be gone, got "${seenBeta}"`);
  assert.match(seenBeta, /context-management/, 'unrelated beta values must survive');
});

test('abandoning a request stops the work upstream', async (t) => {
  // Without this, a client that gives up during prompt ingestion leaves the local
  // model generating for nobody — minutes of GPU on an answer no one will read.
  let upstreamAborted = false;
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      req.on('aborted', () => {
        upstreamAborted = true;
      });
      res.on('close', () => {
        if (!res.writableEnded) upstreamAborted = true;
      });
      // Never respond: model the silent ingestion window.
    });
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => upstream.close());

  const config = resolveConfig(
    ['--port', '0', '--upstream', `http://127.0.0.1:${upstream.address().port}`, '--log-level', 'silent', '--early-ping-after', '0'],
    {}
  );
  const proxy = createServer(config);
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  t.after(() => proxy.close());

  const payload = Buffer.from(JSON.stringify({ model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }));
  const req = http.request({
    hostname: '127.0.0.1',
    port: proxy.address().port,
    path: '/v1/messages',
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': payload.length },
  });
  req.on('error', () => {});
  req.end(payload);

  await new Promise((r) => setTimeout(r, 150));
  req.destroy();
  await new Promise((r) => setTimeout(r, 250));

  assert.ok(upstreamAborted, 'upstream request should have been torn down');
});
