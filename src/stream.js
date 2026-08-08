import { log } from './logger.js';

/**
 * SSE relay.
 *
 * Two jobs beyond moving bytes:
 *
 *  1. Keepalive. Prompt processing for a large agent context on a local model can
 *     run for minutes before the first token, during which the connection is
 *     completely silent. The Anthropic stream protocol has a `ping` event exactly
 *     for this, so we synthesize one whenever upstream goes quiet — but only on an
 *     event boundary, since splicing bytes into a half-written event would corrupt
 *     the stream.
 *
 *  2. Usage capture. `message_start` and `message_delta` carry the real token counts
 *     from the loaded model, which feed the token-count calibrator.
 */

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
};

const PING_FRAME = Buffer.from('event: ping\ndata: {"type": "ping"}\n\n', 'utf8');

export function isEventStream(headers) {
  return String(headers?.['content-type'] ?? '').includes('text/event-stream');
}

/**
 * Relay an upstream SSE response to the client.
 *
 * @returns {Promise<{ usage: object|null }>}
 */
export function pipeSse(upstreamRes, clientRes, opts = {}) {
  const pingIntervalMs = opts.pingIntervalMs ?? 10_000;

  if (!opts.headersSent) {
    clientRes.writeHead(upstreamRes.statusCode ?? 200, { ...SSE_HEADERS });
    if (typeof clientRes.flushHeaders === 'function') clientRes.flushHeaders();
  }

  return new Promise((resolve) => {
    let atEventBoundary = true;
    let tail = '';
    let usage = null;
    let settled = false;

    const timer =
      pingIntervalMs > 0
        ? setInterval(() => {
            if (!atEventBoundary || clientRes.writableEnded) return;
            clientRes.write(PING_FRAME);
          }, pingIntervalMs)
        : null;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      resolve({ usage });
    };

    const scanForUsage = (chunk) => {
      tail += chunk.toString('utf8');
      // Keep the buffer bounded; usage frames are small and arrive early/late, not mid-flood.
      const lines = tail.split('\n');
      tail = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const event = JSON.parse(payload);
          if (event.type === 'message_start' && event.message?.usage) {
            usage = { ...(usage ?? {}), ...event.message.usage };
          } else if (event.type === 'message_delta' && event.usage) {
            usage = { ...(usage ?? {}), ...event.usage };
          }
        } catch {
          // Partial or non-JSON frame; ignore.
        }
      }
      if (tail.length > 1_000_000) tail = '';
    };

    upstreamRes.on('data', (chunk) => {
      atEventBoundary = chunk.length >= 2 && chunk.subarray(chunk.length - 2).toString() === '\n\n';
      scanForUsage(chunk);
      const ok = clientRes.write(chunk);
      if (!ok) {
        upstreamRes.pause();
        clientRes.once('drain', () => upstreamRes.resume());
      }
    });

    upstreamRes.on('end', () => {
      if (!clientRes.writableEnded) clientRes.end();
      finish();
    });

    upstreamRes.on('error', (err) => {
      log.warn('upstream stream error:', err.message);
      if (!clientRes.writableEnded) {
        clientRes.write(
          `event: error\ndata: ${JSON.stringify({
            type: 'error',
            error: { type: 'api_error', message: `upstream stream error: ${err.message}` },
          })}\n\n`
        );
        clientRes.end();
      }
      finish();
    });

    clientRes.on('close', () => {
      if (!upstreamRes.destroyed) upstreamRes.destroy();
      finish();
    });
  });
}

/**
 * Keep the connection alive while LM Studio is still ingesting the prompt.
 *
 * The relay above can only ping once upstream has flushed its response headers. If
 * LM Studio withholds them until the first generated token, nothing reaches the client
 * during prompt ingestion — and Claude Code aborts a stream that stays silent for 300
 * seconds. Rather than depend on when LM Studio happens to flush, this commits to the
 * SSE response itself after `delayMs` and starts pinging.
 *
 * The delay matters: LM Studio returns validation errors in milliseconds, so a delay of
 * seconds means real `400`s still reach the client as proper HTTP errors, and only a
 * genuinely slow request is ever converted into a committed stream.
 *
 * @returns {{ committed: boolean, stop: () => void }}
 */
export function startEarlyPing(clientRes, { delayMs, intervalMs }) {
  let committed = false;
  let interval = null;

  const timer = setTimeout(() => {
    if (clientRes.writableEnded || clientRes.headersSent) return;
    committed = true;
    clientRes.writeHead(200, { ...SSE_HEADERS });
    if (typeof clientRes.flushHeaders === 'function') clientRes.flushHeaders();
    clientRes.write(PING_FRAME);
    if (intervalMs > 0) {
      interval = setInterval(() => {
        if (!clientRes.writableEnded) clientRes.write(PING_FRAME);
      }, intervalMs);
    }
  }, delayMs);

  return {
    get committed() {
      return committed;
    },
    stop() {
      clearTimeout(timer);
      if (interval) clearInterval(interval);
      interval = null;
    },
  };
}

/** Emit an Anthropic-shaped error as a single SSE frame (for failures after headers are sent). */
export function writeSseError(clientRes, message, type = 'api_error') {
  const payload = JSON.stringify({ type: 'error', error: { type, message } });
  if (!clientRes.headersSent) clientRes.writeHead(200, SSE_HEADERS);
  clientRes.write(`event: error\ndata: ${payload}\n\n`);
  clientRes.end();
}
