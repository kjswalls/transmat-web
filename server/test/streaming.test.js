/**
 * Proves the upload path streams: a 2 GB file must never be buffered in
 * memory, so bytes have to be on disk *while* the request is still open.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { makeListeningServer, registerDevice, TEST_TOKEN } from './helpers.js';

const CHUNK = 256 * 1024;
const CHUNKS = 40; // ~10 MB
const BOUNDARY = '----transmatStreamTest';

function multipartStream({ onProgress } = {}) {
  const head = Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="big.bin"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(
    `\r\n--${BOUNDARY}\r\nContent-Disposition: form-data; name="to"\r\n\r\nall\r\n--${BOUNDARY}--\r\n`,
    'utf8',
  );
  const hash = crypto.createHash('sha256');

  const body = new ReadableStream({
    async start(controller) {
      controller.enqueue(head);
      for (let i = 0; i < CHUNKS; i += 1) {
        const chunk = Buffer.alloc(CHUNK, i % 251);
        hash.update(chunk);
        controller.enqueue(chunk);
        await onProgress?.(i);
        await sleep(8);
      }
      controller.enqueue(tail);
      controller.close();
    },
  });

  return { body, digest: () => hash.digest('hex'), total: CHUNK * CHUNKS };
}

test('a large upload streams to disk instead of buffering', async (t) => {
  const s = await makeListeningServer();
  await registerDevice(s, { name: 'Phone', platform: 'ios', push_token: 'st1' });
  const blobsDir = path.join(s.dataDir, 'blobs');

  /** Largest size we observed on disk while the request was still open. */
  let inFlightBytes = 0;
  const observe = () => {
    for (const name of fs.readdirSync(blobsDir)) {
      const size = fs.statSync(path.join(blobsDir, name)).size;
      if (size > inFlightBytes) inFlightBytes = size;
    }
  };

  const { body, digest, total } = multipartStream({
    onProgress: (i) => {
      if (i % 4 === 0) observe();
    },
  });

  const res = await fetch(s.url('/v1/transfers'), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TEST_TOKEN}`,
      'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
    },
    body,
    duplex: 'half',
  });
  const { transfer } = await res.json();

  await t.test('the upload succeeded with the right size', () => {
    assert.equal(res.status, 200);
    assert.equal(transfer.kind, 'file');
    assert.equal(transfer.file_name, 'big.bin');
    assert.equal(transfer.size, total);
  });

  await t.test('bytes were already on disk before the response came back', () => {
    assert.ok(
      inFlightBytes > CHUNK && inFlightBytes < total,
      `expected a partial file mid-upload; largest observed was ${inFlightBytes} of ${total}`,
    );
  });

  await t.test('the downloaded bytes are byte-identical', async () => {
    const redirect = await fetch(s.url(`/v1/transfers/${transfer.transfer_id}/blob`), {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
      redirect: 'manual',
    });
    assert.equal(redirect.status, 302);
    await redirect.body?.cancel();

    // The signed URL is absolute against PUBLIC_BASE_URL; re-point it at the
    // ephemeral test port.
    const signed = new URL(redirect.headers.get('location'));
    const download = await fetch(s.url(signed.pathname + signed.search));
    assert.equal(download.status, 200);

    const hash = crypto.createHash('sha256');
    for await (const chunk of download.body) hash.update(chunk);
    assert.equal(hash.digest('hex'), digest());
  });

  await t.test('no temp .part files survive', () => {
    const leftovers = fs.readdirSync(blobsDir).filter((n) => n.includes('.part-'));
    assert.deepEqual(leftovers, []);
  });
});
