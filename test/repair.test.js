import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseValidationError,
  repairFromError,
  extractErrorMessage,
  coerceAllToolResults,
} from '../src/repair.js';

const ZOD_ERROR =
  'request.messages.461.content.0.content.0.type: Invalid literal value, expected "text"';
const GUARD_ERROR = 'Only text tool_result blocks are supported when tool_result.content is an array.';

function poisonedBody() {
  return {
    model: 'local',
    max_tokens: 10,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'ToolSearch', input: {} }] },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_1',
            content: [{ type: 'tool_reference', tool_name: 'Write' }],
          },
        ],
      },
    ],
  };
}

test('the Zod path form is parsed into a navigable path', () => {
  const parsed = parseValidationError(ZOD_ERROR);
  assert.deepEqual(parsed.path, ['messages', '461', 'content', '0', 'content', '0', 'type']);
  assert.equal(parsed.reason, 'Invalid literal value, expected "text"');
});

test('bracket notation is normalized to the same path', () => {
  const parsed = parseValidationError('request.messages[3].content[0].type: Invalid literal value, expected "text"');
  assert.deepEqual(parsed.path, ['messages', '3', 'content', '0', 'type']);
});

test('prose that is not a path is not mistaken for one', () => {
  assert.equal(parseValidationError('Something went badly wrong: try again'), null);
  assert.equal(parseValidationError(undefined), null);
});

test('the Zod path form repairs exactly the node it names', () => {
  const body = {
    model: 'local',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'x', content: [{ type: 'tool_reference', tool_name: 'Bash' }] },
        ],
      },
    ],
  };
  const repaired = repairFromError(
    body,
    'request.messages.0.content.0.content.0.type: Invalid literal value, expected "text"'
  );

  assert.ok(repaired);
  assert.deepEqual(repaired.body.messages[0].content[0].content, [
    { type: 'text', text: 'Tool loaded: Bash' },
  ]);
  // The original is never mutated.
  assert.equal(body.messages[0].content[0].content[0].type, 'tool_reference');
});

test('the pathless guard form sweeps every tool_result', () => {
  const repaired = repairFromError(poisonedBody(), GUARD_ERROR);

  assert.ok(repaired);
  assert.deepEqual(repaired.body.messages[2].content[0].content, [
    { type: 'text', text: 'Tool loaded: Write' },
  ]);
  assert.match(repaired.description, /tool_result/);
});

test('the guard form hoists images and reports how many', () => {
  const body = {
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'x',
            content: [
              { type: 'text', text: 'shot' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } },
            ],
          },
        ],
      },
    ],
  };
  const repaired = repairFromError(body, GUARD_ERROR);

  assert.equal(repaired.hoisted, 1);
  assert.deepEqual(repaired.body.messages[0].content.map((b) => b.type), ['tool_result', 'image']);
});

test('unrecognized keys named by upstream are removed', () => {
  const body = { model: 'local', messages: [], output_config: { effort: 'xhigh' } };
  const repaired = repairFromError(body, "request: Unrecognized key(s) in object: 'output_config'");

  assert.ok(repaired);
  assert.equal(repaired.body.output_config, undefined);
  assert.equal(repaired.body.model, 'local');
});

test('an error we cannot act on returns null rather than guessing', () => {
  assert.equal(repairFromError(poisonedBody(), 'context length exceeded'), null);
});

test('a body with nothing to coerce falls through to the string form', () => {
  const body = {
    messages: [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: [{ type: 'text', text: 'ok' }] }] },
    ],
  };
  const repaired = repairFromError(body, GUARD_ERROR);

  assert.ok(repaired);
  assert.equal(repaired.body.messages[0].content[0].content, 'ok');
});

test('coerceAllToolResults leaves a clean body alone', () => {
  assert.equal(coerceAllToolResults({ messages: [{ role: 'user', content: 'hi' }] }), null);
});

test('error envelopes are unwrapped in both shapes', () => {
  assert.equal(
    extractErrorMessage(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: ZOD_ERROR } })),
    ZOD_ERROR
  );
  assert.equal(extractErrorMessage({ message: 'plain' }), 'plain');
  assert.equal(extractErrorMessage('not json'), 'not json');
  assert.equal(extractErrorMessage(null), null);
});

test('the guard sweep never splices an image between two tool_results', () => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } };
  const repaired = coerceAllToolResults({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: 'shot' }, image] },
          { type: 'tool_result', tool_use_id: 'b', content: 'ok' },
        ],
      },
    ],
  });

  assert.deepEqual(
    repaired.body.messages[0].content.map((b) => b.type),
    ['tool_result', 'tool_result', 'image']
  );
});

test('images are dropped only when upstream actually complains about them', () => {
  const body = {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } },
        ],
      },
    ],
  };

  const dropped = repairFromError(body, 'This model does not support image input');
  assert.ok(dropped);
  assert.deepEqual(dropped.body.messages[0].content.map((b) => b.type), ['text', 'text']);
  assert.match(dropped.body.messages[0].content[1].text, /image omitted/);

  // An unrelated failure must never cost the user their screenshots.
  assert.equal(repairFromError(body, 'context length exceeded'), null);
  assert.equal(body.messages[0].content[1].type, 'image', 'original untouched');
});

test('a crafted upstream path cannot reach the prototype chain', () => {
  const body = { model: 'local', messages: [] };
  const before = Object.prototype.polluted;

  repairFromError(body, 'request.__proto__.polluted.type: Invalid literal value, expected "text"');
  repairFromError(body, "request.constructor: Unrecognized key(s) in object: 'prototype'");

  assert.equal(Object.prototype.polluted, before);
  assert.equal({}.polluted, undefined);
});

test('the upstream error type is preserved, not relabelled', async () => {
  const { extractErrorType } = await import('../src/repair.js');
  assert.equal(
    extractErrorType(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } })),
    'overloaded_error'
  );
  assert.equal(extractErrorType('not json'), null);
  assert.equal(extractErrorType(null), null);
});
