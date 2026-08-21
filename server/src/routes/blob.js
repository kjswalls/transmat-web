/**
 * GET /blob/:key?exp=&sig=  — local storage driver only.
 *
 * No bearer auth: the HMAC signature *is* the authorization, which is what
 * lets a redirect from GET /v1/transfers/:id/blob be followed by a plain
 * URLSession/`curl -L` with no headers. Same shape as an R2 presigned URL.
 */
import { Hono } from 'hono';
import { Readable } from 'node:stream';
import { AppError, notFound, tooLarge } from '../errors.js';
import {
  verifyBlobSignature,
  isValidKey,
  contentDisposition,
  BlobTooLargeError,
} from '../storage.js';
import { MAX_FILE_BYTES, MAX_FILE_NAME_CHARS, isValidMimeType } from '../config.js';
import { createUploadRegistry } from '../uploads.js';

export function blobRoutes(ctx) {
  const app = new Hono();
  const { config, db, storage } = ctx;
  // Shared with completeUpload, so `complete` can tell "the bytes are all
  // here" apart from "the bytes are still arriving".
  const uploads = ctx.uploads ?? (ctx.uploads = createUploadRegistry());

  /**
   * PUT /blob/:key?exp=&sig=  — local driver's answer to a presigned PUT.
   *
   * Signed with purpose 'put', so a download link cannot be replayed to
   * overwrite a blob. The transfer row must still be in state 'uploading':
   * that stops a completed (or revoked) transfer's bytes being swapped out
   * from under a recipient who already has the link.
   */
  app.put('/:key', async (c) => {
    if (storage.name !== 'local') {
      throw notFound('this server does not accept direct blob uploads');
    }
    const key = c.req.param('key');
    if (!isValidKey(key)) throw notFound('no such blob');

    const verdict = verifyBlobSignature(
      config.blobSigningSecret, key, c.req.query('exp') ?? '', c.req.query('sig') ?? '', 'put',
    );
    if (verdict === 'expired') throw new AppError('expired', 'this upload link has expired');
    if (verdict !== 'ok') throw new AppError('signature_invalid', 'bad or missing signature');

    const transfer = db.getTransferByBlobKey(key);
    if (!transfer) throw notFound('no such blob');
    if (transfer.state !== 'uploading') {
      throw new AppError('bad_request', `this upload is already ${transfer.state}`);
    }
    // The signature can outlive the transfer: UPLOAD_URL_TTL_SECONDS is an hour
    // but expires_in_days could be clamped to anything. Do not accept bytes for
    // something the sweep is about to expire anyway.
    if (new Date(transfer.expires_at).getTime() <= Date.now()) {
      throw new AppError('expired', 'this transfer has expired');
    }

    const body = c.req.raw.body;
    if (!body) throw new AppError('bad_request', 'no request body');

    // One PUT at a time per key. Two concurrent PUTs would race each other's
    // temp file and rename, and `complete` could certify whichever fragment
    // happened to be on disk at the moment it looked.
    const release = uploads.begin(key);
    if (!release) {
      throw new AppError('bad_request', 'an upload to this URL is already in progress');
    }

    try {
      // The cap is the size the client declared, not the 2 GB ceiling. A
      // presigned URL cannot carry an enforced Content-Length, but nothing
      // obliges us to accept more than was reserved: without this a 5-byte
      // reservation is a licence to park 2 GB, and `complete` only finds out
      // once all of it is already on disk. Counted as it streams, so an
      // oversized body is answered and abandoned mid-flight.
      const limit = Math.min(
        typeof transfer.size === 'number' && transfer.size >= 0 ? transfer.size : MAX_FILE_BYTES,
        MAX_FILE_BYTES,
      );
      await storage.put(key, Readable.fromWeb(body), {
        contentType: transfer.mime_type || 'application/octet-stream',
        maxBytes: limit,
      });

      // Re-read under the claim. A revoke, a cancel or the janitor may have
      // run while the bytes were streaming; they deleted a key that did not
      // exist yet, and this rename would otherwise resurrect it as an orphan
      // no sweep will ever look at again.
      const still = db.getTransfer(transfer.id);
      if (!still || still.state !== 'uploading') {
        await storage.delete(key).catch(() => {});
        throw new AppError('bad_request', `this upload is ${still ? still.state : 'gone'}`);
      }
    } catch (err) {
      await storage.delete(key).catch(() => {});
      if (err instanceof BlobTooLargeError) {
        throw tooLarge(`upload exceeds the declared ${transfer.size} bytes`);
      }
      throw err;
    } finally {
      release();
    }
    return c.body(null, 204);
  });

  app.get('/:key', async (c) => {
    if (storage.name !== 'local') {
      throw notFound('this server does not serve blobs directly; use the signed URL');
    }
    const key = c.req.param('key');
    if (!isValidKey(key)) throw notFound('no such blob');

    const exp = c.req.query('exp');
    const sig = c.req.query('sig');
    const verdict = verifyBlobSignature(config.blobSigningSecret, key, exp ?? '', sig ?? '');
    if (verdict === 'expired') throw new AppError('expired', 'this download link has expired');
    if (verdict !== 'ok') throw new AppError('signature_invalid', 'bad or missing signature');

    // Filename and type come from our own row, never from the query string —
    // only `key` and `exp` are covered by the signature. The row is also what
    // lets a still-valid link answer 410 instead of 404 once the bytes are
    // gone: revoke and expiry delete the blob but keep the archive.
    const transfer = db.getTransferByBlobKey(key);
    if (transfer?.state === 'revoked') {
      throw new AppError('revoked', 'this transfer was revoked by the sender');
    }
    if (transfer?.state === 'expired' || (transfer && new Date(transfer.expires_at) <= new Date())) {
      throw new AppError('expired', 'this transfer has expired');
    }
    if (transfer?.state === 'uploading') {
      // Bytes may be on disk, but nothing has verified them and no recipient
      // has been told this transfer exists. It is not downloadable yet.
      throw notFound('no such blob');
    }

    // Build the headers BEFORE opening anything. A hostile file_name or
    // mime_type that the Response constructor rejects would otherwise throw
    // with a file handle already open and no stream to close it.
    const headers = responseHeaders(transfer, key);

    // Open first, measure second: a stat() followed by a separate open() is a
    // race the sweep and revoke both win, and the loser is a client holding a
    // 200 with half a file in it.
    const blob = await openBlob(storage, key);
    if (!blob) throw notFound('no such blob');

    const range = parseRange(c.req.header('range'), blob.size);
    if (range === 'unsatisfiable') {
      await blob.close();
      return c.body(null, 416, { 'content-range': `bytes */${blob.size}` });
    }

    if (range) {
      headers['content-range'] = `bytes ${range.start}-${range.end}/${blob.size}`;
      headers['content-length'] = String(range.end - range.start + 1);
      return new Response(Readable.toWeb(blob.stream(range)), { status: 206, headers });
    }

    headers['content-length'] = String(blob.size);
    if (c.req.method === 'HEAD') {
      await blob.close();
      return c.body(null, 200, headers);
    }
    return new Response(Readable.toWeb(blob.stream()), { status: 200, headers });
  });

  return app;
}

/**
 * Content headers for a blob response, from our own row and never from the
 * request. Both `file_name` and `mime_type` are attacker-supplied on the
 * presigned path, and both land in a header: a CRLF in either used to make
 * `new Response()` throw, which is a 500 on every download of that transfer
 * forever. Validation at reservation time is the real fix; this is the belt.
 *
 * @returns {Record<string,string>}
 */
function responseHeaders(transfer, key) {
  const filename = String(transfer?.file_name || key).slice(0, MAX_FILE_NAME_CHARS);
  const mime = isValidMimeType(transfer?.mime_type)
    ? transfer.mime_type
    : 'application/octet-stream';
  return {
    'content-type': mime,
    'content-disposition': contentDisposition(filename),
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=0, no-store',
    'x-content-type-options': 'nosniff',
  };
}

/**
 * Prefer a driver that can open and measure in one step; fall back to the
 * stat + createReadStream pair for any driver that does not implement open().
 * @returns {Promise<{size:number, stream:(range?:{start:number,end:number})=>import('node:stream').Readable, close:()=>Promise<void>}|null>}
 */
async function openBlob(storage, key) {
  if (typeof storage.open === 'function') return storage.open(key);
  const stat = await storage.stat(key);
  if (!stat) return null;
  return {
    size: stat.size,
    stream: (range) => storage.createReadStream(key, range),
    close: async () => {},
  };
}

/**
 * Single-range `bytes=a-b` support — enough for URLSession resume.
 * @returns {{start:number,end:number}|null|'unsatisfiable'}
 */
export function parseRange(header, size) {
  if (!header || size === 0) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  let start;
  let end;
  if (rawStart === '') {
    if (rawEnd === '') return null;
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return 'unsatisfiable';
  }
  return { start, end: Math.min(end, size - 1) };
}

export default blobRoutes;
