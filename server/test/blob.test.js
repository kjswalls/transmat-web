import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeServer, registerDevice, postMultipart } from './helpers.js';
import {
  createLocalStorage,
  signBlob,
  verifyBlobSignature,
  isValidKey,
  contentDisposition,
} from '../src/storage.js';
import { parseRange } from '../src/routes/blob.js';

const FILE_BODY = 'the quick brown fox jumps over the lazy dog\n'.repeat(40);

test('blob round trip through the local driver', async (t) => {
  const s = await makeServer();
  await registerDevice(s, { name: 'Phone', platform: 'ios', push_token: 'b1' });

  const { body } = await postMultipart(s, [
    { name: 'file', filename: 'report.pdf', contentType: 'application/pdf', value: FILE_BODY },
    { name: 'to', value: 'all' },
  ]);
  const transfer = body.transfer;

  await t.test('the bytes landed in DATA_DIR/blobs', () => {
    const files = fs.readdirSync(path.join(s.dataDir, 'blobs'));
    assert.equal(files.length, 1);
    assert.equal(
      fs.readFileSync(path.join(s.dataDir, 'blobs', files[0]), 'utf8'),
      FILE_BODY,
    );
  });

  let signedUrl;

  await t.test('GET :id/blob 302s to a signed URL on our own /blob route', async () => {
    const res = await s.fetch(`/v1/transfers/${transfer.transfer_id}/blob`);
    assert.equal(res.status, 302);
    signedUrl = res.headers.get('location');
    const url = new URL(signedUrl);
    assert.match(url.pathname, /^\/blob\/[a-f0-9]{32}$/);
    assert.match(url.searchParams.get('sig'), /^[a-f0-9]{64}$/);
    const ttl = Number(url.searchParams.get('exp')) - Math.floor(Date.now() / 1000);
    assert.ok(ttl > 250 && ttl <= 300, `expected a ~5 minute ttl, got ${ttl}s`);
  });

  await t.test('the signed URL serves the bytes with NO bearer token', async () => {
    const url = new URL(signedUrl);
    const res = await s.fetch(url.pathname + url.search, { auth: false });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.match(res.headers.get('content-disposition'), /filename="report\.pdf"/);
    assert.equal(await res.text(), FILE_BODY);
  });

  await t.test('a tampered signature is a 403 signature_invalid', async () => {
    const url = new URL(signedUrl);
    const sig = url.searchParams.get('sig');
    url.searchParams.set('sig', sig.slice(0, -1) + (sig.endsWith('a') ? 'b' : 'a'));
    const res = await s.fetch(url.pathname + url.search, { auth: false });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, 'signature_invalid');
  });

  await t.test('a tampered exp is a 403 — exp is covered by the signature', async () => {
    const url = new URL(signedUrl);
    url.searchParams.set('exp', String(Number(url.searchParams.get('exp')) + 100000));
    const res = await s.fetch(url.pathname + url.search, { auth: false });
    assert.equal(res.status, 403);
  });

  await t.test('a missing signature is a 403', async () => {
    const url = new URL(signedUrl);
    const res = await s.fetch(url.pathname, { auth: false });
    assert.equal(res.status, 403);
  });

  await t.test('a validly signed but past exp is a 410 expired', async () => {
    const key = new URL(signedUrl).pathname.split('/').pop();
    const exp = Math.floor(Date.now() / 1000) - 5;
    const sig = signBlob(s.config.blobSigningSecret, key, exp);
    const res = await s.fetch(`/blob/${key}?exp=${exp}&sig=${sig}`, { auth: false });
    assert.equal(res.status, 410);
    assert.equal((await res.json()).error.code, 'expired');
  });

  await t.test('a signature from the wrong secret is rejected', async () => {
    const key = new URL(signedUrl).pathname.split('/').pop();
    const exp = Math.floor(Date.now() / 1000) + 300;
    const sig = signBlob('some-other-secret', key, exp);
    const res = await s.fetch(`/blob/${key}?exp=${exp}&sig=${sig}`, { auth: false });
    assert.equal(res.status, 403);
  });

  await t.test('range requests work (URLSession resume)', async () => {
    const url = new URL(signedUrl);
    const res = await s.fetch(url.pathname + url.search, {
      auth: false,
      headers: { range: 'bytes=0-9' },
    });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-range'), `bytes 0-9/${FILE_BODY.length}`);
    assert.equal(await res.text(), FILE_BODY.slice(0, 10));
  });

  await t.test('revoke deletes the blob and 410s afterwards', async () => {
    const del = await s.json(`/v1/transfers/${transfer.transfer_id}`, { method: 'DELETE' });
    assert.equal(del.res.status, 200);
    assert.deepEqual(del.body, { ok: true });

    assert.equal(fs.readdirSync(path.join(s.dataDir, 'blobs')).length, 0, 'blob must be gone');

    const after = await s.json(`/v1/transfers/${transfer.transfer_id}`);
    assert.equal(after.body.transfer.state, 'revoked');

    const blob = await s.fetch(`/v1/transfers/${transfer.transfer_id}/blob`);
    assert.equal(blob.status, 410);
    assert.equal((await blob.json()).error.code, 'revoked');

    // Even a previously-issued, still-valid signed URL stops working.
    const url = new URL(signedUrl);
    const direct = await s.fetch(url.pathname + url.search, { auth: false });
    assert.equal(direct.status, 410);
  });

  await t.test('revoking an unknown transfer is a 404', async () => {
    const { res, body } = await s.json('/v1/transfers/not-real', { method: 'DELETE' });
    assert.equal(res.status, 404);
    assert.equal(body.error.code, 'not_found');
  });
});

test('storage unit behaviour', async (t) => {
  await t.test('signature verification is exact', () => {
    const sig = signBlob('secret', 'key123', 99999999999);
    assert.equal(verifyBlobSignature('secret', 'key123', '99999999999', sig), 'ok');
    assert.equal(verifyBlobSignature('secret', 'key123', '99999999999', sig.toUpperCase()), 'invalid');
    assert.equal(verifyBlobSignature('secret', 'other', '99999999999', sig), 'invalid');
    assert.equal(verifyBlobSignature('other', 'key123', '99999999999', sig), 'invalid');
    assert.equal(verifyBlobSignature('secret', 'key123', '99999999999', 'short'), 'invalid');
    assert.equal(verifyBlobSignature('secret', 'key123', '99999999999', ''), 'invalid');
    const past = Math.floor(Date.now() / 1000) - 1;
    assert.equal(
      verifyBlobSignature('secret', 'key123', String(past), signBlob('secret', 'key123', past)),
      'expired',
    );
  });

  await t.test('keys cannot traverse out of the blob directory', () => {
    assert.equal(isValidKey('abc123'), true);
    assert.equal(isValidKey('../../etc/passwd'), false);
    assert.equal(isValidKey('a/b'), false);
    assert.equal(isValidKey(''), false);
    assert.equal(isValidKey('..'), false);
  });

  await t.test('content-disposition survives odd filenames', () => {
    const cd = contentDisposition('rép"ort\n.pdf');
    assert.ok(!cd.includes('\n'));
    assert.match(cd, /filename\*=UTF-8''/);
  });

  await t.test('parseRange handles the shapes URLSession sends', () => {
    assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 });
    assert.deepEqual(parseRange('bytes=50-', 100), { start: 50, end: 99 });
    assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
    assert.equal(parseRange('bytes=200-300', 100), 'unsatisfiable');
    assert.equal(parseRange('bytes=9-1', 100), 'unsatisfiable');
    assert.equal(parseRange(undefined, 100), null);
    assert.equal(parseRange('items=0-1', 100), null);
  });

  await t.test('put() cleans up its temp file when the source blows up', async () => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'transmat-storage-'));
    const storage = createLocalStorage({
      blobDir: path.join(dir, 'blobs'),
      blobSigningSecret: 'x',
      publicBaseUrl: 'http://localhost',
    });
    const { Readable } = await import('node:stream');
    const exploding = new Readable({
      read() {
        this.destroy(new Error('boom'));
      },
    });
    await assert.rejects(() => storage.put('k1', exploding), /boom/);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'blobs')), [], 'no .part file left behind');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
