/**
 * Response-side normalization: LM Studio → Claude Code.
 *
 * Everything else in this proxy fixes the request direction. This fixes the other half.
 *
 * The Anthropic streaming contract is a strictly ordered envelope:
 *
 *   message_start
 *     ( content_block_start → content_block_delta* → content_block_stop )*
 *   message_delta
 *   message_stop
 *
 * Claude Code drives its state machine off those events. A stream that stops early —
 * because the model hit its context limit, the backend crashed, llama.cpp aborted a
 * grammar, or the socket dropped — leaves the client waiting for a `message_stop` that
 * never arrives. That presents as a hang, not an error, which is exactly the symptom
 * that is hardest to attribute to the right cause.
 *
 * The design here is deliberately minimal-risk: upstream bytes are relayed verbatim and
 * never rewritten. This only tracks what has been seen and, at end-of-stream, appends
 * the events the contract requires but upstream omitted. A well-formed stream is
 * therefore passed through untouched and this module is a no-op.
 */

/** Events that carry an `index` referring to a content block. */
const BLOCK_EVENTS = new Set(['content_block_start', 'content_block_delta', 'content_block_stop']);

function frame(type, payload) {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/**
 * Track an Anthropic SSE stream and report what is missing when it ends.
 *
 * Usage:
 *   const guard = createStreamGuard();
 *   guard.observe(chunkBuffer);        // for every upstream chunk
 *   const trailer = guard.close();     // '' when the stream was already well-formed
 */
export function createStreamGuard(opts = {}) {
  const state = {
    sawMessageStart: false,
    sawMessageDelta: false,
    sawMessageStop: false,
    sawError: false,
    openBlocks: new Set(),
    maxIndex: -1,
    usage: null,
    stopReason: null,
    messageId: null,
    model: opts.model ?? null,
  };

  let pending = '';
  const repairs = [];

  function handleEvent(event) {
    const type = event?.type;
    if (!type) return;

    switch (type) {
      case 'message_start':
        state.sawMessageStart = true;
        state.messageId = event.message?.id ?? state.messageId;
        state.model = event.message?.model ?? state.model;
        if (event.message?.usage) state.usage = { ...(state.usage ?? {}), ...event.message.usage };
        break;

      case 'content_block_start':
        if (typeof event.index === 'number') {
          state.openBlocks.add(event.index);
          state.maxIndex = Math.max(state.maxIndex, event.index);
        }
        break;

      case 'content_block_stop':
        if (typeof event.index === 'number') state.openBlocks.delete(event.index);
        break;

      case 'content_block_delta':
        if (typeof event.index === 'number') {
          state.maxIndex = Math.max(state.maxIndex, event.index);
          // A delta for a block that never opened still implies an open block.
          if (!state.openBlocks.has(event.index)) state.openBlocks.add(event.index);
        }
        break;

      case 'message_delta':
        state.sawMessageDelta = true;
        if (event.delta?.stop_reason) state.stopReason = event.delta.stop_reason;
        if (event.usage) state.usage = { ...(state.usage ?? {}), ...event.usage };
        break;

      case 'message_stop':
        state.sawMessageStop = true;
        break;

      case 'error':
        // Upstream reported a terminal error; the envelope is legitimately incomplete.
        state.sawError = true;
        break;

      default:
        break;
    }
  }

  return {
    state,
    repairs,

    /** Feed an upstream chunk. Never modifies it — this is observation only. */
    observe(chunk) {
      pending += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trimEnd();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          handleEvent(JSON.parse(payload));
        } catch {
          // Partial or non-JSON frame; the next chunk completes it.
        }
      }

      // Bound the buffer: a frame that never terminates must not grow without limit.
      if (pending.length > 1_000_000) pending = '';
    },

    /**
     * Close the stream, returning SSE text to append so the envelope is complete.
     * Returns '' when upstream already produced a well-formed stream.
     */
    close() {
      // An upstream `error` event is a valid terminal state; Claude Code handles it.
      if (state.sawError) return '';

      let out = '';

      // Nothing at all arrived. Without a complete envelope the client waits forever,
      // so emit a minimal well-formed empty message it can finish and surface.
      if (!state.sawMessageStart) {
        if (state.maxIndex === -1 && state.openBlocks.size === 0) {
          repairs.push('synthesized an empty message for a stream that produced no events');
          return (
            frame('message_start', {
              type: 'message_start',
              message: {
                id: state.messageId ?? 'msg_claude_lmstudio_recovered',
                type: 'message',
                role: 'assistant',
                model: state.model ?? 'unknown',
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: state.usage ?? { input_tokens: 0, output_tokens: 0 },
              },
            }) +
            frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
            frame('content_block_stop', { type: 'content_block_stop', index: 0 }) +
            frame('message_delta', {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn', stop_sequence: null },
              usage: state.usage ?? { output_tokens: 0 },
            }) +
            frame('message_stop', { type: 'message_stop' })
          );
        }
        // Blocks arrived without a message_start — prepend one so the client can begin.
        repairs.push('stream began without message_start');
        out += frame('message_start', {
          type: 'message_start',
          message: {
            id: state.messageId ?? 'msg_claude_lmstudio_recovered',
            type: 'message',
            role: 'assistant',
            model: state.model ?? 'unknown',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: state.usage ?? { input_tokens: 0, output_tokens: 0 },
          },
        });
      }

      // Close any content block upstream left open, lowest index first.
      const open = [...state.openBlocks].sort((a, b) => a - b);
      for (const index of open) {
        repairs.push(`content block ${index} was never closed`);
        out += frame('content_block_stop', { type: 'content_block_stop', index });
      }

      if (!state.sawMessageDelta) {
        repairs.push('stream ended without message_delta');
        out += frame('message_delta', {
          type: 'message_delta',
          // `max_tokens` is the honest guess for a stream that stopped mid-block.
          delta: {
            stop_reason: state.stopReason ?? (open.length ? 'max_tokens' : 'end_turn'),
            stop_sequence: null,
          },
          usage: state.usage ?? { output_tokens: 0 },
        });
      }

      if (!state.sawMessageStop) {
        repairs.push('stream ended without message_stop');
        out += frame('message_stop', { type: 'message_stop' });
      }

      return out;
    },
  };
}

/**
 * Repair a tool call whose arguments arrived in the wrong shape.
 *
 * Local models routinely emit `input` as a JSON *string* rather than an object, because
 * that is what the OpenAI function-calling format uses on the wire. Claude Code expects
 * an object and will pass a string straight through to the tool, which then rejects it.
 *
 * This does not invent missing arguments — a model that omits a required parameter has
 * made a mistake only it can correct, and the agent loop handles that by reading the
 * tool's error and retrying.
 *
 * @returns {{ block: object, repair: string } | null}
 */
export function normalizeToolUse(block) {
  if (block?.type !== 'tool_use') return null;

  if (block.input === undefined || block.input === null) {
    return { block: { ...block, input: {} }, repair: `${block.name}: input was missing` };
  }

  if (typeof block.input === 'string') {
    const text = block.input.trim();
    if (text === '') return { block: { ...block, input: {} }, repair: `${block.name}: input was an empty string` };
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { block: { ...block, input: parsed }, repair: `${block.name}: input was a JSON string` };
      }
    } catch {
      // Not JSON — leave it alone rather than guess at a shape.
    }
  }

  return null;
}

/** Report tool calls missing a parameter their schema declares required. */
export function missingRequiredParams(block, tools) {
  if (block?.type !== 'tool_use' || !Array.isArray(tools)) return [];
  const schema = tools.find((t) => t?.name === block.name)?.input_schema;
  if (!schema || !Array.isArray(schema.required)) return [];
  const input = block.input && typeof block.input === 'object' ? block.input : {};
  return schema.required.filter((key) => input[key] === undefined);
}

/**
 * Fill in the fields a non-streaming Messages response must carry.
 *
 * Claude Code reads `stop_reason` and `usage` directly; a body missing them is not a
 * hang, but it does produce wrong accounting and an unrecognized turn.
 *
 * @returns {{ body: object, repairs: string[] } | null} null when nothing was missing.
 */
export function normalizeMessageResponse(body, opts = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  // Never touch an error envelope: its wording is what Claude Code's recovery matches on.
  if (body.type === 'error' || body.error) return null;

  const repairs = [];
  const out = { ...body };

  if (out.type !== 'message') {
    repairs.push('missing type: "message"');
    out.type = 'message';
  }
  if (out.role !== 'assistant') {
    repairs.push('missing role: "assistant"');
    out.role = 'assistant';
  }
  if (!Array.isArray(out.content)) {
    repairs.push('content was not an array');
    out.content = typeof out.content === 'string' ? [{ type: 'text', text: out.content }] : [];
  }
  if (typeof out.id !== 'string' || !out.id) {
    repairs.push('missing id');
    out.id = 'msg_claude_lmstudio_recovered';
  }
  if (typeof out.model !== 'string' || !out.model) {
    repairs.push('missing model');
    out.model = opts.model ?? 'unknown';
  }
  if (out.stop_reason === undefined) {
    repairs.push('missing stop_reason');
    out.stop_reason = 'end_turn';
  }
  if (out.stop_sequence === undefined) out.stop_sequence = null;
  if (!out.usage || typeof out.usage !== 'object') {
    repairs.push('missing usage');
    out.usage = { input_tokens: 0, output_tokens: 0 };
  }

  // Tool calls: fix the shape, and report anything the schema says is missing.
  let contentChanged = false;
  const content = out.content.map((block) => {
    const fixed = normalizeToolUse(block);
    if (fixed) {
      repairs.push(fixed.repair);
      contentChanged = true;
      return fixed.block;
    }
    return block;
  });
  if (contentChanged) out.content = content;

  for (const block of out.content) {
    const missing = missingRequiredParams(block, opts.tools);
    if (missing.length) {
      repairs.push(`${block.name}: model omitted required ${missing.join(', ')}`);
    }
  }

  return repairs.length ? { body: out, repairs } : null;
}
