/**
 * Tool-schema sanitation.
 *
 * LM Studio compiles each tool's `input_schema` into a GBNF grammar to constrain
 * tool-call output. llama.cpp's grammar compiler caps repetitions at ~100k, so a
 * bound like `maxLength: 524288` (Claude Code's `Workflow.script` field) makes the
 * compiler throw "number of repetitions exceeds sane defaults" and every tool turn
 * dies with a 400 before the model ever runs.
 *
 * Clamping the bounds costs nothing — they exist to describe intent, not to be
 * enforced byte-for-byte by a local grammar.
 */

export const DEFAULT_LIMITS = {
  maxStringLength: 80_000,
  maxNumber: 1_000_000,
  maxItems: 1_000,
};

const CLAMP_KEYS = new Map([
  ['maxLength', 'maxStringLength'],
  ['minLength', 'maxStringLength'],
  ['maximum', 'maxNumber'],
  ['exclusiveMaximum', 'maxNumber'],
  ['minimum', 'maxNumber'],
  ['exclusiveMinimum', 'maxNumber'],
  ['maxItems', 'maxItems'],
  ['minItems', 'maxItems'],
  ['maxProperties', 'maxItems'],
  ['minProperties', 'maxItems'],
]);

function clampMagnitude(value, cap) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value;
  if (value > cap) return cap;
  if (value < -cap) return -cap;
  return value;
}

/**
 * Recursively clamp oversized bounds. Returns a new object; the input is untouched.
 */
export function sanitizeSchema(node, limits = DEFAULT_LIMITS, stats = {}, stripDialect = true) {
  if (Array.isArray(node)) {
    return node.map((item) => sanitizeSchema(item, limits, stats, stripDialect));
  }
  if (node === null || typeof node !== 'object') return node;

  const out = {};
  for (const [key, value] of Object.entries(node)) {
    // `$schema` is dialect metadata, never a constraint, and some grammar
    // converters trip over draft-2020-12 URIs.
    if (stripDialect && key === '$schema') {
      stats.dialectKeysStripped = (stats.dialectKeysStripped ?? 0) + 1;
      continue;
    }

    const limitKey = CLAMP_KEYS.get(key);
    if (limitKey && typeof value === 'number') {
      const clamped = clampMagnitude(value, limits[limitKey]);
      if (clamped !== value) stats.boundsClamped = (stats.boundsClamped ?? 0) + 1;
      out[key] = clamped;
      continue;
    }

    out[key] = value && typeof value === 'object'
      ? sanitizeSchema(value, limits, stats, stripDialect)
      : value;
  }
  return out;
}

/**
 * Sanitize every tool definition on a request body, in both the Anthropic
 * (`tools[].input_schema`) and OpenAI (`tools[].function.parameters`) shapes.
 */
export function sanitizeTools(body, opts = {}, stats = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(opts.limits ?? {}) };
  const stripDialect = opts.stripSchemaDialect !== false;

  const before = stats.boundsClamped ?? 0;
  const beforeDialect = stats.dialectKeysStripped ?? 0;
  const beforeDefer = stats.deferLoadingStripped ?? 0;

  const mapTool = (rawTool) => {
    if (!rawTool || typeof rawTool !== 'object') return rawTool;

    let tool = rawTool;

    // `defer_loading` marks a tool as discoverable through the tool-search flow. It is
    // meaningless to LM Studio, which is handed all the definitions anyway, and it is
    // the field that makes Claude Code emit the tool_reference blocks in the first
    // place — so a backend that sees it may reason about deferral it cannot support.
    if (tool.defer_loading !== undefined) {
      const { defer_loading, ...rest } = tool;
      tool = rest;
      stats.deferLoadingStripped = (stats.deferLoadingStripped ?? 0) + 1;
    }

    if (tool.input_schema && typeof tool.input_schema === 'object') {
      return { ...tool, input_schema: sanitizeSchema(tool.input_schema, limits, stats, stripDialect) };
    }
    if (tool !== rawTool) return tool;
    if (tool.function?.parameters && typeof tool.function.parameters === 'object') {
      return {
        ...tool,
        function: {
          ...tool.function,
          parameters: sanitizeSchema(tool.function.parameters, limits, stats, stripDialect),
        },
      };
    }
    if (tool.parameters && typeof tool.parameters === 'object') {
      return { ...tool, parameters: sanitizeSchema(tool.parameters, limits, stats, stripDialect) };
    }
    return tool;
  };

  const out = { ...body };
  if (Array.isArray(body.tools)) out.tools = body.tools.map(mapTool);
  if (Array.isArray(body.functions)) out.functions = body.functions.map(mapTool);

  const changed =
    (stats.boundsClamped ?? 0) !== before ||
    (stats.dialectKeysStripped ?? 0) !== beforeDialect ||
    (stats.deferLoadingStripped ?? 0) !== beforeDefer;

  return changed ? out : body;
}
