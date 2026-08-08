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
