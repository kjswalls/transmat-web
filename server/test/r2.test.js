/**
 * The R2 storage driver, against a real S3-compatible server.
 *
 * This exists because the driver shipped broken and nothing caught it: every
 * other test runs the `local` driver, so `r2` was never executed once. The
 * bug was `Body: counted(body)` handing the AWS SDK a bare AsyncGenerator,
 * which it does not accept (string | Uint8Array | Buffer | Readable |
 * ReadableStream | Blob only) — every upload failed with a 500 the moment
 * STORAGE_DRIVER=r2. Cloudflare credentials are not needed to catch that.
 *
 * Skips cleanly when s3rver is absent, so the suite still runs anywhere.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { createR2Storage } from '../src/storage.js';

let S3rver = null;
try {
  ({ default: S3rver } = await import('s3rver'));
} catch {
  /* not installed — every test below skips */
}

const PORT = 4599;
const BUCKET = 'transmat-test';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

describe('r2 storage driver (against a local S3)', { skip: S3rver ? false : 's3rver not installed' }, () => {
  let s3, storage, dir;

  before(async () => {
    dir = `${process.env.TMPDIR || '/tmp'}/transmat-s3-${crypto.randomUUID()}`;
    const fs = await import('node:fs');
    fs.mkdirSync(dir, { recursive: true });
    s3 = new S3rver({
      port: PORT, address: '127.0.0.1', silent: true, directory: dir,
      configureBuckets: [{ name: BUCKET }],
    });
    await s3.run();
    storage = await createR2Storage({
      r2: {
        accountId: 'local', accessKeyId: 'S3RVER', secretAccessKey: 'S3RVER',
        bucket: BUCKET, endpoint: `http://127.0.0.1:${PORT}`,
      },
    });
  });

  after(async () => {
    await s3?.close?.();
    const fsp = await import('node:fs/promises');
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  test('name is r2', () => assert.equal(storage.name, 'r2'));

  test('put accepts a Readable and reports the byte count', async () => {
    const body = crypto.randomBytes(64 * 1024);
    const { size } = await storage.put('rt-small', Readable.from([body]), { contentType: 'application/octet-stream' });
    assert.equal(size, body.length);
  });

  test('round trips bytes through a presigned GET', async () => {
    const body = crypto.randomBytes(3 * 1024 * 1024);
    await storage.put('rt-3mb', Readable.from([body]), {});
    const url = await storage.signedUrl('rt-3mb', 300, 'r2-test.bin');
    const res = await fetch(url);
    assert.equal(res.status, 200, `presigned GET failed: ${res.status}`);
    assert.equal(sha(Buffer.from(await res.arrayBuffer())), sha(body));
  });

  test('multipart: a body larger than the 8MB part size round trips intact', async () => {
    // Three parts. This is the path that a phone video actually takes.
    const body = crypto.randomBytes(20 * 1024 * 1024);
    const { size } = await storage.put('rt-20mb', Readable.from([body]), {});
    assert.equal(size, body.length);
    const res = await fetch(await storage.signedUrl('rt-20mb', 300));
    assert.equal(sha(Buffer.from(await res.arrayBuffer())), sha(body));
  });

  test('the byte cap aborts mid-upload', async () => {
    const body = crypto.randomBytes(2 * 1024 * 1024);
    await assert.rejects(
      () => storage.put('rt-capped', Readable.from([body]), { maxBytes: 1024 }),
      (err) => err?.name === 'BlobTooLargeError' || /exceeds|too large|limit/i.test(String(err?.message ?? err)),
    );
  });

  test('a presigned URL carries the signature and expiry', async () => {
    const url = new URL(await storage.signedUrl('rt-small', 120));
    assert.ok(url.searchParams.get('X-Amz-Signature'), 'no signature on the URL');
    assert.equal(url.searchParams.get('X-Amz-Expires'), '120');
  });

  test('delete removes the object', async () => {
    await storage.put('rt-doomed', Readable.from([Buffer.from('bye')]), {});
    await storage.delete('rt-doomed');
    const res = await fetch(await storage.signedUrl('rt-doomed', 60));
    assert.ok(res.status >= 400, `expected the object to be gone, got ${res.status}`);
  });
});
