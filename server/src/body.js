/**
 * Request-body reading with a hard byte cap.
 *
 * Nothing on this server should ever buffer an unbounded body: the only
 * unbounded thing we accept is a multipart *file* part, and that one streams
 * straight into the storage driver. Every JSON route goes through here, which
 * counts bytes as they arrive and aborts the moment the cap is passed —
 * `content-length` is only ever a hint, never trusted on its own.
 */
import { Readable } from 'node:stream';
import { badRequest, tooLarge } from './errors.js';

/**
 * @param {import('hono').Context} c
 * @param {number} maxBytes
 * @returns {Promise<string>}
 */
export async function readBodyWithCap(c, maxBytes) {
  const declared = Number(c.req.header('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw tooLarge(`request body exceeds ${maxBytes} bytes`);
  }

  const incoming = c.env?.incoming;
  const source =
    incoming && typeof incoming[Symbol.asyncIterator] === 'function'
      ? incoming
      : c.req.raw.body
        ? Readable.fromWeb(c.req.raw.body)
        : null;
  if (!source) return '';

  /** @type {Buffer[]} */
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of source) {
      total += chunk.length;
      if (total > maxBytes) {
        source.destroy?.(); // stop reading; do not drain a hostile body
        throw tooLarge(`request body exceeds ${maxBytes} bytes`);
      }
      chunks.push(chunk);
    }
  } catch (err) {
    if (err?.code === 'too_large') throw err;
    throw badRequest(`could not read request body: ${err?.message ?? err}`);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Capped read + strict JSON-object parse, with the contract's 400 on failure.
 * @param {import('hono').Context} c
 * @param {number} maxBytes
 * @returns {Promise<Record<string, unknown>>}
 */
export async function readJsonBody(c, maxBytes) {
  const raw = await readBodyWithCap(c, maxBytes);
  if (!raw.trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw badRequest(`invalid JSON body: ${err.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw badRequest('body must be a JSON object');
  }
  return parsed;
}
