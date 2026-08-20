/**
 * Build a complete, wired application context. Shared by src/index.js and the
 * test suite so they exercise identical code.
 */
import fs from 'node:fs';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createStorage } from './storage.js';
import { createPush } from './push.js';
import { createEventHub } from './events.js';
import { createApp } from './app.js';
import { startSweep, runSweep } from './sweep.js';

/**
 * @param {Parameters<typeof loadConfig>[0] & {
 *   sweep?: boolean,
 *   quiet?: boolean,
 *   drivers?: {storage?: any, push?: any},
 * }} [options] `drivers` lets a caller (the test suite) substitute a storage
 *   or push implementation without changing how anything else is wired.
 */
export async function createServices(options = {}) {
  const config = loadConfig(options);
  fs.mkdirSync(config.dataDir, { recursive: true });

  const db = openDb(config.dbPath);
  const storage = options.drivers?.storage ?? (await createStorage(config));
  const push = options.drivers?.push ?? createPush(config, db);
  const events = createEventHub();

  const ctx = { config, db, storage, push, events };
  const app = createApp(ctx);

  let sweeper = null;
  if (options.sweep !== false) {
    sweeper = startSweep(ctx, { intervalMs: config.sweepIntervalMs, quiet: options.quiet });
  }

  return {
    ...ctx,
    app,
    sweeper,
    runSweep: (opts) => runSweep(ctx, opts),
    async close() {
      sweeper?.stop();
      events.closeAll();
      await push.close?.();
      db.close();
    },
  };
}

export default createServices;
