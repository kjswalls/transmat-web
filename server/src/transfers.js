/**
 * Transfer creation: the rules from docs/CONTRACT.md in one place, shared by
 * the multipart and JSON paths so they cannot drift.
 */
import { AppError, badRequest, noTargets, tooLarge, notFound } from './errors.js';
import { MAX_TEXT_BYTES, KINDS, BLOB_URL_TTL_SECONDS, MAX_FILE_BYTES, UPLOAD_URL_TTL_SECONDS } from './config.js';
import { newId, nowIso } from './db.js';
import { newBlobKey } from './storage.js';
import { serializeTransfer, transferAudience } from './serialize.js';
import { buildPushPayload } from './push.js';

export const MIN_EXPIRY_DAYS = 1;
export const MAX_EXPIRY_DAYS = 30;
export const DEFAULT_EXPIRY_DAYS = 7;

/** `text` that parses as an http(s) URL is a link. */
export function looksLikeUrl(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  try {
    const u = new URL(trimmed);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Contract: `file` if a file part exists, else `link` if `text` parses as an
 * http(s) URL, else `text`. An explicit `kind` wins.
 * @param {{kind?:string, hasFile:boolean, text?:string|null}} input
 */
export function resolveKind({ kind, hasFile, text }) {
  if (kind != null && kind !== '') {
    const k = String(kind).trim().toLowerCase();
    if (!KINDS.includes(k)) {
      throw badRequest(`kind must be one of ${KINDS.join(', ')} (got "${kind}")`);
    }
    return k;
  }
  if (hasFile) return 'file';
  if (looksLikeUrl(text)) return 'link';
  return 'text';
}

/**
 * Contract targeting rules:
 *  - `to` is repeatable; values are `all`, `others`, or a device_id
 *  - `others` = every device except `from`
 *  - if `from` is absent or unknown, `others` behaves as `all`
 *  - default `others`
 *
 * @param {import('./db.js').Db} db
 * @param {{to?: string[], from?: string|null}} input
 * @returns {{targets: string[], fromDeviceId: string|null, fromKnown: boolean}}
 */
export function resolveTargets(db, { to = [], from = null }) {
  const fromDeviceId = from ? String(from).trim() || null : null;
  const fromDevice = fromDeviceId ? db.getDevice(fromDeviceId) : null;
  const fromKnown = Boolean(fromDevice);

  const tokens = (to.length ? to : ['others'])
    .flatMap((v) => String(v).split(','))
    .map((v) => v.trim())
    .filter(Boolean);

  const allIds = db.listDeviceIds();
  /** @type {Set<string>} */
  const targets = new Set();

  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower === 'all') {
      for (const id of allIds) targets.add(id);
    } else if (lower === 'others') {
      // "If `from` is absent or unknown, `others` behaves as `all`."
      for (const id of allIds) {
        if (fromKnown && id === fromDeviceId) continue;
        targets.add(id);
      }
    } else if (db.getDevice(token)) {
      targets.add(token);
    }
    // An unknown device id contributes nothing; zero total targets is a 400.
  }

  return { targets: [...targets], fromDeviceId, fromKnown };
}

/** 1–30, default 7. Out-of-range values are clamped rather than rejected. */
export function resolveExpiry(raw, now = Date.now()) {
  let days = DEFAULT_EXPIRY_DAYS;
  if (raw != null && String(raw).trim() !== '') {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      throw badRequest(`expires_in_days must be a number between ${MIN_EXPIRY_DAYS} and ${MAX_EXPIRY_DAYS}`);
    }
    days = Math.min(MAX_EXPIRY_DAYS, Math.max(MIN_EXPIRY_DAYS, Math.round(parsed)));
  }
  return {
    days,
    expiresAt: new Date(now + days * 24 * 60 * 60 * 1000).toISOString(),
  };
}

export function assertTextWithinCap(text) {
  const bytes = Buffer.byteLength(text ?? '', 'utf8');
  if (bytes > MAX_TEXT_BYTES) {
    throw tooLarge(`text payload is ${bytes} bytes; the limit is ${MAX_TEXT_BYTES}`);
  }
  return bytes;
}

/**
 * Persist a transfer, fan out deliveries, push, and announce over SSE.
 *
 * @param {{db:import('./db.js').Db, storage:any, push:any, events:any}} ctx
 * @param {object} input
 * @param {string} input.kind
 * @param {string[]} input.to
 * @param {string|null} input.from
 * @param {string|null} [input.fileName]
 * @param {string|null} [input.mimeType]
 * @param {number|null} [input.size]
 * @param {string|null} [input.text]
 * @param {string|null} [input.blobKey]
 * @param {string|number|null} [input.expiresInDays]
 */
export async function createTransfer(ctx, input) {
  const { db } = ctx;
  const { targets, fromDeviceId, fromKnown } = resolveTargets(db, {
    to: input.to,
    from: input.from,
  });

  if (targets.length === 0) {
    throw noTargets(
      db.listDeviceIds().length === 0
        ? 'no devices are registered — POST /v1/devices first'
        : 'no devices matched the requested targets',
    );
  }

  const { expiresAt } = resolveExpiry(input.expiresInDays);
  const id = newId();

  const row = db.createTransfer(
    {
      id,
      kind: input.kind,
      state: 'complete',
      file_name: input.kind === 'file' ? (input.fileName ?? 'file') : null,
      mime_type: input.kind === 'file' ? (input.mimeType ?? 'application/octet-stream') : null,
      size: input.kind === 'file' ? (input.size ?? 0) : null,
      text: input.kind === 'file' ? null : (input.text ?? ''),
      blob_key: input.kind === 'file' ? input.blobKey : null,
      from_device_id: fromKnown ? fromDeviceId : null,
      created_at: nowIso(),
      expires_at: expiresAt,
    },
    targets,
  );

  if (fromKnown && fromDeviceId) db.touchDevice(fromDeviceId);

  return announceTransfer(ctx, row);
}

/**
 * Push, then announce. Shared by the direct upload and the two-phase
 * presigned path, so both report identical delivery states.
 */
async function announceTransfer(ctx, row) {
  const { db } = ctx;
  await dispatchPushes(ctx, row, serializeTransfer(db, row));

  // Announce only after the fan-out, so the SSE payload and the HTTP response
  // report the same delivery states rather than a stale `pending`.
  const serialized = serializeTransfer(db, db.getTransfer(row.id));
  ctx.events.publish('transfer.created', { transfer: serialized }, {
    audience: transferAudience(db, row),
  });
  return serialized;
}

/**
 * Phase one of a direct-to-storage upload: validate the targets, reserve a
 * transfer row in state 'uploading', and hand back a signed URL to PUT to.
 *
 * Deliberately a single PUT rather than multipart — see storage.js presignPut.
 * Nothing is pushed and nothing is announced yet: the transfer does not exist
 * as far as recipients are concerned until the bytes are verified.
 */
export async function beginPresignedUpload(ctx, input) {
  const { db, storage } = ctx;
  if (typeof storage.presignPut !== 'function') {
    throw new AppError('bad_request', 'this storage driver does not support presigned uploads');
  }

  const declaredSize = Number(input.size);
  if (!Number.isFinite(declaredSize) || declaredSize < 0) {
    throw new AppError('bad_request', 'size must be a non-negative number');
  }
  if (declaredSize > MAX_FILE_BYTES) {
    throw new AppError('too_large', `declared size ${declaredSize} exceeds the ${MAX_FILE_BYTES} byte limit`);
  }

  const { targets, fromDeviceId, fromKnown } = resolveTargets(db, {
    to: input.to,
    from: input.from,
  });
  if (targets.length === 0) {
    throw noTargets(
      db.listDeviceIds().length === 0
        ? 'no devices are registered — POST /v1/devices first'
        : 'no devices matched the requested targets',
    );
  }

  const { expiresAt } = resolveExpiry(input.expiresInDays);
  const id = newId();
  const blobKey = newBlobKey();
  const mimeType = input.mimeType || 'application/octet-stream';

  const row = db.createTransfer(
    {
      id,
      kind: 'file',
      state: 'uploading',
      file_name: input.fileName ?? 'file',
      mime_type: mimeType,
      size: declaredSize,
      text: null,
      blob_key: blobKey,
      from_device_id: fromKnown ? fromDeviceId : null,
      created_at: nowIso(),
      expires_at: expiresAt,
    },
    targets,
  );

  if (fromKnown && fromDeviceId) db.touchDevice(fromDeviceId);

  const upload = await storage.presignPut(blobKey, UPLOAD_URL_TTL_SECONDS, {
    contentType: mimeType,
  });

  return { transfer: serializeTransfer(db, row), upload };
}

/**
 * Phase two: the bytes are supposedly in storage. Verify what actually landed
 * before anyone is told about it.
 *
 * This check is not optional. A presigned URL cannot carry an enforced
 * Content-Length (S3 does not support it on PUT), so the declared size is a
 * claim until stat() confirms it. Anything that does not match is deleted and
 * rejected rather than delivered.
 */
export async function completeUpload(ctx, id) {
  const { db, storage } = ctx;
  const row = db.getTransfer(id);
  if (!row) throw notFound('no such transfer');
  if (row.state === 'complete') return serializeTransfer(db, row); // idempotent
  if (row.state !== 'uploading') {
    throw new AppError('bad_request', `this transfer is ${row.state}, not uploading`);
  }

  const stat = typeof storage.stat === 'function' ? await storage.stat(row.blob_key) : null;
  if (!stat) {
    throw new AppError('bad_request', 'no bytes were uploaded to the signed URL');
  }
  if (stat.size > MAX_FILE_BYTES) {
    await storage.delete(row.blob_key).catch(() => {});
    db.setTransferState(row.id, 'cancelled', null);
    throw new AppError('too_large', `uploaded ${stat.size} bytes; the limit is ${MAX_FILE_BYTES}`);
  }
  if (row.size != null && stat.size !== row.size) {
    await storage.delete(row.blob_key).catch(() => {});
    db.setTransferState(row.id, 'cancelled', null);
    throw new AppError(
      'bad_request',
      `declared ${row.size} bytes but ${stat.size} landed`,
    );
  }

  db.setTransferSize(row.id, stat.size);
  db.setTransferState(row.id, 'complete', row.blob_key);
  return announceTransfer(ctx, db.getTransfer(row.id));
}

/**
 * @param {{db:import('./db.js').Db, push:any}} ctx
 */
async function dispatchPushes(ctx, row, serialized) {
  const { db, push } = ctx;
  const fromName = serialized.from_device_name;
  const results = await Promise.allSettled(
    db.listDeliveries(row.id).map(async (delivery) => {
      const device = db.getDevice(delivery.device_id);
      if (!device) return;
      const payload = buildPushPayload(row, delivery.delivery_id, fromName);
      const result = await push.send(device, payload);
      if (result?.ok) db.markDeliveryPushed(delivery.delivery_id);
      else if (result?.reason && result.reason !== 'no_push_token') {
        console.warn(
          `[transmat] push to ${device.name} (${device.id}) failed: ${result.reason}`,
        );
      }
    }),
  );
  for (const r of results) {
    if (r.status === 'rejected') console.warn('[transmat] push threw:', r.reason);
  }
}

/**
 * Blob availability checks shared by GET /v1/transfers/:id/blob and revoke.
 * @param {object} row
 */
export function assertBlobAvailable(row) {
  if (row.state === 'revoked') throw new AppError('revoked', 'this transfer was revoked by the sender');
  if (row.state === 'expired') throw new AppError('expired', 'this transfer has expired');
  if (row.kind !== 'file') {
    throw badRequest(`transfer kind "${row.kind}" has no blob; read the "text" field instead`);
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    throw new AppError('expired', 'this transfer has expired');
  }
  if (!row.blob_key) throw new AppError('expired', 'the bytes for this transfer are gone');
}

export { BLOB_URL_TTL_SECONDS };
