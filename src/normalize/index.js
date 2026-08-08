import { sanitizeTools } from './tools.js';
import { normalizeParams } from './params.js';
import {
  normalizeMessageContents,
  handleSystemMessages,
  mergeAdjacentRoles,
  repairToolPairing,
  dropEmptyMessages,
  enforceBlockOrder,
} from './messages.js';

export { sanitizeTools, sanitizeSchema, DEFAULT_LIMITS } from './tools.js';
export { normalizeParams, CORE_PARAMS, EXTENDED_PARAMS } from './params.js';
export {
  coerceToolResultContent,
  normalizeContentBlocks,
  describeBlock,
  TOOL_RESULT_SAFE_TYPES,
} from './blocks.js';
export {
  handleSystemMessages,
  mergeAdjacentRoles,
  repairToolPairing,
  dropEmptyMessages,
  enforceBlockOrder,
  normalizeMessageContents,
} from './messages.js';

export const DEFAULT_OPTIONS = {
  /** Rewrite non-text blocks inside tool_result content. This is the core fix. */
  coerceToolResults: true,
  /** Move images out of tool_result into the enclosing message instead of dropping them. */
  hoistImages: true,
  /** Clamp oversized JSON-schema bounds so llama.cpp's grammar compiler survives. */
  sanitizeTools: true,
  /** Remove `$schema` dialect URIs from tool schemas. */
  stripSchemaDialect: true,
  /** `keep` | `user` | `hoist` — LM Studio accepts interleaved system messages, so keep. */
  systemMessages: 'keep',
  /** Synthesize missing tool_results and demote orphaned ones. */
  repairToolPairing: true,
  /** Merge messages that end up adjacent with the same role. */
  mergeAdjacent: true,
  /** Drop messages left with no content. */
  dropEmpty: true,
  /** Strip cache_control (LM Studio ignores it; harmless either way). */
  stripCacheControl: false,
  /** Keep only Anthropic-core top-level params. */
  strictParams: false,
  /** Explicit top-level params to remove. */
  stripParams: [],
  /** Cap on JSON-stringified unknown blocks rendered into text. */
  maxInlineJson: 4000,
};

/**
 * Rewrite a Claude Code `/v1/messages` request into one LM Studio accepts.
 *
 * Every transformation is a no-op when it has nothing to do, so a request that
 * already validates is forwarded byte-identical.
 *
 * @returns {{ body: object, stats: object, changed: boolean }}
 */
export function normalizeRequest(body, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const stats = {};

  if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) {
    return { body, stats, changed: false };
  }

  let out = normalizeParams(body, opts, stats);
  if (opts.sanitizeTools) out = sanitizeTools(out, opts, stats);

  let messages = out.messages;
  const original = messages;

  if (opts.coerceToolResults) messages = normalizeMessageContents(messages, opts, stats);

  const system = handleSystemMessages(messages, opts.systemMessages, stats);
  messages = system.messages;

  if (opts.repairToolPairing) messages = repairToolPairing(messages, stats);
  // Dropping runs before merging: removing a message can put two same-role turns
  // next to each other, and merging afterwards is what collapses them.
  if (opts.dropEmpty) messages = dropEmptyMessages(messages, stats);
  if (opts.mergeAdjacent) messages = mergeAdjacentRoles(messages, stats);
  // Last, because merging and demotion can both disturb it.
  messages = enforceBlockOrder(messages, stats);

  if (messages !== original) out = { ...out, messages };

  if (system.hoisted.length) {
    const existing = Array.isArray(out.system)
      ? out.system
      : typeof out.system === 'string'
        ? [{ type: 'text', text: out.system }]
        : [];
    out = { ...out, system: [...existing, ...system.hoisted] };
  }

  const changed = out !== body || messages !== original;
  return { body: out, stats, changed };
}

/** True when the normalizer actually had to touch something worth logging. */
export function summarizeStats(stats) {
  const parts = [];
  if (stats.toolResultsRewritten) parts.push(`${stats.toolResultsRewritten} tool_result(s) coerced`);
  if (stats.imagesHoisted) parts.push(`${stats.imagesHoisted} image(s) hoisted`);
  if (stats.boundsClamped) parts.push(`${stats.boundsClamped} schema bound(s) clamped`);
  if (stats.dialectKeysStripped) parts.push(`${stats.dialectKeysStripped} $schema key(s) stripped`);
  if (stats.deferLoadingStripped) parts.push(`${stats.deferLoadingStripped} defer_loading flag(s) stripped`);
  if (stats.systemMessagesRewritten) parts.push(`${stats.systemMessagesRewritten} system msg(s) rewritten`);
  if (stats.messagesMerged) parts.push(`${stats.messagesMerged} message(s) merged`);
  if (stats.stubResultsAdded) parts.push(`${stats.stubResultsAdded} stub tool_result(s) added`);
  if (stats.orphanResultsDemoted) parts.push(`${stats.orphanResultsDemoted} orphan result(s) demoted`);
  if (stats.emptyMessagesDropped) parts.push(`${stats.emptyMessagesDropped} empty message(s) dropped`);
  if (stats.turnsReordered) parts.push(`${stats.turnsReordered} turn(s) reordered`);
  if (stats.paramsStripped) parts.push(`${stats.paramsStripped} param(s) stripped`);
  return parts.join(', ');
}
