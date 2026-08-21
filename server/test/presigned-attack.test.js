/**
 * Adversarial tests for the two-phase presigned upload.
 *
 * The signed PUT is an unauthenticated write surface, and `complete` is the
 * only thing standing between "some bytes landed" and "recipients are told
 * about them". Everything here started life as a demonstrated break.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { makeListeningServer, registerDevice, TEST_TOKEN } from './helpers.js';
import { signBlob, createLocalStorage } from '../src/storage.js';
import { runSweep } from '../src/sweep.js';

let S3rver = null;
try {
  ({ default: S3rver } = await import('s3rver'));
} catch {
  /* the r2 test below skips */
}

const auth = { authorization: `Bearer ${TEST_TOKEN}` };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** PUBLIC_BASE_URL is fixed at config time; the test server picks a port. */
function localize(h, url) {
  const u = new URL(url);
  return `${h.base}${u.pathname}${u.search}`;
}

async function reserve(h, body) {
  const res = await fetch(h.url('/v1/transfers'), {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'presigned', to: 'all', ...body }),
  });
  return { res, body: await res.json().catch(() => null) };
}

const complete = (h, id) =>
  fetch(h.url(`/v1/transfers/${id}/complete`), { method: 'POST', headers: auth });

const blobsOnDisk = (h) => fs.readdirSync(path.join(h.dataDir, 'blobs'));

/** A raw chunked PUT we can feed by hand, to hold a request open mid-body. */
function slowPut(port, urlPath, firstChunk = 'A') {
  const sock = net.connect(port, '127.0.0.1');
  const chunks = [];
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));
  sock.on('data', (d) => chunks.push(d));
  sock.on('close', () => resolveDone(Buffer.concat(chunks).toString('latin1')));
  sock.on('error', () => resolveDone(Buffer.concat(chunks).toString('latin1')));
  const ready = new Promise((r) =>
    sock.on('connect', () => {
      sock.write(
        `PUT ${urlPath} HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n`,
      );
      sock.write(`${firstChunk.length.toString(16)}\r\n${firstChunk}\r\n`);
      r();
    }),
  );
  return {
    ready,
    done,
    write: (s) => sock.write(`${Buffer.byteLength(s).toString(16)}\r\n${s}\r\n`),
    /** Same, but honours backpressure — otherwise we queue megabytes locally
     *  and never get around to reading the server's answer. */
    async writeSlowly(s) {
      const ok = sock.write(`${Buffer.byteLength(s).toString(16)}\r\n${s}\r\n`);
      if (!ok) await new Promise((r) => sock.once('drain', r));
    },
    end: () => sock.write('0\r\n\r\n'),
    destroy: () => sock.destroy(),
    writable: () => sock.writable && !sock.destroyed,
    seen: () => Buffer.concat(chunks).toString('latin1'),
  };
}

/* -------------------------------------------------------------------------- */
/* the signature itself                                                       */
/* -------------------------------------------------------------------------- */

describe('presigned PUT — key and signature binding', () => {
  test('no traversal, encoded or otherwise, escapes the blob directory', async () => {
    const h = await makeListeningServer();
    await registerDevice(h, { name: 'P', platform: 'ios' });
    const { body } = await reserve(h, { name: 'x.bin', size: 4 });
    const exp = new URL(body.upload.url).searchParams.get('exp');

    for (const key of ['../../etc/passwd', '..%2f..%2fetc%2fpasswd', '%2e%2e%2ffoo', 'a/../b', 'foo/bar']) {
      const sig = signBlob(TEST_TOKEN, key, exp, 'put');
      const r = await fetch(`${h.base}/blob/${key}?exp=${exp}&sig=${sig}`, {
        method: 'PUT',
        body: 'pwned',
      });
      assert.ok(r.status >= 400, `${key} was accepted (${r.status})`);
    }
    assert.deepEqual(blobsOnDisk(h), [], 'a traversal PUT created a file');
  });

  test('a signature for a key with no reservation writes nothing', async () => {
    const h = await makeListeningServer();
    await registerDevice(h, { name: 'P', platform: 'ios' });
    const exp = Math.floor(Date.now() / 1000) + 600;
    const key = 'akeynobodyissued';
    const sig = signBlob(TEST_TOKEN, key, exp, 'put');
    const r = await fetch(`${h.base}/blob/${key}?exp=${exp}&sig=${sig}`, { method: 'PUT', body: 'x' });
    assert.equal(r.status, 404);
    assert.deepEqual(blobsOnDisk(h), []);
  });

  test('purpose binding holds in both directions and expiry is enforced on PUT', async () => {
    const h = await makeListeningServer();
    await registerDevice(h, { name: 'P', platform: 'ios' });
    const { body } = await reserve(h, { name: 'x.bin', size: 5 });
    const u = new URL(body.upload.url);
    const key = u.pathname.split('/').pop();

    // a put signature is not a get signature
    assert.equal((await fetch(localize(h, body.upload.url))).status, 403);

    // an expired put signature is refused even though the HMAC is valid
    const past = Math.floor(Date.now() / 1000) - 10;
    const expiredSig = signBlob(TEST_TOKEN, key, past, 'put');
    const r = await fetch(`${h.base}/blob/${key}?exp=${past}&sig=${expiredSig}`, {
      method: 'PUT',
      body: 'nope!',
    });
    assert.equal(r.status, 410);

    // and the exp cannot be stretched without breaking the signature
    const stretched = `${h.base}/blob/${key}?exp=${past + 99999}&sig=${expiredSig}`;
    assert.equal((await fetch(stretched, { method: 'PUT', body: 'nope!' })).status, 403);
    assert.deepEqual(blobsOnDisk(h), []);
  });
});

/* -------------------------------------------------------------------------- */
/* the size claim                                                             */
/* -------------------------------------------------------------------------- */

describe('presigned PUT — the size cap', () => {
  test('the PUT is capped at the size the client declared, not at the 2 GB ceiling', async () => {
    const h = await makeListeningServer();
    await registerDevice(h, { name: 'P', platform: 'ios' });
    const { body } = await reserve(h, { name: 'x.bin', size: 5 });

    const r = await fetch(localize(h, body.upload.url), {
      method: 'PUT',
      body: Buffer.alloc(8 * 1024 * 1024, 0x41),
    });
    assert.equal(r.status, 413, 'a 5-byte reservation swallowed 8 MB');
    assert.equal((await r.json()).error.code, 'too_large');
    assert.deepEqual(blobsOnDisk(h), [], 'the oversized body was left on disk');
  });

  test('the cap bites mid-stream: the socket is answered before the body is sent', async () => {
    const h = await makeListeningServer();
    await registerDevice(h, { name: 'P', platform: 'ios' });
    const { body } = await reserve(h, { name: 'x.bin', size: 1000 });
    const u = new URL(body.upload.url);

    const s = slowPut(h.port, u.pathname + u.search, 'A');
    await s.ready;
    const chunk = 'B'.repeat(64 * 1024);
    const total = 64 * 1024 * 1024;
    let sent = 1;
    let answered = 0;
    // 64 MB in 64 KB slices, stopping the moment the server says something. A
    // server that only weighs the body once it is all on disk cannot answer
    // until we stop writing, so it would run the whole loop.
    while (sent < total && s.writable()) {
      if (/^HTTP\/1\.1 \d\d\d/.test(s.seen())) {
        answered = sent;
        break;
      }
      await s.writeSlowly(chunk);
      sent += chunk.length;
      await sleep(1);
    }
    for (let i = 0; i < 20 && !/^HTTP\/1\.1 \d\d\d/.test(s.seen()); i++) await sleep(25);
    if (!answered) answered = sent;
    s.destroy();
    await s.done;

    assert.match(s.seen(), /^HTTP\/1\.1 413/, 'expected a 413, got:\n' + s.seen().slice(0, 200));
    assert.ok(
      answered < 8 * 1024 * 1024,
      `the cap only bit after ${answered} of ${total} bytes — that is not mid-stream enforcement`,
    );
    assert.deepEqual(blobsOnDisk(h), []);
  });
});

/* -------------------------------------------------------------------------- */
/* races                                                                      */
/* -------------------------------------------------------------------------- */

describe('presigned PUT — races', () => {
  test('a PUT still in flight cannot overwrite bytes that complete just verified', async () => {
    const h = await makeListeningServer();
    await registerDevice(h, { name: 'P', platform: 'ios' });
    const { body } = await reserve(h, { name: 'x.bin', size: 5 });
    const id = body.transfer.transfer_id;
    const u = new URL(body.upload.url);

    await fetch(localize(h, body.upload.url), { method: 'PUT', body: Buffer.from('hello') });

    // A second PUT opens and stalls mid-body while `complete` runs.
    const s = slowPut(h.port, u.pathname + u.search, 'E');
    await s.ready;
    await sleep(50);

    const done = await complete(h, id);
    s.write('VILEVILEVILEVILEVILE');
    s.end();
    await s.done;

    // Either complete refuses to certify bytes that are still moving, or the
    // in-flight PUT loses. What must never happen is a transfer marked
    // complete with size 5 that serves 21 attacker-chosen bytes.
    const meta = await h.json(`/v1/transfers/${id}`);
    if (meta.body.transfer.state === 'complete') {
      const r = await fetch(h.url(`/v1/transfers/${id}/blob`), { headers: auth, redirect: 'manual' });
      assert.equal(r.status, 302);
      const dl = await fetch(localize(h, r.headers.get('location')));
      const got = Buffer.from(await dl.arrayBuffer());
      assert.equal(
        got.toString(),
        'hello',
        `verified bytes were swapped after complete (status ${done.status})`,
      );
      assert.equal(got.length, meta.body.transfer.size);
    } else {
      assert.notEqual(done.status, 200, 'complete claimed success but the state is not complete');
    }
  });

  test('two concurrent PUTs cannot interleave into one blob', async () => {
    const h = await makeListeningServer();
    await registerDevice(h, { name: 'P', platform: 'ios' });
    const { body } = await reserve(h, { name: 'x.bin', size: 5 });
    const u = new URL(body.upload.url);

    const s = slowPut(h.port, u.pathname + u.search, 'A');
    await s.ready;
    await sleep(50);
    const second = await fetch(localize(h, body.upload.url), { method: 'PUT', body: 'ZZZZZ' });
    assert.ok(second.status >= 400, 'a second concurrent PUT to the same key was accepted');
    s.write('AAAA');
    s.end();
    await s.done;
    assert.match(s.seen(), /^HTTP\/1\.1 204/);

    const done = await complete(h, body.transfer.transfer_id);
    assert.equal(done.status, 200);
    const r = await fetch(h.url(`/v1/transfers/${body.transfer.transfer_id}/blob`), {
      headers: auth,
      redirect: 'manual',
    });
    const dl = await fetch(localize(h, r.headers.get('location')));
    assert.equal(await dl.text(), 'AAAAA');
  });

  test('a revoke landing mid-PUT does not leave the bytes on disk', async () => {
    const h = await makeListeningServer();
    await registerDevice(h, { name: 'P', platform: 'ios' });
    const { body } = await reserve(h, { name: 'x.bin', size: 9 });
    const id = body.transfer.transfer_id;
    const u = new URL(body.upload.url);

    const s = slowPut(h.port, u.pathname + u.search, 'AAAA');
    await s.ready;
    await sleep(50);
    assert.equal((await fetch(h.url(`/v1/transfers/${id}`), { method: 'DELETE', headers: auth })).status, 200);
    s.write('BBBBB');
    s.end();
    await s.done;
    await sleep(50);

    assert.deepEqual(
      blobsOnDisk(h),
      [],
      'a PUT that finished after revoke left orphaned bytes no sweep will ever collect',
    );
  });

  test('a complete racing a revoke cannot resurrect the transfer', async () => {
    const h = await makeListeningServer();
    await registerDevice(h, { name: 'P', platform: 'ios', push_token: 'tok-resurrect' });
    const { body } = await reserve(h, { name: 'x.bin', size: 5 });
    const id = body.transfer.transfer_id;
    await fetch(localize(h, body.upload.url), { method: 'PUT', body: Buffer.from('hello') });

    // Widen complete's stat window so revoke can land inside it.
    const realStat = h.storage.stat.bind(h.storage);
    h.storage.stat = async (k) => {
      const r = await realStat(k);
      await sleep(150);
      return r;
    };
    const completing = complete(h, id);
    await sleep(40);
    assert.equal((await fetch(h.url(`/v1/transfers/${id}`), { method: 'DELETE', headers: auth })).status, 200);
    const done = await completing;
    h.storage.stat = realStat;

    const meta = await h.json(`/v1/transfers/${id}`);
    assert.equal(meta.body.transfer.state, 'revoked', 'complete overwrote a revoke');
    assert.notEqual(done.status, 200, 'complete reported success for a revoked transfer');
    assert.equal(h.push.sent.length, 0, 'a revoked transfer was pushed to recipients');
  });

  test('the janitor cannot reclaim an upload that completed while it was running', async () => {
    const h = await makeListeningServer();
    await registerDevice(h, { name: 'P', platform: 'ios' });
    const { body } = await reserve(h, { name: 'x.bin', size: 5 });
    const id = body.transfer.transfer_id;
    await fetch(localize(h, body.upload.url), { method: 'PUT', body: Buffer.from('hello') });

    const realDelete = h.storage.delete.bind(h.storage);
    let first = true;
    h.storage.delete = async (k) => {
      if (first) {
        first = false;
        await sleep(200);
      }
      return realDelete(k);
    };
    const later = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString();
    const sweeping = runSweep(h, { asOf: later, quiet: true });
    await sleep(40);
    const done = await complete(h, id);
    await sweeping;
    h.storage.delete = realDelete;

    const meta = await h.json(`/v1/transfers/${id}`);
    if (done.status === 200) {
      assert.equal(meta.body.transfer.state, 'complete', 'the sweep cancelled a completed transfer');
      const r = await fetch(h.url(`/v1/transfers/${id}/blob`), { headers: auth, redirect: 'manual' });
      assert.equal(r.status, 302);
      const dl = await fetch(localize(h, r.headers.get('location')));
      assert.equal(await dl.text(), 'hello', 'the sweep deleted a completed transfer’s bytes');
    } else {
      assert.equal(meta.body.transfer.state, 'cancelled');
    }
  });

  test('an aborted PUT releases the key and leaves no temp file', async () => {
    const h = await makeListeningServer();
    await registerDevice(h, { name: 'P', platform: 'ios' });
    const { body } = await reserve(h, { name: 'x.bin', size: 9 });
    const id = body.transfer.transfer_id;
    const u = new URL(body.upload.url);

    // Client vanishes mid-body: the socket dies with the upload claimed.
    const s = slowPut(h.port, u.pathname + u.search, 'AAAA');
    await s.ready;
    await sleep(50);
    s.destroy();
    await s.done;
    await sleep(150);

    assert.deepEqual(blobsOnDisk(h), [], 'an aborted PUT left a partial file or a temp file');
    // The claim must be gone, or this reservation is wedged until the janitor.
    const retry = await fetch(localize(h, body.upload.url), { method: 'PUT', body: 'ABCDEFGHI' });
    assert.equal(retry.status, 204, 'the key stayed claimed after the client vanished');
    assert.equal((await complete(h, id)).status, 200);
  });

  test('concurrent completes push exactly once', async () => {
    const h = await makeListeningServer();
    await registerDevice(h, { name: 'P', platform: 'ios', push_token: 'tok-once' });
    const { body } = await reserve(h, { name: 'x.bin', size: 4 });
    const id = body.transfer.transfer_id;
    await fetch(localize(h, body.upload.url), { method: 'PUT', body: Buffer.from('abcd') });

    const rs = await Promise.all(
      Array.from({ length: 6 }, () => h.fetch(`/v1/transfers/${id}/complete`, { method: 'POST' })),
    );
    for (const r of rs) assert.equal(r.status, 200, 'a concurrent complete failed');
    assert.equal(h.push.sent.length, 1, `pushed ${h.push.sent.length} times for one transfer`);
  });

  test('complete refuses while bytes are still moving', async () => {
    const h = await makeListeningServer();
    await registerDevice(h, { name: 'P', platform: 'ios' });
    const { body } = await reserve(h, { name: 'x.bin', size: 9 });
    const u = new URL(body.upload.url);
    const s = slowPut(h.port, u.pathname + u.search, 'AAAA');
    await s.ready;
    await sleep(50);
    const early = await complete(h, body.transfer.transfer_id);
    assert.equal(early.status, 400);
    s.write('BBBBB');
    s.end();
    await s.done;
    assert.equal((await complete(h, body.transfer.transfer_id)).status, 200);
  });
});

/* -------------------------------------------------------------------------- */
/* state leaks and hostile metadata                                           */
/* -------------------------------------------------------------------------- */

describe('presigned upload — state and metadata', () => {
  test('unverified bytes are not downloadable while the transfer is uploading', async () => {
    const h = await makeListeningServer();
    await registerDevice(h, { name: 'P', platform: 'ios' });
    const { body } = await reserve(h, { name: 'x.bin', size: 400 });
    await fetch(localize(h, body.upload.url), { method: 'PUT', body: Buffer.from('partial') });

    const r = await fetch(h.url(`/v1/transfers/${body.transfer.transfer_id}/blob`), {
      headers: auth,
      redirect: 'manual',
    });
    assert.ok(r.status >= 400, `unverified bytes were handed out (${r.status})`);
  });

  test('no terminal state accepts more bytes on its upload URL', async () => {
    const h = await makeListeningServer();
    await registerDevice(h, { name: 'P', platform: 'ios' });

    /** Reserve, upload 5 bytes, then drive the transfer into `finish`. */
    const drive = async (finish) => {
      const { body } = await reserve(h, { name: 'x.bin', size: 5 });
      const id = body.transfer.transfer_id;
      await fetch(localize(h, body.upload.url), { method: 'PUT', body: Buffer.from('hello') });
      await finish(id);
      const again = await fetch(localize(h, body.upload.url), {
        method: 'PUT',
        body: Buffer.from('evil!'),
      });
      return { id, again, url: body.upload.url };
    };

    const completed = await drive((id) => complete(h, id));
    assert.ok(completed.again.status >= 400, 'a completed transfer accepted new bytes');

    const revoked = await drive((id) =>
      fetch(h.url(`/v1/transfers/${id}`), { method: 'DELETE', headers: auth }),
    );
    assert.ok(revoked.again.status >= 400, 'a revoked transfer accepted new bytes');

    const cancelled = await drive(async () => {
      const later = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString();
      await runSweep(h, { asOf: later, quiet: true });
    });
    assert.ok(cancelled.again.status >= 400, 'a cancelled transfer accepted new bytes');

    // And the completed one still serves exactly what was verified.
    const r = await fetch(h.url(`/v1/transfers/${completed.id}/blob`), {
      headers: auth,
      redirect: 'manual',
    });
    const dl = await fetch(localize(h, r.headers.get('location')));
    assert.equal(await dl.text(), 'hello');
  });

  test('a hostile mime_type cannot be stored, let alone served', async () => {
    const h = await makeListeningServer();
    await registerDevice(h, { name: 'P', platform: 'ios' });
    for (const mime of ['text/plain\r\nX-Injected: yes', 'text/plain\nSet-Cookie: a=b', 'x'.repeat(5000)]) {
      const { res } = await reserve(h, { name: 'x.bin', size: 4, mime_type: mime });
      assert.equal(res.status, 400, `mime_type ${JSON.stringify(mime.slice(0, 30))} was accepted`);
    }
  });

  test('a file_name too long for a response header is refused at reservation', async () => {
    const h = await makeListeningServer();
    await registerDevice(h, { name: 'P', platform: 'ios' });
    const { res } = await reserve(h, { name: 'A'.repeat(40000), size: 4 });
    assert.equal(res.status, 400, 'a 40 KB filename was accepted and will break the download');
  });

  test('a legitimate download still works after all of the above', async () => {
    const h = await makeListeningServer();
    await registerDevice(h, { name: 'P', platform: 'ios' });
    const bytes = crypto.randomBytes(64 * 1024);
    const { body } = await reserve(h, {
      name: 'clip.mov',
      mime_type: 'video/quicktime',
      size: bytes.length,
    });
    assert.equal((await fetch(localize(h, body.upload.url), { method: 'PUT', body: bytes })).status, 204);
    assert.equal((await complete(h, body.transfer.transfer_id)).status, 200);
    const r = await fetch(h.url(`/v1/transfers/${body.transfer.transfer_id}/blob`), {
      headers: auth,
      redirect: 'manual',
    });
    const dl = await fetch(localize(h, r.headers.get('location')));
    assert.equal(dl.headers.get('content-type'), 'video/quicktime');
    assert.deepEqual(Buffer.from(await dl.arrayBuffer()), bytes);
  });
});

/* -------------------------------------------------------------------------- */
/* storage exhaustion                                                         */
/* -------------------------------------------------------------------------- */

describe('presigned upload — resource bounds', () => {
  test('reservations in flight are bounded', async () => {
    const h = await makeListeningServer();
    await registerDevice(h, { name: 'P', platform: 'ios' });
    let issued = 0;
    let refused = null;
    for (let i = 0; i < 80; i++) {
      const { res, body } = await reserve(h, { name: `junk${i}.bin`, size: 1024 });
      if (res.status === 200) {
        issued += 1;
        continue;
      }
      refused = body;
      break;
    }
    assert.ok(refused, `all ${issued} reservations were granted — nothing bounds parked uploads`);
    assert.match(refused.error.message, /in flight|too many/i);
  });

  test('a reclaimed upload frees its slot again', async () => {
    const h = await makeListeningServer();
    await registerDevice(h, { name: 'P', platform: 'ios' });
    let last = null;
    for (let i = 0; i < 80; i++) {
      const { res, body } = await reserve(h, { name: `j${i}.bin`, size: 1024 });
      if (res.status !== 200) break;
      last = body;
    }
    assert.ok(last);
    const later = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString();
    await runSweep(h, { asOf: later, quiet: true });
    const { res } = await reserve(h, { name: 'after-sweep.bin', size: 1024 });
    assert.equal(res.status, 200, 'the janitor did not free the in-flight budget');
  });
});

/* -------------------------------------------------------------------------- */
/* drivers                                                                    */
/* -------------------------------------------------------------------------- */

describe('storage drivers — presign hygiene', () => {
  test('the local upload URL carries no secret', async () => {
    const dir = fs.mkdtempSync('/tmp/transmat-presign-');
    try {
      const st = createLocalStorage({
        blobDir: path.join(dir, 'blobs'),
        blobSigningSecret: 'SUPERSECRETVALUE',
        publicBaseUrl: 'http://example.test',
      });
      const put = await st.presignPut('abc123', 60);
      const get = await st.signedUrl('abc123', 60);
      assert.ok(!put.url.includes('SUPERSECRETVALUE'));
      assert.ok(!get.includes('SUPERSECRETVALUE'));
      assert.notEqual(new URL(put.url).searchParams.get('sig'), new URL(get).searchParams.get('sig'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('two same-tick puts to one key do not collide on a temp file', async () => {
    const dir = fs.mkdtempSync('/tmp/transmat-tmpname-');
    try {
      const st = createLocalStorage({
        blobDir: path.join(dir, 'blobs'),
        blobSigningSecret: 's',
        publicBaseUrl: 'http://example.test',
      });
      const { Readable } = await import('node:stream');
      const slow = () =>
        Readable.from(
          (async function* () {
            yield Buffer.from('AAAA');
            await sleep(30);
            yield Buffer.from('BBBB');
          })(),
        );
      // Freeze the clock: the temp name must not depend on it.
      const realNow = Date.now;
      Date.now = () => 1700000000000;
      let results;
      try {
        results = await Promise.allSettled([st.put('k', slow()), st.put('k', slow())]);
      } finally {
        Date.now = realNow;
      }
      for (const r of results) {
        assert.equal(r.status, 'fulfilled', `same-tick put collided: ${r.reason?.message}`);
      }
      assert.deepEqual(fs.readdirSync(path.join(dir, 'blobs')), ['k'], 'a temp file was left behind');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('r2 presigned PUT', () => {
  test(
    'the URL pins no payload checksum and leaks no secret',
    { skip: S3rver ? false : 's3rver not installed' },
    async () => {
      const { createR2Storage } = await import('../src/storage.js');
      const dir = `/tmp/transmat-s3-attack-${crypto.randomUUID()}`;
      fs.mkdirSync(dir, { recursive: true });
      const s3 = new S3rver({
        port: 4623,
        address: '127.0.0.1',
        silent: true,
        directory: dir,
        configureBuckets: [{ name: 'attack' }],
      });
      await s3.run();
      try {
        const storage = await createR2Storage({
          r2: {
            accountId: 'local',
            accessKeyId: 'S3RVER',
            secretAccessKey: 'S3RVER',
            bucket: 'attack',
            endpoint: 'http://127.0.0.1:4623',
          },
        });
        const p = await storage.presignPut('r2attack', 900, { contentType: 'text/plain' });
        const params = new URL(p.url).searchParams;

        // The SDK's flexible-checksum default hoists x-amz-checksum-crc32 for
        // the *empty* body it signed. Real S3/R2 validates it, so every
        // non-empty PUT to such a URL fails with BadDigest.
        for (const [k] of params) {
          assert.ok(
            !/checksum/i.test(k),
            `presigned PUT pins ${k}=${params.get(k)} — a real S3 rejects any body that does not match`,
          );
        }
        assert.ok(!p.url.includes('S3RVER=') && !p.url.includes('secretAccessKey'));

        const put = await fetch(p.url, { method: 'PUT', body: 'hello world' });
        assert.equal(put.status, 200, `presigned PUT failed: ${put.status}`);
        assert.equal((await storage.stat('r2attack')).size, 11);
      } finally {
        await s3.close().catch(() => {});
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test(
    'the whole two-phase flow works end to end against a real S3',
    { skip: S3rver ? false : 's3rver not installed' },
    async () => {
      const { createR2Storage } = await import('../src/storage.js');
      const dir = `/tmp/transmat-s3-e2e-${crypto.randomUUID()}`;
      fs.mkdirSync(dir, { recursive: true });
      const s3 = new S3rver({
        port: 4624,
        address: '127.0.0.1',
        silent: true,
        directory: dir,
        configureBuckets: [{ name: 'e2e' }],
      });
      await s3.run();
      try {
        const storage = await createR2Storage({
          r2: {
            accountId: 'local',
            accessKeyId: 'S3RVER',
            secretAccessKey: 'S3RVER',
            bucket: 'e2e',
            endpoint: 'http://127.0.0.1:4624',
          },
        });
        const h = await makeListeningServer({ drivers: { storage } });
        await registerDevice(h, { name: 'Phone', platform: 'ios', push_token: 'tok-r2' });
        const bytes = crypto.randomBytes(128 * 1024);

        const { res, body } = await reserve(h, {
          name: 'clip.mov',
          mime_type: 'video/quicktime',
          size: bytes.length,
        });
        assert.equal(res.status, 200);

        // Exactly what a background URLSession does: one PUT, no bearer.
        const put = await fetch(body.upload.url, { method: 'PUT', body: bytes });
        assert.equal(put.status, 200, `presigned PUT to R2 failed with ${put.status}`);

        const done = await complete(h, body.transfer.transfer_id);
        assert.equal(done.status, 200);
        assert.equal((await done.json()).transfer.state, 'complete');
        assert.equal(h.push.sent.length, 1);

        const r = await fetch(h.url(`/v1/transfers/${body.transfer.transfer_id}/blob`), {
          headers: auth,
          redirect: 'manual',
        });
        assert.equal(r.status, 302);
        const dl = await fetch(r.headers.get('location'));
        assert.deepEqual(Buffer.from(await dl.arrayBuffer()), bytes);

        // Direct PUT uploads never reach this server, so the local /blob route
        // must refuse them outright rather than half-implementing them.
        const local = await fetch(h.url('/blob/whatever?exp=1&sig=x'), { method: 'PUT', body: 'x' });
        assert.equal(local.status, 404);
      } finally {
        await s3.close().catch(() => {});
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
