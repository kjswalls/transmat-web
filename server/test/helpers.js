/**
 * Test harness: a real server (real SQLite file, real local storage driver)
 * against a throwaway data directory, with the push driver swapped for a
 * recorder so assertions can see exactly what would have been sent.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { serve } from '@hono/node-server';
import { createServices } from '../src/services.js';

export const TEST_TOKEN = 'test-token-0123456789';

/** A PushDriver that records instead of printing. */
export function createRecordingPush() {
  /** @type {Array<{device:any, payload:any}>} */
  const sent = [];
  return {
    name: 'console',
    sent,
    ok: true,
    async send(device, payload) {
      sent.push({ device, payload });
      return this.ok ? { ok: true } : { ok: false, reason: 'test_failure' };
    },
    async close() {},
  };
}

/**
 * @param {{overrides?:Record<string,string>, push?:any, sweep?:boolean, drivers?:{storage?:any, push?:any}}} [options]
 *   `drivers.storage` swaps the storage implementation — how the r2 tests run
 *   the whole HTTP surface against a local S3.
 */
export async function makeServer(options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transmat-test-'));
  const push = options.push ?? createRecordingPush();

  const services = await createServices({
    quiet: true,
    sweep: options.sweep ?? false,
    drivers: { ...(options.drivers ?? {}), push },
    overrides: {
      TRANSMAT_TOKEN: TEST_TOKEN,
      DATA_DIR: dataDir,
      DB_PATH: path.join(dataDir, 'test.db'),
      STORAGE_DRIVER: 'local',
      PUSH_DRIVER: 'console',
      LOG_REQUESTS: 'false',
      // Off by default: most tests hammer endpoints from one address and would
      // trip the limiter. test/ratelimit.test.js turns it back on explicitly.
      RATE_LIMIT: 'false',
      PUBLIC_BASE_URL: 'http://localhost:8787',
      ...options.overrides,
    },
  });

  const harness = {
    ...services,
    push,
    dataDir,
    /** Authenticated fetch against the app, no socket involved. */
    fetch(pathname, init = {}) {
      const headers = new Headers(init.headers ?? {});
      if (!headers.has('authorization') && init.auth !== false) {
        headers.set('authorization', `Bearer ${TEST_TOKEN}`);
      }
      return services.app.fetch(
        new Request(new URL(pathname, 'http://localhost:8787'), { ...init, headers }),
      );
    },
    async json(pathname, init) {
      const res = await harness.fetch(pathname, init);
      return { res, body: await res.json().catch(() => null) };
    },
    async cleanup() {
      await services.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };

  after(() => harness.cleanup());
  return harness;
}

/** Same, but bound to a real TCP listener — for SSE and streamed uploads. */
export async function makeListeningServer(options = {}) {
  const harness = await makeServer(options);
  const server = serve({ fetch: harness.app.fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise((resolve) => {
    if (server.listening) resolve();
    else server.once('listening', resolve);
  });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  after(
    () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  );

  return { ...harness, server, port, base, url: (p) => `${base}${p}` };
}

/** POST /v1/devices, returning the created Device. */
export async function registerDevice(harness, body) {
  const { res, body: device } = await harness.json('/v1/devices', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status !== 200) throw new Error(`device registration failed: ${JSON.stringify(device)}`);
  return device;
}

/** Build a multipart body as a Buffer (small fixtures only). */
export function multipart(parts, boundary = '----transmatTest' + Date.now()) {
  const chunks = [];
  for (const part of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"`;
    if (part.filename != null) head += `; filename="${part.filename}"`;
    head += '\r\n';
    if (part.contentType) head += `Content-Type: ${part.contentType}\r\n`;
    head += '\r\n';
    chunks.push(Buffer.from(head, 'utf8'));
    chunks.push(Buffer.isBuffer(part.value) ? part.value : Buffer.from(String(part.value), 'utf8'));
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** POST a multipart transfer through the in-process app. */
export function postMultipart(harness, parts) {
  const { body, contentType } = multipart(parts);
  return harness.json('/v1/transfers', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
  });
}
