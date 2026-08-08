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

Both enforce the same rule:

> When `tool_result.content` is an array, LM Studio only accepts blocks of type `"text"`.

The prose form is quoted from LM Studio's own server log in their bug tracker
(0.4.12 and 0.4.15, both still open). The JSON-path form came out of a 0.4.20 server
log directly — but it has no other public LM Studio attestation, and the identical
string has been reported against Anthropic's own API, so treat the two as enforcing
one rule rather than as interchangeable LM Studio signatures.

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

This one is confirmed independently on LM Studio's own Discord, in an open thread
titled "Anthropic-compatible API support for images in `tool_result`" (30 July 2026),
reporting the same error verbatim and the same permanence:

> Currently using Claude Code, it looks like it is impossible for the model to read an
> image file on its own. […] If the model does attempt to read an image file, the
> entire conversation is bricked and can't be continued/appended to.

Note what that means for the client-side fix below: **no Claude Code setting turns
screenshots off.** If your workflow reads images, the config change alone will not
save you.

Anthropic's current Messages API schema lists `tool_reference` in the
`tool_result.content` union, and LM Studio implements a strictly narrower subset.

That is not the whole story, though, and the honest version matters because it
changes what you should do:

- Anthropic's own API rejected the identical block nine days after tool search went
  GA, and their tool-result page still enumerates only `text`, `image`, `document`
  and `search_result`. Two live Anthropic pages disagree with each other.
- Claude Code is **documented not to emit these blocks against a non-first-party
  base URL** — it "disables tool search when `ANTHROPIC_BASE_URL` points to a
  non-first-party host, since most proxies don't forward `tool_reference` blocks."
- Claude Code emitting them against a third-party gateway anyway is tracked as a
  Claude Code defect, whose own proposed fix is converting `tool_reference` blocks
  to text — which is what this proxy does.

So: **there is a client setting that stops this** (see the next section), and the
proxy exists for the cases that setting cannot reach.

### The `"text"` vs `"message"` confusion

There is a claim going around that the error comes from a typo — `"message"` written
where `"text"` belongs. That is not a typo in anyone's documentation, but the
confusion is real and it produces the identical error, because **LM Studio's two APIs
name the same thing differently**:

| | text part | field holding the text |
|---|---|---|
| LM Studio native `POST /api/v1/chat` | `"type": "message"` | `content` |
| Anthropic `POST /v1/messages` | `"type": "text"` | `text` |

Code written against `/api/v1/chat` and pointed at `/v1/messages` therefore emits
`{"type": "message", "content": "…"}` and gets back `Invalid literal value, expected
"text"` — the same string, with no `tool_reference` and no image involved. The proxy
renders that shape into a proper text block rather than JSON-dumping it, so a mixed-up
client still works.

It is **not** what happened in the captured session here: that block was a
`tool_reference`, read directly out of the request body in LM Studio's log.

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

The longer-range version of "it used to work": Claude Code **2.1.69** moved the
built-in tools (Bash, Read, Edit, Write, Glob, Grep, Agent…) behind ToolSearch.
Before that, only MCP tools were deferred, so a local session with no MCP servers
never produced a `tool_reference` block at all. The four tools in the failing
message are all built-ins — no MCP involved.

---

## Fix the `tool_reference` error without any proxy

**Set `toolSearchEnabled` back to `false`.** On Claude Desktop third-party
inference this key defaults to `false`, so if you are seeing `tool_reference`
blocks, it was turned on. Anthropic's configuration reference describes it as:

> Load MCP tool schemas on demand (tool search) instead of inlining every schema
> into context. Defaults to `false`.

and documents that enabling it *"causes sessions to send experimental
`anthropic-beta` request headers to your inference endpoint"* and *"re-enables
other experimental Claude Code betas (like `context_management`) on 3P
deployments"* — because Claude Desktop **pins
`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` by default on 3P deployments**, and
`toolSearchEnabled` lifts that suppression.

Turning it off therefore removes three things at once: the `tool_reference`
blocks, the `defer_loading` tool field, and the `context_management` body field.

On the CLI the equivalents are leaving `ENABLE_TOOL_SEARCH` unset, or setting
`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`.

### What that does not fix

- **A session that is already wedged.** The Messages API is stateless — every turn
  re-posts the whole conversation, so a block written into the transcript is replayed
  forever. Turning tool search off stops *new* blocks being written; it cannot remove
  one already there. Either start a fresh conversation, or put the proxy in front,
  which rewrites the entire history on every request.
- **Images in `tool_result`.** Screenshot tools are not tool search, and no client
  setting stops them.
- **`count_tokens`.** Still answered by LM Studio with a bogus `200`.
- **The 300-second stream watchdog.** Still aborts on long prompt-processing pauses.

### Raise your context window before you do this

Turning tool search off means all ~30 tool schemas load upfront on every request —
roughly **14–16k tokens of context instead of ~1k**. LM Studio's default context
length has been 8k since 0.4.16 Build 2, so on a default setup this trades one hard
failure for another.

**Load the model with at least 77k context.** That figure is from running this setup,
not from arithmetic: Claude Code's system prompt, the upfront tool schemas, and a
working conversation do not fit in less. 32k is not enough. `--preload` below sets it,
or set it in the model's load config and reload.

If you only ever hit the `tool_reference` error and your context window is large
enough, the config change is the whole fix and you can stop reading here.

---

## Quickstart

```bash
git clone https://github.com/iboss21/claude-lmstudio
cd claude-lmstudio
node bin/claude-lmstudio.js --upstream http://127.0.0.1:1234
```

Then point Claude Code at the proxy instead of LM Studio. **The two surfaces are
configured differently — they are not interchangeable.**

**Claude Code desktop (3P).** Environment variables are *not* read for inference on
this surface, so `ANTHROPIC_BASE_URL` does nothing. Use Help → Troubleshooting →
Enable Developer Mode → Developer → Configure Third-Party Inference, which writes:

```
inferenceProvider:       gateway
inferenceGatewayBaseUrl: http://localhost:2140
inferenceGatewayApiKey:  lm-studio          # placeholder; LM Studio has no auth
inferenceGatewayAuthScheme: bearer
inferenceModels:         <your full model id>
```

Set `inferenceModels` explicitly so the app skips model discovery — an unreachable
or slow `/v1/models` delays launch by up to 10 seconds.

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
| `tools[].defer_loading: true` | meaningless | stripped, together with its paired `anthropic-beta` value |
| `$schema: "…draft/2020-12/schema"` | can confuse the grammar converter | stripped |
| `role: "system"` inside `messages[]` | accepted on desktop 0.4.15+ | left alone by default (`--system-messages hoist` for headless `llmster`) |
| orphaned `tool_use` with no result | confuses the model | synthesizes a stub result |
| orphaned `tool_result` with no call | confuses the model | demotes it to text |
| `POST /v1/messages/count_tokens` | **not implemented** | answered locally with a real `{"input_tokens": N}` |
| streaming, minutes of silence during prompt processing | connection looks dead, client aborts at 300s | commits the stream after 20s of upstream silence and pings every 10s |
| a response stream that stops early | Claude Code waits forever for `message_stop` | closes open blocks and completes the envelope |
| a response missing `stop_reason` / `usage` / `id` | wrong accounting, unrecognized turn | filled in |
| `tool_use.input` arriving as a JSON string | tool receives a string and rejects it | parsed into an object |

Every transformation is a no-op when there is nothing to do, so a request that already
validates passes through semantically unchanged. It is not *byte*-identical: the body
is parsed and re-serialized on every request, which normalizes key order and
whitespace. That is deliberate — LM Studio's prefix cache keys on the rendered prompt,
not the raw bytes — but it does mean the proxy is in the path of every request, not
only broken ones.

**Upstream errors are forwarded verbatim.** Anthropic's gateway protocol reference
warns that *"the retry logic matches on the upstream's error wording, so forward error
response bodies unmodified. A gateway that wraps upstream errors in its own envelope
breaks the recovery path even when it preserves the status code."* Claude Code uses
that path to recover from rejections of `thinking`, thinking signatures, and
mid-conversation system messages — which is why those survived in the captured
session. There is a test asserting the error body arrives byte-identical.

`defer_loading` is stripped by default because LM Studio receives every tool
definition anyway. The same reference notes that beta body fields pair with beta
headers and that splitting a pair can cause `400`s, so `--no-strip-defer-loading`
forwards it untouched if you need the pairing intact.

### Token counting matters more than it looks

The endpoint is genuinely optional — Anthropic's gateway protocol reference says
*"Token-counting endpoints are the only optional ones: when they're absent, Claude
Code estimates context usage locally."* So a clean `404` would be fine.

What is not fine is what LM Studio actually does: it answers unknown routes with
**HTTP 200 and a body that isn't an Anthropic response**. The client cannot tell that
failed, so it never falls back to local estimation.

The same reference also says *"Inference requests post to `/v1/messages?beta=true`,
so match on the path, not the full URL."* The proxy routes on the parsed pathname and
answers `count_tokens` in both forms, then **self-calibrates**: every completion
returns a real `usage.input_tokens`, which is compared against the estimate and folded
into a moving average, converging on the loaded GGUF's tokenizer within a few turns.
Watch it with `curl localhost:2140/health`.

### Why the SSE pings matter

From Anthropic's gateway protocol reference:

> Claude Code counts every byte your gateway relays, including SSE `ping` events and
> comment lines, and aborts a stream that goes silent for 300 seconds by default. The
> upstream's pings are the only traffic during long thinking pauses, so if your
> gateway strips or buffers them, Claude Code aborts the stream during those pauses.

A local model ingesting a large agent context can go quiet for longer than 300s.
Pings every 10s keep the byte counter moving. The same page requires that responses
stream rather than buffer, which is why the proxy relays chunks straight through and
only ever inserts a ping at an event boundary.

The subtle part is *when* pinging can start. A proxy can only relay pings once the
upstream has flushed its own response headers — so if LM Studio withholds them until
the first generated token, nothing reaches the client during ingestion and the
watchdog fires anyway. LM Studio's log prints `Streaming response…` ahead of
`Prompt processing progress: 0.0%`, which suggests it flushes early, but a log line
is not proof that headers hit the socket.

So the proxy does not rely on it. After `--early-ping-after` milliseconds of upstream
silence (default 20000) it commits to the SSE response itself and starts pinging.
The delay is what keeps this safe: LM Studio returns validation errors in
milliseconds, so real `400`s still reach Claude Code as proper HTTP errors with their
status and wording intact, and only a genuinely slow request is ever converted into a
committed stream. If upstream then fails, the error is delivered as an SSE `error`
event carrying the upstream's exact message. `--early-ping-after 0` disables it.

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
--no-strip-defer-loading   Forward the defer_loading tool field unchanged
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
--context-length <n>       Context window to load it with (Claude Code needs 77k+)
--num-experts <n>          Active experts for MoE models
--flash-attention          Enable flash attention
--eval-batch-size <n>      Prompt batch size
--max-output-tokens <n>    Clamp max_tokens (Claude Code sends 32000 by default)
--api-token <token>        Bearer token for LM Studio's native REST API

--ping-interval <ms>       SSE keepalive interval, 0 disables (default 10000)
--early-ping-after <ms>    Commit the stream and ping after this much upstream
                           silence, 0 disables               (default 20000)
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
needs 77k or more in practice. Separately, JIT loading means the first request after an idle
period pays a full model load, which looks exactly like a timeout.

The proxy can load the model up front through LM Studio's native REST API:

```bash
node bin/claude-lmstudio.js \
  --preload regescore-1.0-35b \
  --context-length 77000 \
  --num-experts 4 \
  --flash-attention
```

It reports the context length LM Studio actually applied, warns if it is below 77k,
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

## Upstream status

Neither side has shipped a fix, and both trackers have open, unanswered reports. This
is the evidence behind treating a local fix as the fix rather than a stopgap.

**Anthropic / Claude Code**

| Issue | What it reports | State |
|---|---|---|
| [#77928](https://github.com/anthropics/claude-code/issues/77928) | `tool_reference` injected into history breaks a third-party backend's template rendering — same mechanism, vLLM instead of LM Studio | open, no maintainer response |
| [#64311](https://github.com/anthropics/claude-code/issues/64311) | tool-search deferral bypassed, schemas re-injected every turn | open, stale |
| [#63436](https://github.com/anthropics/claude-code/issues/63436) | raw tool schemas forwarded, producing a 400 | closed, not planned |

Nothing in that set is marked fixed.

**LM Studio**

| Issue | What it reports | State |
|---|---|---|
| [#1878](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1878) | "Only text tool_result blocks are supported…" with Claude Code | open |
| [#1590](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1590) | 400 with an image attachment from Claude Code | open |
| [#1755](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1755) | server 500 when the Messages API is called with image content | open |
| [#2164](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/2164) | 0.4.19 Build 2 regression: `/v1/messages` tool calling breaks for Qwen models with custom thinking templates | open |
| Discord thread | images in `tool_result`, "the entire conversation is bricked" | open |

That last LM Studio issue is worth checking against your own setup — a Qwen-derived
model with a custom Jinja thinking template is exactly its blast radius.

One thing *was* fixed: Claude Code
[#39906](https://github.com/anthropics/claude-code/issues/39906), "Cannot Handle API
Requests >5 Minutes Long", is closed as completed. The client-side half of the
long-request problem is handled; the keepalive here covers the gateway half.

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
  (8k default since 0.4.16 Build 2, and Claude Code needs 77k+), and load the model
  before starting a session so the first request does not pay for it.
- **Grammar compilation.** LM Studio 0.4.20 has an open regression where converting
  Claude Code's ~30 tool schemas to BNF crashes llama.cpp's parser
  (`failed to parse grammar`). `--sanitize-tools` (on by default) addresses the
  oversized-bounds form of this; the schema-count form is upstream's to fix.

---

## The chat template matters too

LM Studio accepting a request only gets you to the model. The **chat template** then
has to render it, and a template that raises on an unrecognized block turns a
recoverable turn into a dead session — the request fails, the block stays in history,
and every retry raises again. That is the same permanence as the validator bug, one
layer down. It is exactly the failure in Claude Code
[#77928](https://github.com/anthropics/claude-code/issues/77928):
`jinja2 TemplateError: Unexpected item type in content`.

`templates/claude-code-fable5.jinja` is a template built for this traffic. Its one
structural rule is that **it never calls `raise_exception`** — unknown blocks render
as readable text and the conversation continues.

Check any template, including your own, with:

```bash
python3 tools/verify-template.py templates/claude-code-fable5.jinja
```

It renders the template against every shape Claude Code actually produces and reports
two things separately, because they fail differently:

- **hard failure** — `raise_exception` fired; the session cannot recover
- **silent drop** — it rendered, but content the model was sent never reached it

The second is the one that hides. Mid-conversation system messages are the usual
casualty: a template that only merges `messages[0]` and `messages[1]` drops every
later one, and the captured session carried **46 of them**.

---

## Development

```bash
npm test          # 127 tests, no network, no LM Studio required
```

The suite runs the proxy against a fake LM Studio that enforces the real
`tool_result` rule and reproduces **both** of LM Studio's error strings, plus the
bogus `200` it returns for `count_tokens`. `test/fixtures/claude-code-request.json`
is reduced from a real captured Claude Code request, including the exact message that
wedged the session.

## License

MIT
