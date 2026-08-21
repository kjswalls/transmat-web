/**
 * POST/GET/DELETE /v1/transfers — the heart of the contract.
 */
import { Hono } from 'hono';
import { Readable } from 'node:stream';
import { AppError, badRequest, notFound, tooLarge } from '../errors.js';
import {
  MAX_FILE_BYTES,
  MAX_TEXT_BYTES,
  MAX_JSON_BODY_BYTES,
  BLOB_URL_TTL_SECONDS,
  KINDS,
} from '../config.js';
import { readBodyWithCap } from '../body.js';
import { newBlobKey, BlobTooLargeError } from '../storage.js';
import { parseMultipart, fieldsToMap } from '../multipart.js';
import { serializeTransfer, transferAudience, encodeCursor, decodeCursor } from '../serialize.js';
import {
  createTransfer,
  beginPresignedUpload,
  completeUpload,
  resolveKind,
  assertTextWithinCap,
  assertBlobAvailable,
} from '../transfers.js';

export function transferRoutes(ctx) {
  const app = new Hono();
  const { db, storage, events, config } = ctx;

  /* ---------------------------------------------------------------- POST */
  app.post('/', async (c) => {
    const contentType = (c.req.header('content-type') ?? '').toLowerCase();

    if (contentType.startsWith('multipart/form-data')) {
      return c.json({ transfer: await createFromMultipart(ctx, c) });
    }
    if (contentType.startsWith('application/json') || contentType === '') {
      const body = await readJsonBody(c);
      // mode:'presigned' reserves a transfer and hands back a URL to PUT to,
      // instead of streaming the bytes through this server. This is the path
      // the iOS share extension uses, because a background URLSession can only
      // upload a file to a URL — it cannot stream through a multipart form.
      if (body?.mode === 'presigned') {
        const result = await beginPresignedUpload(ctx, {
          fileName: body.name ?? body.file_name,
          mimeType: body.mime_type,
          size: body.size,
          to: normalizeTo(body.to),
          from: body.from ?? null,
          expiresInDays: body.expires_in_days,
        });
        return c.json(result);
      }
      return c.json({ transfer: await createFromJson(ctx, c, body) });
    }
    throw badRequest(
      `content-type must be multipart/form-data or application/json (got "${contentType}")`,
    );
  });

  /* -------------------------------------------------------- POST complete */
  // Phase two of a presigned upload. Idempotent: completing an already
  // complete transfer returns it rather than erroring, because a background
  // URLSession can genuinely deliver the same completion twice.
  app.post('/:id/complete', async (c) => {
    return c.json({ transfer: await completeUpload(ctx, c.req.param('id')) });
  });

  /* ----------------------------------------------------------------- GET */
  app.get('/', (c) => {
    const q = c.req.query();
    const cursor = decodeCursor(q.cursor);
    if (q.cursor && !cursor) throw badRequest('invalid cursor');
    if (q.kind && !KINDS.includes(q.kind)) {
      throw badRequest(`kind must be one of ${KINDS.join(', ')}`);
    }
    if (q.direction && !['in', 'out', 'both'].includes(q.direction)) {
      throw badRequest('direction must be "in", "out" or "both"');
    }
    const limit = q.limit ? Number(q.limit) : 50;
    if (q.limit && (!Number.isFinite(limit) || limit < 1)) {
      throw badRequest('limit must be a positive number');
    }

    const { rows, hasMore } = db.listTransfers({
      device_id: q.device_id,
      direction: q.direction,
      kind: q.kind,
      q: q.q,
      limit,
      cursor,
    });
    if (q.device_id && db.getDevice(q.device_id)) db.touchDevice(q.device_id);

    const transfers = rows.map((row) => serializeTransfer(db, row));
    const body = { transfers };
    if (hasMore && rows.length) body.next_cursor = encodeCursor(rows[rows.length - 1]);
    return c.json(body);
  });

  app.get('/:id', (c) => {
    const row = db.getTransfer(c.req.param('id'));
    if (!row) throw notFound(`no transfer ${c.req.param('id')}`);
    return c.json({ transfer: serializeTransfer(db, row) });
  });

  /* --------------------------------------------------- GET :id/blob (302) */
  app.get('/:id/blob', async (c) => {
    const row = db.getTransfer(c.req.param('id'));
    if (!row) throw notFound(`no transfer ${c.req.param('id')}`);
    assertBlobAvailable(row);
    // The mime type goes with it: on r2 the stored Content-Type is whatever the
    // uploader's PUT sent (a presigned PUT signs only `host`), so the download
    // is served with the type from our row via ResponseContentType instead.
    const url = await storage.signedUrl(
      row.blob_key, BLOB_URL_TTL_SECONDS, row.file_name, row.mime_type || undefined,
    );
    return c.redirect(url, 302);
  });

  /* ------------------------------------------------------- DELETE (revoke) */
  app.delete('/:id', async (c) => {
    const id = c.req.param('id');
    const row = db.getTransfer(id);
    if (!row) throw notFound(`no transfer ${id}`);

    const audience = transferAudience(db, row);
    if (row.blob_key) {
      await storage.delete(row.blob_key).catch((err) => {
        console.warn(`[transmat] could not delete blob ${row.blob_key}: ${err.message}`);
      });
    }
    // Keep blob_key: the bytes are gone, but the row remembers which key it
    // had so an already-issued signed URL answers 410 revoked, not 404.
    db.setTransferState(id, 'revoked', row.blob_key);
    events.publish('transfer.revoked', { transfer_id: id }, { audience });
    return c.json({ ok: true });
  });

  return app;
}

/* -------------------------------------------------------------------------- */
/* multipart                                                                  */
/* -------------------------------------------------------------------------- */

async function createFromMultipart(ctx, c) {
  const { storage } = ctx;
  const incoming = c.env?.incoming;
  const usingRawNode = incoming && typeof incoming.pipe === 'function';
  if (!usingRawNode && !c.req.raw.body) {
    // multipart/form-data with no body at all. Node always hands us a stream,
    // but app.fetch (tests, other adapters) can produce a bodyless Request —
    // and that is a malformed upload, not a 500.
    throw badRequest('multipart/form-data request has no body');
  }
  const source = usingRawNode ? incoming : Readable.fromWeb(c.req.raw.body);
  const headers = usingRawNode
    ? incoming.headers
    : Object.fromEntries([...c.req.raw.headers.entries()]);

  /** Set as soon as bytes start landing, so every failure path can clean up. */
  let blobKey = null;

  try {
    const { fields, file, fileInfo } = await parseMultipart(source, {
      headers,
      maxFileBytes: MAX_FILE_BYTES,
      maxFieldBytes: MAX_TEXT_BYTES,
      onFile: async (stream, info) => {
        blobKey = newBlobKey();
        const { size } = await storage.put(blobKey, stream, {
          contentType: info?.mimeType,
          maxBytes: MAX_FILE_BYTES,
        });
        return { size };
      },
    });

    const f = fieldsToMap(fields);
    const text = f.first('text') ?? null;
    if (text != null) assertTextWithinCap(text);

    const kind = resolveKind({ kind: f.first('kind'), hasFile: Boolean(file), text });

    if (kind === 'file' && !file) throw badRequest('kind=file requires a "file" part');
    if (kind !== 'file' && file) {
      throw badRequest(`kind=${kind} must not carry a file part`);
    }
    if (kind !== 'file' && !text) throw badRequest(`kind=${kind} requires a "text" field`);

    return await createTransfer(ctx, {
      kind,
      to: f.all('to'),
      from: f.first('from') ?? null,
      fileName: f.first('name') || fileInfo?.filename || 'file',
      mimeType: fileInfo?.mimeType || 'application/octet-stream',
      size: file?.size ?? null,
      text,
      blobKey,
      expiresInDays: f.first('expires_in_days'),
    });
  } catch (err) {
    if (blobKey) await storage.delete(blobKey).catch(() => {});
    throw normalizeUploadError(err);
  }
}

function normalizeUploadError(err) {
  if (err instanceof BlobTooLargeError) {
    return tooLarge(`file exceeds ${MAX_FILE_BYTES} bytes`);
  }
  if (err instanceof AppError) return err;
  return err;
}

/* -------------------------------------------------------------------------- */
/* json                                                                       */
/* -------------------------------------------------------------------------- */

/** Parse and validate a JSON body once, so the route can branch on `mode`. */
async function readJsonBody(c) {
  const raw = await readBodyWithCap(c, MAX_JSON_BODY_BYTES);
  let body;
  try {
    body = raw.trim() ? JSON.parse(raw) : {};
  } catch (err) {
    throw badRequest(`invalid JSON body: ${err.message}`);
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('body must be a JSON object');
  }
  return body;
}

/** `to` accepts a single value or a list; always hand the service a list. */
function normalizeTo(to) {
  if (to == null) return [];
  return Array.isArray(to) ? to.map(String) : [String(to)];
}

async function createFromJson(ctx, c, body) {
  const text = typeof body.text === 'string' ? body.text : null;
  if (text != null) assertTextWithinCap(text);

  const kind = resolveKind({ kind: body.kind, hasFile: false, text });
  if (kind === 'file') {
    throw badRequest('kind=file needs multipart/form-data with a file part');
  }
  if (!text) throw badRequest(`kind=${kind} requires a "text" field`);

  return createTransfer(ctx, {
    kind,
    to: normalizeTo(body.to),
    from: body.from != null ? String(body.from) : null,
    text,
    expiresInDays: body.expires_in_days,
  });
}

/** Re-exported for callers that used to import it from this module. */
export { readBodyWithCap };

export default transferRoutes;
