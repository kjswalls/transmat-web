import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http2 from 'node:http2';
import { PassThrough } from 'node:stream';
import {
  buildPushPayload,
  formatBytes,
  signApnsJwt,
  createConsolePush,
  createApnsPush,
} from '../src/push.js';

test('push payload', async (t) => {
  await t.test('matches the contract shape for a file', () => {
    const payload = buildPushPayload(
      { id: 'tr_1', kind: 'file', file_name: 'report.pdf', size: 2516582, text: null },
      'dl_1',
      "Kirby's iPhone",
    );
    assert.deepEqual(payload, {
      aps: {
        alert: {
          title: 'report.pdf',
          subtitle: "from Kirby's iPhone",
          body: '2.4 MB · tap to receive',
        },
        sound: 'default',
        category: 'TRANSFER_ARRIVED',
        'mutable-content': 1,
        'thread-id': 'transmat',
      },
      transfer_id: 'tr_1',
      delivery_id: 'dl_1',
      kind: 'file',
      file_name: 'report.pdf',
      size: 2516582,
    });
  });

  await t.test('text and link transfers carry the payload in the body', () => {
    const text = buildPushPayload(
      { id: 't', kind: 'text', file_name: null, size: null, text: 'remember the milk' },
      'd',
      'Laptop',
    );
    assert.equal(text.aps.alert.title, 'Text');
    assert.equal(text.aps.alert.body, 'remember the milk');
    assert.equal(text.file_name, null);
    assert.equal(text.size, null);

    const link = buildPushPayload(
      { id: 't', kind: 'link', file_name: null, size: null, text: 'https://example.com' },
      'd',
      null,
    );
    assert.equal(link.aps.alert.title, 'A link');
    assert.equal(link.aps.alert.subtitle, 'from an unknown device');
  });

  await t.test('a long text payload is truncated, not sent whole', () => {
    const payload = buildPushPayload(
      { id: 't', kind: 'text', text: 'x'.repeat(5000), file_name: null, size: null },
      'd',
      'A',
    );
    assert.ok(payload.aps.alert.body.length <= 120);
  });

  await t.test('formatBytes reads like the contract example', () => {
    assert.equal(formatBytes(2516582), '2.4 MB');
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(1024), '1 KB');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(3 * 1024 ** 3), '3 GB');
  });
});

test('console push driver', async (t) => {
  await t.test('prints a readable push and reports ok', async () => {
    const out = new PassThrough();
    const chunks = [];
    out.on('data', (c) => chunks.push(c));
    const driver = createConsolePush({ out });
    assert.equal(driver.name, 'console');

    const result = await driver.send(
      { id: 'dev_1', name: 'Kirby iPhone', platform: 'ios', push_channel: 'apns', push_token: 'abcdef0123456789' },
      buildPushPayload(
        { id: 'tr_1', kind: 'file', file_name: 'report.pdf', size: 2516582, text: null },
        'dl_1',
        'Laptop',
      ),
    );
    assert.deepEqual(result, { ok: true });

    const printed = Buffer.concat(chunks).toString('utf8');
    assert.match(printed, /PUSH → Kirby iPhone \(ios\)/);
    assert.match(printed, /report\.pdf/);
    assert.match(printed, /from Laptop/);
    assert.match(printed, /2\.4 MB · tap to receive/);
    assert.match(printed, /transfer_id: tr_1/);
    assert.ok(!printed.includes('abcdef0123456789'), 'the raw token is masked');
  });
});

test('apns driver', async (t) => {
  // A real ES256 key, and a local h2c server standing in for api.push.apple.com.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transmat-apns-'));
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const keyPath = path.join(dir, 'AuthKey_TEST.p8');
  fs.writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));

  /** @type {{status:number, body:string}} */
  let reply = { status: 200, body: '' };
  /** @type {any[]} */
  const received = [];

  const server = http2.createServer();
  server.on('stream', (stream, headers) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => {
      received.push({ headers, body: Buffer.concat(chunks).toString('utf8') });
      stream.respond({ ':status': reply.status, 'apns-id': 'apns-id-1', 'content-type': 'application/json' });
      stream.end(reply.body);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const cleared = [];
  const fakeDb = { clearPushToken: (id) => cleared.push(id) };
  const config = {
    apns: {
      keyPath,
      keyId: 'KEY1234567',
      teamId: 'TEAM123456',
      bundleId: 'com.example.transmat',
      env: 'sandbox',
      host: `http://127.0.0.1:${port}`,
    },
  };
  const driver = createApnsPush(config, fakeDb);

  t.after(async () => {
    await driver.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const device = { id: 'dev_1', name: 'Phone', platform: 'ios', push_channel: 'apns', push_token: 'devicetoken123' };
  const payload = buildPushPayload(
    { id: 'tr_1', kind: 'file', file_name: 'a.pdf', size: 10, text: null },
    'dl_1',
    'Laptop',
  );

  await t.test('a 200 is a successful send, with the right headers and a valid JWT', async () => {
    reply = { status: 200, body: '' };
    const result = await driver.send(device, payload);
    assert.equal(result.ok, true);

    const req = received.at(-1);
    assert.equal(req.headers[':method'], 'POST');
    assert.equal(req.headers[':path'], '/3/device/devicetoken123');
    assert.equal(req.headers['apns-topic'], 'com.example.transmat');
    assert.equal(req.headers['apns-push-type'], 'alert');
    assert.equal(req.headers['apns-priority'], '10');
    assert.deepEqual(JSON.parse(req.body), payload);

    const [scheme, jwt] = req.headers.authorization.split(' ');
    assert.equal(scheme, 'bearer');
    const [h, p, sig] = jwt.split('.');
    assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString()), {
      alg: 'ES256',
      kid: 'KEY1234567',
      typ: 'JWT',
    });
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    assert.equal(claims.iss, 'TEAM123456');
    assert.ok(Math.abs(claims.iat - Math.floor(Date.now() / 1000)) < 60);
    const raw = Buffer.from(sig, 'base64url');
    assert.equal(raw.length, 64, 'APNs needs the raw r||s JOSE signature, not DER');
    assert.ok(
      crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, raw),
    );
  });

  await t.test('the JWT is cached across sends (Apple rate-limits minting)', async () => {
    reply = { status: 200, body: '' };
    const before = received.at(-1).headers.authorization;
    await driver.send(device, payload);
    assert.equal(received.at(-1).headers.authorization, before);
  });

  await t.test('a 410 clears the device push token', async () => {
    cleared.length = 0;
    reply = { status: 410, body: JSON.stringify({ reason: 'Unregistered' }) };
    const result = await driver.send(device, payload);
    assert.deepEqual(result, { ok: false, reason: 'unregistered' });
    assert.deepEqual(cleared, ['dev_1']);
  });

  await t.test('a 400 BadDeviceToken also clears the token', async () => {
    cleared.length = 0;
    reply = { status: 400, body: JSON.stringify({ reason: 'BadDeviceToken' }) };
    const result = await driver.send(device, payload);
    assert.deepEqual(result, { ok: false, reason: 'unregistered' });
    assert.deepEqual(cleared, ['dev_1']);
  });

  await t.test('other failures surface Apple’s reason and keep the token', async () => {
    cleared.length = 0;
    reply = { status: 429, body: JSON.stringify({ reason: 'TooManyRequests' }) };
    const result = await driver.send(device, payload);
    assert.deepEqual(result, { ok: false, reason: 'TooManyRequests' });
    assert.deepEqual(cleared, []);
  });

  await t.test('an expired provider token forces a fresh JWT on the next send', async () => {
    const stale = received.at(-1).headers.authorization;
    reply = { status: 403, body: JSON.stringify({ reason: 'ExpiredProviderToken' }) };
    const failed = await driver.send(device, payload);
    assert.deepEqual(failed, { ok: false, reason: 'ExpiredProviderToken' });

    reply = { status: 200, body: '' };
    await new Promise((r) => setTimeout(r, 1100)); // iat has 1s granularity
    await driver.send(device, payload);
    assert.notEqual(received.at(-1).headers.authorization, stale, 'a new JWT was minted');
  });

  await t.test('a device with no push token is refused without a network call', async () => {
    const count = received.length;
    const result = await driver.send({ ...device, push_token: null }, payload);
    assert.deepEqual(result, { ok: false, reason: 'no_push_token' });
    assert.equal(received.length, count);
  });

  await t.test('signApnsJwt is deterministic for a given iat', () => {
    const a = signApnsJwt(privateKey, 'K', 'T', 1700000000);
    const b = signApnsJwt(privateKey, 'K', 'T', 1700000000);
    assert.equal(a.split('.').slice(0, 2).join('.'), b.split('.').slice(0, 2).join('.'));
  });
});
