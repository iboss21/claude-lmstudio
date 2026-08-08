/**
 * Top-level request parameter handling.
 *
 * Claude Code sends several beta-gated fields that LM Studio has no opinion about
 * (`thinking`, `context_management`, `output_config`, `metadata`). LM Studio 0.4.x
 * ignores them rather than rejecting them, so the default here is passthrough —
 * a proxy that strips working fields is a proxy that causes its own bugs. The
 * knobs exist for stricter upstreams.
 */

/** Fields defined by the Anthropic Messages API that any upstream should tolerate. */
export const CORE_PARAMS = new Set([
  'model',
  'messages',
  'system',
  'tools',
  'tool_choice',
  'max_tokens',
  'stream',
  'temperature',
  'top_p',
  'top_k',
  'stop_sequences',
]);

/** Beta / client-specific fields that a strict upstream may not know. */
export const EXTENDED_PARAMS = new Set([
  'thinking',
  'context_management',
  'output_config',
  'metadata',
  'betas',
  'service_tier',
]);

function stripCacheControl(value) {
  if (Array.isArray(value)) return value.map(stripCacheControl);
  if (value === null || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === 'cache_control') continue;
    out[k] = v && typeof v === 'object' ? stripCacheControl(v) : v;
  }
  return out;
}

export function normalizeParams(body, opts = {}, stats = {}) {
  let out = body;

  const drop = new Set(opts.stripParams ?? []);
  if (opts.strictParams) {
    for (const key of Object.keys(body)) {
      if (!CORE_PARAMS.has(key)) drop.add(key);
    }
  }

  if (drop.size) {
    out = {};
    for (const [key, value] of Object.entries(body)) {
      if (drop.has(key)) {
        stats.paramsStripped = (stats.paramsStripped ?? 0) + 1;
        continue;
      }
      out[key] = value;
    }
  }

  if (opts.stripCacheControl) {
    const stripped = stripCacheControl(out);
    if (JSON.stringify(stripped) !== JSON.stringify(out)) {
      stats.cacheControlStripped = true;
      out = stripped;
    }
  }

  // `max_tokens` is required by the Messages API; a missing value is a hard 400.
  if (out.max_tokens == null && opts.defaultMaxTokens) {
    out = { ...out, max_tokens: opts.defaultMaxTokens };
    stats.maxTokensDefaulted = true;
  }

  // Claude Code defaults max_tokens to 32000 for any model ID it does not recognize,
  // which every local GGUF name is. llama.cpp reserves that much of the context window
  // for output, so on a 32k-context model it can leave almost nothing for the prompt.
  if (opts.maxOutputTokens && typeof out.max_tokens === 'number' && out.max_tokens > opts.maxOutputTokens) {
    stats.maxTokensClamped = out.max_tokens;
    out = { ...out, max_tokens: opts.maxOutputTokens };
  }

  return out;
}
