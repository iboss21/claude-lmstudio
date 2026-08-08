import { DEFAULT_LIMITS } from './normalize/tools.js';
import { DEFAULT_CHARS_PER_TOKEN } from './tokenizer.js';

export const DEFAULTS = {
  host: '127.0.0.1',
  port: 2140,
  upstream: 'http://127.0.0.1:1234',
  pingIntervalMs: 10_000,
  // Commit to the SSE response after this long without upstream headers, so prompt
  // ingestion cannot look like a dead connection. 0 disables.
  earlyPingAfterMs: 20_000,
  logLevel: 'info',
  dumpDir: null,
  autoRepair: true,
  maxRepairAttempts: 3,
  countTokens: 'local', // local | upstream | passthrough
  charsPerToken: DEFAULT_CHARS_PER_TOKEN,
  calibrate: true,
  systemMessages: 'keep',
  strictParams: false,
  stripCacheControl: false,
  coerceToolResults: true,
  hoistImages: true,
  sanitizeTools: true,
  stripDeferLoading: true,
  repairToolPairing: true,
  maxStringLength: DEFAULT_LIMITS.maxStringLength,
  maxNumber: DEFAULT_LIMITS.maxNumber,
  maxItems: DEFAULT_LIMITS.maxItems,
  // Model pre-warming through LM Studio's native REST API.
  preload: null,
  contextLength: null,
  flashAttention: null,
  numExperts: null,
  evalBatchSize: null,
  apiToken: null,
  // Clamp Claude Code's 32000 default for unrecognized model IDs.
  maxOutputTokens: null,
};

/** Ports LM Studio is commonly served on, probed when the configured upstream is down. */
export const COMMON_UPSTREAM_PORTS = [1234, 2126, 8080, 11434];

const NUMERIC = new Set([
  'port',
  'pingIntervalMs',
  'earlyPingAfterMs',
  'maxRepairAttempts',
  'charsPerToken',
  'maxStringLength',
  'maxNumber',
  'maxItems',
  'contextLength',
  'numExperts',
  'evalBatchSize',
  'maxOutputTokens',
]);

const BOOLEAN = new Set([
  'autoRepair',
  'calibrate',
  'strictParams',
  'stripCacheControl',
  'coerceToolResults',
  'hoistImages',
  'sanitizeTools',
  'stripDeferLoading',
  'repairToolPairing',
  'flashAttention',
]);

const ENV_MAP = {
  CLAUDE_LMSTUDIO_HOST: 'host',
  CLAUDE_LMSTUDIO_PORT: 'port',
  CLAUDE_LMSTUDIO_UPSTREAM: 'upstream',
  CLAUDE_LMSTUDIO_PING_INTERVAL: 'pingIntervalMs',
  CLAUDE_LMSTUDIO_EARLY_PING_AFTER: 'earlyPingAfterMs',
  CLAUDE_LMSTUDIO_LOG_LEVEL: 'logLevel',
  CLAUDE_LMSTUDIO_DUMP_DIR: 'dumpDir',
  CLAUDE_LMSTUDIO_COUNT_TOKENS: 'countTokens',
  CLAUDE_LMSTUDIO_CHARS_PER_TOKEN: 'charsPerToken',
  CLAUDE_LMSTUDIO_SYSTEM_MESSAGES: 'systemMessages',
  CLAUDE_LMSTUDIO_PRELOAD: 'preload',
  CLAUDE_LMSTUDIO_CONTEXT_LENGTH: 'contextLength',
  CLAUDE_LMSTUDIO_API_TOKEN: 'apiToken',
};

/**
 * Flags whose CLI spelling differs from the config key, because the key carries a unit
 * suffix that would be noise on the command line.
 */
const FLAG_ALIASES = {
  pingInterval: 'pingIntervalMs',
  earlyPingAfter: 'earlyPingAfterMs',
};

function camel(flag) {
  const key = flag.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  return FLAG_ALIASES[key] ?? key;
}

function coerce(key, value) {
  if (NUMERIC.has(key)) {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`--${key} expects a number, got "${value}"`);
    return n;
  }
  if (BOOLEAN.has(key)) {
    if (value === true || value === 'true' || value === '1') return true;
    if (value === false || value === 'false' || value === '0') return false;
    throw new Error(`--${key} expects a boolean, got "${value}"`);
  }
  return value;
}

/**
 * Resolve configuration from defaults, then environment, then CLI flags.
 * Supports `--flag value`, `--flag=value`, and `--no-flag` for booleans.
 */
export function resolveConfig(argv = [], env = process.env) {
  const config = { ...DEFAULTS };

  for (const [envKey, key] of Object.entries(ENV_MAP)) {
    if (env[envKey] != null && env[envKey] !== '') config[key] = coerce(key, env[envKey]);
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;

    const eq = arg.indexOf('=');
    let flag = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    let value = eq === -1 ? undefined : arg.slice(eq + 1);

    if (flag.startsWith('no-')) {
      const key = camel(flag.slice(3));
      if (!(key in DEFAULTS)) throw new Error(`unknown option --${flag}`);
      config[key] = false;
      continue;
    }

    const key = camel(flag);
    if (key === 'help' || key === 'version') {
      config[key] = true;
      continue;
    }
    if (!(key in DEFAULTS)) throw new Error(`unknown option --${flag}`);

    if (value === undefined) {
      if (BOOLEAN.has(key) && (argv[i + 1] === undefined || argv[i + 1].startsWith('--'))) {
        config[key] = true;
        continue;
      }
      value = argv[++i];
      if (value === undefined) throw new Error(`--${flag} expects a value`);
    }

    config[key] = coerce(key, value);
  }

  const COUNT_TOKEN_MODES = ['local', 'upstream', 'passthrough'];
  if (!COUNT_TOKEN_MODES.includes(config.countTokens)) {
    throw new Error(
      `--count-tokens expects one of ${COUNT_TOKEN_MODES.join(' | ')}, got "${config.countTokens}"`
    );
  }
  const SYSTEM_MESSAGE_MODES = ['keep', 'user', 'hoist'];
  if (!SYSTEM_MESSAGE_MODES.includes(config.systemMessages)) {
    throw new Error(
      `--system-messages expects one of ${SYSTEM_MESSAGE_MODES.join(' | ')}, got "${config.systemMessages}"`
    );
  }

  if (!/^https?:\/\//.test(config.upstream)) config.upstream = `http://${config.upstream}`;
  config.upstream = config.upstream.replace(/\/+$/, '');

  return config;
}

/** The subset of config the request normalizer cares about. */
export function normalizerOptions(config) {
  return {
    coerceToolResults: config.coerceToolResults,
    hoistImages: config.hoistImages,
    sanitizeTools: config.sanitizeTools,
    stripDeferLoading: config.stripDeferLoading,
    stripSchemaDialect: true,
    systemMessages: config.systemMessages,
    repairToolPairing: config.repairToolPairing,
    mergeAdjacent: true,
    dropEmpty: true,
    stripCacheControl: config.stripCacheControl,
    maxOutputTokens: config.maxOutputTokens,
    strictParams: config.strictParams,
    limits: {
      maxStringLength: config.maxStringLength,
      maxNumber: config.maxNumber,
      maxItems: config.maxItems,
    },
  };
}

export const HELP = `
claude-lmstudio — compatibility proxy between Claude Code and LM Studio

  Usage: claude-lmstudio [options]

  Connection
    --host <addr>              Bind address                     (default 127.0.0.1)
    --port <n>                 Port Claude Code connects to      (default 2140)
    --upstream <url>           LM Studio server URL              (default http://127.0.0.1:1234)

  Request rewriting
    --no-coerce-tool-results   Do not rewrite non-text blocks inside tool_result
    --no-hoist-images          Drop images in tool_result instead of re-attaching them
    --no-sanitize-tools        Do not clamp oversized JSON-schema bounds
    --no-strip-defer-loading   Forward the defer_loading tool field unchanged
    --no-repair-tool-pairing   Do not synthesize missing tool_results
    --system-messages <mode>   keep | user | hoist               (default keep)
    --strict-params            Forward only core Anthropic params
    --strip-cache-control      Remove cache_control from all blocks

  Recovery
    --no-auto-repair           Do not retry after an upstream validation error
    --max-repair-attempts <n>  Repair rounds per request         (default 3)

  Token counting
    --count-tokens <mode>      local | upstream | passthrough    (default local)
    --chars-per-token <n>      Estimator ratio                   (default 3.5)
    --no-calibrate             Do not calibrate against real usage counts

  Model pre-warming (LM Studio native REST API)
    --preload <model>          Load this model before the first request
    --context-length <n>       Context window to load it with (Claude Code needs 25k+)
    --num-experts <n>          Active experts for MoE models
    --flash-attention          Enable flash attention
    --eval-batch-size <n>      Prompt batch size
    --max-output-tokens <n>    Clamp max_tokens (Claude Code sends 32000 by default)
    --api-token <token>        Bearer token for LM Studio's native REST API

  Diagnostics
    --ping-interval <ms>       SSE keepalive interval, 0 disables (default 10000)
    --early-ping-after <ms>    Commit the stream and ping after this much upstream
                               silence, 0 disables                (default 20000)
    --log-level <level>        silent | error | warn | info | debug
    --dump-dir <path>          Write failing requests here for inspection
    --help                     Show this message
`;
