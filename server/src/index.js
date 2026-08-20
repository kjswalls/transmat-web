#!/usr/bin/env node
/**
 * Transmat API server — Weekend 0.
 *
 * Boots with zero cloud credentials: local blob storage, console push, SQLite
 * on disk. Prints the bearer token and the health URL so you can copy them
 * straight into a client.
 */
import { serve } from '@hono/node-server';
import { createServices } from './services.js';

const services = await createServices();
const { config, app } = services;

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  banner(config, info);
});

// A long SSE stream must not block a restart forever.
server.on?.('error', (err) => {
  if (err?.code === 'EADDRINUSE') {
    console.error(
      `\n[transmat] port ${config.port} is already in use.\n` +
        `           Stop the other process, or start with PORT=8788 npm run dev\n`,
    );
  } else {
    console.error('[transmat] server error:', err);
  }
  process.exitCode = 1;
  services.close().finally(() => process.exit(1));
});

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[transmat] ${signal} — shutting down`);
    services.events.closeAll();
    server.close(async () => {
      await services.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

function banner(config, info) {
  const base = config.publicBaseUrl;
  const rule = '─'.repeat(64);
  console.log(
    `\n${rule}\n` +
      `  Transmat API v${config.version}\n` +
      `${rule}\n` +
      `  listening   http://${info.address === '::' ? 'localhost' : info.address}:${info.port}\n` +
      `  health      ${base}/health\n` +
      `  storage     ${config.storageDriver}  (${config.storageDriver === 'local' ? config.blobDir : 'r2://' + config.r2.bucket})\n` +
      `  push        ${config.pushDriver}\n` +
      `  database    ${config.dbPath}\n` +
      `  env file    ${config.envFilePath ?? '(none)'}\n` +
      `${rule}\n` +
      `  TRANSMAT_TOKEN=${config.token}\n` +
      `${rule}\n` +
      `  Try it:\n` +
      `    curl ${base}/health\n` +
      `    curl -H "Authorization: Bearer ${config.token}" ${base}/v1/devices\n` +
      `${rule}\n`,
  );
}
