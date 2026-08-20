import test from 'node:test';
import assert from 'node:assert/strict';
import { makeServer, TEST_TOKEN } from './helpers.js';
import { tokenMatches } from '../src/app.js';

test('auth', async (t) => {
  const s = await makeServer();

  await t.test('/health needs no bearer token', async () => {
    const res = await s.fetch('/health', { auth: false });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(
      { ok: body.ok, storage: body.storage, push: body.push },
      { ok: true, storage: 'local', push: 'console' },
    );
    assert.ok(typeof body.version === 'string');
  });

  await t.test('/v1 rejects a missing token with the contract envelope', async () => {
    const res = await s.fetch('/v1/devices', { auth: false });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.code, 'unauthorized');
    assert.ok(body.error.message.length > 0);
  });

  await t.test('/v1 rejects a wrong token', async () => {
    const res = await s.fetch('/v1/devices', {
      headers: { authorization: 'Bearer not-the-token' },
    });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'unauthorized');
  });

  await t.test('/v1 rejects a non-Bearer scheme', async () => {
    const res = await s.fetch('/v1/devices', {
      headers: { authorization: `Basic ${TEST_TOKEN}` },
    });
    assert.equal(res.status, 401);
  });

  await t.test('/v1 rejects a token that is a prefix of the real one', async () => {
    const res = await s.fetch('/v1/devices', {
      headers: { authorization: `Bearer ${TEST_TOKEN.slice(0, -1)}` },
    });
    assert.equal(res.status, 401);
  });

  await t.test('/v1 accepts the right token, case-insensitively on the scheme', async () => {
    const res = await s.fetch('/v1/devices', {
      headers: { authorization: `bearer ${TEST_TOKEN}` },
    });
    assert.equal(res.status, 200);
  });

  await t.test('every /v1 route is behind the middleware', async () => {
    const routes = [
      ['GET', '/v1/devices'],
      ['POST', '/v1/devices'],
      ['GET', '/v1/transfers'],
      ['POST', '/v1/transfers'],
      ['GET', '/v1/transfers/x'],
      ['GET', '/v1/transfers/x/blob'],
      ['DELETE', '/v1/transfers/x'],
      ['POST', '/v1/deliveries/x/ack'],
      ['GET', '/v1/events'],
    ];
    for (const [method, path] of routes) {
      const res = await s.fetch(path, { method, auth: false });
      assert.equal(res.status, 401, `${method} ${path} should be 401 without a token`);
    }
  });

  await t.test('tokenMatches is length-safe and exact', () => {
    assert.equal(tokenMatches('abc', 'abc'), true);
    assert.equal(tokenMatches('abc', 'abd'), false);
    assert.equal(tokenMatches('abc', 'ab'), false);
    assert.equal(tokenMatches('abc', 'abcd'), false);
    assert.equal(tokenMatches('abc', ''), false);
    assert.equal(tokenMatches('abc', null), false);
  });
});
