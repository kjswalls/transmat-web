/**
 * transmat watch — the receiver, and the half of the loop that makes a laptop
 * a real device.
 *
 * Shape of the thing:
 *   connect SSE  →  catch up by polling  →  handle events  →  (drop) → backoff → repeat
 *
 * The poll happens *after* the stream is live, not before: anything created
 * while we were away shows up in the poll, and anything created during the
 * poll shows up on the stream, so the seam between them can't lose a transfer.
 * Every handled transfer is remembered by id, so seeing it twice is free.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { Api } from '../api.js';
import { expandHome, requireDevice } from '../config.js';
import { CliError, EXIT } from '../errors.js';
import { ensureDir, openWithoutClobbering, resolveInside, safeFileName, safeIdSegment } from '../files.js';
import { readReceipts, writeReceipts } from '../receipts.js';
import { backoffDelay, parseSSE } from '../sse.js';
import { color, err, formatBytes, out, progress } from '../ui.js';

/**
 * The contract promises a `:keepalive` comment every 25s. Three missed ones
 * and the connection is dead even if the socket still looks open — which is
 * exactly what a sleeping laptop, a wifi change or a silently-dropped proxy
 * connection looks like from here. Without this the watcher sits forever
 * showing "● watching" and receives nothing.
 */
const SSE_IDLE_MS = envMs('TRANSMAT_SSE_IDLE_MS', 75_000);

/** No bytes for this long mid-download and the transfer is not coming back. */
const DOWNLOAD_IDLE_MS = envMs('TRANSMAT_STALL_MS', 60_000);

/** A connection that dies this fast never really came up; keep backing off. */
const HEALTHY_CONNECTION_MS = 30_000;

/** Pages of 100 the catch-up poll will walk before giving up. */
const MAX_CATCHUP_PAGES = 50;

function envMs(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

/**
 * A dead-man's switch. `kick()` on every byte that arrives; if `ms` passes
 * without one, `onStall` runs.
 */
function stallWatchdog(ms, onStall) {
  let timer = null;
  const kick = () => {
    if (timer) clearTimeout(timer);
    if (ms > 0) {
      timer = setTimeout(onStall, ms);
      timer.unref?.();
    }
  };
  return {
    kick,
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

export const spec = {
  name: 'watch',
  summary: 'receive anything sent to this device',
  usage: 'transmat watch [--dir <path>] [--once]',
  options: {
    dir: { type: 'string', short: 'd' },
    once: { type: 'boolean', default: false },
    'no-download': { type: 'boolean', default: false },
    'no-ack': { type: 'boolean', default: false },
    quiet: { type: 'boolean', short: 'q', default: false },
    verbose: { type: 'boolean', short: 'v', default: false },
  },
  help: `
Listen for transfers addressed to this machine, download them, and ack them.

  transmat watch
  transmat watch --dir ~/Desktop
  transmat watch --once           # drain whatever is waiting, then exit
  transmat watch --json | jq -r .path

Files land in the download directory (default ~/Downloads, or --dir), never
overwriting an existing file: "report.pdf" becomes "report (2).pdf". Text and
link transfers are printed to stdout instead of being written to disk.

The connection reconnects with exponential backoff when it drops, and polls
GET /v1/transfers on every reconnect so nothing sent while it was down is
missed — walking past the first page of results, so a backlog bigger than one
page is not stranded. A stream that goes silent for 75s (three missed
keepalives) counts as dropped, which is what makes a sleeping laptop or a
changed network reconnect instead of sitting there looking connected. A
download that delivers no bytes for 60s is abandoned and retried later.

A file whose ack didn't reach the server is remembered, so it is not
downloaded a second time as "report (2).pdf" on the next poll.

options:
  -d, --dir <path>    where files land (default: ~/Downloads)
      --once          poll once for anything pending, then exit — no streaming
      --no-download   print arrivals but don't fetch the bytes (and don't ack)
      --no-ack        download, but leave the delivery unacked
  -q, --quiet         only print arrivals, no connection chatter
  -v, --verbose       also report acks from other devices and keepalives
      --json          one JSON object per line, per arrival (newline-delimited)
`.trim(),
};

const DEFAULT_DIR = path.join(os.homedir(), 'Downloads');

export async function run({ values }) {
  const config = requireDevice();
  const api = new Api(config);
  const deviceId = config.device_id;

  const dir = path.resolve(expandHome(values.dir || config.download_dir || DEFAULT_DIR));
  try {
    ensureDir(dir);
    fs.accessSync(dir, fs.constants.W_OK);
  } catch (cause) {
    throw new CliError(`cannot write to ${dir}: ${cause.message}`, {
      hint: 'pick another directory with --dir',
      cause,
    });
  }

  const ui = {
    json: Boolean(values.json),
    quiet: Boolean(values.quiet),
    verbose: Boolean(values.verbose),
  };
  const receiver = new Receiver({ api, deviceId, deviceName: config.device_name, dir, values, ui });

  if (values.once) {
    const handled = await receiver.catchUp();
    if (!ui.json && !ui.quiet) {
      err(color.dim(handled ? `${handled} transfer${handled === 1 ? '' : 's'} received` : 'nothing waiting'));
    }
    // `transmat watch --once && do-something-with-the-files` has to be able to
    // tell "nothing waiting" from "the download failed".
    return receiver.failed ? EXIT.ERROR : EXIT.OK;
  }

  return runForever({ api, deviceId, receiver, dir, ui });
}

/* -------------------------------------------------------------- the loop */

async function runForever({ api, deviceId, receiver, dir, ui }) {
  const controller = new AbortController();
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    controller.abort();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  let attempt = 0;
  let everConnected = false;

  /**
   * A connection that stayed up long enough to be real earns a reset; one
   * that dies on arrival does not, or a server that accepts and instantly
   * closes turns the "backoff" into a fixed sub-second retry loop.
   */
  const nextAttempt = (connectedAt) =>
    connectedAt && Date.now() - connectedAt >= HEALTHY_CONNECTION_MS ? 1 : attempt + 1;

  while (!stopping) {
    // One controller per connection, so the stall watchdog can drop *this*
    // stream without tearing down the whole command.
    const conn = new AbortController();
    let stalled = false;
    const signal = AbortSignal.any([controller.signal, conn.signal]);

    let response;
    try {
      response = await api.openEvents({ deviceId, signal });
    } catch (cause) {
      if (stopping) break;
      // A 401 will never fix itself by retrying; anything else might.
      if (cause?.exitCode === EXIT.AUTH) throw cause;
      attempt = nextAttempt(null);
      await sleepOrStop(reportRetry(cause, attempt, ui), controller.signal);
      continue;
    }

    const connectedAt = Date.now();
    // Deliberately *not* resetting `attempt` here: a connection is only proof
    // of health once it has survived a while, and nextAttempt() is what
    // decides. Zeroing it on connect is what let a server that accepts and
    // instantly closes spin at a fixed half-second forever.
    if (!ui.quiet && !ui.json) {
      err(
        `${color.green('●')} watching as ${color.bold(receiver.deviceName ?? deviceId)} ` +
          `${color.dim(`→ ${dir}`)}${everConnected ? color.dim(' (reconnected)') : ''}`,
      );
    }
    everConnected = true;

    const watchdog = stallWatchdog(SSE_IDLE_MS, () => {
      stalled = true;
      conn.abort();
    });

    try {
      // Poll after the stream is live: the two windows overlap, so nothing falls
      // between them.
      watchdog.kick();
      await receiver.catchUp();
      for await (const event of parseSSE(response.body)) {
        watchdog.kick();
        if (stopping) break;
        if (event.type === 'comment') {
          if (ui.verbose) err(color.dim(`  :${event.text}`));
          continue;
        }
        await receiver.onEvent(event);
      }
    } catch (cause) {
      if (stopping) break;
      if (cause?.exitCode === EXIT.AUTH) throw cause;
      attempt = nextAttempt(stalled ? null : connectedAt);
      const why = stalled
        ? new Error(`no keepalive for ${Math.round(SSE_IDLE_MS / 1000)}s — connection is dead`)
        : cause;
      await sleepOrStop(reportRetry(why, attempt, ui), controller.signal);
      continue;
    } finally {
      watchdog.stop();
    }

    if (stopping) break;
    // Clean end of stream: the server restarted or a proxy timed us out.
    attempt = nextAttempt(connectedAt);
    await sleepOrStop(reportRetry(new Error('stream closed'), attempt, ui), controller.signal);
  }

  if (!ui.quiet && !ui.json) err(color.dim('stopped watching'));
  return EXIT.OK;
}

function reportRetry(cause, attempt, ui) {
  const delay = backoffDelay(attempt);
  if (!ui.quiet && !ui.json) {
    const why = cause?.message ?? String(cause);
    err(color.yellow(`… disconnected (${why}); reconnecting in ${(delay / 1000).toFixed(1)}s`));
  }
  return delay;
}

/** "This operation was aborted" tells the user nothing; say what happened. */
function stallMessage(cause, signal) {
  if (!signal?.aborted) return cause;
  return new CliError(
    `download stalled — no data for ${Math.round(DOWNLOAD_IDLE_MS / 1000)}s`,
    { cause },
  );
}

function sleepOrStop(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
  });
}

/* --------------------------------------------------------------- receiver */

export class Receiver {
  constructor({ api, deviceId, deviceName = null, dir, values = {}, ui = {}, write, receipts, saveReceipts } = {}) {
    this.api = api;
    this.deviceId = deviceId;
    this.deviceName = deviceName;
    this.dir = dir;
    this.values = values;
    this.ui = ui;
    /** Injectable so tests can read what a run reported without hijacking stdout. */
    this.write = write ?? ((chunk) => process.stdout.write(chunk));
    /** Transfers already handled (or in flight), so the stream and the poll can overlap. */
    this.seen = new Set();
    /** Downloaded, but the ack didn't land: transfer_id → delivery. */
    this.pendingAcks = new Map();
    this.count = 0;
    /** Transfers that errored out — the exit code of `--once` depends on it. */
    this.failed = 0;
    /** Has this process read the whole backlog once? See catchUp(). */
    this.walkedFully = false;
    /** Cross-process memory of what already landed on this disk. */
    this.receipts = receipts ?? readReceipts();
    this.saveReceipts = saveReceipts ?? ((map) => writeReceipts(map));
  }

  /**
   * GET /v1/transfers — everything addressed here that we haven't taken yet.
   *
   * Paginated, because a single page is not the same thing as "everything
   * waiting". Sending 105 things to a device that was offline used to strand
   * the five oldest forever: the poll asked for the newest 100, ignored
   * `next_cursor`, and SSE never replays history. Keep walking while a page
   * still contains something pending for us, then stop — a device that is up
   * to date pays for exactly one request.
   */
  async catchUp() {
    await this.retryPendingAcks();

    /** @type {object[]} */
    const waiting = [];
    let cursor;
    for (let page = 0; page < MAX_CATCHUP_PAGES; page += 1) {
      const { transfers, next_cursor } = await this.api.listTransfers({
        device_id: this.deviceId,
        direction: 'in',
        limit: 100,
        cursor,
      });
      const mine = transfers.filter((t) => this.isForUs(t));
      waiting.push(...mine);
      if (!next_cursor || !transfers.length) break;
      // The first sweep of a process reads the whole (bounded) history, so a
      // backlog that sank below the first page is still found. After that the
      // front of the list is enough: keep reading only while it is still
      // producing work.
      if (this.walkedFully && !mine.length) break;
      cursor = next_cursor;
    }
    this.walkedFully = true;

    let handled = 0;
    // The list is newest-first; deliver in the order things were sent.
    for (const transfer of waiting.reverse()) {
      if (await this.handle(transfer)) handled += 1;
    }
    return handled;
  }

  /** Cheap pre-filter: is this transfer one we still owe a download for? */
  isForUs(transfer) {
    return transfer?.state === 'complete' && Boolean(this.pendingDelivery(transfer));
  }

  /**
   * Acks that never landed (the server went away between the last byte and
   * the POST). Retried before every catch-up poll — without this the delivery
   * stays `pending` and the very next poll downloads the file a second time
   * as "report (2).pdf".
   */
  async retryPendingAcks() {
    for (const [transferId, delivery] of [...this.pendingAcks]) {
      try {
        await this.api.ackDelivery(delivery.delivery_id);
        this.pendingAcks.delete(transferId);
      } catch (cause) {
        // 404/410: the transfer is gone, so the ack is moot. Stop retrying.
        if (cause?.exitCode === EXIT.NOT_FOUND) this.pendingAcks.delete(transferId);
      }
    }
  }

  /** @param {{event?:string, data?:string}} event */
  async onEvent(event) {
    let payload;
    try {
      payload = event.data ? JSON.parse(event.data) : {};
    } catch {
      if (this.ui.verbose) err(color.dim(`  ignoring unparseable ${event.event} event`));
      return;
    }

    switch (event.event) {
      case 'transfer.created':
        if (payload.transfer) await this.handle(payload.transfer);
        break;
      case 'transfer.revoked':
        this.seen.delete(payload.transfer_id);
        if (!this.ui.json && !this.ui.quiet) {
          err(color.dim(`  ${payload.transfer_id} was revoked by the sender`));
        }
        break;
      case 'delivery.acked':
        if (this.ui.verbose && payload.device_id !== this.deviceId) {
          err(color.dim(`  ${payload.device_id} downloaded ${payload.transfer_id}`));
        }
        break;
      default:
        if (this.ui.verbose) err(color.dim(`  unknown event ${event.event}`));
    }
  }

  /** The pending delivery for *this* device, if there is one. */
  pendingDelivery(transfer) {
    return (transfer?.deliveries ?? []).find(
      (d) => d.device_id === this.deviceId && d.state !== 'downloaded',
    );
  }

  /**
   * @param {object} transfer a Transfer from the contract
   * @returns {Promise<boolean>} true if we took delivery of it
   */
  async handle(transfer) {
    if (!transfer?.transfer_id) return false;
    if (transfer.state !== 'complete') return false;
    const delivery = this.pendingDelivery(transfer);
    if (!delivery) return false;
    if (this.seen.has(transfer.transfer_id)) return false;

    // Already on this disk from an earlier run whose ack never landed. Finish
    // the job — retry the ack — but do not write the bytes a second time.
    const receipt = this.receipts.get(transfer.transfer_id);
    if (receipt) {
      this.seen.add(transfer.transfer_id);
      if (!receipt.acked && !this.values['no-ack'] && !this.values['no-download']) {
        const acked = await this.ack(transfer, delivery);
        if (acked) this.recordReceipt(transfer, delivery, receipt.path, true);
      }
      if (this.ui.verbose) {
        err(color.dim(`  ${transfer.file_name ?? transfer.kind} already received${receipt.path ? ` → ${receipt.path}` : ''}`));
      }
      return false;
    }

    this.seen.add(transfer.transfer_id);

    try {
      if (transfer.kind === 'file') await this.receiveFile(transfer, delivery);
      else await this.receiveInline(transfer, delivery);
      this.count += 1;
      return true;
    } catch (cause) {
      // Forget it, so the next reconnect's catch-up poll tries again.
      this.seen.delete(transfer.transfer_id);
      const name = transfer.file_name ?? transfer.kind;
      if (cause?.exitCode === EXIT.NOT_FOUND || cause?.code === 'revoked' || cause?.code === 'expired') {
        err(color.dim(`  skipped ${name}: ${cause.message}`));
        this.seen.add(transfer.transfer_id);
        return false;
      }
      this.failed += 1;
      err(`${color.red('✗')} ${name}: ${cause.message}`);
      return false;
    }
  }

  async receiveFile(transfer, delivery) {
    const from = transfer.from_device_name ?? 'unknown';

    if (this.values['no-download']) {
      this.report({ transfer, delivery, action: 'skipped', path: null });
      return;
    }

    // The download gets its own controller so a stalled body can be dropped
    // without killing the watcher. Before this there was no timeout of any
    // kind on the blob leg: a server that sent headers and then went quiet
    // hung `transmat watch` — and `transmat watch --once` in a script —
    // forever.
    const download = new AbortController();
    const watchdog = stallWatchdog(DOWNLOAD_IDLE_MS, () => download.abort(new Error('stalled')));
    watchdog.kick();

    let response;
    try {
      response = await this.api.openBlob(transfer.transfer_id, { signal: download.signal });
    } catch (cause) {
      watchdog.stop();
      throw stallMessage(cause, download.signal);
    }
    const declared = Number(response.headers.get('content-length'));
    const total = Number.isFinite(declared) && declared > 0 ? declared : transfer.size ?? null;

    // Both of these are server-supplied and therefore hostile until proven
    // otherwise: a transfer_id of "x/../../PWNED" used to put the .part file
    // outside the download directory, truncating whatever was already there.
    const safeId = safeIdSegment(transfer.transfer_id, 'transfer');
    const finalName = safeFileName(transfer.file_name, `transfer-${safeId}.bin`);

    // Download into a dotfile first. Nothing ever appears under the real name
    // until the last byte has landed, so a watcher, a Finder window, or the
    // next command in a pipeline never sees a half-written "report.pdf".
    const partPath = resolveInside(this.dir, `.transmat-${safeId}.part`);
    const partFd = fs.openSync(partPath, 'w', 0o600);

    const bar = progress(
      `${color.green('↓')} ${finalName}`,
      total,
      this.ui.json || this.ui.quiet ? { enabled: false } : {},
    );
    const hash = createHash('sha256');
    let bytes = 0;

    try {
      const source = Readable.fromWeb(response.body);
      const counting = async function* counting(stream) {
        for await (const chunk of stream) {
          watchdog.kick();
          hash.update(chunk);
          bytes += chunk.length;
          bar.tick(chunk.length);
          yield chunk;
        }
      };
      await pipeline(counting(source), fs.createWriteStream(null, { fd: partFd, autoClose: true }));
      bar.finish();

      if (total && bytes !== total) {
        throw new CliError(`download truncated: got ${bytes} bytes, expected ${total}`);
      }
    } catch (cause) {
      bar.finish();
      try {
        fs.closeSync(partFd);
      } catch {
        /* the stream already closed it */
      }
      fs.rmSync(partPath, { force: true });
      throw stallMessage(cause, download.signal);
    } finally {
      watchdog.stop();
    }

    // Claim the name with O_EXCL — two watchers on one directory can't both
    // win it — then move the finished bytes on top of the empty placeholder.
    const reserved = openWithoutClobbering(this.dir, finalName);
    fs.closeSync(reserved.fd);
    try {
      fs.renameSync(partPath, reserved.filePath);
    } catch (cause) {
      fs.rmSync(partPath, { force: true });
      fs.rmSync(reserved.filePath, { force: true });
      throw cause;
    }

    // Record before acking: if the ack is what fails, the receipt is exactly
    // what stops the next process re-downloading the file we just wrote.
    this.recordReceipt(transfer, delivery, reserved.filePath, false);
    const acked = await this.ack(transfer, delivery);
    if (acked) this.recordReceipt(transfer, delivery, reserved.filePath, true);
    this.report({
      transfer,
      delivery,
      action: 'downloaded',
      path: reserved.filePath,
      bytes,
      sha256: hash.digest('hex'),
      acked,
      from,
    });
  }

  async receiveInline(transfer, delivery) {
    const acked = await this.ack(transfer, delivery);
    this.report({
      transfer,
      delivery,
      action: 'printed',
      path: null,
      text: transfer.text ?? '',
      acked,
      from: transfer.from_device_name ?? 'unknown',
    });
  }

  /**
   * Write down that these bytes are on this disk, so a later process does not
   * fetch them again just because the ack never landed.
   */
  recordReceipt(transfer, delivery, filePath, acked) {
    this.receipts.delete(transfer.transfer_id);
    this.receipts.set(transfer.transfer_id, {
      delivery_id: delivery.delivery_id,
      path: filePath ?? null,
      acked: Boolean(acked),
      at: new Date().toISOString(),
    });
    this.saveReceipts(this.receipts);
  }

  /**
   * The bytes are already on disk by the time this runs, so a failed ack must
   * never propagate as "the download failed" — that would delete nothing,
   * clear `seen`, and make the next catch-up poll fetch the same file again
   * as "report (2).pdf". Queue it for retry instead.
   *
   * @returns {Promise<boolean>} whether the server has been told
   */
  async ack(transfer, delivery) {
    if (this.values['no-ack'] || this.values['no-download']) {
      if (this.values['no-ack']) this.pendingAcks.delete(transfer.transfer_id);
      return false;
    }
    try {
      await this.api.ackDelivery(delivery.delivery_id);
      this.pendingAcks.delete(transfer.transfer_id);
      return true;
    } catch (cause) {
      if (cause?.exitCode === EXIT.AUTH) throw cause;
      if (cause?.exitCode !== EXIT.NOT_FOUND) this.pendingAcks.set(transfer.transfer_id, delivery);
      err(color.dim(`  ack for ${transfer.transfer_id} failed (${cause.message}); will retry`));
      return false;
    }
  }

  /** Arrivals go to stdout — that's the data. Everything else goes to stderr. */
  report({ transfer, delivery, action, path: filePath, bytes, sha256, text, acked, from }) {
    if (this.ui.json) {
      // Newline-delimited JSON: `transmat watch --json | while read -r line`.
      this.write(
        `${JSON.stringify({
          action,
          transfer_id: transfer.transfer_id,
          delivery_id: delivery.delivery_id,
          kind: transfer.kind,
          file_name: transfer.file_name ?? null,
          path: filePath ?? null,
          size: bytes ?? transfer.size ?? null,
          sha256: sha256 ?? null,
          text: text ?? null,
          from: transfer.from_device_name ?? null,
          from_device_id: transfer.from_device_id ?? null,
          acked: Boolean(acked),
          received_at: new Date().toISOString(),
        })}\n`,
      );
      return;
    }

    const who = from ? color.dim(` from ${from}`) : '';
    if (transfer.kind === 'file') {
      if (action === 'skipped') {
        out(`${color.yellow('·')} ${transfer.file_name}${who} ${color.dim('(not downloaded)')}`);
        return;
      }
      out(
        `${color.green('↓')} ${color.bold(path.basename(filePath))} ` +
          `${color.dim(`(${formatBytes(bytes)})`)}${who} ${color.dim(`→ ${filePath}`)}` +
          `${acked ? '' : color.yellow(' [not acked]')}`,
      );
      return;
    }

    const label = transfer.kind === 'link' ? 'link' : 'text';
    out(`${color.green('↓')} ${color.bold(label)}${who}${acked ? '' : color.yellow(' [not acked]')}`);
    out(text);
  }
}
