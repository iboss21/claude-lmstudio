/**
 * Token estimation for `/v1/messages/count_tokens`.
 *
 * LM Studio does not implement that endpoint. Anthropic's gateway protocol reference
 * says token counting is optional and that Claude Code estimates context usage locally
 * when it is absent — so a clean 404 would be fine. What is not fine is what LM Studio
 * actually does: it answers unknown routes with HTTP 200 and a body that is not an
 * Anthropic response, which the client cannot detect as a failure. Claude Code drives
 * auto-compaction off these counts, so the history then grows without bound until every
 * turn is a multi-minute prompt-processing stall.
 *
 * (Its log line "Unexpected endpoint or method … Returning 200 anyway" also fires for
 * routes it does implement, so it is not evidence about the `?beta=true` variant
 * specifically. The proxy routes on the pathname and answers both forms regardless.)
 *
 * There is no tokenizer exposed over LM Studio's REST API, so we estimate — and then
 * self-calibrate against the real `usage.input_tokens` that comes back on every
 * completion, which converges on the loaded model's actual tokenizer within a few turns.
 */

/** Characters per token before calibration. Deliberately low, so we over-count rather than overflow. */
export const DEFAULT_CHARS_PER_TOKEN = 3.5;

/** Per-message framing overhead (role markers, separators). */
const MESSAGE_OVERHEAD = 4;
const TOOL_OVERHEAD = 8;

function estimateText(text, charsPerToken) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  return Math.ceil(text.length / charsPerToken);
}

/**
 * Read width/height out of a base64 PNG header so image cost tracks reality.
 * PNG signature is 8 bytes, then an IHDR chunk whose width/height are big-endian
 * uint32s at offsets 16 and 20.
 */
export function pngDimensions(base64) {
  try {
    const head = Buffer.from(base64.slice(0, 64), 'base64');
    if (head.length < 24) return null;
    if (head.readUInt32BE(0) !== 0x89504e47) return null;
    if (head.toString('ascii', 12, 16) !== 'IHDR') return null;
    const width = head.readUInt32BE(16);
    const height = head.readUInt32BE(20);
    if (!width || !height || width > 100_000 || height > 100_000) return null;
    return { width, height };
  } catch {
    return null;
  }
}

/** Anthropic's published approximation is (width * height) / 750. */
export function estimateImageTokens(block) {
  const source = block?.source;
  if (!source) return 1600;

  if (source.type === 'base64' && typeof source.data === 'string') {
    if (source.media_type === 'image/png') {
      const dims = pngDimensions(source.data);
      if (dims) return Math.min(Math.ceil((dims.width * dims.height) / 750), 4000);
    }
    // Fall back to payload size: bigger encodes generally mean more pixels.
    const bytes = Math.floor((source.data.length * 3) / 4);
    return Math.min(Math.max(Math.ceil(bytes / 750), 200), 4000);
  }

  return 1600;
}

function estimateBlock(block, charsPerToken) {
  if (block == null) return 0;
  if (typeof block === 'string') return estimateText(block, charsPerToken);
  if (typeof block !== 'object') return 0;

  switch (block.type) {
    case 'text':
      return estimateText(block.text, charsPerToken);
    case 'thinking':
      return estimateText(block.thinking, charsPerToken);
    case 'image':
      return estimateImageTokens(block);
    case 'tool_use':
      return (
        estimateText(block.name, charsPerToken) +
        estimateText(JSON.stringify(block.input ?? {}), charsPerToken) +
        TOOL_OVERHEAD
      );
    case 'tool_result': {
      const inner = Array.isArray(block.content)
        ? block.content.reduce((sum, b) => sum + estimateBlock(b, charsPerToken), 0)
        : estimateText(block.content, charsPerToken);
      return inner + TOOL_OVERHEAD;
    }
    case 'tool_reference':
      return estimateText(block.tool_name ?? '', charsPerToken) + 2;
    default:
      return estimateText(JSON.stringify(block), charsPerToken);
  }
}

function estimateContent(content, charsPerToken) {
  if (typeof content === 'string') return estimateText(content, charsPerToken);
  if (!Array.isArray(content)) return 0;
  return content.reduce((sum, block) => sum + estimateBlock(block, charsPerToken), 0);
}

/**
 * Estimate the prompt tokens for an Anthropic Messages request body.
 */
export function countRequestTokens(body, opts = {}) {
  const charsPerToken = opts.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
  let total = 0;

  if (Array.isArray(body?.messages)) {
    for (const message of body.messages) {
      total += MESSAGE_OVERHEAD + estimateContent(message?.content, charsPerToken);
    }
  }

  if (body?.system) total += estimateContent(body.system, charsPerToken);

  if (Array.isArray(body?.tools)) {
    for (const tool of body.tools) {
      total += TOOL_OVERHEAD + estimateText(JSON.stringify(tool), charsPerToken);
    }
  }

  const calibrated = Math.ceil(total * (opts.calibration ?? 1));
  return Math.max(calibrated, 1);
}

/**
 * Exponential moving average of (real tokens / estimated tokens), so the estimate
 * converges on whatever tokenizer the loaded GGUF actually uses.
 */
export function totalInputTokens(usage) {
  if (!usage) return 0;
  // A cached prefix is still prompt the model must fit. Backends report it separately,
  // and counting only `input_tokens` would make the calibration factor collapse toward
  // zero on a long conversation — the direction that overflows the context window.
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  );
}

export class TokenCalibrator {
  constructor({ alpha = 0.25, min = 0.6, max = 2.5 } = {}) {
    this.alpha = alpha;
    this.min = min;
    this.max = max;
    this.factor = 1;
    this.samples = 0;
  }

  get value() {
    return this.factor;
  }

  record(estimated, actual) {
    if (!Number.isFinite(estimated) || !Number.isFinite(actual)) return this.factor;
    if (estimated <= 0 || actual <= 0) return this.factor;

    const ratio = actual / estimated;
    if (!Number.isFinite(ratio)) return this.factor;

    const clamped = Math.min(Math.max(ratio, this.min), this.max);
    // Always smooth, including the first sample. Adopting sample one outright let a
    // single anomalous usage number set the factor permanently.
    this.factor = this.factor * (1 - this.alpha) + clamped * this.alpha;
    this.samples += 1;
    return this.factor;
  }
}
