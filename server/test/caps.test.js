import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { makeServer, registerDevice, postMultipart, multipart } from './helpers.js';
import { MAX_TEXT_BYTES, MAX_FILE_BYTES } from '../src/config.js';
import { createLocalStorage, BlobTooLargeError, newBlobKey } from '../src/storage.js';
import { parseMultipart } from '../src/multipart.js';

test('size caps', async (t) => {
  const s = await makeServer();
  await registerDevice(s, { name: 'Phone', platform: 'ios', push_token: 'c1' });
  const blobsDir = path.join(s.dataDir, 'blobs');

  await t.test('the contract caps are what we enforce', () => {
    assert.equal(MAX_FILE_BYTES, 2 * 1024 * 1024 * 1024);
    assert.equal(MAX_TEXT_BYTES, 64 * 1024);
  });

  await t.test('text of exactly 64 KB is accepted', async () => {
    const { res, body } = await s.json('/v1/transfers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'a'.repeat(MAX_TEXT_BYTES), to: 'all' }),
    });
    assert.equal(res.status, 200);
    assert.equal(body.transfer.text.length, MAX_TEXT_BYTES);
  });

  await t.test('text one byte over 64 KB is a 413 too_large (JSON)', async () => {
    const { res, body } = await s.json('/v1/transfers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'a'.repeat(MAX_TEXT_BYTES + 1), to: 'all' }),
    });
    assert.equal(res.status, 413);
    assert.equal(body.error.code, 'too_large');
  });

  await t.test('the cap counts BYTES, not characters', async () => {
    // 'é' is 2 bytes in UTF-8, so 32K+1 of them is over the byte cap.
    const { res, body } = await s.json('/v1/transfers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'é'.repeat(MAX_TEXT_BYTES / 2 + 1), to: 'all' }),
    });
    assert.equal(res.status, 413);
    assert.equal(body.error.code, 'too_large');
  });

  await t.test('text over 64 KB is a 413 through multipart too', async () => {
    const { res, body } = await postMultipart(s, [
      { name: 'text', value: 'b'.repeat(MAX_TEXT_BYTES + 10) },
      { name: 'to', value: 'all' },
    ]);
    assert.equal(res.status, 413);
    assert.equal(body.error.code, 'too_large');
  });

  await t.test('an oversized JSON body is a 413 before parsing', async () => {
    const { res, body } = await s.json('/v1/transfers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(MAX_TEXT_BYTES + 64 * 1024),
    });
    assert.equal(res.status, 413);
    assert.equal(body.error.code, 'too_large');
  });

  await t.test('a rejected upload leaves no orphan blob behind', async () => {
    assert.deepEqual(fs.readdirSync(blobsDir), [], 'precondition: no blobs yet');
    // kind=text with a file part: the bytes stream to disk, then validation
    // fails — the route must delete what it wrote.
    const { res } = await postMultipart(s, [
      { name: 'file', filename: 'x.bin', value: 'some bytes' },
      { name: 'kind', value: 'text' },
      { name: 'text', value: 'hello' },
      { name: 'to', value: 'all' },
    ]);
    assert.equal(res.status, 400);
    assert.deepEqual(fs.readdirSync(blobsDir), [], 'the partial blob must be cleaned up');
  });

  await t.test('a no_targets rejection also cleans up the blob', async () => {
    const { res, body } = await postMultipart(s, [
      { name: 'file', filename: 'y.bin', value: 'more bytes' },
      { name: 'to', value: 'no-such-device' },
    ]);
    assert.equal(res.status, 400);
    assert.equal(body.error.code, 'no_targets');
    assert.deepEqual(fs.readdirSync(blobsDir), []);
  });
});

test('streaming caps at the driver and parser level', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transmat-caps-'));
  const storage = createLocalStorage({
    blobDir: path.join(dir, 'blobs'),
    blobSigningSecret: 'secret',
    publicBaseUrl: 'http://localhost:8787',
  });

  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  await t.test('put() aborts mid-stream once maxBytes is passed', async () => {
    // 10 chunks of 1 KB against a 4 KB cap: it must stop, not buffer.
    let chunksProduced = 0;
    const source = Readable.from(
      (function* () {
        for (let i = 0; i < 10; i += 1) {
          chunksProduced += 1;
          yield Buffer.alloc(1024, 0x41);
        }
      })(),
    );
    await assert.rejects(
      () => storage.put(newBlobKey(), source, { maxBytes: 4096 }),
      (err) => err instanceof BlobTooLargeError && err.limit === 4096,
    );
    assert.ok(chunksProduced < 10, `aborted early (produced ${chunksProduced}/10 chunks)`);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'blobs')), [], 'no partial file left');
  });

  await t.test('put() accepts a stream exactly at the cap', async () => {
    const key = newBlobKey();
    const { size } = await storage.put(key, Readable.from([Buffer.alloc(4096, 0x42)]), {
      maxBytes: 4096,
    });
    assert.equal(size, 4096);
    assert.equal((await storage.stat(key)).size, 4096);
    await storage.delete(key);
  });

  await t.test('parseMultipart turns an over-cap file into a 413 AppError', async () => {
    const { body, contentType } = multipart([
      { name: 'file', filename: 'big.bin', value: Buffer.alloc(50 * 1024, 0x43) },
      { name: 'to', value: 'all' },
    ]);
    let written = null;
    await assert.rejects(
      () =>
        parseMultipart(Readable.from([body]), {
          headers: { 'content-type': contentType, 'content-length': String(body.length) },
          maxFileBytes: 8 * 1024,
          maxFieldBytes: 1024,
          onFile: async (stream) => {
            written = newBlobKey();
            return storage.put(written, stream, { maxBytes: 8 * 1024 });
          },
        }),
      (err) => err.code === 'too_large' && err.status === 413,
    );
    assert.deepEqual(fs.readdirSync(path.join(dir, 'blobs')), []);
  });

  await t.test('parseMultipart rejects a malformed body as 400, not 500', async () => {
    await assert.rejects(
      () =>
        parseMultipart(Readable.from([Buffer.from('not multipart at all')]), {
          headers: { 'content-type': 'text/plain' },
          maxFileBytes: 1024,
          maxFieldBytes: 1024,
          onFile: async () => ({ size: 0 }),
        }),
      (err) => err.code === 'bad_request' && err.status === 400,
    );
  });
});
