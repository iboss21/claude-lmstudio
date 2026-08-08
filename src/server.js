import http from 'node:http';

import { normalizeRequest, summarizeStats } from './normalize/index.js';
import { normalizerOptions, COMMON_UPSTREAM_PORTS } from './config.js';
import { sendUpstream, readAll, forwardableHeaders } from './upstream.js';
import { pipeSse, isEventStream } from './stream.js';
import { countRequestTokens, TokenCalibrator } from './tokenizer.js';
import { repairFromError, extractErrorMessage } from './repair.js';
import { makeContextGuard } from './preload.js';
import { log, dump, configureLogger } from './logger.js';

const MESSAGES_PATH = '/v1/messages';
const COUNT_TOKENS_PATH = '/v1/messages/count_tokens';

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    ...extraHeaders,
  });
  res.end(body);
}

function anthropicError(res, status, type, message) {
  sendJson(res, status, { type: 'error', error: { type, message } });
}

export function createServer(config) {
  configureLogger(config);

  const baseOpts = normalizerOptions(config);
  const calibrator = new TokenCalibrator();
  const state = { requests: 0, repaired: 0, rewritten: 0 };

  // Learned at runtime. Claude Code itself puts screenshot images at the top level of a
  // user message, and LM Studio validates those fine, so hoisting images out of a
  // tool_result is the lossless fix. If a build ever rejects them there too, we notice
  // once and stop hoisting for the rest of the process instead of paying a retry per turn.
  const runtime = { hoistImages: config.hoistImages };
  const normOpts = () => ({ ...baseOpts, hoistImages: runtime.hoistImages });

  const tokenOpts = () => ({
    charsPerToken: config.charsPerToken,
    calibration: config.calibrate ? calibrator.value : 1,
  });

  const guardContext = makeContextGuard(config.contextLength);

  /**
   * POST /v1/messages — normalize, forward, and retry through upstream validation
   * errors before giving up.
   */
  async function handleMessages(req, res, raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch (err) {
      anthropicError(res, 400, 'invalid_request_error', `proxy could not parse body: ${err.message}`);
      return;
    }

    const { body: normalized, stats, changed } = normalizeRequest(parsed, normOpts());
    if (changed) {
      state.rewritten += 1;
      const summary = summarizeStats(stats);
      if (summary) log.info(`rewrote request: ${summary}`);
    }

    const headers = forwardableHeaders(req.headers, { 'content-type': 'application/json' });

    let current = normalized;
    let attempts = 0;
    let lastRepairHoisted = 0;
    const repairs = [];

    for (;;) {
      const payload = Buffer.from(JSON.stringify(current), 'utf8');

      let upstream;
      try {
        upstream = await sendUpstream({
          baseUrl: config.upstream,
          path: req.url,
          method: 'POST',
          headers,
          body: payload,
          signal: null,
        });
      } catch (err) {
        log.error(`cannot reach LM Studio at ${config.upstream}: ${err.message}`);
        anthropicError(
          res,
          502,
          'api_error',
          `claude-lmstudio could not reach LM Studio at ${config.upstream} (${err.message}). ` +
            `Is the server running, and is --upstream pointing at the right port?`
        );
        return;
      }

      const status = upstream.statusCode ?? 502;

      if (status < 400) {
        const extra = repairs.length ? { 'x-claude-lmstudio-repairs': String(repairs.length) } : {};

        if (isEventStream(upstream.headers)) {
          for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
          const { usage } = await pipeSse(upstream, res, { pingIntervalMs: config.pingIntervalMs });
          if (config.calibrate && usage?.input_tokens) {
            const estimate = countRequestTokens(current, { charsPerToken: config.charsPerToken });
            calibrator.record(estimate, usage.input_tokens);
            log.debug(
              `token calibration: est=${estimate} actual=${usage.input_tokens} factor=${calibrator.value.toFixed(3)}`
            );
          }
          return;
        }

        const buffered = await readAll(upstream);
        if (config.calibrate) {
          try {
            const usage = JSON.parse(buffered.toString('utf8'))?.usage;
            if (usage?.input_tokens) {
              const estimate = countRequestTokens(current, { charsPerToken: config.charsPerToken });
              calibrator.record(estimate, usage.input_tokens);
            }
          } catch {
            // Non-JSON success body; nothing to calibrate against.
          }
        }
        res.writeHead(status, {
          ...Object.fromEntries(
            Object.entries(upstream.headers).filter(([k]) => k !== 'transfer-encoding')
          ),
          'content-length': buffered.length,
          ...extra,
        });
        res.end(buffered);
        return;
      }

      // Upstream rejected the request. Read the error and try to fix the exact node it named.
      const errorBody = await readAll(upstream);
      const text = errorBody.toString('utf8');
      const message = extractErrorMessage(text) ?? text;

      // A retry that still fails after we relocated images means this build will not
      // take top-level images either. Stop hoisting and render them as placeholders.
      if (lastRepairHoisted > 0 && runtime.hoistImages) {
        runtime.hoistImages = false;
        log.warn('upstream rejected hoisted images too — falling back to text placeholders');
      }

      const canRetry = config.autoRepair && attempts < config.maxRepairAttempts && status === 400;
      const repair = canRetry ? repairFromError(current, message, normOpts()) : null;

      if (!repair) {
        if (status === 400) {
          log.error(`LM Studio rejected the request: ${message}`);
          const file = dump('rejected-request', { url: req.url, message, request: current });
          if (file) log.error(`wrote failing request to ${file}`);
          if (!config.autoRepair) {
            log.error('auto-repair is disabled; re-run without --no-auto-repair to self-heal');
          } else if (attempts >= config.maxRepairAttempts) {
            log.error(`gave up after ${attempts} repair attempt(s)`);
          } else {
            log.error('no automatic repair matched this error — please report the dump above');
          }
        }

        res.writeHead(status, {
          ...Object.fromEntries(
            Object.entries(upstream.headers).filter(([k]) => k !== 'transfer-encoding')
          ),
          'content-length': errorBody.length,
        });
        res.end(errorBody);
        return;
      }

      attempts += 1;
      state.repaired += 1;
      lastRepairHoisted = repair.hoisted ?? 0;
      repairs.push(repair.description);
      log.warn(
        `upstream 400 (${message}) — ${repair.description}; retrying (${attempts}/${config.maxRepairAttempts})`
      );
      current = repair.body;
    }
  }

  /**
   * POST /v1/messages/count_tokens — answered locally.
   *
   * LM Studio does not implement this route (and misses it entirely when Claude Code
   * appends `?beta=true`), returning a 200 with a body the client cannot use. Claude
   * Code drives auto-compaction off these numbers, so a wrong answer here is what
   * turns a working session into an ever-growing prompt.
   */
  async function handleCountTokens(req, res, raw) {
    if (config.countTokens !== 'local') {
      await proxyTransparently(req, res, raw);
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch (err) {
      anthropicError(res, 400, 'invalid_request_error', `proxy could not parse body: ${err.message}`);
      return;
    }

    const input_tokens = countRequestTokens(parsed, tokenOpts());
    log.debug(`count_tokens -> ${input_tokens} (factor ${calibrator.value.toFixed(3)})`);
    guardContext(input_tokens);
    sendJson(res, 200, { input_tokens });
  }

  /** Everything else goes straight through, unmodified. */
  async function proxyTransparently(req, res, raw) {
    let upstream;
    try {
      upstream = await sendUpstream({
        baseUrl: config.upstream,
        path: req.url,
        method: req.method,
        headers: forwardableHeaders(req.headers),
        body: raw.length ? raw : null,
      });
    } catch (err) {
      anthropicError(res, 502, 'api_error', `upstream unreachable: ${err.message}`);
      return;
    }

    if (isEventStream(upstream.headers)) {
      await pipeSse(upstream, res, { pingIntervalMs: config.pingIntervalMs });
      return;
    }

    const buffered = await readAll(upstream);
    res.writeHead(upstream.statusCode ?? 502, {
      ...Object.fromEntries(
        Object.entries(upstream.headers).filter(([k]) => k !== 'transfer-encoding')
      ),
      'content-length': buffered.length,
    });
    res.end(buffered);
  }

  const server = http.createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    state.requests += 1;

    try {
      if (path === '/health' || path === '/__health') {
        sendJson(res, 200, {
          ok: true,
          upstream: config.upstream,
          calibration: Number(calibrator.value.toFixed(3)),
          ...state,
        });
        return;
      }

      const raw = await readBody(req);

      if (req.method === 'POST' && path === COUNT_TOKENS_PATH) {
        await handleCountTokens(req, res, raw);
        return;
      }
      if (req.method === 'POST' && path === MESSAGES_PATH) {
        await handleMessages(req, res, raw);
        return;
      }

      await proxyTransparently(req, res, raw);
    } catch (err) {
      log.error('handler error:', err.stack ?? err.message);
      if (!res.headersSent) anthropicError(res, 500, 'api_error', `proxy error: ${err.message}`);
      else res.end();
    }
  });

  server.on('clientError', (err, socket) => {
    log.debug('client error:', err.message);
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  // Never let a slow local model get cut off by a socket timeout.
  server.timeout = 0;
  server.headersTimeout = 0;
  server.requestTimeout = 0;
  server.keepAliveTimeout = 72_000;

  return server;
}

/** Probe the configured upstream, and suggest alternatives when it is down. */
export async function probeUpstream(config) {
  const tryPort = (url) =>
    new Promise((resolve) => {
      const target = new URL('/v1/models', url);
      const req = http.request(
        { hostname: target.hostname, port: target.port, path: target.pathname, method: 'GET' },
        (res) => {
          res.resume();
          resolve(res.statusCode != null && res.statusCode < 500);
        }
      );
      req.setTimeout(1500, () => req.destroy());
      req.on('error', () => resolve(false));
      req.end();
    });

  if (await tryPort(config.upstream)) return { ok: true, upstream: config.upstream };

  const base = new URL(config.upstream);
  for (const port of COMMON_UPSTREAM_PORTS) {
    if (String(port) === base.port) continue;
    const candidate = `${base.protocol}//${base.hostname}:${port}`;
    if (await tryPort(candidate)) return { ok: false, upstream: config.upstream, suggestion: candidate };
  }

  return { ok: false, upstream: config.upstream };
}
