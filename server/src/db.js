/**
 * SQLite persistence, on node:sqlite's DatabaseSync (Node >= 22.5, no native
 * module to build). Exports an `openDb()` factory returning small query
 * functions — never the raw handle — so routes stay declarative and tests can
 * spin up a throwaway database.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

/** Migrations: one idempotent exec, run on every boot. */
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS devices (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  platform      TEXT NOT NULL,
  push_channel  TEXT NOT NULL DEFAULT 'none',
  push_token    TEXT,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_push_token
  ON devices(push_token) WHERE push_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_devices_name_platform ON devices(name, platform);
CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON devices(last_seen_at DESC);

CREATE TABLE IF NOT EXISTS transfers (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,
  state           TEXT NOT NULL,
  file_name       TEXT,
  mime_type       TEXT,
  size            INTEGER,
  text            TEXT,
  blob_key        TEXT,
  from_device_id  TEXT REFERENCES devices(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transfers_created_at ON transfers(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_transfers_from_device ON transfers(from_device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transfers_expiry ON transfers(state, expires_at);
CREATE INDEX IF NOT EXISTS idx_transfers_blob_key ON transfers(blob_key);

CREATE TABLE IF NOT EXISTS deliveries (
  id           TEXT PRIMARY KEY,
  transfer_id  TEXT NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
  device_id    TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  state        TEXT NOT NULL DEFAULT 'pending',
  pushed_at    TEXT,
  acked_at     TEXT,
  created_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_transfer_device
  ON deliveries(transfer_id, device_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_transfer ON deliveries(transfer_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_device ON deliveries(device_id, created_at DESC);
`;

export const nowIso = () => new Date().toISOString();
export const newId = () => crypto.randomUUID();

/**
 * @typedef {object} DeviceRow
 * @property {string} id
 * @property {string} name
 * @property {string} platform
 * @property {'apns'|'none'} push_channel
 * @property {string|null} push_token
 * @property {string} created_at
 * @property {string} last_seen_at
 */

/**
 * Open (and migrate) a database.
 * @param {string} filePath absolute path, or ':memory:'
 */
export function openDb(filePath) {
  if (filePath !== ':memory:') {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }
  const db = new DatabaseSync(filePath);
  db.exec(SCHEMA);

  const q = (sql) => db.prepare(sql);

  // --- devices -----------------------------------------------------------
  const sDeviceById = q('SELECT * FROM devices WHERE id = ?');
  const sDeviceByToken = q('SELECT * FROM devices WHERE push_token = ?');
  const sDeviceByNamePlatform = q(
    'SELECT * FROM devices WHERE name = ? AND platform = ? ORDER BY created_at ASC LIMIT 1',
  );
  const sAllDevices = q('SELECT * FROM devices ORDER BY last_seen_at DESC, created_at DESC');
  const sAllDeviceIds = q('SELECT id FROM devices ORDER BY created_at ASC');
  const iDevice = q(`INSERT INTO devices (id, name, platform, push_channel, push_token, created_at, last_seen_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const uDevice = q(`UPDATE devices SET name = ?, platform = ?, push_channel = ?, push_token = ?, last_seen_at = ?
                     WHERE id = ?`);
  const uDeviceName = q('UPDATE devices SET name = ?, last_seen_at = ? WHERE id = ?');
  const uDeviceSeen = q('UPDATE devices SET last_seen_at = ? WHERE id = ?');
  const uClearPushToken = q(
    "UPDATE devices SET push_token = NULL, push_channel = 'none' WHERE id = ?",
  );
  const dDevice = q('DELETE FROM devices WHERE id = ?');

  // --- transfers ---------------------------------------------------------
  const sTransferById = q('SELECT * FROM transfers WHERE id = ?');
  const sTransferByBlobKey = q('SELECT * FROM transfers WHERE blob_key = ? LIMIT 1');
  const iTransfer = q(`INSERT INTO transfers
      (id, kind, state, file_name, mime_type, size, text, blob_key, from_device_id, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const uTransferState = q('UPDATE transfers SET state = ?, blob_key = ? WHERE id = ?');
  // Conditional transition. Every state change that races another request or
  // the janitor goes through this: the WHERE clause is the lock.
  const uTransferStateIf = q(
    'UPDATE transfers SET state = ?, blob_key = ? WHERE id = ? AND state = ?',
  );
  const sCountByState = q('SELECT COUNT(*) AS n FROM transfers WHERE state = ?');
  const uTransferSize = q('UPDATE transfers SET size = ? WHERE id = ?');
  const sStaleUploads = q(
    "SELECT * FROM transfers WHERE state = 'uploading' AND created_at <= ?",
  );
  const sExpirable = q(
    "SELECT * FROM transfers WHERE state = 'complete' AND expires_at <= ?",
  );

  // --- deliveries --------------------------------------------------------
  const iDelivery = q(
    'INSERT INTO deliveries (id, transfer_id, device_id, state, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  const sDeliveriesForTransfer = q(`
    SELECT d.id AS delivery_id, d.device_id, d.state, d.acked_at, d.pushed_at,
           COALESCE(dev.name, '(deleted device)') AS device_name
    FROM deliveries d LEFT JOIN devices dev ON dev.id = d.device_id
    WHERE d.transfer_id = ? ORDER BY d.created_at ASC, d.id ASC`);
  const sDeliveryById = q('SELECT * FROM deliveries WHERE id = ?');
  const sDeviceIdsForTransfer = q('SELECT device_id FROM deliveries WHERE transfer_id = ?');
  const uDeliveryPushed = q(
    "UPDATE deliveries SET state = 'pushed', pushed_at = ? WHERE id = ? AND state = 'pending'",
  );
  const uDeliveryAcked = q(
    "UPDATE deliveries SET state = 'downloaded', acked_at = ? WHERE id = ?",
  );

  const api = {
    /** Escape hatch for migrations/maintenance only. Routes must not use it. */
    _raw: db,
    close() {
      try {
        db.close();
      } catch {
        /* already closed */
      }
    },

    // ---- devices --------------------------------------------------------
    /** @returns {DeviceRow|undefined} */
    getDevice: (id) => sDeviceById.get(id),
    /** @returns {DeviceRow[]} */
    listDevices: () => sAllDevices.all(),
    listDeviceIds: () => sAllDeviceIds.all().map((r) => r.id),

    /**
     * Upsert per the contract: on push_token when present, else name+platform.
     * @param {{name:string, platform:string, push_token?:string|null, push_channel?:string|null}} input
     * @returns {DeviceRow}
     */
    upsertDevice(input) {
      const ts = nowIso();
      const pushToken = input.push_token ? String(input.push_token) : null;
      const pushChannel = input.push_channel
        ? String(input.push_channel)
        : pushToken
          ? 'apns'
          : 'none';

      const existing = pushToken
        ? sDeviceByToken.get(pushToken)
        : sDeviceByNamePlatform.get(input.name, input.platform);

      if (existing) {
        // A re-registration without a push_token keeps the one we already have,
        // so the channel has to be derived from the token that actually ends up
        // stored — otherwise the row claims push_channel='none' while
        // has_push_token=true and APNs keeps firing. An explicit push_channel
        // from the caller still wins.
        const nextToken = pushToken ?? existing.push_token;
        const nextChannel = input.push_channel
          ? String(input.push_channel)
          : nextToken
            ? 'apns'
            : 'none';
        uDevice.run(input.name, input.platform, nextChannel, nextToken, ts, existing.id);
        return sDeviceById.get(existing.id);
      }
      const id = newId();
      iDevice.run(id, input.name, input.platform, pushChannel, pushToken, ts, ts);
      return sDeviceById.get(id);
    },

    renameDevice(id, name) {
      const existing = sDeviceById.get(id);
      if (!existing) return undefined;
      uDeviceName.run(name, nowIso(), id);
      return sDeviceById.get(id);
    },
    touchDevice(id) {
      uDeviceSeen.run(nowIso(), id);
    },
    clearPushToken(id) {
      uClearPushToken.run(id);
    },
    deleteDevice(id) {
      const existing = sDeviceById.get(id);
      if (!existing) return false;
      dDevice.run(id);
      return true;
    },

    // ---- transfers ------------------------------------------------------
    getTransfer: (id) => sTransferById.get(id),
    getTransferByBlobKey: (key) => sTransferByBlobKey.get(key),

    /**
     * Insert a transfer and its deliveries atomically.
     * @param {object} t
     * @param {string[]} targetDeviceIds
     */
    createTransfer(t, targetDeviceIds) {
      const ts = t.created_at ?? nowIso();
      db.exec('BEGIN IMMEDIATE');
      try {
        iTransfer.run(
          t.id,
          t.kind,
          t.state ?? 'complete',
          t.file_name ?? null,
          t.mime_type ?? null,
          t.size ?? null,
          t.text ?? null,
          t.blob_key ?? null,
          t.from_device_id ?? null,
          ts,
          t.expires_at,
        );
        for (const deviceId of targetDeviceIds) {
          iDelivery.run(newId(), t.id, deviceId, 'pending', nowIso());
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return sTransferById.get(t.id);
    },

    setTransferSize(id, size) {
      uTransferSize.run(size, id);
    },

    /** Transfers stuck mid-upload — the client never came back to complete. */
    findStaleUploads(before) {
      return sStaleUploads.all(before);
    },

    setTransferState(id, state, blobKey = null) {
      uTransferState.run(state, blobKey, id);
      return sTransferById.get(id);
    },

    /**
     * Move a transfer from one state to another, but only if it is still in
     * `from`. Returns the updated row, or null if somebody else got there
     * first — a revoke, a concurrent complete, the janitor.
     *
     * This is the whole concurrency story for transfer state: SQLite runs the
     * UPDATE atomically, so exactly one caller can observe `changes === 1` and
     * therefore exactly one caller pushes, announces or deletes bytes.
     */
    transitionTransferState(id, from, to, blobKey = null) {
      const result = uTransferStateIf.run(to, blobKey, id, from);
      return result.changes > 0 ? sTransferById.get(id) : null;
    },

    /** How many transfers are parked mid-upload right now. */
    countTransfersInState: (state) => Number(sCountByState.get(state)?.n ?? 0),

    findExpirable: (asOfIso = nowIso()) => sExpirable.all(asOfIso),

    /**
     * Keyset-paginated listing.
     * @param {{device_id?:string, direction?:string, kind?:string, q?:string, limit?:number, cursor?:{created_at:string,id:string}}} f
     */
    listTransfers(f = {}) {
      // Transfers still mid-upload are not yet real: the bytes are unverified
      // and no recipient has been told. They surface only once completed.
      const where = ["t.state != 'uploading'"];
      const params = [];
      const limit = Math.min(Math.max(Number(f.limit) || 50, 1), 200);

      if (f.device_id) {
        const inClause = 'EXISTS (SELECT 1 FROM deliveries d WHERE d.transfer_id = t.id AND d.device_id = ?)';
        const outClause = 't.from_device_id = ?';
        if (f.direction === 'in') {
          where.push(inClause);
          params.push(f.device_id);
        } else if (f.direction === 'out') {
          where.push(outClause);
          params.push(f.device_id);
        } else {
          where.push(`(${inClause} OR ${outClause})`);
          params.push(f.device_id, f.device_id);
        }
      }
      if (f.kind) {
        where.push('t.kind = ?');
        params.push(f.kind);
      }
      if (f.q) {
        // The ESCAPE clause is not optional: without it SQLite treats the
        // backslash we just inserted as a literal character, so a search for
        // "50%" silently matches nothing and a search for "\\" matches wildly.
        where.push("(t.file_name LIKE ? ESCAPE '\\' OR t.text LIKE ? ESCAPE '\\')");
        const like = `%${String(f.q).replace(/[\\%_]/g, (m) => '\\' + m)}%`;
        params.push(like, like);
      }
      if (f.cursor) {
        where.push('(t.created_at < ? OR (t.created_at = ? AND t.id < ?))');
        params.push(f.cursor.created_at, f.cursor.created_at, f.cursor.id);
      }

      const sql =
        'SELECT t.* FROM transfers t' +
        (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
        ' ORDER BY t.created_at DESC, t.id DESC LIMIT ?';
      const rows = db.prepare(sql).all(...params, limit + 1);
      const hasMore = rows.length > limit;
      return { rows: hasMore ? rows.slice(0, limit) : rows, hasMore };
    },

    // ---- deliveries -----------------------------------------------------
    listDeliveries: (transferId) => sDeliveriesForTransfer.all(transferId),
    getDelivery: (id) => sDeliveryById.get(id),
    deviceIdsForTransfer: (transferId) =>
      sDeviceIdsForTransfer.all(transferId).map((r) => r.device_id),
    markDeliveryPushed(id) {
      uDeliveryPushed.run(nowIso(), id);
    },
    ackDelivery(id) {
      const row = sDeliveryById.get(id);
      if (!row) return undefined;
      uDeliveryAcked.run(nowIso(), id);
      return sDeliveryById.get(id);
    },
  };

  return api;
}

/** @typedef {ReturnType<typeof openDb>} Db */
export default openDb;
