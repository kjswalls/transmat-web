import test from 'node:test';
import assert from 'node:assert/strict';
import { makeServer, registerDevice } from './helpers.js';

test('devices', async (t) => {
  const s = await makeServer();

  await t.test('POST /v1/devices returns the contract Device shape', async () => {
    const device = await registerDevice(s, {
      name: "Kirby's iPhone",
      platform: 'ios',
      push_token: 'token-aaa',
    });
    assert.deepEqual(Object.keys(device).sort(), [
      'created_at',
      'device_id',
      'has_push_token',
      'last_seen_at',
      'name',
      'platform',
      'push_channel',
    ]);
    assert.equal(device.push_channel, 'apns');
    assert.equal(device.has_push_token, true);
    assert.ok(!('push_token' in device), 'the raw push token must never be exposed');
  });

  await t.test('upsert on push_token is idempotent and updates the name', async () => {
    const first = await registerDevice(s, {
      name: 'Phone A',
      platform: 'ios',
      push_token: 'token-shared',
    });
    const second = await registerDevice(s, {
      name: 'Phone A renamed',
      platform: 'ios',
      push_token: 'token-shared',
    });
    assert.equal(second.device_id, first.device_id);
    assert.equal(second.name, 'Phone A renamed');
    assert.equal(second.created_at, first.created_at);
    assert.ok(second.last_seen_at >= first.last_seen_at);

    const { body } = await s.json('/v1/devices');
    assert.equal(body.devices.filter((d) => d.name.startsWith('Phone A')).length, 1);
  });

  await t.test('upsert on name+platform when no push_token is given', async () => {
    const a = await registerDevice(s, { name: 'MacBook', platform: 'cli' });
    const b = await registerDevice(s, { name: 'MacBook', platform: 'cli' });
    assert.equal(b.device_id, a.device_id);
    assert.equal(b.has_push_token, false);
    assert.equal(b.push_channel, 'none');

    const other = await registerDevice(s, { name: 'MacBook', platform: 'macos' });
    assert.notEqual(other.device_id, a.device_id, 'a different platform is a different device');
  });

  await t.test('different push tokens are different devices', async () => {
    const a = await registerDevice(s, { name: 'Twin', platform: 'ios', push_token: 't1' });
    const b = await registerDevice(s, { name: 'Twin', platform: 'ios', push_token: 't2' });
    assert.notEqual(a.device_id, b.device_id);
  });

  await t.test('an unknown platform is a 400', async () => {
    const { res, body } = await s.json('/v1/devices', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'X', platform: 'toaster' }),
    });
    assert.equal(res.status, 400);
    assert.equal(body.error.code, 'bad_request');
  });

  await t.test('a missing name is a 400', async () => {
    const { res, body } = await s.json('/v1/devices', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'ios' }),
    });
    assert.equal(res.status, 400);
    assert.equal(body.error.code, 'bad_request');
  });

  await t.test('malformed JSON is a 400, not a 500', async () => {
    const { res, body } = await s.json('/v1/devices', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(res.status, 400);
    assert.equal(body.error.code, 'bad_request');
  });

  await t.test('PATCH renames, DELETE removes, both 404 on an unknown id', async () => {
    const device = await registerDevice(s, { name: 'Old name', platform: 'web' });

    const patched = await s.json(`/v1/devices/${device.device_id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'New name' }),
    });
    assert.equal(patched.res.status, 200);
    assert.equal(patched.body.name, 'New name');

    const missing = await s.json('/v1/devices/nope', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    assert.equal(missing.res.status, 404);
    assert.equal(missing.body.error.code, 'not_found');

    const deleted = await s.json(`/v1/devices/${device.device_id}`, { method: 'DELETE' });
    assert.equal(deleted.res.status, 200);
    assert.deepEqual(deleted.body, { ok: true });

    const again = await s.json(`/v1/devices/${device.device_id}`, { method: 'DELETE' });
    assert.equal(again.res.status, 404);
  });
});
