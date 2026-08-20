/**
 * Streaming uploads over node:http — because global fetch() will not stream.
 *
 * The obvious implementation of `send` is `fetch(url, {body: someStream,
 * duplex: 'half'})`, and it looks like it streams: memory stays flat for a
 * moment, the progress bar moves, everything seems fine. It does not. Undici
 * accumulates the whole request body before the server finishes reading it,
 * so RSS tracks file size one-for-one — measured on Node 22.22.2, a 1 GB
 * upload peaked at 1047 MB RSS, while the same bytes through node:http peaked
 * at 100 MB. At the contract's 2 GB ceiling that is an out-of-memory kill on
 * any laptop, for the one operation this CLI exists to do.
 *
 * So the upload leg (and only the upload leg) uses node:http/node:https
 * directly, piped, with real socket backpressure. Everything else still goes
 * through fetch, where response bodies stream perfectly well.
 *
 * The returned object is deliberately shaped like a fetch Response — status,
 * statusText, headers.get(), ok, text() — so api.js's error handling does not
 * need a second code path.
 */
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** No bytes in either direction for this long and the socket is dead. */
export const DEFAULT_IDLE_TIMEOUT_MS = 120_000;

/**
 * @param {object} options
 * @param {string} options.url
 * @param {string} [options.method]
 * @param {Record<string,string>} [options.headers]
 * @param {AsyncIterable<Uint8Array>|import('node:stream').Readable} options.body
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.idleTimeoutMs] 0 disables the idle watchdog
 * @returns {Promise<{status:number, statusText:string, ok:boolean, headers:{get(name:string):string|null}, text():Promise<string>}>}
 */
export function postStream({
  url,
  method = 'POST',
  headers = {},
  body,
  signal,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
}) {
  const target = new URL(url);
  const transport = target.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const req = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method,
        headers,
      },
      (res) => {
        // Small JSON envelopes only — the contract's POST /v1/transfers
        // answers with one Transfer object.
        const chunks = [];
        let bytes = 0;
        res.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes <= 1_000_000) chunks.push(chunk);
        });
        res.on('error', fail);
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          done({
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? '',
            ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
            headers: { get: (name) => res.headers[String(name).toLowerCase()] ?? null },
            text: async () => text,
          });
        });
      },
    );

    if (idleTimeoutMs > 0) {
      req.setTimeout(idleTimeoutMs, () => {
        const err = new Error(`upload stalled — no data for ${Math.round(idleTimeoutMs / 1000)}s`);
        err.code = 'ETIMEDOUT';
        req.destroy(err);
      });
    }

    req.on('error', fail);

    const onAbort = () => req.destroy(abortError(signal));
    if (signal) {
      if (signal.aborted) return void req.destroy(abortError(signal));
      signal.addEventListener('abort', onAbort, { once: true });
      req.on('close', () => signal.removeEventListener('abort', onAbort));
    }

    const source = body instanceof Readable ? body : Readable.from(body);
    // pipeline gives us the backpressure fetch would not: the generator is
    // only pulled when the socket has drained.
    pipeline(source, req).catch((cause) => {
      // A server that answers early (413 too_large) tears the request down
      // mid-pipe; that is a real response, not an upload failure, so let the
      // response handler win the race.
      setTimeout(() => fail(cause), 50);
    });
  });
}

function abortError(signal) {
  const err = new Error(signal?.reason?.message ?? 'aborted');
  err.name = 'AbortError';
  err.code = 'ABORT_ERR';
  return err;
}
