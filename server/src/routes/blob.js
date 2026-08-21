/**
 * GET /blob/:key?exp=&sig=  — local storage driver only.
 *
 * No bearer auth: the HMAC signature *is* the authorization, which is what
 * lets a redirect from GET /v1/transfers/:id/blob be followed by a plain
 * URLSession/`curl -L` with no headers. Same shape as an R2 presigned URL.
 */
import { Hono } from 'hono';
import { Readable } from 'node:stream';
import { AppError, notFound } from '../errors.js';
import { verifyBlobSignature, isValidKey, contentDisposition } from '../storage.js';
import { MAX_FILE_BYTES } from '../config.js';

export function blobRoutes(ctx) {
  const app = new Hono();
  const { config, db, storage } = ctx;

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

    const body = c.req.raw.body;
    if (!body) throw new AppError('bad_request', 'no request body');

    try {
      await storage.put(key, Readable.fromWeb(body), {
        contentType: transfer.mime_type || 'application/octet-stream',
        maxBytes: MAX_FILE_BYTES,
      });
    } catch (err) {
      await storage.delete(key).catch(() => {});
      throw err;
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

    // Open first, measure second: a stat() followed by a separate open() is a
    // race the sweep and revoke both win, and the loser is a client holding a
    // 200 with half a file in it.
    const blob = await openBlob(storage, key);
    if (!blob) throw notFound('no such blob');

    const filename = transfer?.file_name || key;
    const mime = transfer?.mime_type || 'application/octet-stream';

    /** @type {Record<string,string>} */
    const headers = {
      'content-type': mime,
      'content-disposition': contentDisposition(filename),
      'accept-ranges': 'bytes',
      'cache-control': 'private, max-age=0, no-store',
      'x-content-type-options': 'nosniff',
    };

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
