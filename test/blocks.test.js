import test from 'node:test';
import assert from 'node:assert/strict';

import {
  coerceToolResultContent,
  normalizeContentBlocks,
  describeBlock,
} from '../src/normalize/blocks.js';

test('a string tool_result is left exactly as it was', () => {
  const result = coerceToolResultContent('No matching deferred tools found');
  assert.equal(result.changed, false);
  assert.equal(result.content, 'No matching deferred tools found');
});

test('an all-text tool_result array is left exactly as it was', () => {
  const content = [{ type: 'text', text: 'ok' }];
  const result = coerceToolResultContent(content);
  assert.equal(result.changed, false);
  assert.equal(result.content, content);
});

test('tool_reference blocks collapse into one text block', () => {
  // This is the exact payload from the user's LM Studio log, message 461.
  const result = coerceToolResultContent([
    { type: 'tool_reference', tool_name: 'Write' },
    { type: 'tool_reference', tool_name: 'Edit' },
    { type: 'tool_reference', tool_name: 'Grep' },
    { type: 'tool_reference', tool_name: 'Bash' },
  ]);

  assert.equal(result.changed, true);
  assert.deepEqual(result.content, [{ type: 'text', text: 'Tools loaded: Write, Edit, Grep, Bash' }]);
  assert.equal(result.hoisted.length, 0);
});

test('a single tool_reference reads naturally', () => {
  const result = coerceToolResultContent([{ type: 'tool_reference', tool_name: 'Bash' }]);
  assert.deepEqual(result.content, [{ type: 'text', text: 'Tool loaded: Bash' }]);
});

test('images in a tool_result are hoisted out, not discarded', () => {
  const image = {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
  };
  const result = coerceToolResultContent([{ type: 'text', text: 'screenshot taken' }, image]);

  assert.equal(result.changed, true);
  assert.equal(result.hoisted.length, 1);
  assert.equal(result.hoisted[0], image);
  assert.match(result.content[0].text, /screenshot taken/);
  assert.match(result.content[0].text, /image attached below/);
});

test('images become placeholders when hoisting is disabled', () => {
  const result = coerceToolResultContent(
    [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } }],
    { hoistImages: false }
  );
  assert.equal(result.hoisted.length, 0);
  assert.deepEqual(result.content, [{ type: 'text', text: '[image omitted]' }]);
});

test('an unknown future block type keeps its payload instead of vanishing', () => {
  const result = coerceToolResultContent([{ type: 'some_new_block_2027', value: 42 }]);
  assert.equal(result.changed, true);
  assert.match(result.content[0].text, /some_new_block_2027/);
  assert.match(result.content[0].text, /42/);
});

test('an empty tool_result array becomes valid non-empty content', () => {
  const result = coerceToolResultContent([]);
  assert.deepEqual(result.content, [{ type: 'text', text: '(no output)' }]);
});

test('null tool_result content becomes valid content', () => {
  const result = coerceToolResultContent(null);
  assert.deepEqual(result.content, [{ type: 'text', text: '(no output)' }]);
});

test('hoisted images are re-attached to the enclosing message', () => {
  const stats = {};
  const { content, changed } = normalizeContentBlocks(
    [
      {
        type: 'tool_result',
        tool_use_id: 'tu_1',
        content: [
          { type: 'text', text: 'shot' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } },
        ],
      },
      { type: 'text', text: 'after' },
    ],
    {},
    stats
  );

  assert.equal(changed, true);
  assert.deepEqual(content.map((b) => b.type), ['tool_result', 'image', 'text']);
  assert.equal(stats.imagesHoisted, 1);
  assert.equal(stats.toolResultsRewritten, 1);
});

test('describeBlock renders each known type without throwing', () => {
  assert.equal(describeBlock({ type: 'text', text: 'hi' }), 'hi');
  assert.equal(describeBlock({ type: 'tool_reference', tool_name: 'Read' }), 'Tool loaded: Read');
  assert.equal(describeBlock({ type: 'redacted_thinking' }), '');
  assert.equal(describeBlock(null), null);
  assert.equal(describeBlock('raw string'), 'raw string');
});
