/**
 * Self-healing retry.
 *
 * The normalizer fixes the incompatibilities we know about. This is the safety net
 * for the ones we don't: LM Studio reports validation failures as a JSON path plus a
 * reason, e.g.
 *
 *   request.messages.461.content.0.content.0.type: Invalid literal value, expected "text"
 *
 * That is enough to walk straight to the offending node and coerce it, then retry.
 * When Claude Code ships a new content block type, this keeps the session alive
 * instead of wedging it until the proxy is updated.
 */

import { describeBlock, coerceToolResultContent } from './normalize/blocks.js';

/**
 * LM Studio states the tool_result rule two different ways depending on version:
 * a Zod path ("…content.0.content.0.type: Invalid literal value, expected \"text\"")
 * or an explicit guard message with no path at all. The second form needs a sweep
 * rather than a pinpoint fix.
 */
const TOOL_RESULT_GUARD = /Only text tool_result blocks are supported/i;

/**
 * Force every `tool_result.content` array in the body down to a single text block.
 * Used when upstream complains about tool_result contents without saying which one.
 *
 * @returns {{ body: object, description: string, hoisted: number } | null}
 */
export function coerceAllToolResults(body, opts = {}) {
  if (!Array.isArray(body?.messages)) return null;

  const clone = structuredClone(body);
  let rewritten = 0;
  let hoisted = 0;

  for (const message of clone.messages) {
    if (!Array.isArray(message?.content)) continue;

    const next = [];
    for (const block of message.content) {
      if (block?.type !== 'tool_result') {
        next.push(block);
        continue;
      }
      const result = coerceToolResultContent(block.content, opts);
      // Force the array form to collapse even when it was already all-text, since
      // some builds reject arrays outright in favour of a plain string.
      if (!result.changed && Array.isArray(block.content) && opts.forceString) {
        next.push({
          ...block,
          content: block.content.map((b) => describeBlock(b, opts) ?? '').filter(Boolean).join('\n'),
        });
        rewritten += 1;
        continue;
      }
      if (!result.changed) {
        next.push(block);
        continue;
      }
      rewritten += 1;
      hoisted += result.hoisted.length;
      next.push({ ...block, content: result.content });
      next.push(...result.hoisted);
    }
    message.content = next;
  }

  if (!rewritten) return null;
  return {
    body: clone,
    hoisted,
    description: `coerced ${rewritten} tool_result block(s) to text${hoisted ? `, hoisting ${hoisted} image(s)` : ''}`,
  };
}

/**
 * Parse an upstream validation message into a path and a reason.
 * @returns {{ path: string[], reason: string } | null}
 */
export function parseValidationError(message) {
  if (typeof message !== 'string') return null;
  const idx = message.indexOf(': ');
  if (idx === -1) return null;

  const rawPath = message.slice(0, idx).trim();
  const reason = message.slice(idx + 2).trim();

  // Must look like a dotted JSON path, optionally prefixed with `request.`
  if (!/^[A-Za-z_$][\w$]*(\.[\w$[\]]+)*$/.test(rawPath)) return null;

  const path = rawPath
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);

  // An empty path after dropping the envelope prefix means the error is about the
  // root object itself, which is a legitimate target — don't discard it.
  if (path[0] === 'request' || path[0] === 'body') path.shift();

  return { path, reason };
}

function resolve(root, path) {
  let node = root;
  for (const key of path) {
    if (node == null || typeof node !== 'object') return undefined;
    node = Array.isArray(node) ? node[Number(key)] : node[key];
  }
  return node;
}

function setAt(root, path, value) {
  if (!path.length) return false;
  const parent = resolve(root, path.slice(0, -1));
  if (parent == null || typeof parent !== 'object') return false;
  const key = path[path.length - 1];
  if (Array.isArray(parent)) {
    const i = Number(key);
    if (!Number.isInteger(i) || i < 0 || i >= parent.length) return false;
    parent[i] = value;
    return true;
  }
  parent[key] = value;
  return true;
}

function deleteAt(root, path) {
  if (!path.length) return false;
  const parent = resolve(root, path.slice(0, -1));
  if (parent == null || typeof parent !== 'object' || Array.isArray(parent)) return false;
  const key = path[path.length - 1];
  if (!(key in parent)) return false;
  delete parent[key];
  return true;
}

/**
 * Apply a targeted repair to a *deep copy* of the request body.
 *
 * @returns {{ body: object, description: string } | null} null when we have no safe fix.
 */
export function repairFromError(body, errorMessage, opts = {}) {
  // Pathless guard message: sweep every tool_result rather than a single node.
  if (typeof errorMessage === 'string' && TOOL_RESULT_GUARD.test(errorMessage)) {
    const swept = coerceAllToolResults(body, opts);
    if (swept) return swept;
    // Nothing left to coerce as blocks — fall back to the plain-string form.
    return coerceAllToolResults(body, { ...opts, forceString: true });
  }

  const parsed = parseValidationError(errorMessage);
  if (!parsed) return null;

  const { path, reason } = parsed;
  const clone = structuredClone(body);

  // "…content.0.type: Invalid literal value, expected \"text\"" — the failing
  // property is `type`; the thing we must rewrite is its parent block.
  if (/Invalid literal value, expected "text"/i.test(reason) && path[path.length - 1] === 'type') {
    const blockPath = path.slice(0, -1);
    const block = resolve(clone, blockPath);
    if (block === undefined) return null;
    const text = describeBlock(block, opts) ?? '';
    if (!setAt(clone, blockPath, { type: 'text', text: text === '' ? '(unsupported content)' : text })) {
      return null;
    }
    return {
      body: clone,
      description: `coerced ${blockPath.join('.')} (type=${block?.type ?? 'unknown'}) to a text block`,
    };
  }

  // "Unrecognized key(s) in object: 'foo', 'bar'"
  const unrecognized = reason.match(/Unrecognized key\(s\) in object:\s*(.+)$/i);
  if (unrecognized) {
    const keys = [...unrecognized[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    const removed = keys.filter((key) => deleteAt(clone, [...path, key]));
    if (!removed.length) return null;
    return {
      body: clone,
      description: `removed unrecognized key(s) ${removed.join(', ')} at ${path.join('.') || '<root>'}`,
    };
  }

  // A discriminated-union miss on a block we can still render as text.
  if (/Invalid (discriminator|literal|enum) value/i.test(reason) && path[path.length - 1] === 'type') {
    const blockPath = path.slice(0, -1);
    const block = resolve(clone, blockPath);
    if (block === undefined || typeof block !== 'object') return null;
    const text = describeBlock(block, opts) ?? '';
    if (!setAt(clone, blockPath, { type: 'text', text: text === '' ? '(unsupported content)' : text })) {
      return null;
    }
    return {
      body: clone,
      description: `coerced ${blockPath.join('.')} to a text block after a union mismatch`,
    };
  }

  return null;
}

/** Pull the human-readable message out of an Anthropic-style error envelope. */
export function extractErrorMessage(payload) {
  if (!payload) return null;
  if (typeof payload === 'string') {
    try {
      return extractErrorMessage(JSON.parse(payload));
    } catch {
      return payload;
    }
  }
  return payload?.error?.message ?? payload?.message ?? null;
}
