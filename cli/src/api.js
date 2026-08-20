/**
 * The API client — one place that knows the contract in docs/CONTRACT.md.
 *
 * Everything goes through `#request`, so every route gets the same bearer
 * header, the same `{error:{code,message}}` unwrapping, and the same
 * translation of "connection refused" into a sentence a human can act on.
 */
import { CliError, EXIT, exitCodeForStatus } from './errors.js';
import { buildMultipart } from './multipart.js';
import { postStream } from './upload.js';

/** Plain JSON calls are small; if one hangs this long, something is wrong. */
const DEFAULT_TIMEOUT_MS = 30_000;

export class ApiError extends CliError {
  constructor(status, code, message, url) {
    super(message, { exitCode: exitCodeForStatus(status), code });
    this.name = 'ApiError';
    this.status = status;
    this.url = url;
  }
}

export class Api {
  /**
   * @param {object} options
   * @param {string} options.url   base URL, no trailing slash
   * @param {string} options.token bearer token
   */
  constructor({ url, token }) {
    this.url = String(url).replace(/\/+$/, '');
    this.token = token;
  }

  /** @param {string} pathname @param {Record<string, any>} [query] */
  endpoint(pathname, query) {
    const u = new URL(this.url + pathname);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) for (const v of value) u.searchParams.append(key, String(v));
      else u.searchParams.set(key, String(value));
    }
    return u.toString();
  }

  headers(extra = {}) {
    return { authorization: `Bearer ${this.token}`, accept: 'application/json', ...extra };
  }

  /**
   * @param {string} pathname
   * @param {object} [options]
   * @param {string} [options.method]
   * @param {Record<string, any>} [options.query]
   * @param {any} [options.body]              JSON-serialised unless it's a stream
   * @param {Record<string,string>} [options.headers]
   * @param {number|null} [options.timeout]   null = no timeout (uploads, SSE, blobs)
   * @param {AbortSignal} [options.signal]
   * @param {'follow'|'manual'} [options.redirect]
   * @param {boolean} [options.raw]           return the Response instead of parsed JSON
   * @param {boolean} [options.auth]          send the bearer header (default true)
   */
  async request(pathname, options = {}) {
    const {
      method = 'GET',
      query,
      body,
      headers = {},
      timeout = DEFAULT_TIMEOUT_MS,
      signal,
      redirect = 'follow',
      raw = false,
      auth = true,
      duplex,
    } = options;

    const url = /^https?:\/\//i.test(pathname) ? pathname : this.endpoint(pathname, query);

    const init = {
      method,
      redirect,
      headers: auth ? this.headers(headers) : { accept: 'application/json', ...headers },
    };
    if (body !== undefined && body !== null) {
      if (typeof body === 'string' || body instanceof Uint8Array || body instanceof ReadableStream) {
        init.body = body;
      } else {
        init.body = JSON.stringify(body);
        init.headers['content-type'] = 'application/json';
      }
    }
    if (duplex) init.duplex = duplex;

    const signals = [];
    if (signal) signals.push(signal);
    if (timeout) signals.push(AbortSignal.timeout(timeout));
    if (signals.length === 1) init.signal = signals[0];
    else if (signals.length > 1) init.signal = AbortSignal.any(signals);

    let response;
    try {
      response = await fetch(url, init);
    } catch (cause) {
      throw networkError(cause, url, signal);
    }

    const isRedirect = response.status >= 300 && response.status < 400 && redirect === 'manual';
    if (raw) {
      // A manual redirect is the caller's business, not an error — openBlob
      // follows it by hand so the bearer token is not resent to R2.
      if (!isRedirect && !response.ok) await throwForResponse(response, url);
      return response;
    }
    if (isRedirect) return response;
    if (!response.ok) await throwForResponse(response, url);
    if (response.status === 204) return null;

    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new CliError(`server returned non-JSON from ${url}: ${text.slice(0, 200)}`);
    }
  }

  /* ------------------------------------------------------------- routes */

  /** GET /health — no auth, and the one call that proves the URL is a Transmat server. */
  health({ timeout = 5000 } = {}) {
    return this.request('/health', { auth: false, timeout });
  }

  /** POST /v1/devices */
  registerDevice({ name, platform = 'cli', push_channel = 'none', push_token }) {
    const body = { name, platform, push_channel };
    if (push_token) body.push_token = push_token;
    return this.request('/v1/devices', { method: 'POST', body });
  }

  /** GET /v1/devices */
  async listDevices() {
    const data = await this.request('/v1/devices');
    return data?.devices ?? [];
  }

  /** PATCH /v1/devices/:id */
  renameDevice(id, name) {
    return this.request(`/v1/devices/${encodeURIComponent(id)}`, { method: 'PATCH', body: { name } });
  }

  /** DELETE /v1/devices/:id */
  deleteDevice(id) {
    return this.request(`/v1/devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  /** GET /v1/transfers */
  async listTransfers(query = {}) {
    const data = await this.request('/v1/transfers', { query });
    return { transfers: data?.transfers ?? [], next_cursor: data?.next_cursor };
  }

  /** GET /v1/transfers/:id */
  async getTransfer(id) {
    const data = await this.request(`/v1/transfers/${encodeURIComponent(id)}`);
    return data?.transfer ?? null;
  }

  /** POST /v1/transfers with a JSON body — text and link kinds only. */
  async createTextTransfer({ kind, text, to, from, expires_in_days }) {
    const body = { kind, text };
    if (to?.length) body.to = to.length === 1 ? to[0] : to;
    if (from) body.from = from;
    if (expires_in_days) body.expires_in_days = expires_in_days;
    const data = await this.request('/v1/transfers', { method: 'POST', body, timeout: null });
    return data?.transfer;
  }

  /**
   * POST /v1/transfers as multipart/form-data, streaming the file so a 2 GB
   * upload never lands in memory.
   *
   * @param {object} options
   * @param {Array<[string,string]>} options.fields
   * @param {{filename:string, contentType:string, size:number|null, stream:AsyncIterable<Uint8Array>}} [options.file]
   * @param {(n:number)=>void} [options.onProgress]
   * @param {AbortSignal} [options.signal]
   */
  async createFileTransfer({ fields, file, onProgress, signal }) {
    const { contentType, parts } = buildMultipart({ fields, file, onProgress });
    const url = this.endpoint('/v1/transfers');
    // node:http, not fetch: see the comment at the top of upload.js. fetch()
    // buffers the entire request body, which turns a 2 GB send into a 2 GB
    // resident set.
    const response = await postStream({
      url,
      headers: { ...this.headers(), 'content-type': contentType },
      body: parts,
      signal,
    }).catch((cause) => {
      throw networkError(cause, url, signal);
    });

    if (!response.ok) await throwForResponse(response, url);
    const text = await response.text();
    if (!text) return undefined;
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new CliError(`server returned non-JSON from ${url}: ${text.slice(0, 200)}`);
    }
    return data?.transfer;
  }

  /** DELETE /v1/transfers/:id — revoke. */
  revokeTransfer(id) {
    return this.request(`/v1/transfers/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  /** POST /v1/deliveries/:id/ack */
  ackDelivery(id) {
    return this.request(`/v1/deliveries/${encodeURIComponent(id)}/ack`, { method: 'POST' });
  }

  /**
   * GET /v1/transfers/:id/blob → 302 → the signed URL.
   *
   * The redirect is followed by hand: the signed URL needs no bearer header
   * (and on a real deployment it points at R2, where sending ours would be a
   * credential leak), so we drop it rather than let fetch decide.
   *
   * @returns {Promise<Response>} a streaming response body
   */
  async openBlob(id, { signal } = {}) {
    const first = await this.request(`/v1/transfers/${encodeURIComponent(id)}/blob`, {
      redirect: 'manual',
      timeout: null,
      // raw, or request() reads the whole body as text looking for JSON —
      // which for a server that serves the bytes inline means buffering the
      // entire file into a string and then throwing it away as "non-JSON".
      raw: true,
      signal,
    });
    if (first.status >= 200 && first.status < 300) return first;
    const location = first.headers.get('location');
    if (!location) {
      throw new CliError(`server did not redirect to a download URL (HTTP ${first.status})`);
    }
    const target = new URL(location, this.url).toString();
    return this.request(target, { auth: false, timeout: null, raw: true, signal });
  }

  /**
   * GET /v1/events — the raw SSE response. Parsing lives in sse.js.
   * @returns {Promise<Response>}
   */
  openEvents({ deviceId, signal } = {}) {
    return this.request('/v1/events', {
      query: { device_id: deviceId },
      headers: { accept: 'text/event-stream', 'cache-control': 'no-cache' },
      timeout: null,
      raw: true,
      signal,
    });
  }
}

/* ---------------------------------------------------------------- helpers */

async function throwForResponse(response, url) {
  let code;
  let message;
  const text = await response.text().catch(() => '');
  try {
    const parsed = JSON.parse(text);
    code = parsed?.error?.code;
    message = parsed?.error?.message;
  } catch {
    /* not our envelope — fall through to the raw body */
  }
  if (!message) message = text.slice(0, 300) || response.statusText || `HTTP ${response.status}`;

  if (response.status === 401) {
    const e = new ApiError(401, code ?? 'unauthorized', `server rejected the access token (${message})`, url);
    e.hint = 'run `transmat login <url> <token>` with the token the server was started with';
    throw e;
  }

  const error = new ApiError(response.status, code, `${message} (HTTP ${response.status})`, url);
  error.hint = HINTS[code];
  throw error;
}

/** What to do about each of the contract's error codes, where there is something to do. */
const HINTS = {
  no_targets:
    'nothing was addressed — register another device, or use --to all to include this one',
  too_large: 'the server caps a file at 2 GB and a text payload at 64 KB',
  revoked: 'the sender revoked this transfer; ask them to send it again',
  expired: 'transfers expire after 7 days by default — send it again with --expires 30',
  signature_invalid: 'the download link expired mid-flight; try again',
};

/** Turn undici's terse failures into something a human can fix. */
export function networkError(cause, url, userSignal) {
  if (userSignal?.aborted) {
    return new CliError('cancelled', { exitCode: EXIT.OK, cause });
  }
  const origin = safeOrigin(url);
  const inner = cause?.cause ?? cause;
  const code = inner?.code ?? cause?.code;
  if (cause?.name === 'TimeoutError' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return new CliError(`timed out talking to ${origin}`, {
      exitCode: EXIT.NETWORK,
      hint: 'is the server still running?',
      cause,
    });
  }
  if (code === 'ECONNREFUSED') {
    return new CliError(`could not connect to ${origin} — connection refused`, {
      exitCode: EXIT.NETWORK,
      hint: 'start the server (`npm run dev` in server/) or check the URL with `transmat status`',
      cause,
    });
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new CliError(`could not resolve the host in ${origin}`, {
      exitCode: EXIT.NETWORK,
      hint: 'check the server URL you logged in with',
      cause,
    });
  }
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') {
    return new CliError(`connection to ${origin} was reset`, { exitCode: EXIT.NETWORK, cause });
  }
  return new CliError(`request to ${origin} failed: ${inner?.message ?? cause?.message ?? cause}`, {
    exitCode: EXIT.NETWORK,
    cause,
  });
}

function safeOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return String(url);
  }
}
