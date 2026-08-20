import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeServer, registerDevice, postMultipart } from './helpers.js';

const jsonPost = (s, body) =>
  s.json('/v1/transfers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('transfers — targeting', async (t) => {
  const s = await makeServer();
  const phone = await registerDevice(s, { name: 'Phone', platform: 'ios', push_token: 'p1' });
  const laptop = await registerDevice(s, { name: 'Laptop', platform: 'cli' });
  const tablet = await registerDevice(s, { name: 'Tablet', platform: 'ios', push_token: 'p2' });

  await t.test('default target is "others" — everyone but the sender', async () => {
    const { res, body } = await jsonPost(s, { text: 'hello', from: laptop.device_id });
    assert.equal(res.status, 200);
    const ids = body.transfer.deliveries.map((d) => d.device_id).sort();
    assert.deepEqual(ids, [phone.device_id, tablet.device_id].sort());
    assert.equal(body.transfer.from_device_id, laptop.device_id);
    assert.equal(body.transfer.from_device_name, 'Laptop');
  });

  await t.test('to=all includes the sender', async () => {
    const { body } = await jsonPost(s, { text: 'hello', from: laptop.device_id, to: 'all' });
    const ids = body.transfer.deliveries.map((d) => d.device_id).sort();
    assert.deepEqual(ids, [phone.device_id, laptop.device_id, tablet.device_id].sort());
  });

  await t.test('to=<device_id> targets exactly that device', async () => {
    const { body } = await jsonPost(s, { text: 'hello', to: phone.device_id });
    assert.deepEqual(
      body.transfer.deliveries.map((d) => d.device_id),
      [phone.device_id],
    );
  });

  await t.test('to is repeatable and de-duplicates', async () => {
    const { body } = await jsonPost(s, {
      text: 'hello',
      to: [phone.device_id, phone.device_id, laptop.device_id],
    });
    assert.equal(body.transfer.deliveries.length, 2);
  });

  await t.test('others with an ABSENT from behaves as all', async () => {
    const { body } = await jsonPost(s, { text: 'hello', to: 'others' });
    assert.equal(body.transfer.deliveries.length, 3);
    assert.equal(body.transfer.from_device_id, null);
  });

  await t.test('others with an UNKNOWN from behaves as all', async () => {
    const { body } = await jsonPost(s, {
      text: 'hello',
      to: 'others',
      from: '00000000-0000-0000-0000-000000000000',
    });
    assert.equal(body.transfer.deliveries.length, 3, 'unknown sender must not be subtracted');
    assert.equal(body.transfer.from_device_id, null, 'an unknown sender is not recorded');
  });

  await t.test('an unknown target device is a 400 no_targets, not a silent success', async () => {
    const { res, body } = await jsonPost(s, { text: 'hello', to: 'nope-not-a-device' });
    assert.equal(res.status, 400);
    assert.equal(body.error.code, 'no_targets');
  });

  await t.test('a sender alone on the server gets no_targets from others', async () => {
    const solo = await makeServer();
    const only = await registerDevice(solo, { name: 'Only', platform: 'cli' });
    const { res, body } = await jsonPost(solo, { text: 'hi', from: only.device_id, to: 'others' });
    assert.equal(res.status, 400);
    assert.equal(body.error.code, 'no_targets');
    await solo.cleanup();
  });

  await t.test('no devices registered at all is no_targets', async () => {
    const empty = await makeServer();
    const { res, body } = await jsonPost(empty, { text: 'hi' });
    assert.equal(res.status, 400);
    assert.equal(body.error.code, 'no_targets');
    await empty.cleanup();
  });
});

test('transfers — kinds', async (t) => {
  const s = await makeServer();
  const phone = await registerDevice(s, { name: 'Phone', platform: 'ios', push_token: 'k1' });

  await t.test('plain text infers kind=text and carries no blob leg', async () => {
    const { body } = await jsonPost(s, { text: 'just some words', to: 'all' });
    const tr = body.transfer;
    assert.equal(tr.kind, 'text');
    assert.equal(tr.text, 'just some words');
    assert.equal(tr.file_name, null);
    assert.equal(tr.mime_type, null);
    assert.equal(tr.size, null);
    assert.equal(fs.readdirSync(path.join(s.dataDir, 'blobs')).length, 0);

    const blob = await s.fetch(`/v1/transfers/${tr.transfer_id}/blob`);
    assert.equal(blob.status, 400, 'text transfers have no blob to redirect to');
  });

  await t.test('an http(s) URL infers kind=link', async () => {
    const { body } = await jsonPost(s, { text: 'https://example.com/x?y=1', to: 'all' });
    assert.equal(body.transfer.kind, 'link');
    assert.equal(body.transfer.text, 'https://example.com/x?y=1');
  });

  await t.test('a non-http URL scheme stays text', async () => {
    const { body } = await jsonPost(s, { text: 'ftp://example.com/x', to: 'all' });
    assert.equal(body.transfer.kind, 'text');
  });

  await t.test('an explicit kind overrides inference', async () => {
    const { body } = await jsonPost(s, { text: 'https://example.com', kind: 'text', to: 'all' });
    assert.equal(body.transfer.kind, 'text');
  });

  await t.test('an unknown kind is a 400', async () => {
    const { res, body } = await jsonPost(s, { text: 'x', kind: 'video', to: 'all' });
    assert.equal(res.status, 400);
    assert.equal(body.error.code, 'bad_request');
  });

  await t.test('kind=file over JSON is a 400 — it needs multipart', async () => {
    const { res, body } = await jsonPost(s, { text: 'x', kind: 'file', to: 'all' });
    assert.equal(res.status, 400);
    assert.equal(body.error.code, 'bad_request');
  });

  await t.test('JSON with no text at all is a 400', async () => {
    const { res } = await jsonPost(s, { to: 'all' });
    assert.equal(res.status, 400);
  });

  await t.test('multipart with a file infers kind=file', async () => {
    const { res, body } = await postMultipart(s, [
      { name: 'file', filename: 'notes.txt', contentType: 'text/plain', value: 'hello bytes' },
      { name: 'to', value: phone.device_id },
    ]);
    assert.equal(res.status, 200);
    assert.equal(body.transfer.kind, 'file');
    assert.equal(body.transfer.file_name, 'notes.txt');
    assert.equal(body.transfer.mime_type, 'text/plain');
    assert.equal(body.transfer.size, Buffer.byteLength('hello bytes'));
    assert.equal(body.transfer.text, null);
  });

  await t.test('the name field overrides the part filename', async () => {
    const { body } = await postMultipart(s, [
      { name: 'file', filename: 'tmp-upload.bin', value: 'x' },
      { name: 'name', value: 'report.pdf' },
      { name: 'to', value: 'all' },
    ]);
    assert.equal(body.transfer.file_name, 'report.pdf');
  });

  await t.test('multipart text-only transfers work too (the Shortcut path)', async () => {
    const { res, body } = await postMultipart(s, [
      { name: 'text', value: 'https://example.com/from-shortcut' },
      { name: 'to', value: 'all' },
    ]);
    assert.equal(res.status, 200);
    assert.equal(body.transfer.kind, 'link');
  });

  await t.test('multipart fields may follow the file part', async () => {
    const { res, body } = await postMultipart(s, [
      { name: 'file', filename: 'after.txt', value: 'body first' },
      { name: 'name', value: 'after.txt' },
      { name: 'to', value: 'all' },
      { name: 'expires_in_days', value: '2' },
    ]);
    assert.equal(res.status, 200);
    const days =
      (new Date(body.transfer.expires_at) - new Date(body.transfer.created_at)) / 86400000;
    assert.equal(Math.round(days), 2);
  });
});

test('transfers — lifecycle', async (t) => {
  const s = await makeServer();
  const phone = await registerDevice(s, { name: 'Phone', platform: 'ios', push_token: 'L1' });
  const laptop = await registerDevice(s, { name: 'Laptop', platform: 'cli' });

  await t.test('a push is sent per target and flips the delivery to pushed', async () => {
    s.push.sent.length = 0;
    const { body } = await postMultipart(s, [
      { name: 'file', filename: 'a.bin', value: 'abcdef' },
      { name: 'to', value: 'others' },
      { name: 'from', value: laptop.device_id },
    ]);
    assert.equal(s.push.sent.length, 1);
    const { device, payload } = s.push.sent[0];
    assert.equal(device.id, phone.device_id);
    assert.equal(payload.aps.alert.title, 'a.bin');
    assert.equal(payload.aps.alert.subtitle, 'from Laptop');
    assert.equal(payload.aps.category, 'TRANSFER_ARRIVED');
    assert.equal(payload.aps['mutable-content'], 1);
    assert.equal(payload.aps['thread-id'], 'transmat');
    assert.equal(payload.transfer_id, body.transfer.transfer_id);
    assert.equal(payload.delivery_id, body.transfer.deliveries[0].delivery_id);
    assert.equal(payload.kind, 'file');
    assert.equal(payload.size, 6);
    assert.equal(body.transfer.deliveries[0].state, 'pushed');
  });

  await t.test('ack flips the delivery to downloaded and stamps acked_at', async () => {
    const { body } = await jsonPost(s, { text: 'ack me', to: phone.device_id });
    const delivery = body.transfer.deliveries[0];
    assert.equal(delivery.acked_at, null);

    const ack = await s.json(`/v1/deliveries/${delivery.delivery_id}/ack`, { method: 'POST' });
    assert.equal(ack.res.status, 200);
    assert.deepEqual(ack.body, { ok: true });

    const after = await s.json(`/v1/transfers/${body.transfer.transfer_id}`);
    assert.equal(after.body.transfer.deliveries[0].state, 'downloaded');
    assert.ok(after.body.transfer.deliveries[0].acked_at);
  });

  await t.test('acking an unknown delivery is a 404', async () => {
    const { res, body } = await s.json('/v1/deliveries/does-not-exist/ack', { method: 'POST' });
    assert.equal(res.status, 404);
    assert.equal(body.error.code, 'not_found');
  });

  await t.test('GET /v1/transfers/:id 404s on an unknown id', async () => {
    const { res, body } = await s.json('/v1/transfers/nope');
    assert.equal(res.status, 404);
    assert.equal(body.error.code, 'not_found');
  });
});

test('transfers — listing', async (t) => {
  const s = await makeServer();
  const phone = await registerDevice(s, { name: 'Phone', platform: 'ios', push_token: 'q1' });
  const laptop = await registerDevice(s, { name: 'Laptop', platform: 'cli' });

  await jsonPost(s, { text: 'from laptop to phone', from: laptop.device_id, to: phone.device_id });
  await jsonPost(s, { text: 'https://example.com/link', from: phone.device_id, to: laptop.device_id });
  await postMultipart(s, [
    { name: 'file', filename: 'invoice.pdf', value: 'pdf-bytes' },
    { name: 'to', value: 'all' },
  ]);

  await t.test('lists newest first with full Transfer objects', async () => {
    const { body } = await s.json('/v1/transfers');
    assert.equal(body.transfers.length, 3);
    const times = body.transfers.map((x) => x.created_at);
    assert.deepEqual(times, [...times].sort().reverse());
    assert.ok(Array.isArray(body.transfers[0].deliveries));
  });

  await t.test('direction=out filters by sender', async () => {
    const { body } = await s.json(`/v1/transfers?device_id=${laptop.device_id}&direction=out`);
    assert.equal(body.transfers.length, 1);
    assert.equal(body.transfers[0].text, 'from laptop to phone');
  });

  await t.test('direction=in filters by recipient', async () => {
    const { body } = await s.json(`/v1/transfers?device_id=${phone.device_id}&direction=in`);
    assert.deepEqual(
      body.transfers.map((x) => x.text ?? x.file_name).sort(),
      ['from laptop to phone', 'invoice.pdf'].sort(),
    );
  });

  await t.test('device_id with no direction means either side', async () => {
    const { body } = await s.json(`/v1/transfers?device_id=${laptop.device_id}`);
    assert.equal(body.transfers.length, 3);
  });

  await t.test('kind filters', async () => {
    const { body } = await s.json('/v1/transfers?kind=link');
    assert.equal(body.transfers.length, 1);
    assert.equal(body.transfers[0].kind, 'link');
  });

  await t.test('q searches file names and text', async () => {
    const byName = await s.json('/v1/transfers?q=invoice');
    assert.equal(byName.body.transfers.length, 1);
    const byText = await s.json('/v1/transfers?q=laptop');
    assert.equal(byText.body.transfers.length, 1);
  });

  await t.test('limit + cursor paginate without gaps or repeats', async () => {
    const seen = [];
    let url = '/v1/transfers?limit=2';
    for (let page = 0; page < 5; page += 1) {
      const { body } = await s.json(url);
      seen.push(...body.transfers.map((x) => x.transfer_id));
      if (!body.next_cursor) break;
      url = `/v1/transfers?limit=2&cursor=${encodeURIComponent(body.next_cursor)}`;
    }
    assert.equal(seen.length, 3);
    assert.equal(new Set(seen).size, 3);
  });

  await t.test('a garbage cursor is a 400', async () => {
    const { res, body } = await s.json('/v1/transfers?cursor=%%%not-base64%%%');
    assert.equal(res.status, 400);
    assert.equal(body.error.code, 'bad_request');
  });
});
