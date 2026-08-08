#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { resolveConfig, HELP } from '../src/config.js';
import { createServer, probeUpstream } from '../src/server.js';
import { preloadModel } from '../src/preload.js';
import { log } from '../src/logger.js';

const here = dirname(fileURLToPath(import.meta.url));

function version() {
  try {
    return JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

let config;
try {
  config = resolveConfig(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`claude-lmstudio: ${err.message}\n${HELP}`);
  process.exit(2);
}

if (config.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (config.version) {
  process.stdout.write(`${version()}\n`);
  process.exit(0);
}

const server = createServer(config);

server.listen(config.port, config.host, async () => {
  const url = `http://${config.host}:${config.port}`;
  log.info(`claude-lmstudio ${version()} listening on ${url}`);
  log.info(`forwarding to LM Studio at ${config.upstream}`);
  log.info(`point Claude Code's base URL at ${url}`);

  const probe = await probeUpstream(config);
  if (probe.ok) {
    log.info('upstream reachable');
    const loaded = await preloadModel(config);
    // Warn against the window the model really has, not the one we asked for.
    if (loaded?.context_length) config.contextLength = loaded.context_length;
  } else if (probe.suggestion) {
    log.warn(
      `no LM Studio server answered at ${config.upstream}, but one is running at ${probe.suggestion} — ` +
        `restart with --upstream ${probe.suggestion}`
    );
  } else {
    log.warn(
      `no LM Studio server answered at ${config.upstream}. Start the server ` +
        `(LM Studio -> Developer -> Status: Running) or pass --upstream <url>.`
    );
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log.error(`port ${config.port} is already in use — pass --port <n> to pick another`);
  } else {
    log.error(err.message);
  }
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log.info('shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
