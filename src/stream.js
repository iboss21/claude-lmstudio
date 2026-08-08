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

  const headers = { ...SSE_HEADERS };
  clientRes.writeHead(upstreamRes.statusCode ?? 200, headers);
  if (typeof clientRes.flushHeaders === 'function') clientRes.flushHeaders();

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

/** Emit an Anthropic-shaped error as a single SSE frame (for failures after headers are sent). */
export function writeSseError(clientRes, message, type = 'api_error') {
  const payload = JSON.stringify({ type: 'error', error: { type, message } });
  if (!clientRes.headersSent) clientRes.writeHead(200, SSE_HEADERS);
  clientRes.write(`event: error\ndata: ${payload}\n\n`);
  clientRes.end();
}
