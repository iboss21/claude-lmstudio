import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { normalizeRequest } from '../src/normalize/index.js';
import { sanitizeSchema, sanitizeTools } from '../src/normalize/tools.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = () =>
  JSON.parse(readFileSync(join(here, 'fixtures', 'claude-code-request.json'), 'utf8'));

/** Walk every tool_result and report block types that LM Studio would reject. */
function illegalToolResultTypes(body) {
  const bad = [];
  for (const message of body.messages ?? []) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block?.type !== 'tool_result' || !Array.isArray(block.content)) continue;
      for (const inner of block.content) {
        if (inner?.type !== 'text') bad.push(inner?.type);
      }
    }
  }
  return bad;
}

test('the real Claude Code request no longer contains anything LM Studio rejects', () => {
  const body = fixture();
  assert.ok(illegalToolResultTypes(body).length > 0, 'fixture should start out broken');

  const { body: fixed, changed, stats } = normalizeRequest(body);

  assert.equal(changed, true);
  assert.deepEqual(illegalToolResultTypes(fixed), []);
  assert.ok(stats.toolResultsRewritten >= 2);
  assert.ok(stats.imagesHoisted >= 1);
});

test('the ToolSearch result becomes readable text', () => {
  const { body } = normalizeRequest(fixture());
  const found = body.messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((b) => b?.type === 'tool_result')
    .map((b) => (Array.isArray(b.content) ? b.content[0]?.text : b.content))
    .find((t) => typeof t === 'string' && t.includes('Tools loaded'));

  assert.equal(found, 'Tools loaded: Write, Edit, Grep, Bash');
});

test('a request that already validates is returned untouched', () => {
  const clean = {
    model: 'local',
    max_tokens: 100,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      { role: 'user', content: 'plain string' },
    ],
  };
  const before = JSON.stringify(clean);
  const { body, changed } = normalizeRequest(clean);

  assert.equal(changed, false);
  assert.equal(JSON.stringify(body), before);
});

test('normalizing is idempotent', () => {
  const once = normalizeRequest(fixture()).body;
  const twice = normalizeRequest(once);

  assert.equal(twice.changed, false);
  assert.equal(JSON.stringify(twice.body), JSON.stringify(once));
});

test('interleaved system messages are preserved by default', () => {
  const { body } = normalizeRequest(fixture());
  assert.ok(body.messages.some((m) => m.role === 'system'), 'system messages should survive');
});

test('system messages can be hoisted into the top-level system field', () => {
  const { body } = normalizeRequest(fixture(), { systemMessages: 'hoist' });

  assert.ok(!body.messages.some((m) => m.role === 'system'));
  assert.ok(Array.isArray(body.system));
  assert.ok(body.system.some((b) => b.text.includes('deferred tools')));
});

test('system messages can be converted to user turns without breaking alternation', () => {
  const { body } = normalizeRequest(fixture(), { systemMessages: 'user' });

  assert.ok(!body.messages.some((m) => m.role === 'system'));
  for (let i = 1; i < body.messages.length; i++) {
    assert.notEqual(
      body.messages[i].role,
      body.messages[i - 1].role,
      `messages ${i - 1} and ${i} share a role`
    );
  }
});

test('oversized schema bounds are clamped below the GBNF repetition limit', () => {
  // Claude Code's Workflow.script carries maxLength 524288, which makes llama.cpp's
  // grammar compiler throw "number of repetitions exceeds sane defaults".
  const stats = {};
  const schema = sanitizeSchema(
    {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        script: { type: 'string', maxLength: 524_288 },
        offset: { type: 'integer', maximum: 9_007_199_254_740_991 },
        items: { type: 'array', maxItems: 100_000 },
      },
    },
    undefined,
    stats
  );

  assert.equal(schema.properties.script.maxLength, 80_000);
  assert.equal(schema.properties.offset.maximum, 1_000_000);
  assert.equal(schema.properties.items.maxItems, 1_000);
  assert.equal(schema.$schema, undefined);
  assert.equal(stats.boundsClamped, 3);
});

test('tool sanitation handles both Anthropic and OpenAI tool shapes', () => {
  const stats = {};
  const body = sanitizeTools(
    {
      tools: [
        { name: 'a', input_schema: { type: 'object', properties: { s: { maxLength: 999_999 } } } },
        { function: { name: 'b', parameters: { properties: { s: { maxLength: 999_999 } } } } },
      ],
    },
    {},
    stats
  );

  assert.equal(body.tools[0].input_schema.properties.s.maxLength, 80_000);
  assert.equal(body.tools[1].function.parameters.properties.s.maxLength, 80_000);
  assert.equal(stats.boundsClamped, 2);
});

test('orphaned tool_use calls get a stub result', () => {
  const stats = {};
  const { body } = normalizeRequest(
    {
      model: 'local',
      max_tokens: 10,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_x', name: 'Read', input: {} }] },
      ],
    },
    { stats }
  );

  const last = body.messages[body.messages.length - 1];
  assert.equal(last.role, 'user');
  assert.equal(last.content[0].type, 'tool_result');
  assert.equal(last.content[0].tool_use_id, 'tu_x');
});

test('orphaned tool_results are demoted to text rather than rejected', () => {
  const { body } = normalizeRequest({
    model: 'local',
    max_tokens: 10,
    messages: [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'gone', content: 'output' }] },
    ],
  });

  assert.equal(body.messages[0].content[0].type, 'text');
  assert.match(body.messages[0].content[0].text, /output/);
});

test('defer_loading is stripped from tool definitions', () => {
  // It is the flag that makes Claude Code emit tool_reference blocks at all, and it
  // means nothing to a backend that receives every tool definition anyway.
  const stats = {};
  const body = sanitizeTools(
    {
      tools: [
        { name: 'Write', defer_loading: true, input_schema: { type: 'object' } },
        { name: 'Read', input_schema: { type: 'object' } },
      ],
    },
    {},
    stats
  );

  assert.equal(body.tools[0].defer_loading, undefined);
  assert.equal(body.tools[0].name, 'Write');
  assert.equal(stats.deferLoadingStripped, 1);
});

test('both tool_reference field spellings are understood', () => {
  // The documented field is `tool_name`. Accepting `name` as well is defensive parsing
  // for a second spelling seen in the wild — not a documented variant.
  const { body } = normalizeRequest({
    model: 'local',
    max_tokens: 10,
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'ToolSearch', input: {} }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'a', content: [{ type: 'tool_reference', name: 'Bash' }] },
        ],
      },
    ],
  });

  assert.deepEqual(body.messages[1].content[0].content, [{ type: 'text', text: 'Tool loaded: Bash' }]);
});

test('an unanswered parallel tool_use still gets a result', () => {
  // Claude Code issues several tool_use blocks in one assistant turn. If compaction
  // drops one of the results, the following user turn still carries the others — which
  // must not be mistaken for "this call was answered".
  const { body } = normalizeRequest({
    model: 'local',
    max_tokens: 10,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'a', name: 'Read', input: {} },
          { type: 'tool_use', id: 'b', name: 'Grep', input: {} },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] },
    ],
  });

  const calls = new Set();
  const answers = new Set();
  for (const m of body.messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === 'tool_use') calls.add(b.id);
      if (b.type === 'tool_result') answers.add(b.tool_use_id);
    }
  }

  assert.deepEqual([...calls].filter((id) => !answers.has(id)), [], 'no orphaned tool_use');
});

test('the synthesized result merges into the existing turn instead of adding one', () => {
  const { body } = normalizeRequest({
    model: 'local',
    max_tokens: 10,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'a', name: 'Read', input: {} },
          { type: 'tool_use', id: 'b', name: 'Grep', input: {} },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] },
    ],
  });

  assert.deepEqual(body.messages.map((m) => m.role), ['user', 'assistant', 'user']);
  // Both results lead the turn, as the Messages API requires.
  assert.deepEqual(body.messages[2].content.map((b) => b.type), ['tool_result', 'tool_result']);
});

test('tool_result blocks always lead a user turn after normalization', () => {
  const { body } = normalizeRequest(fixture());

  for (const message of body.messages) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;
    const types = message.content.map((b) => b.type);
    const lastToolResult = types.lastIndexOf('tool_result');
    if (lastToolResult === -1) continue;
    const firstOther = types.findIndex((t) => t !== 'tool_result');
    assert.ok(
      firstOther === -1 || firstOther > lastToolResult,
      `tool_result must lead the turn, got ${types.join(',')}`
    );
  }
});

/** Assert the Messages API invariant across every user turn in a body. */
function assertToolResultsLead(body, label) {
  for (const message of body.messages) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;
    const types = message.content.map((b) => b.type);
    const lastToolResult = types.lastIndexOf('tool_result');
    if (lastToolResult === -1) continue;
    const firstOther = types.findIndex((t) => t !== 'tool_result');
    assert.ok(
      firstOther === -1 || firstOther > lastToolResult,
      `${label}: tool_result must lead the turn, got ${types.join(',')}`
    );
  }
}

test('demoting an orphaned result does not push text ahead of a valid one', () => {
  const { body } = normalizeRequest({
    model: 'local',
    max_tokens: 10,
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'real', name: 'R', input: {} }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'gone', content: 'orphan' },
          { type: 'tool_result', tool_use_id: 'real', content: 'ok' },
        ],
      },
    ],
  });

  assert.deepEqual(body.messages.at(-1).content.map((b) => b.type), ['tool_result', 'text']);
  assertToolResultsLead(body, 'demotion');
});

test('the ordering invariant holds under every system-message mode', () => {
  for (const systemMessages of ['keep', 'user', 'hoist']) {
    const { body } = normalizeRequest(fixture(), { systemMessages });
    assertToolResultsLead(body, `systemMessages=${systemMessages}`);
  }
});

test('a system turn rewritten to user never displaces the following tool_results', () => {
  const { body } = normalizeRequest(
    {
      model: 'local',
      max_tokens: 10,
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'R', input: {} }] },
        { role: 'system', content: 'a mid-conversation reminder' },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] },
      ],
    },
    { systemMessages: 'user' }
  );

  assertToolResultsLead(body, 'system->user');
});

test('merging assistant turns keeps thinking blocks leading', () => {
  // Hoisting a system message out from between two assistant turns makes them
  // adjacent; concatenating them blindly would leave a thinking block mid-array,
  // which extended thinking forbids.
  const { body } = normalizeRequest(
    {
      model: 'local',
      max_tokens: 10,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'a', signature: '' }, { type: 'text', text: 'one' }] },
        { role: 'system', content: 'reminder' },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'b', signature: '' }, { type: 'text', text: 'two' }] },
      ],
    },
    { systemMessages: 'hoist' }
  );

  const merged = body.messages.find((m) => m.role === 'assistant');
  const types = merged.content.map((b) => b.type);
  const lastThinking = types.lastIndexOf('thinking');
  const firstOther = types.findIndex((t) => t !== 'thinking');
  assert.ok(firstOther > lastThinking, `thinking must lead, got ${types.join(',')}`);
});
