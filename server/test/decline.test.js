/**
 * Declining a delivery.
 *
 * This exists because the iOS app already ships a destructive "Decline"
 * notification action that, until now, only wrote a log line — the sender's
 * delivery sat at `pushed` forever and the recipient's own clients kept
 * offering the file. A shipped button that does nothing is worse than no
 * button.
 *
 * What decline does NOT do: delete bytes. Other recipients may still want
 * them, and one recipient's refusal is not authority over the sender's file.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeServer, registerDevice, postMultipart, TEST_TOKEN } from './helpers.js';

const post = (h, path) => h.json(path, { method: 'POST' });

/** A file sent to every device, plus the delivery for `deviceId`. */
async function sendTo(h, deviceId) {
  const { body } = await postMultipart(h, [
    { name: 'file', filename: 'x.bin', value: 'hello' },
    { name: 'to', value: 'all' },
  ]);
  const transfer = body.transfer;
  const delivery = transfer.deliveries.find((d) => d.device_id === deviceId)
    ?? transfer.deliveries[0];
  return { transfer, delivery };
}

describe('decline', () => {
  test('moves the delivery to declined and reports it', async () => {
    const h = await makeServer();
    const device = await registerDevice(h, { name: 'Phone', platform: 'ios' });
    const { transfer, delivery } = await sendTo(h, device.device_id);

    const { res, body } = await post(h, `/v1/deliveries/${delivery.delivery_id}/decline`);
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.state, 'declined');

    const after = await h.json(`/v1/transfers/${transfer.transfer_id}`);
    const updated = after.body.transfer.deliveries.find((d) => d.delivery_id === delivery.delivery_id);
    assert.equal(updated.state, 'declined');
  });

  test('does NOT delete the bytes — one recipient does not speak for the rest', async () => {
    const h = await makeServer();
    const a = await registerDevice(h, { name: 'A', platform: 'ios' });
    await registerDevice(h, { name: 'B', platform: 'macos' });
    const { transfer, delivery } = await sendTo(h, a.device_id);

    await post(h, `/v1/deliveries/${delivery.delivery_id}/decline`);

    const blob = await h.fetch(`/v1/transfers/${transfer.transfer_id}/blob`);
    assert.ok(blob.status === 302 || blob.status === 200,
      `declining destroyed the file for everyone (${blob.status})`);
  });

  test('is idempotent', async () => {
    const h = await makeServer();
    const device = await registerDevice(h, { name: 'Phone', platform: 'ios' });
    const { delivery } = await sendTo(h, device.device_id);

    assert.equal((await post(h, `/v1/deliveries/${delivery.delivery_id}/decline`)).res.status, 200);
    assert.equal((await post(h, `/v1/deliveries/${delivery.delivery_id}/decline`)).res.status, 200);
  });

  test('a downloaded delivery cannot be un-received', async () => {
    const h = await makeServer();
    const device = await registerDevice(h, { name: 'Phone', platform: 'ios' });
    const { delivery } = await sendTo(h, device.device_id);

    await post(h, `/v1/deliveries/${delivery.delivery_id}/ack`);
    const { res, body } = await post(h, `/v1/deliveries/${delivery.delivery_id}/decline`);
    assert.equal(res.status, 400);
    assert.match(body.error.message, /already downloaded/i);
  });

  test('an unknown delivery is a 404, not a silent success', async () => {
    const h = await makeServer();
    const { res } = await post(h, '/v1/deliveries/00000000-0000-0000-0000-000000000000/decline');
    assert.equal(res.status, 404);
  });

  test('declining one delivery leaves the others alone', async () => {
    const h = await makeServer();
    const a = await registerDevice(h, { name: 'A', platform: 'ios' });
    await registerDevice(h, { name: 'B', platform: 'macos' });
    const { transfer, delivery } = await sendTo(h, a.device_id);

    await post(h, `/v1/deliveries/${delivery.delivery_id}/decline`);

    const after = await h.json(`/v1/transfers/${transfer.transfer_id}`);
    const states = Object.fromEntries(
      after.body.transfer.deliveries.map((d) => [d.delivery_id, d.state]),
    );
    assert.equal(states[delivery.delivery_id], 'declined');
    const others = Object.entries(states).filter(([id]) => id !== delivery.delivery_id);
    assert.ok(others.length > 0, 'test needs a second recipient');
    for (const [, state] of others) {
      assert.notEqual(state, 'declined', 'declining one delivery declined another');
    }
  });

  test('requires auth like every other /v1 route', async () => {
    const h = await makeServer();
    const device = await registerDevice(h, { name: 'Phone', platform: 'ios' });
    const { delivery } = await sendTo(h, device.device_id);
    const res = await h.fetch(`/v1/deliveries/${delivery.delivery_id}/decline`, {
      method: 'POST', auth: false,
    });
    assert.equal(res.status, 401);
  });
});
