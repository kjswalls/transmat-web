/**
 * StorageDriver — the contract's interface, two implementations.
 *
 *   interface StorageDriver {
 *     put(key, body: Readable, meta: {contentType?}): Promise<{size}>
 *     signedUrl(key, ttlSeconds, filename?): Promise<string>
 *     delete(key): Promise<void>
 *     name: 'local' | 'r2'
 *   }
 *
 * `local` is the default and needs no credentials: bytes land in
 * $DATA_DIR/blobs/<key> and signedUrl() points back at our own
 * GET /blob/:key?exp=&sig= route, where sig is HMAC-SHA256 over "key:exp"
 * with BLOB_SIGNING_SECRET, verified in constant time.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

/** Blob keys are opaque and must never escape the blob directory. */
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isValidKey(key) {
  return typeof key === 'string' && KEY_RE.test(key) && !key.includes('..');
}

export function newBlobKey() {
  return crypto.randomUUID().replace(/-/g, '');
}

export class BlobTooLargeError extends Error {
  constructor(limit) {
    super(`blob exceeds ${limit} bytes`);
    this.name = 'BlobTooLargeError';
    this.limit = limit;
  }
}

/* -------------------------------------------------------------------------- */
/* signing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * @param {string} secret
 * @param {string} key
 * @param {number|string} exp unix seconds
 */
export function signBlob(secret, key, exp, purpose = 'get') {
  // `purpose` is in the HMAC input so a download link can never be replayed as
  // an upload: the two signatures are unrelated even for the same key and exp.
  return crypto.createHmac('sha256', secret).update(`${purpose}:${key}:${exp}`).digest('hex');
}

/**
 * Constant-time verification of a `/blob/:key?exp=&sig=` signature.
 * @returns {'ok'|'expired'|'invalid'}
 */
export function verifyBlobSignature(secret, key, exp, sig, purpose = 'get') {
  if (typeof sig !== 'string' || typeof exp !== 'string') return 'invalid';
  const expected = signBlob(secret, key, exp, purpose);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(sig, 'utf8');
  // Length check first — timingSafeEqual throws on mismatched lengths. Lengths
  // are fixed (64 hex chars) so leaking "wrong length" leaks nothing.
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return 'invalid';
  const expSeconds = Number(exp);
  if (!Number.isFinite(expSeconds)) return 'invalid';
  if (expSeconds * 1000 < Date.now()) return 'expired';
  return 'ok';
}

/* -------------------------------------------------------------------------- */
/* local                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * @param {{blobDir:string, blobSigningSecret:string, publicBaseUrl:string}} config
 */
export function createLocalStorage(config) {
  const blobDir = config.blobDir;
  fs.mkdirSync(blobDir, { recursive: true });

  const pathFor = (key) => {
    if (!isValidKey(key)) throw new Error(`invalid blob key: ${key}`);
    return path.join(blobDir, key);
  };

  return {
    name: /** @type {'local'} */ ('local'),

    /**
     * @param {string} key
     * @param {import('node:stream').Readable} body
     * @param {{contentType?:string, maxBytes?:number}} [meta]
     * @returns {Promise<{size:number}>}
     */
    async put(key, body, meta = {}) {
      const target = pathFor(key);
      // The suffix has to be unique per call, not per millisecond: two PUTs to
      // the same key in the same tick would otherwise pick the same temp path,
      // and the loser's cleanup deletes the winner's file out from under it.
      const tmp = `${target}.part-${process.pid}-${crypto.randomUUID()}`;
      let size = 0;
      const limit = meta.maxBytes ?? Infinity;
      const out = fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 });
      try {
        await pipeline(
          body,
          async function* (source) {
            for await (const chunk of source) {
              size += chunk.length;
              if (size > limit) throw new BlobTooLargeError(limit);
              yield chunk;
            }
          },
          out,
        );
        await fsp.rename(tmp, target);
        return { size };
      } catch (err) {
        await fsp.rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
    },

    /**
     * A URL back to our own signed blob route. No credentials involved.
     * @param {string} key
     * @param {number} ttlSeconds
     */
    async signedUrl(key, ttlSeconds) {
      if (!isValidKey(key)) throw new Error(`invalid blob key: ${key}`);
      const exp = Math.floor(Date.now() / 1000) + Math.max(1, Math.floor(ttlSeconds));
      const sig = signBlob(config.blobSigningSecret, key, exp);
      return `${config.publicBaseUrl}/blob/${encodeURIComponent(key)}?exp=${exp}&sig=${sig}`;
    },

    /**
     * A signed URL the client can PUT bytes to. Mirrors an R2 presigned PUT so
     * both drivers present the same contract to the share extension.
     * @param {string} key
     * @param {number} ttlSeconds
     */
    async presignPut(key, ttlSeconds) {
      if (!isValidKey(key)) throw new Error(`invalid blob key: ${key}`);
      const exp = Math.floor(Date.now() / 1000) + Math.max(1, Math.floor(ttlSeconds));
      const sig = signBlob(config.blobSigningSecret, key, exp, 'put');
      return {
        method: /** @type {'PUT'} */ ('PUT'),
        url: `${config.publicBaseUrl}/blob/${encodeURIComponent(key)}?exp=${exp}&sig=${sig}`,
        headers: {},
        expires_at: new Date(exp * 1000).toISOString(),
      };
    },

    async delete(key) {
      if (!isValidKey(key)) return;
      await fsp.rm(pathFor(key), { force: true });
    },

    /* --- local-only extras, used by GET /blob/:key --- */

    /** @returns {Promise<{size:number, mtime:Date}|null>} */
    async stat(key) {
      if (!isValidKey(key)) return null;
      try {
        const s = await fsp.stat(pathFor(key));
        return { size: s.size, mtime: s.mtime };
      } catch {
        return null;
      }
    },

    /** @param {string} key @param {{start?:number,end?:number}} [range] */
    createReadStream(key, range) {
      return fs.createReadStream(pathFor(key), range);
    },

    /**
     * Open a blob for reading and report its size from the *same* descriptor.
     *
     * This exists because stat()-then-open() is a race the expiry sweep and
     * DELETE /v1/transfers/:id both win regularly: the file disappears between
     * the two calls and the client gets a 200 with a truncated body. Once the
     * descriptor is open, POSIX keeps the bytes alive for us however many times
     * the file is unlinked underneath.
     *
     * @param {string} key
     * @returns {Promise<{size:number, mtime:Date, stream:(range?:{start:number,end:number})=>import('node:stream').Readable, close:()=>Promise<void>}|null>}
     */
    async open(key) {
      if (!isValidKey(key)) return null;
      /** @type {import('node:fs/promises').FileHandle} */
      let handle;
      try {
        handle = await fsp.open(pathFor(key), 'r');
      } catch {
        return null;
      }
      let stats;
      try {
        stats = await handle.stat();
      } catch (err) {
        await handle.close().catch(() => {});
        throw err;
      }
      let streamed = false;
      return {
        size: stats.size,
        mtime: stats.mtime,
        /** Exactly one stream per handle; it closes the handle when it ends. */
        stream(range) {
          if (streamed) throw new Error('blob handle already streamed');
          streamed = true;
          return handle.createReadStream(range ? { start: range.start, end: range.end } : {});
        },
        async close() {
          if (streamed) return; // the stream owns the handle now
          await handle.close().catch(() => {});
        },
      };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* r2 (S3-compatible)                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Cloudflare R2 over the S3 API. Uploads stream through @aws-sdk/lib-storage's
 * multipart Upload (so a 2 GB body never lands in memory); downloads are
 * presigned GETs the client follows directly, keeping bytes off this server.
 *
 * @param {{r2:{accountId:string,accessKeyId:string,secretAccessKey:string,bucket:string,endpoint?:string}}} config
 */
export async function createR2Storage(config) {
  const { S3Client, DeleteObjectCommand, GetObjectCommand, PutObjectCommand, HeadObjectCommand } =
    await import('@aws-sdk/client-s3');
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
  const { Upload } = await import('@aws-sdk/lib-storage');

  const { accountId, accessKeyId, secretAccessKey, bucket } = config.r2;
  const endpoint = config.r2.endpoint || `https://${accountId}.r2.cloudflarestorage.com`;

  const client = new S3Client({
    region: 'auto',
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    // WHEN_SUPPORTED (the SDK default since v3.729) makes the flexible-checksum
    // middleware compute x-amz-checksum-crc32 over the body it is signing —
    // which, for a presigned PutObject, is *no body at all*. The checksum for
    // the empty payload gets hoisted into the query string and signed, and then
    // S3 and R2 reject every real upload to that URL with BadDigest. Presigned
    // PUTs cannot carry a payload checksum, so do not ask for one.
    requestChecksumCalculation: 'WHEN_REQUIRED',
  });

  const objectKey = (key) => {
    if (!isValidKey(key)) throw new Error(`invalid blob key: ${key}`);
    return `blobs/${key}`;
  };

  return {
    name: /** @type {'r2'} */ ('r2'),

    async put(key, body, meta = {}) {
      let size = 0;
      const limit = meta.maxBytes ?? Infinity;
      // Count (and cap) bytes as they pass through, without buffering.
      async function* counted(source) {
        for await (const chunk of source) {
          size += chunk.length;
          if (size > limit) throw new BlobTooLargeError(limit);
          yield chunk;
        }
      }
      const upload = new Upload({
        client,
        params: {
          Bucket: bucket,
          Key: objectKey(key),
          // Readable.from, not the bare async generator: the AWS SDK accepts
          // string | Uint8Array | Buffer | Readable | ReadableStream | Blob,
          // and an AsyncGenerator is none of those.
          Body: Readable.from(counted(body)),
          ContentType: meta.contentType || 'application/octet-stream',
        },
        queueSize: 3,
        partSize: 8 * 1024 * 1024,
      });
      try {
        await upload.done();
      } catch (err) {
        await upload.abort().catch(() => {});
        throw err;
      }
      return { size };
    },

    async signedUrl(key, ttlSeconds, filename, contentType) {
      const cmd = new GetObjectCommand({
        Bucket: bucket,
        Key: objectKey(key),
        ...(filename
          ? { ResponseContentDisposition: contentDisposition(filename) }
          : {}),
        // A presigned PUT signs only `host`, so the stored Content-Type is
        // whatever the uploader chose to send — including text/html. Override
        // it on the way out with the type from our own row, so the object's
        // metadata cannot decide how a browser treats the response.
        ...(contentType ? { ResponseContentType: contentType } : {}),
      });
      return getSignedUrl(client, cmd, { expiresIn: Math.max(1, Math.floor(ttlSeconds)) });
    },

    /**
     * A presigned PUT. Deliberately a SINGLE request, not multipart: an iOS
     * background URLSession hands the transfer to nsurlsessiond and the app is
     * not running to orchestrate parts, so a multipart upload reliably strands
     * itself — every part lands and CompleteMultipartUpload never fires
     * (documented in aws-amplify/aws-sdk-ios#3173). One PUT covers everything
     * up to S3's 5 GB single-request ceiling, comfortably above our 2 GB cap.
     *
     * Note the size cap is NOT enforced here. Presigned URLs cannot carry an
     * enforced Content-Length — the caller must verify with stat() afterwards
     * and delete anything oversized. See POST /v1/transfers/:id/complete.
     */
    async presignPut(key, ttlSeconds, meta = {}) {
      const cmd = new PutObjectCommand({
        Bucket: bucket,
        Key: objectKey(key),
        ...(meta.contentType ? { ContentType: meta.contentType } : {}),
      });
      const expiresIn = Math.max(1, Math.floor(ttlSeconds));
      const url = await getSignedUrl(client, cmd, { expiresIn });
      return {
        method: /** @type {'PUT'} */ ('PUT'),
        url,
        headers: meta.contentType ? { 'content-type': meta.contentType } : {},
        expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
      };
    },

    /** @returns {Promise<{size:number, mtime:Date}|null>} */
    async stat(key) {
      try {
        const head = await client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: objectKey(key) }),
        );
        return { size: Number(head.ContentLength ?? 0), mtime: head.LastModified ?? new Date() };
      } catch {
        return null;
      }
    },

    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey(key) }));
    },
  };
}

/** RFC 5987 Content-Disposition for a possibly non-ASCII filename. */
export function contentDisposition(filename, type = 'attachment') {
  const safe = String(filename).replace(/[\r\n"\\]/g, '_');
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

/**
 * @param {import('./config.js').Config} config
 */
export async function createStorage(config) {
  if (config.storageDriver === 'r2') return createR2Storage(config);
  return createLocalStorage(config);
}

export default createStorage;
