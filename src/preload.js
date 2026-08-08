import { sendUpstream, readAll } from './upstream.js';
import { log } from './logger.js';

/**
 * Model pre-warming via LM Studio's native REST API.
 *
 * Two problems this solves, neither of which the Anthropic endpoint can:
 *
 *  1. `/v1/messages` cannot set context length per request — it is a load-time
 *     property. LM Studio's default dropped to 8k in 0.4.16 Build 2, while a Claude
 *     Code session needs well over 25k, and the overflow shows up as truncation or a
 *     stalled agent loop rather than a clear error.
 *
 *  2. JIT loading means the first request after an idle period pays a full model
 *     load, which is indistinguishable from a timeout on the client side.
 *
 * Loading deliberately up front, with an explicit context length, removes both.
 */

/** Below this, a Claude Code session will thrash or truncate. */
export const RECOMMENDED_CONTEXT_LENGTH = 25_000;

export function buildLoadBody(config) {
  const body = { model: config.preload, echo_load_config: true };
  if (config.contextLength != null) body.context_length = config.contextLength;
  if (config.flashAttention != null) body.flash_attention = config.flashAttention;
  if (config.numExperts != null) body.num_experts = config.numExperts;
  if (config.evalBatchSize != null) body.eval_batch_size = config.evalBatchSize;
  return body;
}

/**
 * Load the configured model before Claude Code's first request arrives.
 * Failures are logged, never fatal — the proxy is still useful without it.
 */
export async function preloadModel(config) {
  if (!config.preload) return null;

  const body = buildLoadBody(config);
  log.info(
    `preloading ${config.preload}${config.contextLength ? ` at ${config.contextLength} context` : ''}…`
  );

  try {
    const res = await sendUpstream({
      baseUrl: config.upstream,
      path: '/api/v1/models/load',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.apiToken ? { authorization: `Bearer ${config.apiToken}` } : {}),
      },
      body: JSON.stringify(body),
    });

    const raw = await readAll(res);
    if ((res.statusCode ?? 500) >= 400) {
      log.warn(`preload failed (${res.statusCode}): ${raw.toString('utf8').slice(0, 300)}`);
      return null;
    }

    const parsed = JSON.parse(raw.toString('utf8'));
    const loaded = parsed.load_config?.context_length ?? config.contextLength;
    log.info(
      `preloaded ${config.preload} in ${parsed.load_time_seconds ?? '?'}s` +
        (loaded ? ` with ${loaded} token context` : '')
    );

    if (loaded && loaded < RECOMMENDED_CONTEXT_LENGTH) {
      log.warn(
        `context length is ${loaded}; Claude Code sessions routinely exceed ` +
          `${RECOMMENDED_CONTEXT_LENGTH}. Pass --context-length to raise it.`
      );
    }
    return { ...parsed, context_length: loaded };
  } catch (err) {
    log.warn(`preload failed: ${err.message}`);
    return null;
  }
}

/**
 * Warn when a request will not fit the loaded context window. Without this the
 * failure mode is silent truncation, which reads as the model ignoring instructions.
 */
export function makeContextGuard(getContextLength) {
  let warned = false;
  const read = typeof getContextLength === 'function' ? getContextLength : () => getContextLength;
  return (inputTokens) => {
    const contextLength = read();
    if (!contextLength || warned) return;
    if (inputTokens < contextLength * 0.9) return;
    warned = true;
    log.warn(
      `request is ~${inputTokens} tokens against a ${contextLength}-token context window. ` +
        `Raise the model's context length in LM Studio, or expect truncation.`
    );
  };
}
