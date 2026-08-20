import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { makeServer, makeListeningServer, registerDevice, TEST_TOKEN } from './helpers.js';
import { createEventHub } from '../src/events.js';

test('event hub', async (t) => {
  await t.test('publish reaches every unfiltered subscriber', () => {
    const hub = createEventHub();
    const a = [];
    const b = [];
    hub.subscribe({ write: (c) => a.push(c) });
    hub.subscribe({ write: (c) => b.push(c) });
    assert.equal(hub.publish('transfer.created', { transfer: { transfer_id: 't1' } }), 2);
    assert.match(a[0], /^event: transfer\.created\ndata: \{"transfer":/);
    assert.ok(a[0].endsWith('\n\n'), 'frames must be terminated by a blank line');
    assert.equal(b.length, 1);
    hub.closeAll();
  });

  await t.test('a device-filtered subscriber only sees its own events', () => {
    const hub = createEventHub();
    const mine = [];
    const theirs = [];
    hub.subscribe({ deviceId: 'dev-1', write: (c) => mine.push(c) });
    hub.subscribe({ deviceId: 'dev-2', write: (c) => theirs.push(c) });

    hub.publish('transfer.created', { transfer: {} }, { audience: ['dev-1'] });
    assert.equal(mine.length, 1);
    assert.equal(theirs.length, 0);

    hub.publish('transfer.created', { transfer: {} }, { audience: ['dev-1', 'dev-2'] });
    assert.equal(mine.length, 2);
    assert.equal(theirs.length, 1);

    hub.publish('server.note', {}); // no audience = broadcast
    assert.equal(mine.length, 3);
    assert.equal(theirs.length, 2);
    hub.closeAll();
  });

  await t.test('keepalive comments are emitted on schedule', async () => {
    const hub = createEventHub({ keepaliveMs: 20 });
    const frames = [];
    const { unsubscribe } = hub.subscribe({ write: (c) => frames.push(c) });
    await sleep(70);
    unsubscribe();
    const keepalives = frames.filter((f) => f.startsWith(':keepalive'));
    assert.ok(keepalives.length >= 2, `expected keepalives, got ${frames.length} frames`);
    assert.ok(keepalives.every((f) => f.endsWith('\n\n')));
    hub.closeAll();
  });

  await t.test('unsubscribe clears the keepalive interval — no leak', async () => {
    const hub = createEventHub({ keepaliveMs: 10 });
    const frames = [];
    const { unsubscribe } = hub.subscribe({ write: (c) => frames.push(c) });
    await sleep(35);
    const countAtUnsubscribe = frames.length;
    assert.ok(countAtUnsubscribe > 0);

    assert.equal(unsubscribe(), true);
    assert.equal(hub.size, 0);
    assert.equal(unsubscribe(), false, 'unsubscribe must be idempotent');

    await sleep(50);
    assert.equal(frames.length, countAtUnsubscribe, 'no writes after unsubscribe');
  });

  await t.test('a throwing writer removes itself instead of breaking publish', () => {
    const hub = createEventHub();
    const good = [];
    hub.subscribe({
      write: () => {
        throw new Error('socket gone');
      },
      onError: () => {},
    });
    hub.subscribe({ write: (c) => good.push(c) });
    hub.publish('transfer.revoked', { transfer_id: 'x' });
    assert.equal(good.length, 1);
    assert.equal(hub.size, 1, 'the broken subscriber was dropped');
    hub.closeAll();
  });

  await t.test('closeAll drops every subscriber and its timer', async () => {
    const hub = createEventHub({ keepaliveMs: 10 });
    const frames = [];
    hub.subscribe({ write: (c) => frames.push(c) });
    hub.subscribe({ write: (c) => frames.push(c) });
    assert.equal(hub.size, 2);
    hub.closeAll();
    assert.equal(hub.size, 0);
    const count = frames.length;
    await sleep(40);
    assert.equal(frames.length, count);
  });
});

test('GET /v1/events over a real socket', async (t) => {
  const s = await makeListeningServer();
  const phone = await registerDevice(s, { name: 'Phone', platform: 'ios', push_token: 'e1' });
  const laptop = await registerDevice(s, { name: 'Laptop', platform: 'cli' });

  /** Open an SSE stream and collect frames until `stop()`. */
  async function openStream(query = '') {
    const controller = new AbortController();
    const res = await fetch(s.url(`/v1/events${query}`), {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
      signal: controller.signal,
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);

    let buffer = '';
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
        }
      } catch {
        /* aborted */
      }
    })();
    return {
      text: () => buffer,
      stop: () => controller.abort(),
    };
  }

  await t.test('SSE requires the bearer token (or ?access_token)', async () => {
    const res = await fetch(s.url('/v1/events'));
    assert.equal(res.status, 401);
    await res.body?.cancel();

    const withQuery = await fetch(s.url(`/v1/events?access_token=${TEST_TOKEN}`));
    assert.equal(withQuery.status, 200);
    await withQuery.body.cancel();
  });

  await t.test('transfer.created and delivery.acked reach a filtered listener', async () => {
    const stream = await openStream(`?device_id=${phone.device_id}`);
    await sleep(50);

    const created = await s.json('/v1/transfers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'ping', from: laptop.device_id, to: phone.device_id }),
    });
    const transfer = created.body.transfer;
    await sleep(80);

    assert.match(stream.text(), /event: transfer\.created/);
    const payload = JSON.parse(
      /event: transfer\.created\ndata: (.+)\n/.exec(stream.text())[1],
    );
    assert.equal(payload.transfer.transfer_id, transfer.transfer_id);
    assert.equal(payload.transfer.text, 'ping');

    await s.json(`/v1/deliveries/${transfer.deliveries[0].delivery_id}/ack`, { method: 'POST' });
    await sleep(80);
    assert.match(stream.text(), /event: delivery\.acked/);
    const ack = JSON.parse(/event: delivery\.acked\ndata: (.+)\n/.exec(stream.text())[1]);
    assert.deepEqual(ack, {
      transfer_id: transfer.transfer_id,
      delivery_id: transfer.deliveries[0].delivery_id,
      device_id: phone.device_id,
    });

    await s.json(`/v1/transfers/${transfer.transfer_id}`, { method: 'DELETE' });
    await sleep(80);
    assert.match(stream.text(), /event: transfer\.revoked/);

    stream.stop();
  });

  await t.test('a listener filtered to an uninvolved device sees nothing', async () => {
    const other = await registerDevice(s, { name: 'Bystander', platform: 'web' });
    const stream = await openStream(`?device_id=${other.device_id}`);
    await sleep(50);

    await s.json('/v1/transfers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'private', from: laptop.device_id, to: phone.device_id }),
    });
    await sleep(80);
    assert.ok(!stream.text().includes('transfer.created'), stream.text());
    stream.stop();
  });

  await t.test('disconnecting a client tears down its subscription', async () => {
    /** Wait for the hub to reach `target` subscribers, or give up. */
    const settle = async (target) => {
      for (let i = 0; i < 60 && s.events.size !== target; i += 1) await sleep(25);
      return s.events.size;
    };

    assert.equal(await settle(0), 0, 'earlier streams should already be released');

    const a = await openStream();
    const b = await openStream();
    assert.equal(await settle(2), 2);

    a.stop();
    assert.equal(await settle(1), 1, 'closing one client releases exactly one subscription');

    b.stop();
    assert.equal(await settle(0), 0, 'subscriptions (and their timers) must be released');
  });
});
