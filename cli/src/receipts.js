/**
 * A tiny ledger of transfers whose bytes are already on this disk.
 *
 * It exists for one failure: the ack doesn't land. The download succeeded,
 * the file is written, and then the POST that tells the server so fails —
 * server restarting, wifi gone, the exact moment a watcher is most likely to
 * be disconnected. The delivery stays `pending`, so the next catch-up poll
 * downloads the same bytes again and the user gets "report (2).pdf".
 *
 * A long-running `transmat watch` handles that in memory. A cron'd
 * `transmat watch --once` cannot: it is a new process every time. So the
 * fact is written down, next to the config, at 0600 (a transfer_id is a
 * capability on this server — anyone holding one and the token can fetch the
 * bytes). Bounded to the most recent MAX_RECEIPTS so it never grows without
 * limit.
 */
import fs from 'node:fs';
import path from 'node:path';
import { configPath } from './config.js';

const MAX_RECEIPTS = 500;

export function receiptsPath() {
  return path.join(path.dirname(configPath()), 'receipts.json');
}

/**
 * @typedef {object} Receipt
 * @property {string} delivery_id
 * @property {string|null} path       where the bytes landed
 * @property {boolean} acked
 * @property {string} at              ISO 8601
 */

/** @returns {Map<string, Receipt>} */
export function readReceipts(file = receiptsPath()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return new Map();
    return new Map(Object.entries(parsed.received ?? {}));
  } catch {
    // Missing, unreadable or corrupt: this is a cache, not a source of truth.
    return new Map();
  }
}

/** @param {Map<string, Receipt>} receipts */
export function writeReceipts(receipts, file = receiptsPath()) {
  const trimmed = [...receipts.entries()].slice(-MAX_RECEIPTS);
  const body = `${JSON.stringify({ received: Object.fromEntries(trimmed) }, null, 2)}\n`;
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    // A read-only home directory must not stop files from arriving.
    fs.rmSync(tmp, { force: true });
  }
  return trimmed.length;
}
