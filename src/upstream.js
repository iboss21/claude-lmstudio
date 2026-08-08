import http from 'node:http';
import https from 'node:https';

/**
 * Upstream transport.
 *
 * Deliberately built on `node:http` rather than `fetch`. Node's fetch (undici)
 * applies a 300s `headersTimeout` by default, and prompt processing for a large
 * agent context on a local GGUF routinely exceeds that before the first byte
 * arrives — which surfaces to the user as an unexplained timeout. Raw sockets with
 * timeouts explicitly disabled do not have that ceiling.
 */

const agents = new Map();

function agentFor(protocol) {
  if (!agents.has(protocol)) {
    const Agent = protocol === 'https:' ? https.Agent : http.Agent;
    agents.set(protocol, new Agent({ keepAlive: true, maxSockets: 64, timeout: 0 }));
  }
  return agents.get(protocol);
}

/** Headers that must not be forwarded verbatim. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

export function forwardableHeaders(headers, extra = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return { ...out, ...extra };
}

/**
 * Send a request upstream and resolve with the live response stream.
 *
 * @returns {Promise<import('node:http').IncomingMessage>}
 */
export function sendUpstream({ baseUrl, path, method, headers, body, signal }) {
  const url = new URL(path, baseUrl);
  const transport = url.protocol === 'https:' ? https : http;
  const payload = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');

  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method,
        agent: agentFor(url.protocol),
        headers: {
          ...headers,
          ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}),
        },
      },
      resolve
    );

    // No socket timeout: local inference can legitimately take many minutes.
    req.setTimeout(0);
    req.on('error', reject);

    if (signal) {
      if (signal.aborted) {
        req.destroy(new Error('client aborted'));
        return;
      }
      signal.addEventListener('abort', () => req.destroy(new Error('client aborted')), {
        once: true,
      });
    }

    if (payload) req.write(payload);
    req.end();
  });
}

/** Read a response stream fully into a Buffer. */
export function readAll(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}
