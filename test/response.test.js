import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createStreamGuard,
  normalizeMessageResponse,
  normalizeToolUse,
  missingRequiredParams,
} from '../src/response.js';

/** Feed SSE text through a guard and return whatever it appends at end-of-stream. */
function trailerFor(sse, opts) {
  const guard = createStreamGuard(opts);
  guard.observe(Buffer.from(sse, 'utf8'));
  return { trailer: guard.close(), repairs: guard.repairs };
}

const frame = (type, payload) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;

const WELL_FORMED =
  frame('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 5 } } }) +
  frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
  frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'hi' } }) +
  frame('content_block_stop', { index: 0 }) +
  frame('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }) +
  frame('message_stop', {});

test('a well-formed stream is passed through with nothing appended', () => {
  const { trailer, repairs } = trailerFor(WELL_FORMED);
  assert.equal(trailer, '');
  assert.deepEqual(repairs, []);
});

test('a stream cut off mid-block is completed', () => {
  // The real failure: the model hits its context limit, or llama.cpp aborts, and the
  // socket simply ends. Claude Code waits for message_stop and appears to hang.
  const truncated =
    frame('message_start', { message: { id: 'msg_1', role: 'assistant', content: [] } }) +
    frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
    frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'half a sen' } });

  const { trailer, repairs } = trailerFor(truncated);

  assert.match(trailer, /event: content_block_stop/);
  assert.match(trailer, /event: message_delta/);
  assert.match(trailer, /event: message_stop/);
  assert.equal(repairs.length, 3);
  // A stream that died mid-block did not end its turn cleanly.
  assert.match(trailer, /"stop_reason":"max_tokens"/);
});

test('every open block is closed, in index order', () => {
  const truncated =
    frame('message_start', { message: { id: 'm', role: 'assistant', content: [] } }) +
    frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
    frame('content_block_start', { index: 2, content_block: { type: 'text', text: '' } }) +
    frame('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }) +
    frame('content_block_stop', { index: 2 });

  const { trailer } = trailerFor(truncated);
  const closed = [...trailer.matchAll(/"type":"content_block_stop","index":(\d+)/g)].map((m) => Number(m[1]));
  assert.deepEqual(closed, [0, 1]);
});

test('a delta for a block that never opened still gets closed', () => {
  const odd =
    frame('message_start', { message: { id: 'm', role: 'assistant', content: [] } }) +
    frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'x' } });

  const { trailer } = trailerFor(odd);
  assert.match(trailer, /"type":"content_block_stop","index":0/);
});

test('a completely empty stream becomes a valid empty message', () => {
  const { trailer, repairs } = trailerFor('');

  assert.match(trailer, /event: message_start/);
  assert.match(trailer, /event: message_stop/);
  assert.match(repairs.join(' '), /no events/);
  // Ordering must still satisfy the contract.
  assert.ok(trailer.indexOf('message_start') < trailer.indexOf('content_block_start'));
  assert.ok(trailer.indexOf('content_block_stop') < trailer.indexOf('message_delta'));
  assert.ok(trailer.indexOf('message_delta') < trailer.indexOf('message_stop'));
});

test('blocks arriving without a message_start get one prepended', () => {
  const noStart = frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  const { trailer, repairs } = trailerFor(noStart, { model: 'local-model' });

  assert.match(trailer, /event: message_start/);
  assert.match(trailer, /"model":"local-model"/);
  assert.match(repairs.join(' '), /without message_start/);
});

test('an upstream error event is a valid ending and is left alone', () => {
  // Claude Code handles error frames; completing the envelope around one would mask it.
  const errored =
    frame('message_start', { message: { id: 'm', role: 'assistant', content: [] } }) +
    frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
    `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'boom' } })}\n\n`;

  const { trailer, repairs } = trailerFor(errored);
  assert.equal(trailer, '');
  assert.deepEqual(repairs, []);
});

test('usage reported mid-stream is carried into the synthesized ending', () => {
  const truncated =
    frame('message_start', { message: { id: 'm', role: 'assistant', content: [], usage: { input_tokens: 4242 } } }) +
    frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });

  const { trailer } = trailerFor(truncated);
  assert.match(trailer, /4242/);
});

test('events split across chunk boundaries are still understood', () => {
  const guard = createStreamGuard();
  for (const byte of Buffer.from(WELL_FORMED, 'utf8')) {
    guard.observe(Buffer.from([byte]));
  }
  assert.equal(guard.close(), '', 'byte-at-a-time delivery must parse identically');
});

test('a non-streaming response missing required fields is completed', () => {
  const fixed = normalizeMessageResponse({ content: [{ type: 'text', text: 'hi' }] }, { model: 'local' });

  assert.ok(fixed);
  assert.equal(fixed.body.type, 'message');
  assert.equal(fixed.body.role, 'assistant');
  assert.equal(fixed.body.stop_reason, 'end_turn');
  assert.equal(fixed.body.model, 'local');
  assert.ok(fixed.body.usage);
  assert.match(fixed.repairs.join(' '), /stop_reason/);
});

test('a complete non-streaming response is left alone', () => {
  const complete = {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'local',
    content: [{ type: 'text', text: 'hi' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  assert.equal(normalizeMessageResponse(complete), null);
});

test('an error envelope is never rewritten', () => {
  // Its wording is what Claude Code's automatic-retry recovery matches on.
  const err = { type: 'error', error: { type: 'invalid_request_error', message: 'nope' } };
  assert.equal(normalizeMessageResponse(err), null);
  assert.equal(normalizeMessageResponse({ error: { message: 'nope' } }), null);
});

test('a string content body is lifted into a text block', () => {
  const fixed = normalizeMessageResponse({ id: 'm', type: 'message', role: 'assistant', model: 'x', content: 'plain', stop_reason: 'end_turn', usage: {} });
  assert.deepEqual(fixed.body.content, [{ type: 'text', text: 'plain' }]);
});

test('a tool call whose arguments arrived as a JSON string is repaired', () => {
  // Local models routinely emit OpenAI-style stringified arguments.
  const fixed = normalizeToolUse({ type: 'tool_use', id: 't1', name: 'preview_screenshot', input: '{"serverId":"68fbd2e7"}' });
  assert.deepEqual(fixed.block.input, { serverId: '68fbd2e7' });
  assert.match(fixed.repair, /JSON string/);
});

test('a well-formed tool call is left alone', () => {
  assert.equal(normalizeToolUse({ type: 'tool_use', id: 't', name: 'x', input: { a: 1 } }), null);
  assert.equal(normalizeToolUse({ type: 'text', text: 'hi' }), null);
});

test('a missing or empty input becomes an empty object, not a guess', () => {
  assert.deepEqual(normalizeToolUse({ type: 'tool_use', id: 't', name: 'x' }).block.input, {});
  assert.deepEqual(normalizeToolUse({ type: 'tool_use', id: 't', name: 'x', input: '  ' }).block.input, {});
});

test('non-JSON string input is left alone rather than guessed at', () => {
  assert.equal(normalizeToolUse({ type: 'tool_use', id: 't', name: 'x', input: 'just words' }), null);
});

test('missing required parameters are reported, not invented', () => {
  // The exact shape of the observed MCP failure: preview_screenshot without serverId.
  const tools = [
    { name: 'preview_screenshot', input_schema: { type: 'object', properties: { serverId: { type: 'string' } }, required: ['serverId'] } },
  ];
  const block = { type: 'tool_use', id: 't', name: 'preview_screenshot', input: {} };

  assert.deepEqual(missingRequiredParams(block, tools), ['serverId']);
  // Reported only — the agent loop recovers by reading the tool's error and retrying.
  assert.equal(normalizeToolUse(block), null);

  const complete = { ...block, input: { serverId: 'abc' } };
  assert.deepEqual(missingRequiredParams(complete, tools), []);
});

test('tools without a required list produce no noise', () => {
  const tools = [{ name: 'x', input_schema: { type: 'object' } }];
  assert.deepEqual(missingRequiredParams({ type: 'tool_use', name: 'x', input: {} }, tools), []);
  assert.deepEqual(missingRequiredParams({ type: 'tool_use', name: 'unknown', input: {} }, tools), []);
});
