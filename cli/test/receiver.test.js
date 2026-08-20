/**
 * The receive path, driven against a fake API: downloads land, deliveries are
 * acked, names never collide, and a failure leaves nothing half-written and
 * nothing acked.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Receiver } from '../src/commands/watch.js';
import { CliError, EXIT } from '../src/errors.js';

const DEVICE = 'device-me';
const OTHER = 'device-phone';

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'transmat-recv-'));

let seq = 0;
function fileTransfer(name, body, overrides = {}) {
  seq += 1;
  return {
    transfer_id: `t${seq}`,
    kind: 'file',
    state: 'complete',
    file_name: name,
    mime_type: 'application/octet-stream',
    size: Buffer.byteLength(body),
    text: null,
    from_device_id: OTHER,
    from_device_name: "Kirby's iPhone",
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    deliveries: [
      { delivery_id: `d${seq}`, device_id: DEVICE, device_name: 'laptop', state: 'pending', acked_at: null },
    ],
    ...overrides,
  };
}

function textTransfer(text, kind = 'text') {
  seq += 1;
  return {
    transfer_id: `t${seq}`,
    kind,
    state: 'complete',
    file_name: null,
    mime_type: null,
    size: null,
    text,
    from_device_id: OTHER,
    from_device_name: "Kirby's iPhone",
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    deliveries: [
      { delivery_id: `d${seq}`, device_id: DEVICE, device_name: 'laptop', state: 'pending', acked_at: null },
    ],
  };
}

class FakeApi {
  constructor() {
    this.transfers = [];
    this.bodies = new Map();
    this.acked = [];
    this.blobCalls = 0;
    this.failNextBlob = null;
    /** When set, listTransfers paginates like the server does. */
    this.pageSize = 0;
    /** Fail this many acks before starting to accept them. */
    this.failAcks = 0;
  }

  add(transfer, body = '') {
    this.transfers.unshift(transfer); // newest first, like the server
    this.bodies.set(transfer.transfer_id, Buffer.from(body));
    return transfer;
  }

  async listTransfers({ cursor } = {}) {
    if (!this.pageSize) return { transfers: this.transfers };
    const start = cursor ? Number(cursor) : 0;
    const page = this.transfers.slice(start, start + this.pageSize);
    const next = start + this.pageSize;
    return {
      transfers: page,
      next_cursor: next < this.transfers.length ? String(next) : undefined,
    };
  }

  async openBlob(id) {
    this.blobCalls += 1;
    if (this.failNextBlob) {
      const err = this.failNextBlob;
      this.failNextBlob = null;
      throw err;
    }
    const body = this.bodies.get(id);
    return new Response(body, { headers: { 'content-length': String(body.length) } });
  }

  async ackDelivery(id) {
    if (this.failAcks > 0) {
      this.failAcks -= 1;
      throw new CliError('ack exploded', { exitCode: EXIT.ERROR });
    }
    this.acked.push(id);
    // Mirror the server: an acked delivery stops being pending.
    for (const t of this.transfers) {
      for (const d of t.deliveries) if (d.delivery_id === id) d.state = 'downloaded';
    }
    return { ok: true };
  }
}

/** Run a receiver with its output captured, so tests stay quiet and assertable. */
async function withReceiver(fn, { values = {}, ui = { json: true }, receipts = new Map() } = {}) {
  const dir = tmpdir();
  const api = new FakeApi();
  const lines = [];
  // Receipts stay in memory: a unit test must never touch the real
  // ~/.config/transmat, and injecting them is also how the cross-process
  // "already received" path gets tested at all.
  const receiver = new Receiver({
    api,
    deviceId: DEVICE,
    dir,
    values,
    ui,
    receipts,
    saveReceipts: () => {},
    write: (chunk) => lines.push(String(chunk).trimEnd()),
  });
  try {
    await fn({ receiver, api, dir, lines, receipts });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('catchUp downloads a file, writes the exact bytes, and acks it', async () => {
  await withReceiver(async ({ receiver, api, dir, lines }) => {
    const body = 'the quick brown fox\n'.repeat(1000);
    api.add(fileTransfer('report.pdf', body), body);

    const handled = await receiver.catchUp();
    assert.equal(handled, 1);

    const written = fs.readFileSync(path.join(dir, 'report.pdf'));
    assert.equal(written.toString(), body);
    assert.deepEqual(api.acked, ['d' + seq]);

    const record = JSON.parse(lines.at(-1));
    assert.equal(record.action, 'downloaded');
    assert.equal(record.acked, true);
    assert.equal(record.sha256, createHash('sha256').update(body).digest('hex'));
    assert.equal(record.size, Buffer.byteLength(body));
  });
});

test('a second pass does not download the same delivery twice', async () => {
  await withReceiver(async ({ receiver, api }) => {
    api.add(fileTransfer('a.txt', 'hello'), 'hello');
    assert.equal(await receiver.catchUp(), 1);
    assert.equal(await receiver.catchUp(), 0);
    assert.equal(api.blobCalls, 1);
    assert.equal(api.acked.length, 1);
  });
});

test('two transfers with the same name do not clobber each other', async () => {
  await withReceiver(async ({ receiver, api, dir }) => {
    api.add(fileTransfer('report.pdf', 'first'), 'first');
    api.add(fileTransfer('report.pdf', 'second'), 'second');
    assert.equal(await receiver.catchUp(), 2);

    const names = fs.readdirSync(dir).sort();
    assert.deepEqual(names, ['report (2).pdf', 'report.pdf']);
    const contents = names.map((n) => fs.readFileSync(path.join(dir, n), 'utf8')).sort();
    assert.deepEqual(contents, ['first', 'second']);
  });
});

test('a filename from the network cannot escape the download directory', async () => {
  await withReceiver(async ({ receiver, api, dir }) => {
    api.add(fileTransfer('../../../../tmp/pwned.txt', 'nope'), 'nope');
    await receiver.catchUp();
    assert.deepEqual(fs.readdirSync(dir), ['pwned.txt']);
  });
});

test('text and link transfers print instead of writing a file, and still ack', async () => {
  await withReceiver(async ({ receiver, api, dir, lines }) => {
    api.add(textTransfer('the wifi password is hunter2'));
    api.add(textTransfer('https://example.com', 'link'));
    assert.equal(await receiver.catchUp(), 2);
    assert.deepEqual(fs.readdirSync(dir), []);
    assert.equal(api.acked.length, 2);
    const kinds = lines.map((l) => JSON.parse(l).kind).sort();
    assert.deepEqual(kinds, ['link', 'text']);
    assert.equal(JSON.parse(lines[0]).text, 'the wifi password is hunter2');
  });
});

test('revoked and already-downloaded transfers are left alone', async () => {
  await withReceiver(async ({ receiver, api, dir }) => {
    api.add(fileTransfer('gone.txt', 'x', { state: 'revoked' }), 'x');
    const done = fileTransfer('done.txt', 'y');
    done.deliveries[0].state = 'downloaded';
    api.add(done, 'y');
    assert.equal(await receiver.catchUp(), 0);
    assert.deepEqual(fs.readdirSync(dir), []);
    assert.equal(api.blobCalls, 0);
  });
});

test('a transfer addressed to someone else is ignored', async () => {
  await withReceiver(async ({ receiver, api, dir }) => {
    const t = fileTransfer('notmine.txt', 'x');
    t.deliveries[0].device_id = 'someone-else';
    api.add(t, 'x');
    assert.equal(await receiver.catchUp(), 0);
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});

test('a failed download leaves no file, no ack, and is retried next time', async () => {
  await withReceiver(async ({ receiver, api, dir }) => {
    const body = 'important';
    api.add(fileTransfer('flaky.bin', body), body);
    api.failNextBlob = new CliError('connection reset', { exitCode: EXIT.NETWORK });

    assert.equal(await receiver.catchUp(), 0);
    assert.deepEqual(fs.readdirSync(dir), [], 'nothing half-written is left behind');
    assert.deepEqual(api.acked, []);

    // The next poll (i.e. the next reconnect) picks it up.
    assert.equal(await receiver.catchUp(), 1);
    assert.equal(fs.readFileSync(path.join(dir, 'flaky.bin'), 'utf8'), body);
    assert.equal(api.acked.length, 1);
  });
});

test('a revoked-mid-flight transfer is dropped, not retried forever', async () => {
  await withReceiver(async ({ receiver, api }) => {
    api.add(fileTransfer('gone.bin', 'x'), 'x');
    api.failNextBlob = new CliError('this transfer was revoked by the sender', {
      exitCode: EXIT.NOT_FOUND,
      code: 'revoked',
    });
    assert.equal(await receiver.catchUp(), 0);
    assert.equal(await receiver.catchUp(), 0, 'not retried');
    assert.equal(api.blobCalls, 1);
  });
});

test('onEvent handles transfer.created and ignores unparseable payloads', async () => {
  await withReceiver(async ({ receiver, api, dir }) => {
    const t = fileTransfer('pushed.txt', 'hi');
    api.bodies.set(t.transfer_id, Buffer.from('hi'));
    api.transfers.unshift(t);

    await receiver.onEvent({ type: 'event', event: 'transfer.created', data: '{ not json' });
    assert.deepEqual(fs.readdirSync(dir), []);

    await receiver.onEvent({
      type: 'event',
      event: 'transfer.created',
      data: JSON.stringify({ transfer: t }),
    });
    assert.equal(fs.readFileSync(path.join(dir, 'pushed.txt'), 'utf8'), 'hi');
    assert.equal(api.acked.length, 1);

    // The catch-up poll must not download it a second time.
    assert.equal(await receiver.catchUp(), 0);
  });
});

test('--no-download reports arrivals without fetching or acking', async () => {
  await withReceiver(
    async ({ receiver, api, dir, lines }) => {
      api.add(fileTransfer('big.iso', 'x'), 'x');
      await receiver.catchUp();
      assert.deepEqual(fs.readdirSync(dir), []);
      assert.deepEqual(api.acked, []);
      assert.equal(api.blobCalls, 0);
      assert.equal(JSON.parse(lines.at(-1)).action, 'skipped');
    },
    { values: { 'no-download': true } },
  );
});

test('--no-ack downloads but leaves the delivery pending', async () => {
  await withReceiver(
    async ({ receiver, api, dir, lines }) => {
      api.add(fileTransfer('keep.txt', 'body'), 'body');
      await receiver.catchUp();
      assert.equal(fs.readFileSync(path.join(dir, 'keep.txt'), 'utf8'), 'body');
      assert.deepEqual(api.acked, []);
      assert.equal(JSON.parse(lines.at(-1)).acked, false);
    },
    { values: { 'no-ack': true } },
  );
});

/* ------------------------------------ regression: reconnect and duplicates */

test('a transfer_id from the network cannot escape the download directory', async () => {
  // The .part file was named from the raw transfer_id, so "x/../../PWNED"
  // truncated a file outside the download directory and then renamed it away.
  await withReceiver(async ({ receiver, api, dir }) => {
    const outside = path.join(dir, '..', `victim-${process.pid}.part`);
    fs.writeFileSync(outside, 'PRECIOUS');
    api.add(fileTransfer('ok.txt', 'body', { transfer_id: 'x/../../PWNED' }), 'body');
    await receiver.catchUp();
    assert.equal(fs.readFileSync(outside, 'utf8'), 'PRECIOUS', 'the outside file is untouched');
    for (const name of fs.readdirSync(dir)) {
      assert.ok(!name.includes('..'), `${name} should not contain a traversal`);
    }
    fs.rmSync(outside, { force: true });
  });
});

test('a null file_name falls back to a scrubbed id, not a raw one', async () => {
  await withReceiver(async ({ receiver, api, dir }) => {
    api.add(fileTransfer(null, 'body', { transfer_id: 'x/../../ESCAPED' }), 'body');
    await receiver.catchUp();
    const written = fs.readdirSync(dir);
    assert.equal(written.length, 1);
    assert.ok(!written[0].includes('/'));
    assert.equal(fs.existsSync(path.join(dir, '..', 'ESCAPED.bin')), false);
  });
});

test('catchUp walks past the first page so a backlog is not stranded', async () => {
  await withReceiver(async ({ receiver, api, dir }) => {
    // 105 waiting, newest first, served 100 at a time — the five oldest used
    // to be invisible forever because next_cursor was ignored.
    const all = [];
    for (let i = 0; i < 105; i += 1) all.push(fileTransfer(`f${i}.txt`, 'x'));
    for (const t of all) api.add(t, 'x');
    api.pageSize = 100;
    assert.equal(await receiver.catchUp(), 105);
    assert.equal(fs.readdirSync(dir).length, 105);
    assert.equal(api.acked.length, 105);
  });
});

test('a failed ack does not cause the file to be downloaded twice', async () => {
  await withReceiver(async ({ receiver, api, dir }) => {
    api.add(fileTransfer('once.bin', 'body'), 'body');
    api.failAcks = 2;
    await receiver.catchUp();
    assert.deepEqual(fs.readdirSync(dir), ['once.bin']);
    assert.equal(api.blobCalls, 1);

    // The next reconnect's poll: retry the ack, do not fetch the bytes again.
    await receiver.catchUp();
    assert.deepEqual(fs.readdirSync(dir), ['once.bin'], 'no "once (2).bin"');
    assert.equal(api.blobCalls, 1, 'the blob is not fetched a second time');

    await receiver.catchUp();
    assert.equal(api.acked.length >= 1, true, 'the ack eventually lands');
  });
});

test('a receipt from an earlier process suppresses a duplicate download', async () => {
  const receipts = new Map();
  await withReceiver(
    async ({ receiver, api, dir }) => {
      const t = fileTransfer('cron.bin', 'body');
      api.add(t, 'body');
      receipts.set(t.transfer_id, {
        delivery_id: t.deliveries[0].delivery_id,
        path: '/somewhere/cron.bin',
        acked: false,
        at: new Date().toISOString(),
      });
      await receiver.catchUp();
      assert.deepEqual(fs.readdirSync(dir), [], 'nothing re-downloaded');
      assert.equal(api.blobCalls, 0);
      assert.equal(api.acked.length, 1, 'but the outstanding ack is retried');
    },
    { receipts },
  );
});
