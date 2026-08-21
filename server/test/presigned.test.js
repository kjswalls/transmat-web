/**
 * Two-phase presigned upload — the path the iOS share extension uses.
 *
 * Why this exists as its own flow: an iOS background URLSession hands the
 * transfer to nsurlsessiond and the app is not running to orchestrate
 * anything, so it can only PUT a file to a URL. Multipart strands itself in
 * exactly that situation (every part lands, CompleteMultipartUpload never
 * fires — aws-amplify/aws-sdk-ios#3173), which is why this is a single PUT.
 *
 * The security shape worth keeping: a presigned URL cannot enforce
 * Content-Length, so the declared size is a *claim* until the server stats
 * what actually landed. Everything below leans on that.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makeListeningServer, registerDevice, TEST_TOKEN } from './helpers.js';

const auth = { authorization: `Bearer ${TEST_TOKEN}` };

/**
 * The signed URL is built from PUBLIC_BASE_URL, which is fixed at config time,
 * while the test server binds an ephemeral port. Swap the origin and keep the
 * path and signature exactly as issued — everything under test is untouched.
 */
function localize(h, url) {
  const u = new URL(url);
  return `${h.base}${u.pathname}${u.search}`;
}

/** Reserve an upload slot. Returns { transfer, upload }. */
async function reserve(h, body) {
  const res = await fetch(h.url('/v1/transfers'), {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'presigned', to: 'all', ...body }),
  });
  return { res, body: await res.json().catch(() => null) };
}

/** Follow the blob redirect by hand, for the same origin reason as localize. */
async function download(h, id) {
  const r = await fetch(h.url(`/v1/transfers/${id}/blob`), { headers: auth, redirect: 'manual' });
  if (r.status < 300 || r.status >= 400) return r;
  return fetch(localize(h, r.headers.get('location')));
}

const complete = (h, id) =>
  fetch(h.url(`/v1/transfers/${id}/complete`), { method: 'POST', headers: auth });

describe('presigned upload', () => {
  test('reserve → PUT → complete round trips the exact bytes', async () => {
    const h = await makeListeningServer({ overrides: {} });
    await registerDevice(h, { name: 'Phone', platform: 'ios' });
    const bytes = crypto.randomBytes(300 * 1024);

    const { body } = await reserve(h, { name: 'clip.mov', mime_type: 'video/quicktime', size: bytes.length });
    assert.equal(body.transfer.state, 'uploading');
    assert.equal(body.upload.method, 'PUT');
    assert.ok(body.upload.url, 'no upload url');

    // No bearer on the PUT: this is what a background URLSession can do.
    const put = await fetch(localize(h, body.upload.url), { method: 'PUT', body: bytes });
    assert.equal(put.status, 204);

    const done = await complete(h, body.transfer.transfer_id);
    assert.equal(done.status, 200);
    const { transfer } = await done.json();
    assert.equal(transfer.state, 'complete');
    assert.equal(transfer.size, bytes.length);
    assert.equal(transfer.deliveries.length, 1);

    const dl = await download(h, transfer.transfer_id);
    assert.equal(dl.status, 200);
    assert.deepEqual(Buffer.from(await dl.arrayBuffer()), bytes);
  });

  test('an in-flight upload is invisible until it completes', async () => {
    const h = await makeListeningServer();
    await registerDevice(h, { name: 'Phone', platform: 'ios' });
    const { body } = await reserve(h, { name: 'x.bin', size: 4 });

    const before = await h.json('/v1/transfers');
    assert.equal(before.body.transfers.length, 0, 'an unverified upload must not be listed');

    await fetch(localize(h, body.upload.url), { method: 'PUT', body: Buffer.from('abcd') });
    await complete(h, body.transfer.transfer_id);

    const after = await h.json('/v1/transfers');
    assert.equal(after.body.transfers.length, 1);
  });

  test('nobody is pushed until the bytes are verified', async () => {
    const h = await makeListeningServer();
    await registerDevice(h, { name: 'Phone', platform: 'ios', push_token: 'tok-presign' });
    const { body } = await reserve(h, { name: 'x.bin', size: 4 });
    assert.equal(h.push.sent.length, 0, 'pushed before the upload even happened');

    await fetch(localize(h, body.upload.url), { method: 'PUT', body: Buffer.from('abcd') });
    assert.equal(h.push.sent.length, 0, 'pushed before complete');

    await complete(h, body.transfer.transfer_id);
    assert.equal(h.push.sent.length, 1);
  });

  test('a size that does not match what landed is rejected and the bytes deleted', async () => {
    const h = await makeListeningServer();
    await registerDevice(h, { name: 'Phone', platform: 'ios' });
    const { body } = await reserve(h, { name: 'x.bin', size: 999_999 });

    await fetch(localize(h, body.upload.url), { method: 'PUT', body: Buffer.from('short') });
    const res = await complete(h, body.transfer.transfer_id);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error.message, /declared 999999 bytes but 5 landed/);

    const blob = await fetch(h.url(`/v1/transfers/${body.transfer.transfer_id}/blob`), { headers: auth });
    assert.ok(blob.status >= 400, 'the rejected upload is still downloadable');
  });

  test('completing without uploading anything fails', async () => {
    const h = await makeListeningServer();
    await registerDevice(h, { name: 'Phone', platform: 'ios' });
    const { body } = await reserve(h, { name: 'x.bin', size: 10 });
    const res = await complete(h, body.transfer.transfer_id);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error.message, /no bytes/i);
  });

  test('complete is idempotent — a background session can deliver it twice', async () => {
    const h = await makeListeningServer();
    await registerDevice(h, { name: 'Phone', platform: 'ios', push_token: 'tok-idem' });
    const { body } = await reserve(h, { name: 'x.bin', size: 4 });
    await fetch(localize(h, body.upload.url), { method: 'PUT', body: Buffer.from('abcd') });

    assert.equal((await complete(h, body.transfer.transfer_id)).status, 200);
    assert.equal((await complete(h, body.transfer.transfer_id)).status, 200);
    assert.equal(h.push.sent.length, 1, 'a repeated complete must not push twice');
  });

  test('a download signature cannot be replayed as an upload', async () => {
    const h = await makeListeningServer();
    await registerDevice(h, { name: 'Phone', platform: 'ios' });
    const { body } = await reserve(h, { name: 'x.bin', size: 5 });
    await fetch(localize(h, body.upload.url), { method: 'PUT', body: Buffer.from('hello') });
    await complete(h, body.transfer.transfer_id);

    const redirect = await fetch(h.url(`/v1/transfers/${body.transfer.transfer_id}/blob`), {
      headers: auth, redirect: 'manual',
    });
    const getUrl = redirect.headers.get('location');
    assert.ok(getUrl, 'no redirect to a signed URL');

    const replay = await fetch(localize(h, getUrl), { method: 'PUT', body: Buffer.from('evil') });
    assert.equal(replay.status, 403, 'a GET signature was accepted for a PUT');

    const dl = await fetch(localize(h, getUrl));
    assert.equal(Buffer.from(await dl.arrayBuffer()).toString(), 'hello', 'bytes were overwritten');
  });

  test('a completed transfer cannot be overwritten with its own upload URL', async () => {
    const h = await makeListeningServer();
    await registerDevice(h, { name: 'Phone', platform: 'ios' });
    const { body } = await reserve(h, { name: 'x.bin', size: 5 });
    await fetch(localize(h, body.upload.url), { method: 'PUT', body: Buffer.from('hello') });
    await complete(h, body.transfer.transfer_id);

    const again = await fetch(localize(h, body.upload.url), { method: 'PUT', body: Buffer.from('evil!') });
    assert.equal(again.status, 400);

    const dl = await download(h, body.transfer.transfer_id);
    assert.equal(Buffer.from(await dl.arrayBuffer()).toString(), 'hello');
  });

  test('a declared size over the cap is refused before any URL is issued', async () => {
    const h = await makeListeningServer();
    await registerDevice(h, { name: 'Phone', platform: 'ios' });
    const { res, body } = await reserve(h, { name: 'huge.bin', size: 3 * 1024 * 1024 * 1024 });
    assert.equal(res.status, 413);
    assert.equal(body.upload, undefined, 'an upload URL was handed out for an oversized file');
  });

  test('reserving with no valid target fails before any URL is issued', async () => {
    const h = await makeListeningServer();
    await registerDevice(h, { name: 'Phone', platform: 'ios' });
    const { res, body } = await reserve(h, { name: 'x.bin', size: 1, to: crypto.randomUUID() });
    assert.equal(res.status, 400);
    assert.equal(body.error.code, 'no_targets');
    assert.equal(body.upload, undefined);
  });

  test('a negative or non-numeric size is refused', async () => {
    const h = await makeListeningServer();
    await registerDevice(h, { name: 'Phone', platform: 'ios' });
    assert.equal((await reserve(h, { name: 'x', size: -1 })).res.status, 400);
    assert.equal((await reserve(h, { name: 'x', size: 'lots' })).res.status, 400);
  });
});

describe('abandoned uploads', () => {
  test('the janitor reclaims bytes nobody ever completed', async () => {
    const { runSweep } = await import('../src/sweep.js');
    const h = await makeListeningServer();
    await registerDevice(h, { name: 'Phone', platform: 'ios' });
    const { body } = await reserve(h, { name: 'ghost.bin', size: 4 });
    await fetch(localize(h, body.upload.url), { method: 'PUT', body: Buffer.from('abcd') });
    // ...and the client vanishes here. No complete call ever arrives.

    const fresh = await runSweep(h, { quiet: true });
    assert.equal(fresh.uploadsReclaimed, 0, 'reclaimed an upload that was still in its window');

    const later = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString();
    const swept = await runSweep(h, { asOf: later, quiet: true });
    assert.equal(swept.uploadsReclaimed, 1);
    assert.equal(swept.blobsDeleted, 1, 'the orphaned bytes are still being paid for');

    const { body: after } = await h.json(`/v1/transfers/${body.transfer.transfer_id}`);
    assert.equal(after.transfer.state, 'cancelled');
  });
});
