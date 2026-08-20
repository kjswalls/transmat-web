/**
 * Streaming multipart/form-data parsing.
 *
 * The point of this file: a 2 GB upload must never be buffered. busboy is a
 * pure-JS streaming parser (no native module); we hand it the raw Node request
 * and pipe the file part straight into the storage driver, enforcing the
 * contract's caps as the bytes go past and aborting cleanly when they're
 * exceeded.
 */
import Busboy from 'busboy';
import { AppError, tooLarge } from './errors.js';

/**
 * @param {import('node:stream').Readable} req the raw request body stream
 * @param {object} options
 * @param {Record<string,any>} options.headers request headers (needs content-type)
 * @param {number} options.maxFileBytes
 * @param {number} options.maxFieldBytes
 * @param {(stream: import('node:stream').Readable, info: {filename?:string, mimeType?:string}) => Promise<any>} options.onFile
 *   Called at most once, with the `file` part. Must consume the stream.
 * @returns {Promise<{fields: Array<[string,string]>, file: any|null, fileInfo: any|null}>}
 */
export function parseMultipart(req, { headers, maxFileBytes, maxFieldBytes, onFile }) {
  return new Promise((resolve, reject) => {
    /** @type {import('busboy').Busboy} */
    let bb;
    try {
      bb = Busboy({
        headers,
        limits: {
          fileSize: maxFileBytes,
          // +1 so we can tell "exactly at the cap" (allowed) from "over" (413).
          fieldSize: maxFieldBytes + 1,
          files: 4,
          fields: 64,
          parts: 72,
        },
      });
    } catch (err) {
      reject(new AppError('bad_request', `malformed multipart request: ${err.message}`));
      return;
    }

    /** @type {Array<[string,string]>} */
    const fields = [];
    /** @type {Promise<any>|null} */
    let filePromise = null;
    /** @type {{filename?:string, mimeType?:string}|null} */
    let fileInfo = null;
    /** @type {import('node:stream').Readable|null} */
    let fileStream = null;
    let truncated = false;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      try {
        // Only if it is still live: re-destroying an already-errored stream
        // re-emits 'error' after its consumer has detached, which surfaces as
        // an uncaught exception.
        if (fileStream && !fileStream.destroyed) fileStream.destroy(err);
      } catch {
        /* ignore */
      }
      req.unpipe?.(bb);
      bb.destroy();
      req.resume(); // drain the rest of the upload so the socket can close
      reject(err);
    };

    bb.on('field', (name, value, info) => {
      if (info?.nameTruncated) return fail(new AppError('bad_request', 'field name too long'));
      if (info?.valueTruncated || Buffer.byteLength(value, 'utf8') > maxFieldBytes) {
        return fail(tooLarge(`field "${name}" exceeds ${maxFieldBytes} bytes`));
      }
      fields.push([name, value]);
    });

    bb.on('file', (name, stream, info) => {
      if (name !== 'file' || filePromise) {
        stream.resume(); // an unconsumed part stalls the parser
        return;
      }
      fileInfo = info;
      fileStream = stream;
      // Keep a handler attached for the window before/after the consumer owns
      // the stream, so an abort never becomes an uncaught 'error' event.
      stream.on('error', () => {});
      // Abort the write the instant the cap is passed, rather than letting a
      // truncated file finish and land in storage.
      stream.on('limit', () => {
        truncated = true;
        stream.destroy(tooLarge(`file exceeds ${maxFileBytes} bytes`));
      });
      filePromise = Promise.resolve()
        .then(() => onFile(stream, info))
        .then((result) => {
          if (truncated) throw tooLarge(`file exceeds ${maxFileBytes} bytes`);
          return result;
        });
      // A failed write must abort the request immediately — waiting for
      // busboy's 'close' can hang, because we just tore the file stream down.
      filePromise.catch((err) => fail(err));
    });

    bb.on('filesLimit', () => fail(new AppError('bad_request', 'too many file parts')));
    bb.on('fieldsLimit', () => fail(new AppError('bad_request', 'too many fields')));
    bb.on('partsLimit', () => fail(new AppError('bad_request', 'too many parts')));
    bb.on('error', (err) =>
      fail(err instanceof AppError ? err : new AppError('bad_request', `malformed multipart: ${err?.message ?? err}`)),
    );

    bb.on('close', () => {
      if (settled) return;
      const finish = filePromise ?? Promise.resolve(null);
      finish.then(
        (file) => {
          if (settled) return;
          settled = true;
          resolve({ fields, file, fileInfo });
        },
        (err) => fail(err),
      );
    });

    req.on('aborted', () => fail(new AppError('bad_request', 'client aborted the upload')));
    req.on('error', (err) => fail(new AppError('bad_request', `upload failed: ${err?.message ?? err}`)));
    req.pipe(bb);
  });
}

/** Collect repeatable form fields into a lookup. */
export function fieldsToMap(fields) {
  /** @type {Map<string,string[]>} */
  const map = new Map();
  for (const [name, value] of fields) {
    const existing = map.get(name);
    if (existing) existing.push(value);
    else map.set(name, [value]);
  }
  return {
    first: (name) => map.get(name)?.[0],
    all: (name) => map.get(name) ?? [],
    has: (name) => map.has(name),
  };
}
