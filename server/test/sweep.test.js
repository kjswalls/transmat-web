import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeServer, registerDevice, postMultipart } from './helpers.js';
import { runSweep, startSweep } from '../src/sweep.js';

test('expiry sweep', async (t) => {
  const s = await makeServer();
  await registerDevice(s, { name: 'Phone', platform: 'ios', push_token: 's1' });
  const blobsDir = path.join(s.dataDir, 'blobs');

  const { body: fileBody } = await postMultipart(s, [
    { name: 'file', filename: 'old.bin', value: 'bytes that should not survive' },
    { name: 'to', value: 'all' },
    { name: 'expires_in_days', value: '1' },
  ]);
  const { body: textBody } = await s.json('/v1/transfers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'a note', to: 'all', expires_in_days: 1 }),
  });

  await t.test('nothing expires before its time', async () => {
    const result = await runSweep(s, { quiet: true });
    assert.deepEqual(result, { expired: 0, blobsDeleted: 0, uploadsReclaimed: 0 });
    assert.equal(fs.readdirSync(blobsDir).length, 1);
  });

  await t.test('past their expiry, bytes are deleted and state flips', async () => {
    const future = new Date(Date.now() + 2 * 86400 * 1000).toISOString();
    const result = await runSweep(s, { asOf: future, quiet: true });
    assert.deepEqual(result, { expired: 2, blobsDeleted: 1, uploadsReclaimed: 0 });
    assert.deepEqual(fs.readdirSync(blobsDir), [], 'blob bytes are gone');
  });

  await t.test('the archive row survives — expiry deletes bytes, not history', async () => {
    const { res, body } = await s.json(`/v1/transfers/${fileBody.transfer.transfer_id}`);
    assert.equal(res.status, 200);
    assert.equal(body.transfer.state, 'expired');
    assert.equal(body.transfer.file_name, 'old.bin', 'metadata is still readable');
    assert.equal(body.transfer.deliveries.length, 1);

    const text = await s.json(`/v1/transfers/${textBody.transfer.transfer_id}`);
    assert.equal(text.body.transfer.state, 'expired');
    assert.equal(text.body.transfer.text, 'a note', 'inline payloads survive as history');
  });

  await t.test('downloading an expired transfer is a 410', async () => {
    const res = await s.fetch(`/v1/transfers/${fileBody.transfer.transfer_id}/blob`);
    assert.equal(res.status, 410);
    assert.equal((await res.json()).error.code, 'expired');
  });

  await t.test('sweeping again is a no-op — expired rows are not re-swept', async () => {
    const future = new Date(Date.now() + 3 * 86400 * 1000).toISOString();
    assert.deepEqual(await runSweep(s, { asOf: future, quiet: true }), {
      expired: 0,
      blobsDeleted: 0,
      uploadsReclaimed: 0,
    });
  });

  await t.test('a revoked transfer is not swept a second time', async () => {
    const fresh = await makeServer();
    await registerDevice(fresh, { name: 'P', platform: 'ios', push_token: 'sr' });
    const { body } = await postMultipart(fresh, [
      { name: 'file', filename: 'r.bin', value: 'x' },
      { name: 'to', value: 'all' },
    ]);
    await fresh.json(`/v1/transfers/${body.transfer.transfer_id}`, { method: 'DELETE' });
    const future = new Date(Date.now() + 30 * 86400 * 1000).toISOString();
    assert.deepEqual(await runSweep(fresh, { asOf: future, quiet: true }), {
      expired: 0,
      blobsDeleted: 0,
      uploadsReclaimed: 0,
    });
    assert.equal(
      (await fresh.json(`/v1/transfers/${body.transfer.transfer_id}`)).body.transfer.state,
      'revoked',
    );
    await fresh.cleanup();
  });

  await t.test('startSweep runs once immediately on boot', async () => {
    const fresh = await makeServer();
    await registerDevice(fresh, { name: 'P', platform: 'ios', push_token: 'sb' });
    await postMultipart(fresh, [
      { name: 'file', filename: 'b.bin', value: 'boot bytes' },
      { name: 'to', value: 'all' },
      { name: 'expires_in_days', value: '1' },
    ]);

    // Age the row so the boot sweep has something to do.
    fresh.db._raw
      .prepare('UPDATE transfers SET expires_at = ?')
      .run(new Date(Date.now() - 1000).toISOString());

    const sweeper = startSweep(fresh, { intervalMs: 60_000, quiet: true });
    const result = await sweeper.firstRun;
    sweeper.stop();
    assert.equal(result.expired, 1);
    assert.equal(result.blobsDeleted, 1);
    assert.deepEqual(fs.readdirSync(path.join(fresh.dataDir, 'blobs')), []);
    await fresh.cleanup();
  });
});

test('expiry validation', async (t) => {
  const s = await makeServer();
  await registerDevice(s, { name: 'P', platform: 'ios', push_token: 'x1' });

  const post = (body) =>
    s.json('/v1/transfers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi', to: 'all', ...body }),
    });
  const days = (t) => Math.round((new Date(t.expires_at) - new Date(t.created_at)) / 86400000);

  await t.test('default is 7 days', async () => {
    const { body } = await post({});
    assert.equal(days(body.transfer), 7);
  });

  await t.test('an explicit value inside 1–30 is honoured', async () => {
    assert.equal(days((await post({ expires_in_days: 1 })).body.transfer), 1);
    assert.equal(days((await post({ expires_in_days: 30 })).body.transfer), 30);
  });

  await t.test('out-of-range values clamp to the 1–30 window', async () => {
    assert.equal(days((await post({ expires_in_days: 0 })).body.transfer), 1);
    assert.equal(days((await post({ expires_in_days: 9000 })).body.transfer), 30);
  });

  await t.test('a non-numeric value is a 400', async () => {
    const { res, body } = await post({ expires_in_days: 'forever' });
    assert.equal(res.status, 400);
    assert.equal(body.error.code, 'bad_request');
  });
});
