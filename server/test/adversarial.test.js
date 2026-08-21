/**
 * Adversarial review suite.
 *
 * Every test here started life as an attack on the shipped server. The ones
 * that failed the first time are marked "REGRESSION:" — they demonstrate a bug
 * that was found and then fixed. The rest are attacks that the server already
 * withstood, kept so they cannot regress.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { serve } from '@hono/node-server';
import { createServices } from '../src/services.js';
import { createLocalStorage, signBlob } from '../src/storage.js';
import { makeServer, makeListeningServer, registerDevice, multipart, TEST_TOKEN } from './helpers.js';

/* -------------------------------------------------------------------------- */
/* 1. auth surface                                                            */
/* -------------------------------------------------------------------------- */

test('adversarial — auth cannot be walked around', async (t) => {
  const s = await makeListeningServer();
  const hit = (p, init) => fetch(s.url(p), init);

  await t.test('every /v1 route 401s without a bearer', async () => {
    const routes = [
      ['GET', '/v1/devices'],
      ['POST', '/v1/devices'],
      ['PATCH', '/v1/devices/x'],
      ['DELETE', '/v1/devices/x'],
      ['GET', '/v1/transfers'],
      ['POST', '/v1/transfers'],
      ['GET', '/v1/transfers/x'],
      ['GET', '/v1/transfers/x/blob'],
      ['DELETE', '/v1/transfers/x'],
      ['POST', '/v1/deliveries/x/ack'],
      ['GET', '/v1/events'],
      ['GET', '/v1/nope'],
      ['GET', '/v1/transfers/x/blob/deeper'],
    ];
    for (const [method, p] of routes) {
      const res = await hit(p, { method });
      const body = await res.json().catch(() => ({}));
      assert.equal(res.status, 401, `${method} ${p} -> ${res.status}`);
      assert.equal(body.error?.code, 'unauthorized', `${method} ${p}`);
    }
  });

  await t.test('path tricks do not skip the middleware', async () => {
    for (const p of ['/v1//devices', '/v1/./devices', '/v1/%2e/devices', '/v1/devices/', '/v1/devices%2f']) {
      const res = await hit(p);
      await res.body?.cancel();
      assert.ok(res.status === 401 || res.status === 404, `${p} -> ${res.status}`);
    }
  });

  await t.test('a token that is a prefix, suffix or wrong length is rejected', async () => {
    const bad = [
      TEST_TOKEN.slice(0, -1),
      TEST_TOKEN + 'x',
      TEST_TOKEN.toUpperCase(),
      '',
      ' ',
      'Bearer ' + TEST_TOKEN,
    ];
    for (const token of bad) {
      const res = await hit('/v1/devices', { headers: { authorization: `Bearer ${token}` } });
      await res.body?.cancel();
      assert.equal(res.status, 401, JSON.stringify(token));
    }
  });

  await t.test('/health stays open, and leaks no token', async () => {
    const res = await hit('/health');
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(body).sort(), ['ok', 'push', 'storage', 'version']);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. blob signing + traversal                                                */
/* -------------------------------------------------------------------------- */

test('adversarial — blob signatures cannot be forged or replayed', async (t) => {
  const s = await makeListeningServer();
  await registerDevice(s, { name: 'Phone', platform: 'ios' });

  const form = multipart([
    { name: 'file', filename: 'secret.bin', value: Buffer.from('classified'), contentType: 'application/octet-stream' },
    { name: 'to', value: 'all' },
  ]);
  const created = await (
    await fetch(s.url('/v1/transfers'), {
      method: 'POST',
      headers: { authorization: `Bearer ${TEST_TOKEN}`, 'content-type': form.contentType },
      body: form.body,
    })
  ).json();
  const transferId = created.transfer.transfer_id;

  const redirect = await fetch(s.url(`/v1/transfers/${transferId}/blob`), {
    headers: { authorization: `Bearer ${TEST_TOKEN}` },
    redirect: 'manual',
  });
  await redirect.body?.cancel();
  const signed = new URL(redirect.headers.get('location'));
  const key = signed.pathname.split('/').pop();
  const local = (p) => fetch(s.url(p));

  await t.test('the honest URL works and needs no bearer', async () => {
    const res = await local(signed.pathname + signed.search);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'classified');
  });

  await t.test('a signature made with a guessed secret is rejected', async () => {
    const exp = Math.floor(Date.now() / 1000) + 300;
    for (const guess of ['', 'secret', 'test-token-0123456789 ', 'TEST-TOKEN-0123456789']) {
      const sig = signBlob(guess, key, exp);
      const res = await local(`/blob/${key}?exp=${exp}&sig=${sig}`);
      const body = await res.json();
      assert.equal(res.status, 403, `guess ${JSON.stringify(guess)}`);
      assert.equal(body.error.code, 'signature_invalid');
    }
  });

  await t.test('exp cannot be extended without re-signing', async () => {
    const res = await local(`${signed.pathname}?exp=99999999999&sig=${signed.searchParams.get('sig')}`);
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, 'signature_invalid');
  });

  await t.test('a validly signed but past exp is 410 expired, not 200', async () => {
    const exp = Math.floor(Date.now() / 1000) - 5;
    const sig = signBlob(TEST_TOKEN, key, exp);
    const res = await local(`/blob/${key}?exp=${exp}&sig=${sig}`);
    assert.equal(res.status, 410);
    assert.equal((await res.json()).error.code, 'expired');
  });

  await t.test('a signature for one key does not open another', async () => {
    const other = 'a'.repeat(32);
    const res = await local(`/blob/${other}?exp=${signed.searchParams.get('exp')}&sig=${signed.searchParams.get('sig')}`);
    assert.equal(res.status, 403);
    await res.body?.cancel();
  });

  await t.test('traversal keys never escape DATA_DIR', async () => {
    const exp = Math.floor(Date.now() / 1000) + 300;
    const keys = [
      '..%2f..%2ftest.db',
      '%2e%2e%2f%2e%2e%2ftest.db',
      '..%2ftest.db',
      '....%2f%2ftest.db',
      '%2e%2e%5ctest.db',
      'a%00.txt',
      '.',
      '..',
    ];
    for (const k of keys) {
      // Sign whatever the server will decode, so only the path check can save us.
      const decoded = decodeURIComponent(k);
      const res = await local(`/blob/${k}?exp=${exp}&sig=${signBlob(TEST_TOKEN, decoded, exp)}`);
      await res.body?.cancel();
      assert.ok(res.status === 403 || res.status === 404, `${k} -> ${res.status}`);
    }
    // ...and the database really is next to the blob dir, so the target existed.
    assert.ok(fs.existsSync(path.join(s.dataDir, 'test.db')));
  });
});

/* -------------------------------------------------------------------------- */
/* 3. REGRESSION: request bodies were unbounded on the device routes          */
/* -------------------------------------------------------------------------- */

test('adversarial — REGRESSION: JSON routes cap the request body', async (t) => {
  const s = await makeListeningServer();

  /** Stream `bytes` of junk JSON at a route without ever holding it locally. */
  async function flood(pathname, method, bytes) {
    const chunk = Buffer.alloc(64 * 1024, 0x41);
    let sent = 0;
    const body = new ReadableStream({
      async pull(controller) {
        if (sent === 0) controller.enqueue(Buffer.from('{"platform":"ios","name":"'));
        if (sent >= bytes) {
          controller.enqueue(Buffer.from('"}'));
          controller.close();
          return;
        }
        controller.enqueue(chunk);
        sent += chunk.length;
      },
    });
    try {
      const res = await fetch(s.url(pathname), {
        method,
        headers: { authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json' },
        body,
        duplex: 'half',
      });
      const parsed = await res.json().catch(() => null);
      return { status: res.status, code: parsed?.error?.code ?? null, sent };
    } catch (err) {
      // A reset mid-upload is an acceptable way to refuse; a 200 is not.
      return { status: 'reset', err: String(err.message), sent };
    }
  }

  await t.test('POST /v1/devices refuses a 32 MB body with 413', async () => {
    const out = await flood('/v1/devices', 'POST', 32 * 1024 * 1024);
    assert.notEqual(out.status, 200, `server accepted a 32MB device body (code=${out.code})`);
    if (out.status !== 'reset') assert.equal(out.status, 413, `status=${out.status} code=${out.code}`);
    const list = await (await fetch(s.url('/v1/devices'), { headers: { authorization: `Bearer ${TEST_TOKEN}` } })).json();
    assert.deepEqual(list.devices, [], 'no device should have been created');
  });

  await t.test('PATCH /v1/devices/:id refuses a 32 MB body', async () => {
    const dev = await registerDevice(s, { name: 'Phone', platform: 'ios' });
    const out = await flood(`/v1/devices/${dev.device_id}`, 'PATCH', 32 * 1024 * 1024);
    assert.notEqual(out.status, 200, `status=${out.status} code=${out.code}`);
  });

  await t.test('an absurd device name is a 400, not a multi-hundred-MB row', async () => {
    const { res, body } = await s.json('/v1/devices', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'A'.repeat(5000), platform: 'ios' }),
    });
    assert.equal(res.status, 400);
    assert.equal(body.error.code, 'bad_request');
  });

  await t.test('an absurd push_token is a 400', async () => {
    const { res, body } = await s.json('/v1/devices', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Phone', platform: 'ios', push_token: 'f'.repeat(4000) }),
    });
    assert.equal(res.status, 400);
    assert.equal(body.error.code, 'bad_request');
  });

  await t.test('a normal device body still works', async () => {
    const dev = await registerDevice(s, { name: 'Normal', platform: 'cli' });
    assert.equal(dev.name, 'Normal');
  });
});

/* -------------------------------------------------------------------------- */
/* 4. REGRESSION: SSE dropped its CORS headers                                */
/* -------------------------------------------------------------------------- */

test('adversarial — REGRESSION: SSE is reachable from a browser origin', async (t) => {
  const s = await makeListeningServer();
  const origin = 'http://localhost:5173';

  await t.test('GET /v1/events echoes Access-Control-Allow-Origin', async () => {
    const ac = new AbortController();
    const res = await fetch(s.url(`/v1/events?access_token=${TEST_TOKEN}`), {
      headers: { origin },
      signal: ac.signal,
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    assert.equal(
      res.headers.get('access-control-allow-origin'),
      origin,
      'EventSource cannot read a cross-origin stream without this header',
    );
    ac.abort();
  });

  await t.test('a plain JSON route already did this', async () => {
    const res = await fetch(s.url('/v1/devices'), {
      headers: { origin, authorization: `Bearer ${TEST_TOKEN}` },
    });
    await res.json();
    assert.equal(res.headers.get('access-control-allow-origin'), origin);
  });

  await t.test('the stream still works and still tears down', async () => {
    const settle = async (target) => {
      for (let i = 0; i < 60 && s.events.size !== target; i += 1) await sleep(25);
      return s.events.size;
    };
    assert.equal(await settle(0), 0);
    const sock = net.connect(s.port, '127.0.0.1');
    await new Promise((r) => sock.once('connect', r));
    sock.write(`GET /v1/events HTTP/1.1\r\nHost: x\r\nOrigin: ${origin}\r\nAuthorization: Bearer ${TEST_TOKEN}\r\n\r\n`);
    const seen = await new Promise((r) => sock.once('data', (d) => r(d.toString())));
    assert.match(seen, /^HTTP\/1\.1 200/);
    assert.match(seen, new RegExp(`access-control-allow-origin: ${origin}`, 'i'));
    assert.equal(await settle(1), 1);
    sock.destroy(); // hard kill, no HTTP-level close
    assert.equal(await settle(0), 0, 'a destroyed socket must release its keepalive interval');
  });
});

/* -------------------------------------------------------------------------- */
/* 5. REGRESSION: malformed multipart 500s                                    */
/* -------------------------------------------------------------------------- */

test('adversarial — REGRESSION: hostile bodies are 4xx, never 500', async (t) => {
  const s = await makeServer();
  await registerDevice(s, { name: 'Phone', platform: 'ios' });

  const cases = [
    ['multipart content-type with no body at all', { 'content-type': 'multipart/form-data; boundary=zz' }, undefined],
    ['multipart with no boundary', { 'content-type': 'multipart/form-data' }, 'junk'],
    ['a JSON body sent as multipart', { 'content-type': 'multipart/form-data; boundary=zz' }, '{"text":"hi","to":"all"}'],
    ['a truncated multipart body', { 'content-type': 'multipart/form-data; boundary=zz' }, '--zz\r\nContent-Disposition: form-data; name="file"; filename="a"\r\n\r\nAAA'],
    ['an empty multipart body', { 'content-type': 'multipart/form-data; boundary=zz' }, ''],
    ['a JSON array', { 'content-type': 'application/json' }, '[1,2,3]'],
    ['JSON null', { 'content-type': 'application/json' }, 'null'],
    ['broken JSON', { 'content-type': 'application/json' }, '{oops'],
    ['an unsupported content-type', { 'content-type': 'text/plain' }, 'hello'],
  ];

  for (const [label, headers, body] of cases) {
    await t.test(label, async () => {
      const { res, body: parsed } = await s.json('/v1/transfers', { method: 'POST', headers, body });
      assert.ok(res.status >= 400 && res.status < 500, `${label} -> ${res.status}`);
      assert.ok(
        ['bad_request', 'no_targets', 'too_large'].includes(parsed.error.code),
        `${label} -> ${JSON.stringify(parsed)}`,
      );
    });
  }

  await t.test('the server is still healthy afterwards', async () => {
    const res = await s.fetch('/health');
    assert.equal(res.status, 200);
  });
});

/* -------------------------------------------------------------------------- */
/* 6. REGRESSION: LIKE search could not find a literal % or _                  */
/* -------------------------------------------------------------------------- */

test('adversarial — REGRESSION: ?q= is escaped, not injectable', async (t) => {
  const s = await makeServer();
  await registerDevice(s, { name: 'Phone', platform: 'ios' });
  const post = (text) =>
    s.json('/v1/transfers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, to: 'all' }),
    });
  await post('one hundred %percent');
  await post('snake_case name');
  await post('back\\slash here');
  await post('plain text');

  const search = async (q) => {
    const { res, body } = await s.json(`/v1/transfers?q=${encodeURIComponent(q)}`);
    assert.equal(res.status, 200);
    return body.transfers.map((tr) => tr.text).sort();
  };

  await t.test('a literal % matches only the row containing it', async () => {
    assert.deepEqual(await search('%percent'), ['one hundred %percent']);
  });
  await t.test('a literal _ is not a single-char wildcard', async () => {
    assert.deepEqual(await search('snake_case'), ['snake_case name']);
    assert.deepEqual(await search('snakeXcase'), []);
  });
  await t.test('a backslash is matched literally', async () => {
    assert.deepEqual(await search('back\\slash'), ['back\\slash here']);
    assert.deepEqual(await search('\\'), ['back\\slash here']);
  });
  await t.test('quotes and SQL fragments find nothing and change nothing', async () => {
    assert.deepEqual(await search("' OR 1=1 --"), []);
    assert.deepEqual(await search("'; DROP TABLE transfers; --"), []);
    const { body } = await s.json('/v1/transfers');
    assert.equal(body.transfers.length, 4, 'the table survived');
  });
});

/* -------------------------------------------------------------------------- */
/* 7. REGRESSION: expiry sweep racing a download                              */
/* -------------------------------------------------------------------------- */

test('adversarial — REGRESSION: a download survives the sweep deleting the file', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transmat-race-'));
  const blobDir = path.join(dataDir, 'blobs');
  const base = createLocalStorage({ blobDir, blobSigningSecret: TEST_TOKEN, publicBaseUrl: 'http://127.0.0.1:1' });

  /** Simulates the sweep winning: the bytes vanish the instant we open them. */
  let sabotage = 'off';
  const storage = {
    name: 'local',
    put: (...a) => base.put(...a),
    signedUrl: (...a) => base.signedUrl(...a),
    delete: (...a) => base.delete(...a),
    stat: (...a) => base.stat(...a),
    createReadStream: (...a) => base.createReadStream(...a),
    async open(key, ...rest) {
      if (sabotage === 'before') await base.delete(key);
      const handle = await base.open(key, ...rest);
      if (sabotage === 'after') await base.delete(key);
      return handle;
    },
  };

  const services = await createServices({
    quiet: true,
    sweep: false,
    drivers: { storage, push: { name: 'console', async send() { return { ok: true }; }, async close() {} } },
    overrides: {
      TRANSMAT_TOKEN: TEST_TOKEN,
      DATA_DIR: dataDir,
      DB_PATH: path.join(dataDir, 'race.db'),
      LOG_REQUESTS: 'false',
      PUBLIC_BASE_URL: 'http://127.0.0.1:1',
    },
  });
  const server = serve({ fetch: services.app.fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  t.after(async () => {
    server.close();
    await services.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const H = { authorization: `Bearer ${TEST_TOKEN}` };
  await fetch(`http://127.0.0.1:${port}/v1/devices`, {
    method: 'POST',
    headers: { ...H, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Phone', platform: 'ios' }),
  });
  const payload = Buffer.alloc(300_000, 9);
  const form = multipart([
    { name: 'file', filename: 'big.bin', value: payload },
    { name: 'to', value: 'all' },
  ]);
  const created = await (
    await fetch(`http://127.0.0.1:${port}/v1/transfers`, {
      method: 'POST',
      headers: { ...H, 'content-type': form.contentType },
      body: form.body,
    })
  ).json();
  const redirect = await fetch(`http://127.0.0.1:${port}/v1/transfers/${created.transfer.transfer_id}/blob`, {
    headers: H,
    redirect: 'manual',
  });
  await redirect.body?.cancel();
  const signed = new URL(redirect.headers.get('location'));
  const blobUrl = `http://127.0.0.1:${port}${signed.pathname}${signed.search}`;

  await t.test('deleted after the fd is open: the full body still arrives', async () => {
    sabotage = 'after';
    const res = await fetch(blobUrl);
    assert.equal(res.status, 200);
    const got = Buffer.from(await res.arrayBuffer());
    assert.equal(got.length, payload.length, 'a half-written 200 is the bug');
    assert.ok(got.equals(payload));
    sabotage = 'off';
  });

  await t.test('deleted before we open: a clean 404, not a truncated 200', async () => {
    sabotage = 'before';
    // Put the bytes back so only the sabotage removes them.
    await base.put(signed.pathname.split('/').pop(), Readable.from([payload]), {});
    const res = await fetch(blobUrl);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, 'not_found');
    sabotage = 'off';
  });

  await t.test('the server survived both', async () => {
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
  });
});

/* -------------------------------------------------------------------------- */
/* 8. target resolution                                                       */
/* -------------------------------------------------------------------------- */

test('adversarial — target resolution corner cases', async (t) => {
  const s = await makeServer();

  await t.test('all with zero devices is a 400 no_targets', async () => {
    const { res, body } = await s.json('/v1/transfers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x', to: 'all' }),
    });
    assert.equal(res.status, 400);
    assert.equal(body.error.code, 'no_targets');
  });

  const a = await registerDevice(s, { name: 'A', platform: 'ios' });
  const b = await registerDevice(s, { name: 'B', platform: 'macos' });
  const post = (payload) =>
    s.json('/v1/transfers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x', ...payload }),
    });

  await t.test('others with an unknown from falls back to all', async () => {
    const { res, body } = await post({ to: 'others', from: 'not-a-device' });
    assert.equal(res.status, 200);
    assert.equal(body.transfer.deliveries.length, 2);
    assert.equal(body.transfer.from_device_id, null);
  });

  await t.test('others with no from at all falls back to all', async () => {
    const { body } = await post({ to: 'others' });
    assert.equal(body.transfer.deliveries.length, 2);
  });

  await t.test('others with a known from excludes only the sender', async () => {
    const { body } = await post({ to: 'others', from: a.device_id });
    assert.deepEqual(body.transfer.deliveries.map((d) => d.device_id), [b.device_id]);
    assert.equal(body.transfer.from_device_id, a.device_id);
  });

  await t.test('a duplicated device id yields exactly one delivery', async () => {
    const { body } = await post({ to: [a.device_id, a.device_id, a.device_id] });
    assert.equal(body.transfer.deliveries.length, 1);
  });

  await t.test('all + others + an explicit id still yields one delivery per device', async () => {
    const { body } = await post({ to: ['all', 'others', a.device_id, b.device_id], from: a.device_id });
    assert.equal(body.transfer.deliveries.length, 2);
    assert.equal(new Set(body.transfer.deliveries.map((d) => d.device_id)).size, 2);
  });

  await t.test('an unknown device id on its own is a 400 no_targets', async () => {
    const { res, body } = await post({ to: 'ffffffff-0000-0000-0000-000000000000' });
    assert.equal(res.status, 400);
    assert.equal(body.error.code, 'no_targets');
  });

  await t.test('a non-string to is refused rather than fanned out', async () => {
    const { res, body } = await post({ to: { evil: true } });
    assert.equal(res.status, 400);
    assert.equal(body.error.code, 'no_targets');
  });

  await t.test('others where the sender is the only device is a 400', async () => {
    const solo = await makeServer();
    const only = await registerDevice(solo, { name: 'Solo', platform: 'cli' });
    const { res, body } = await solo.json('/v1/transfers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x', to: 'others', from: only.device_id }),
    });
    assert.equal(res.status, 400);
    assert.equal(body.error.code, 'no_targets');
  });
});

/* -------------------------------------------------------------------------- */
/* 9. streaming caps really do abort mid-stream                               */
/* -------------------------------------------------------------------------- */

test('adversarial — the file cap trips during the stream, not after it', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transmat-cap-'));
  const blobDir = path.join(dataDir, 'blobs');
  const base = createLocalStorage({ blobDir, blobSigningSecret: TEST_TOKEN, publicBaseUrl: 'http://127.0.0.1:1' });
  const CAP = 64 * 1024;
  let bytesReachingStorage = 0;

  const storage = {
    ...base,
    name: 'local',
    async put(key, body, meta = {}) {
      async function* count(src) {
        for await (const chunk of src) {
          bytesReachingStorage += chunk.length;
          yield chunk;
        }
      }
      return base.put(key, Readable.from(count(body)), { ...meta, maxBytes: CAP });
    },
  };

  const services = await createServices({
    quiet: true,
    sweep: false,
    drivers: { storage, push: { name: 'console', async send() { return { ok: true }; }, async close() {} } },
    overrides: {
      TRANSMAT_TOKEN: TEST_TOKEN,
      DATA_DIR: dataDir,
      DB_PATH: path.join(dataDir, 'cap.db'),
      LOG_REQUESTS: 'false',
      PUBLIC_BASE_URL: 'http://127.0.0.1:1',
    },
  });
  const server = serve({ fetch: services.app.fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  t.after(async () => {
    server.close();
    await services.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  await fetch(`http://127.0.0.1:${port}/v1/devices`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Phone', platform: 'ios' }),
  });

  const TOTAL = 64 * 1024 * 1024;
  const BOUNDARY = '----transmatCapProbe';
  const head =
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="to"\r\n\r\nall\r\n` +
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="huge.bin"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n`;
  const tail = `\r\n--${BOUNDARY}--\r\n`;

  let bytesWritten = 0;
  let response = '';
  const sock = net.connect(port, '127.0.0.1');
  sock.on('error', () => {}); // an EPIPE here IS the server hanging up early
  await new Promise((r) => sock.once('connect', r));
  const responded = new Promise((resolve) => sock.on('data', (d) => { response += d.toString('latin1'); resolve(); }));
  sock.write(
    `POST /v1/transfers HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${TEST_TOKEN}\r\n` +
      `Content-Type: multipart/form-data; boundary=${BOUNDARY}\r\n` +
      `Content-Length: ${Buffer.byteLength(head) + TOTAL + Buffer.byteLength(tail)}\r\nConnection: close\r\n\r\n`,
  );
  sock.write(head);
  const chunk = Buffer.alloc(64 * 1024, 0x41);
  let done = false;
  const stop = () => { done = true; };
  responded.then(stop);
  sock.on('error', stop);
  sock.on('close', stop);

  /** Push the body until the server answers or hangs up. Never block forever. */
  const pump = (async () => {
    for (let i = 0; i < TOTAL / chunk.length && !done; i += 1) {
      if (sock.destroyed || sock.writableEnded) break;
      const flushed = sock.write(chunk);
      bytesWritten += chunk.length;
      if (!flushed) {
        await new Promise((r) => {
          const go = () => r();
          sock.once('drain', go);
          sock.once('error', go);
          sock.once('close', go);
          setTimeout(go, 2000);
        });
      }
    }
  })();

  await Promise.race([responded, sleep(20000)]);
  stop();
  await Promise.race([pump, sleep(2000)]);
  await sleep(200);
  sock.destroy();

  await t.test('the server answered 413 too_large', () => {
    // Only when the response survived the teardown. Answering mid-body means
    // the server hangs up while the client is still writing, and EPIPE can
    // beat the 'data' event carrying the reply — inherent to early-answering,
    // not a defect. The two assertions below prove the streaming behaviour
    // deterministically, and presigned-attack.test.js asserts the 413 itself
    // over a normal fetch where reading it is race-free. Measured: the
    // response survives roughly five runs in six.
    if (!response) return;
    assert.match(response.split('\r\n')[0], /^HTTP\/1\.1 413/, response.slice(0, 200));
    assert.match(response, /"code":"too_large"/);
  });
  await t.test('storage saw only a hair over the cap, not the whole body', () => {
    assert.ok(
      bytesReachingStorage < CAP * 8,
      `storage swallowed ${bytesReachingStorage} bytes for a ${CAP}-byte cap — that is buffering, not streaming`,
    );
  });
  await t.test('the client never had to finish sending', () => {
    assert.ok(bytesWritten < TOTAL / 2, `client pushed ${bytesWritten} of ${TOTAL} before being refused`);
  });
  await t.test('no blob and no .part file was left behind', () => {
    assert.deepEqual(fs.readdirSync(blobDir), []);
  });
});

/* -------------------------------------------------------------------------- */
/* 10. cleanup + lifecycle races                                              */
/* -------------------------------------------------------------------------- */

test('adversarial — no orphaned bytes, no zombie state', async (t) => {
  const s = await makeServer();
  const blobDir = path.join(s.dataDir, 'blobs');
  const phone = await registerDevice(s, { name: 'Phone', platform: 'ios' });

  await t.test('a file whose targets do not resolve leaves no blob', async () => {
    const form = multipart([
      { name: 'file', filename: 'a.bin', value: Buffer.alloc(4096, 1) },
      { name: 'to', value: 'nobody-at-all' },
    ]);
    const { res, body } = await s.json('/v1/transfers', {
      method: 'POST',
      headers: { 'content-type': form.contentType },
      body: form.body,
    });
    assert.equal(res.status, 400);
    assert.equal(body.error.code, 'no_targets');
    assert.deepEqual(fs.readdirSync(blobDir), []);
  });

  await t.test('kind=text with a file part is refused and leaves no blob', async () => {
    const form = multipart([
      { name: 'file', filename: 'a.bin', value: Buffer.alloc(4096, 1) },
      { name: 'kind', value: 'text' },
      { name: 'text', value: 'hello' },
      { name: 'to', value: 'all' },
    ]);
    const { res } = await s.json('/v1/transfers', {
      method: 'POST',
      headers: { 'content-type': form.contentType },
      body: form.body,
    });
    assert.equal(res.status, 400);
    assert.deepEqual(fs.readdirSync(blobDir), []);
  });

  await t.test('revoke then ack: the ack still succeeds and stays consistent', async () => {
    const form = multipart([
      { name: 'file', filename: 'b.bin', value: Buffer.alloc(2048, 2) },
      { name: 'to', value: 'all' },
    ]);
    const { body } = await s.json('/v1/transfers', {
      method: 'POST',
      headers: { 'content-type': form.contentType },
      body: form.body,
    });
    const tr = body.transfer;
    const [revoke, ack] = await Promise.all([
      s.json(`/v1/transfers/${tr.transfer_id}`, { method: 'DELETE' }),
      s.json(`/v1/deliveries/${tr.deliveries[0].delivery_id}/ack`, { method: 'POST' }),
    ]);
    assert.equal(revoke.res.status, 200);
    assert.equal(ack.res.status, 200);
    const after = (await s.json(`/v1/transfers/${tr.transfer_id}`)).body.transfer;
    assert.equal(after.state, 'revoked');
    assert.equal(after.deliveries[0].state, 'downloaded');
    assert.deepEqual(fs.readdirSync(blobDir), [], 'revoke must remove the bytes');
    const blob = await s.fetch(`/v1/transfers/${tr.transfer_id}/blob`);
    assert.equal(blob.status, 410);
    assert.equal((await blob.json()).error.code, 'revoked');
  });

  await t.test('acking a delivery that does not exist is a 404', async () => {
    const res = await s.fetch('/v1/deliveries/nope/ack', { method: 'POST' });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, 'not_found');
  });

  await t.test('deleting a device cascades its deliveries away', async () => {
    const { body } = await s.json('/v1/transfers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'bye', to: 'all', from: phone.device_id }),
    });
    assert.equal(body.transfer.deliveries.length, 1);
    await s.json(`/v1/devices/${phone.device_id}`, { method: 'DELETE' });
    const after = (await s.json(`/v1/transfers/${body.transfer.transfer_id}`)).body.transfer;
    assert.equal(after.deliveries.length, 0);
    assert.equal(after.from_device_id, null);
  });
});

/* -------------------------------------------------------------------------- */
/* 11. concurrency                                                            */
/* -------------------------------------------------------------------------- */

test('adversarial — concurrent writers do not duplicate rows', async (t) => {
  const s = await makeListeningServer();
  const H = { authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json' };

  await t.test('16 simultaneous upserts of one push_token make one device', async () => {
    const bodies = await Promise.all(
      Array.from({ length: 16 }, () =>
        fetch(s.url('/v1/devices'), {
          method: 'POST',
          headers: H,
          body: JSON.stringify({ name: 'Racer', platform: 'ios', push_token: 'RACE-TOKEN' }),
        }).then((r) => r.json()),
      ),
    );
    assert.equal(new Set(bodies.map((b) => b.device_id)).size, 1, JSON.stringify(bodies.slice(0, 3)));
    const list = await (await fetch(s.url('/v1/devices'), { headers: H })).json();
    assert.equal(list.devices.length, 1);
  });

  await t.test('16 simultaneous upserts on name+platform make one device', async () => {
    await Promise.all(
      Array.from({ length: 16 }, () =>
        fetch(s.url('/v1/devices'), {
          method: 'POST',
          headers: H,
          body: JSON.stringify({ name: 'NoToken', platform: 'macos' }),
        }).then((r) => r.json()),
      ),
    );
    const list = await (await fetch(s.url('/v1/devices'), { headers: H })).json();
    assert.equal(list.devices.filter((d) => d.name === 'NoToken').length, 1);
  });

  await t.test('parallel transfers to the same device never duplicate a delivery', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        fetch(s.url('/v1/transfers'), {
          method: 'POST',
          headers: H,
          body: JSON.stringify({ text: `p${i}`, to: 'all' }),
        }).then((r) => r.json()),
      ),
    );
    for (const r of results) {
      assert.equal(r.transfer.deliveries.length, 2, JSON.stringify(r));
      assert.equal(new Set(r.transfer.deliveries.map((d) => d.device_id)).size, 2);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 12. REGRESSION: push_channel drifted away from has_push_token              */
/* -------------------------------------------------------------------------- */

test('adversarial — REGRESSION: a device never claims "none" while it holds a token', async (t) => {
  const s = await makeServer();

  await t.test('re-registering without a token keeps the token AND the channel', async () => {
    const first = await registerDevice(s, { name: 'Zed', platform: 'macos', push_token: 'zedtok' });
    assert.equal(first.push_channel, 'apns');
    assert.equal(first.has_push_token, true);

    const second = await registerDevice(s, { name: 'Zed', platform: 'macos' });
    assert.equal(second.device_id, first.device_id, 'must be the same device');
    assert.equal(second.has_push_token, true, 'the token must survive');
    assert.equal(
      second.push_channel,
      'apns',
      'a device that still holds a push token cannot report push_channel="none"',
    );
  });

  await t.test('a device that never had a token stays on "none"', async () => {
    const dev = await registerDevice(s, { name: 'Silent', platform: 'cli' });
    assert.equal(dev.push_channel, 'none');
    assert.equal(dev.has_push_token, false);
  });

  await t.test('an explicit push_channel still wins', async () => {
    const dev = await registerDevice(s, {
      name: 'Explicit',
      platform: 'ios',
      push_token: 'exptok',
      push_channel: 'none',
    });
    assert.equal(dev.push_channel, 'none');
  });

  await t.test('the listing agrees with the upsert response', async () => {
    const { body } = await s.json('/v1/devices');
    for (const d of body.devices) {
      if (d.push_channel === 'apns') assert.equal(d.has_push_token, true, JSON.stringify(d));
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 13. an SSE client that stops reading is dropped, not buffered forever      */
/* -------------------------------------------------------------------------- */

test('adversarial — a non-reading SSE client cannot grow the process', async (t) => {
  const s = await makeListeningServer();
  const phone = await registerDevice(s, { name: 'Phone', platform: 'ios' });

  const sock = net.connect(s.port, '127.0.0.1');
  await new Promise((r) => sock.once('connect', r));
  sock.write(`GET /v1/events HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${TEST_TOKEN}\r\n\r\n`);
  await new Promise((r) => sock.once('data', r));
  sock.pause(); // stop reading, but keep the socket open
  for (let i = 0; i < 60 && s.events.size !== 1; i += 1) await sleep(25);
  assert.equal(s.events.size, 1);

  // ~60 KB of SSE per event; enough of them to bury the 8 MB backlog ceiling
  // even after the kernel's own send/receive buffers have soaked up their fill.
  const blob = 'x'.repeat(60 * 1024);
  for (let i = 0; i < 800 && s.events.size === 1; i += 1) {
    await fetch(s.url('/v1/transfers'), {
      method: 'POST',
      headers: { authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: blob, to: phone.device_id }),
    }).then((r) => r.json());
  }

  await t.test('the stuck subscriber was released', async () => {
    for (let i = 0; i < 80 && s.events.size !== 0; i += 1) await sleep(25);
    assert.equal(s.events.size, 0, 'a client that never reads must be dropped, not buffered');
  });

  await t.test('the server still serves everyone else', async () => {
    const res = await fetch(s.url('/health'));
    assert.equal(res.status, 200);
  });

  sock.destroy();
});
