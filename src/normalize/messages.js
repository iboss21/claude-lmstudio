/**
 * Message-array repairs.
 *
 * These are deliberately conservative: LM Studio 0.4.x demonstrably accepts
 * `role: "system"` messages interleaved in `messages[]` (Claude Code sends ~46 of
 * them in a long session, and the stock chat templates for local models collect
 * them explicitly), so the default is to leave them alone. Everything here is
 * opt-in repair for the cases where a stricter upstream, or a compacted history,
 * would otherwise produce an invalid request.
 */

import { normalizeContentBlocks } from './blocks.js';

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (b && typeof b === 'object' && typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n');
}

function isEmptyContent(content) {
  if (typeof content === 'string') return content.trim() === '';
  if (Array.isArray(content)) return content.length === 0;
  return content == null;
}

/**
 * Rewrite `role: "system"` messages according to `mode`.
 *  - `keep`  : passthrough (default; matches what LM Studio already accepts)
 *  - `user`  : convert to a user turn, preserving position in the conversation
 *  - `hoist` : strip from messages[] and return the text for the top-level system field
 */
export function handleSystemMessages(messages, mode, stats = {}) {
  if (mode === 'keep' || !mode) return { messages, hoisted: [] };

  const hoisted = [];
  const out = [];

  for (const message of messages) {
    if (message?.role !== 'system') {
      out.push(message);
      continue;
    }
    stats.systemMessagesRewritten = (stats.systemMessagesRewritten ?? 0) + 1;

    if (mode === 'hoist') {
      const text = contentToText(message.content);
      if (text) hoisted.push({ type: 'text', text });
      continue;
    }

    // mode === 'user'
    const text = contentToText(message.content);
    out.push({
      role: 'user',
      content: [{ type: 'text', text: `<system-reminder>\n${text}\n</system-reminder>` }],
    });
  }

  return { messages: out, hoisted };
}

/**
 * Merge consecutive messages that share a role. Rewriting system messages into
 * user turns can create adjacency that the Anthropic schema forbids.
 */
export function mergeAdjacentRoles(messages, stats = {}) {
  const out = [];
  let merged = 0;

  for (const message of messages) {
    const prev = out[out.length - 1];
    if (!prev || prev.role !== message.role) {
      out.push(message);
      continue;
    }

    const a = Array.isArray(prev.content)
      ? prev.content
      : [{ type: 'text', text: String(prev.content ?? '') }];
    const b = Array.isArray(message.content)
      ? message.content
      : [{ type: 'text', text: String(message.content ?? '') }];

    out[out.length - 1] = { ...prev, content: [...a, ...b] };
    stats.messagesMerged = (stats.messagesMerged ?? 0) + 1;
    merged += 1;
  }

  // Preserve identity when nothing moved, so callers can detect a true no-op.
  return merged ? out : messages;
}

/**
 * Repair tool_use / tool_result pairing.
 *
 * Context compaction can drop one half of a pair, which some backends reject and
 * which reliably confuses a local model. Missing results get a synthetic stub;
 * results whose call is gone are demoted to plain text.
 */
export function repairToolPairing(messages, stats = {}) {
  const calls = new Map();
  for (const message of messages) {
    if (!Array.isArray(message?.content)) continue;
    for (const block of message.content) {
      if (block?.type === 'tool_use') calls.set(block.id, block.name);
    }
  }

  const answered = new Set();
  for (const message of messages) {
    if (!Array.isArray(message?.content)) continue;
    for (const block of message.content) {
      if (block?.type === 'tool_result') answered.add(block.tool_use_id);
    }
  }

  const out = [];
  let modified = false;
  // Stub tool_results owed to the previous assistant turn. They are prepended to the
  // next user turn, because tool_result blocks must lead a user turn.
  let pendingStubs = [];

  const flushPending = (message) => {
    if (!pendingStubs.length) return message;
    const content = Array.isArray(message.content)
      ? message.content
      : [{ type: 'text', text: String(message.content ?? '') }];
    const merged = { ...message, content: [...pendingStubs, ...content] };
    pendingStubs = [];
    return merged;
  };

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!Array.isArray(message?.content)) {
      out.push(message?.role === 'user' ? flushPending(message) : message);
      continue;
    }

    // Demote orphaned tool_results (their tool_use is no longer in history).
    let content = message.content;
    let touched = false;
    const mapped = content.map((block) => {
      if (block?.type !== 'tool_result') return block;
      if (calls.has(block.tool_use_id)) return block;
      touched = true;
      stats.orphanResultsDemoted = (stats.orphanResultsDemoted ?? 0) + 1;
      const text =
        typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? block.content.map((c) => c?.text ?? '').filter(Boolean).join('\n')
            : '';
      return { type: 'text', text: `[tool result]\n${text}` };
    });
    if (touched) {
      content = mapped;
      modified = true;
    }

    const staged = touched ? { ...message, content } : message;
    out.push(message.role === 'user' ? flushPending(staged) : staged);

    // Synthesize results for calls that were never answered anywhere in the history.
    // `answered` already spans every message, so an id missing from it has no result —
    // the following turn answering *other* calls does not make this one answered, which
    // is exactly the parallel-tool-call case.
    if (message.role !== 'assistant') continue;
    const unanswered = content.filter((b) => b?.type === 'tool_use' && !answered.has(b.id));
    if (!unanswered.length) continue;

    stats.stubResultsAdded = (stats.stubResultsAdded ?? 0) + unanswered.length;
    modified = true;
    const stubs = unanswered.map((b) => ({
      type: 'tool_result',
      tool_use_id: b.id,
      content: '[no result recorded]',
      is_error: true,
    }));

    if (messages[i + 1]?.role === 'user') {
      // Merge into the existing user turn rather than inserting one, which would
      // create two consecutive user messages.
      pendingStubs = stubs;
    } else {
      out.push({ role: 'user', content: stubs });
    }
  }

  if (pendingStubs.length) out.push({ role: 'user', content: pendingStubs });

  return modified ? out : messages;
}

const LEADING_BLOCKS = {
  // The Messages API requires tool_result blocks to open a user turn...
  user: new Set(['tool_result']),
  // ...and thinking blocks to open an assistant turn when extended thinking is on.
  assistant: new Set(['thinking', 'redacted_thinking']),
};

/**
 * Restore the block-ordering rules the Messages API imposes on a turn.
 *
 * Several transformations can break these on their own — hoisting an image out of the
 * first of several tool_results, demoting an orphaned result to text, merging a
 * rewritten system turn into the following one, concatenating two assistant turns
 * whose thinking blocks then sit mid-array — so rather than trusting every site to be
 * careful, the invariant is restored once, here.
 *
 * The partition is stable, so blocks keep their relative order within each group.
 */
export function enforceBlockOrder(messages, stats = {}) {
  let modified = false;

  const out = messages.map((message) => {
    const leading = LEADING_BLOCKS[message?.role];
    if (!leading || !Array.isArray(message.content)) return message;

    const content = message.content;
    const firstOther = content.findIndex((b) => !leading.has(b?.type));
    if (firstOther === -1) return message;
    if (!content.slice(firstOther).some((b) => leading.has(b?.type))) return message;

    modified = true;
    stats.turnsReordered = (stats.turnsReordered ?? 0) + 1;
    return {
      ...message,
      content: [
        ...content.filter((b) => leading.has(b?.type)),
        ...content.filter((b) => !leading.has(b?.type)),
      ],
    };
  });

  return modified ? out : messages;
}

/** @deprecated kept as the previous name for the user-turn case. */
export const enforceToolResultOrder = enforceBlockOrder;

/** Drop messages whose content ended up empty — most backends reject them. */
export function dropEmptyMessages(messages, stats = {}) {
  const out = messages.filter((m) => !isEmptyContent(m?.content));
  if (out.length === messages.length) return messages;
  stats.emptyMessagesDropped = (stats.emptyMessagesDropped ?? 0) + (messages.length - out.length);
  return out;
}

/** Run block-level coercion across every message. */
export function normalizeMessageContents(messages, opts, stats) {
  let changed = false;
  const out = messages.map((message) => {
    if (!message || typeof message !== 'object') return message;
    const result = normalizeContentBlocks(message.content, opts, stats);
    if (!result.changed) return message;
    changed = true;
    return { ...message, content: result.content };
  });
  return changed ? out : messages;
}
