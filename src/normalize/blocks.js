/**
 * Content-block coercion.
 *
 * LM Studio's Anthropic-compatible `/v1/messages` validates `tool_result.content[]`
 * against a schema whose `type` is the literal `"text"`. Claude Code legitimately
 * puts other Anthropic block types in there — most notably `tool_reference`, emitted
 * by its deferred tool-loading tool (`ToolSearch`) whenever a search actually matches
 * something. LM Studio then rejects the whole request with:
 *
 *   request.messages.<i>.content.<j>.content.<k>.type: Invalid literal value, expected "text"
 *
 * and because the offending block is now part of the conversation history, every
 * subsequent turn replays it, so the session is permanently wedged.
 *
 * This module rewrites those blocks into `text` blocks that carry the same
 * information. Images are hoisted out of the tool_result and re-attached to the
 * enclosing message, which keeps vision working on multimodal models instead of
 * throwing the pixels away.
 */

const DEFAULT_MAX_INLINE_JSON = 4000;

/** Block types that survive verbatim inside `tool_result.content[]`. */
export const TOOL_RESULT_SAFE_TYPES = new Set(['text']);

function truncate(str, max) {
  if (str.length <= max) return str;
  return `${str.slice(0, max)}\n…[truncated ${str.length - max} chars]`;
}

/**
 * Render a non-text block as plain text without losing what it conveyed.
 * Returns null when the block should simply be dropped.
 */
export function describeBlock(block, opts = {}) {
  const maxJson = opts.maxInlineJson ?? DEFAULT_MAX_INLINE_JSON;

  if (block == null) return null;
  if (typeof block === 'string') return block;
  if (typeof block !== 'object') return String(block);

  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' ? block.text : '';

    // Emitted by Claude Code's ToolSearch when deferred tools are matched and loaded.
    case 'tool_reference':
      return `Tool loaded: ${block.tool_name ?? block.name ?? 'unknown'}`;

    case 'image':
      return '[image omitted]';

    case 'document':
      return `[document: ${block.title ?? block.source?.media_type ?? 'attachment'}]`;

    case 'search_result':
      return [
        block.title ? `# ${block.title}` : null,
        block.source ? `Source: ${block.source}` : null,
        Array.isArray(block.content)
          ? block.content.map((c) => describeBlock(c, opts)).filter(Boolean).join('\n')
          : null,
      ]
        .filter(Boolean)
        .join('\n');

    case 'thinking':
      return typeof block.thinking === 'string' ? block.thinking : '';

    // LM Studio's own /api/v1/chat calls a text part {"type":"message","content":"…"},
    // where the Anthropic Messages API calls it {"type":"text","text":"…"}. Code that
    // mixes the two APIs emits the former and gets `expected "text"` back. Render it
    // rather than JSON-dumping it, so the text survives instead of becoming noise.
    case 'message':
      return typeof block.content === 'string' ? block.content : '';

    case 'redacted_thinking':
      return '';

    default:
      // Unknown/future block type: keep the payload rather than silently dropping it.
      return truncate(JSON.stringify(block), maxJson);
  }
}

/**
 * Collapse a run of consecutive `tool_reference` blocks into one readable line.
 * Claude Code emits one block per matched tool; four separate "Tool loaded: X"
 * lines is noisier than a single list.
 */
function collapseToolReferences(names) {
  if (names.length === 1) return `Tool loaded: ${names[0]}`;
  return `Tools loaded: ${names.join(', ')}`;
}

/**
 * Coerce the `content` of a single `tool_result` block into something LM Studio
 * accepts, hoisting any image blocks out so the caller can re-attach them.
 *
 * @returns {{ content: Array|string, hoisted: Array, changed: boolean }}
 */
export function coerceToolResultContent(content, opts = {}) {
  const hoisted = [];

  // A bare string is the shape LM Studio is happiest with — leave it alone.
  if (typeof content === 'string') {
    return { content, hoisted, changed: false };
  }

  if (content == null) {
    return { content: [{ type: 'text', text: '(no output)' }], hoisted, changed: true };
  }

  if (!Array.isArray(content)) {
    return {
      content: [{ type: 'text', text: describeBlock(content, opts) ?? '' }],
      hoisted,
      changed: true,
    };
  }

  // An empty array is not valid content for a tool_result.
  if (content.length === 0) {
    return { content: [{ type: 'text', text: '(no output)' }], hoisted, changed: true };
  }

  let changed = false;
  const pieces = [];
  let pendingToolRefs = [];

  const flushToolRefs = () => {
    if (!pendingToolRefs.length) return;
    pieces.push(collapseToolReferences(pendingToolRefs));
    pendingToolRefs = [];
  };

  for (const block of content) {
    const type = typeof block === 'object' && block !== null ? block.type : undefined;

    if (type === 'tool_reference') {
      pendingToolRefs.push(block.tool_name ?? block.name ?? 'unknown');
      changed = true;
      continue;
    }

    flushToolRefs();

    if (type === 'image' && opts.hoistImages !== false) {
      // Preserve the image by moving it up to the enclosing message, where
      // LM Studio does accept image blocks.
      hoisted.push(block);
      pieces.push('[image attached below]');
      changed = true;
      continue;
    }

    if (TOOL_RESULT_SAFE_TYPES.has(type)) {
      pieces.push(typeof block.text === 'string' ? block.text : '');
      continue;
    }

    pieces.push(describeBlock(block, opts) ?? '');
    changed = true;
  }

  flushToolRefs();

  if (!changed) {
    // Already all-text: hand back the originals so we never disturb a working request.
    return { content, hoisted, changed: false };
  }

  const text = pieces.filter((p) => p !== '').join('\n');
  return {
    content: [{ type: 'text', text: text === '' ? '(no output)' : text }],
    hoisted,
    changed: true,
  };
}

/**
 * Normalize every block in a message's content array.
 * Hoisted images are appended after the block they came from.
 *
 * @returns {{ content: Array|string, changed: boolean }}
 */
export function normalizeContentBlocks(content, opts = {}, stats = {}) {
  if (typeof content === 'string' || content == null) {
    return { content, changed: false };
  }
  if (!Array.isArray(content)) {
    return { content, changed: false };
  }

  let changed = false;
  const out = [];
  const hoisted = [];

  for (const block of content) {
    if (block == null || typeof block !== 'object') {
      out.push(block);
      continue;
    }

    if (block.type !== 'tool_result') {
      out.push(block);
      continue;
    }

    const result = coerceToolResultContent(block.content, opts);
    if (!result.changed) {
      out.push(block);
      continue;
    }

    changed = true;
    stats.toolResultsRewritten = (stats.toolResultsRewritten ?? 0) + 1;
    out.push({ ...block, content: result.content });
    hoisted.push(...result.hoisted);
  }

  // Hoisted images go at the END of the turn, never immediately after the block they
  // came from. Claude Code runs tools in parallel, so one user turn routinely carries
  // several tool_results, and the Messages API requires tool_result blocks to lead the
  // turn — splicing an image between two of them produces an invalid request.
  for (const image of hoisted) {
    stats.imagesHoisted = (stats.imagesHoisted ?? 0) + 1;
    out.push(image);
  }

  return { content: changed ? out : content, changed };
}
