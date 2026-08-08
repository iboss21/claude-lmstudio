# claude-lmstudio

A local compatibility proxy that sits between **Claude Code** and **LM Studio**, so
Claude Code's real traffic stops getting rejected by LM Studio's Anthropic-compatible
`/v1/messages` endpoint.

Zero dependencies. Node 18+.

```
Claude Code  ──►  claude-lmstudio (:2140)  ──►  LM Studio (:1234)
```

---

## The bug this exists to fix

Claude Code dies mid-session with one of these:

```
API Error: 400 request.messages.461.content.0.content.0.type: Invalid literal value, expected "text"
API Error: 400 Only text tool_result blocks are supported when tool_result.content is an array.
```

Both are the **same rule**, worded differently by different LM Studio builds:

> When `tool_result.content` is an array, LM Studio only accepts blocks of type `"text"`.

Claude Code legitimately puts other block types in there. Two hit constantly:

**1. `tool_reference` — from deferred tool loading.** When Claude Code's `ToolSearch`
finds tools, it returns them as structured references:

```json
{ "type": "tool_result", "tool_use_id": "qcQ2…",
  "content": [ { "type": "tool_reference", "tool_name": "Write" },
               { "type": "tool_reference", "tool_name": "Edit"  },
               { "type": "tool_reference", "tool_name": "Grep"  },
               { "type": "tool_reference", "tool_name": "Bash"  } ] }
```

**2. `image` — from screenshot tools.** `Claude Browser: preview screenshot` returns
the PNG inside the `tool_result`.

Anthropic's Messages API defines both as valid there. LM Studio's schema does not
implement them — so LM Studio is the party out of spec, and Claude Code cannot be
configured around it.

### Why it looks like it "worked before, then broke forever"

`ToolSearch` only emits `tool_reference` blocks **when a search actually matches
something**. In one captured 463-message session:

| message | ToolSearch query | result content | LM Studio |
|---|---|---|---|
| 32, 92, 105 | no matches | `"No matching deferred tools found"` (plain string) | accepted |
| 460 | `select:Write,Edit,Grep,Bash` → **4 matches** | array of `tool_reference` blocks | **400** |

The session ran 460 messages fine because every earlier search came back empty. The
first one that *succeeded* poisoned the conversation — and because the block is now
part of history, **every retry replays it**. The session can never recover, and the
client keeps re-sending a 39k-token prompt into a local model at ~19 tok/s, which is
why it presents as a hang rather than a clean error.

---

## Quickstart

```bash
git clone https://github.com/iboss21/claude-lmstudio
cd claude-lmstudio
node bin/claude-lmstudio.js --upstream http://127.0.0.1:1234
```

Then point Claude Code at the proxy instead of LM Studio.

**Claude Code desktop:** Developer → Configure Third-Party Inference → base URL
`http://localhost:2140`.

**Claude Code CLI (PowerShell):**

```powershell
$env:ANTHROPIC_BASE_URL = "http://localhost:2140"
$env:ANTHROPIC_AUTH_TOKEN = "lm-studio"   # any non-empty value
claude
```

**Claude Code CLI (bash):**

```bash
export ANTHROPIC_BASE_URL=http://localhost:2140
export ANTHROPIC_AUTH_TOKEN=lm-studio
claude
```

If LM Studio is on a non-default port (the Developer tab shows it — often `1234`,
sometimes `2126`), pass `--upstream http://127.0.0.1:<port>`. On startup the proxy
probes the upstream and, if it is not there, tells you which port *is* answering.

Check it is alive:

```bash
curl http://localhost:2140/health
```

---

## What it does to each request

| Claude Code sends | LM Studio | claude-lmstudio |
|---|---|---|
| `tool_result.content` with `tool_reference` blocks | **400** | collapses to one text block: `Tools loaded: Write, Edit, Grep, Bash` |
| `tool_result.content` with an `image` block | **400** | moves the image out to the enclosing message, leaves a text marker — vision still works |
| `tool_result.content` with an unknown future block type | **400** | renders it to text rather than dropping it |
| `tool_result.content` as a plain string | fine | untouched |
| `tool_result.content` as an empty array | invalid | becomes `(no output)` |
| `tools[].input_schema` with `maxLength: 524288` | grammar compiler blows up | clamps bounds under llama.cpp's ~100k repetition limit |
| `tools[].defer_loading: true` | meaningless | stripped |
| `$schema: "…draft/2020-12/schema"` | can confuse the grammar converter | stripped |
| `role: "system"` inside `messages[]` | accepted on desktop 0.4.15+ | left alone by default (`--system-messages hoist` for headless `llmster`) |
| orphaned `tool_use` with no result | confuses the model | synthesizes a stub result |
| orphaned `tool_result` with no call | confuses the model | demotes it to text |
| `POST /v1/messages/count_tokens` | **not implemented** | answered locally with a real `{"input_tokens": N}` |
| streaming, minutes of silence during prompt processing | connection looks dead | injects SSE `ping` frames every 10s |

Every transformation is a no-op when there is nothing to do — a request that already
validates is forwarded byte-identical, so the proxy cannot cause its own bugs.

### Token counting matters more than it looks

LM Studio does not implement `/v1/messages/count_tokens`; unknown routes return
**HTTP 200 with a body that isn't an Anthropic response**. That is worse than a 404,
because the client cannot tell it failed. Claude Code drives auto-compaction off
those numbers, so a broken counter means the conversation never compacts and every
turn gets slower until the whole thing stalls.

The proxy answers `count_tokens` itself (with or without the `?beta=true` query the
official SDKs append) and **self-calibrates**: every completion returns a real
`usage.input_tokens`, which is compared against the estimate and folded into a moving
average. The estimate converges on the loaded GGUF's actual tokenizer within a few
turns. Watch it with `curl localhost:2140/health`.

### Self-healing

The rules above cover what is known today. For anything else, the proxy reads the
JSON path out of LM Studio's own validation error, walks to that exact node, coerces
it, and retries — so a new Claude Code block type degrades to text instead of wedging
the session. Turn it off with `--no-auto-repair`; see what it caught with
`--log-level debug` or `--dump-dir ./dumps`.

---

## Options

```
--host <addr>              Bind address                      (default 127.0.0.1)
--port <n>                 Port Claude Code connects to      (default 2140)
--upstream <url>           LM Studio server URL              (default http://127.0.0.1:1234)

--no-coerce-tool-results   Do not rewrite non-text blocks inside tool_result
--no-hoist-images          Drop images in tool_result instead of re-attaching them
--no-sanitize-tools        Do not clamp oversized JSON-schema bounds
--no-repair-tool-pairing   Do not synthesize missing tool_results
--system-messages <mode>   keep | user | hoist               (default keep)
--strict-params            Forward only core Anthropic params
--strip-cache-control      Remove cache_control from all blocks

--no-auto-repair           Do not retry after an upstream validation error
--max-repair-attempts <n>  Repair rounds per request         (default 3)

--count-tokens <mode>      local | upstream | passthrough    (default local)
--chars-per-token <n>      Estimator ratio                   (default 3.5)
--no-calibrate             Do not calibrate against real usage counts

--preload <model>          Load this model before the first request
--context-length <n>       Context window to load it with (Claude Code needs 25k+)
--num-experts <n>          Active experts for MoE models
--flash-attention          Enable flash attention
--eval-batch-size <n>      Prompt batch size
--api-token <token>        Bearer token for LM Studio's native REST API

--ping-interval <ms>       SSE keepalive interval, 0 disables (default 10000)
--log-level <level>        silent | error | warn | info | debug
--dump-dir <path>          Write failing requests here for inspection
```

Equivalent env vars: `CLAUDE_LMSTUDIO_UPSTREAM`, `CLAUDE_LMSTUDIO_PORT`,
`CLAUDE_LMSTUDIO_HOST`, `CLAUDE_LMSTUDIO_LOG_LEVEL`, `CLAUDE_LMSTUDIO_DUMP_DIR`,
`CLAUDE_LMSTUDIO_COUNT_TOKENS`, `CLAUDE_LMSTUDIO_CHARS_PER_TOKEN`,
`CLAUDE_LMSTUDIO_SYSTEM_MESSAGES`, `CLAUDE_LMSTUDIO_PING_INTERVAL`.

---

## Pre-warming the model

`/v1/messages` cannot set context length per request — it is a **load-time** property,
and LM Studio's default dropped to 8k in 0.4.16 Build 2 while a Claude Code session
needs well over 25k. Separately, JIT loading means the first request after an idle
period pays a full model load, which looks exactly like a timeout.

The proxy can load the model up front through LM Studio's native REST API:

```bash
node bin/claude-lmstudio.js \
  --preload regescore-1.0-35b \
  --context-length 32000 \
  --num-experts 4 \
  --flash-attention
```

It reports the context length LM Studio actually applied, warns if it is below 25k,
and warns again if a request's estimated size approaches the window — the failure
mode otherwise is silent truncation, which reads as the model ignoring instructions.
A failed preload is logged, never fatal.

---

## Why not LM Studio's native `/api/v1/chat`?

It looks like a cleaner target — it takes `context_length` per request and reports
real `stats.input_tokens`. It cannot work for Claude Code:

- **No client-supplied tool definitions.** `/api/v1/chat` only exposes tools via
  installed plugins and ephemeral MCP servers. Claude Code defines its own ~30 tools
  per request, and there is no field to put them in.
- **No conversation array.** `input` is a string or a flat list of text/image parts,
  with history threaded by `previous_response_id`. There is nowhere to replay an
  assistant turn carrying `tool_use`, or a user turn carrying `tool_result`.

So `/v1/messages` remains the only viable upstream, and the proxy uses `/api/v1` only
for model loading. LM Studio also documents **no tokenization endpoint at any prefix**,
which is why `count_tokens` is estimated and calibrated rather than computed exactly.

---

## Other things that break this setup

The proxy fixes protocol mismatches. These are LM Studio settings, and it cannot fix
them for you — check them if you still see stalls or truncated replies:

- **LM Studio Engine Protocol** (Settings → Developer). Defaulted to **on** in 0.4.19
  Build 2, and reported to break the Anthropic endpoint's agent loop for models with
  custom Jinja thinking templates — generation stops after ~50–60 tokens, which reads
  as a hang. If your model ships its own `<think>` template, try turning this **off**.
- **Context length and JIT loading.** Both are covered by `--preload` above, but if
  you would rather not use it: raise the model's context length in its load config
  (8k default since 0.4.16 Build 2, and Claude Code needs 25k+), and load the model
  before starting a session so the first request does not pay for it.
- **Grammar compilation.** LM Studio 0.4.20 has an open regression where converting
  Claude Code's ~30 tool schemas to BNF crashes llama.cpp's parser
  (`failed to parse grammar`). `--sanitize-tools` (on by default) addresses the
  oversized-bounds form of this; the schema-count form is upstream's to fix.

---

## Development

```bash
npm test          # 74 tests, no network, no LM Studio required
```

The suite runs the proxy against a fake LM Studio that enforces the real
`tool_result` rule and reproduces **both** of LM Studio's error strings, plus the
bogus `200` it returns for `count_tokens`. `test/fixtures/claude-code-request.json`
is reduced from a real captured Claude Code request, including the exact message that
wedged the session.

## License

MIT
