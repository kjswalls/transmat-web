/**
 * A streaming multipart/form-data body builder.
 *
 * Node's own FormData would work, but it gives no hook for progress and
 * (with a Blob) makes it easy to accidentally buffer the whole file. This
 * yields the envelope by hand around an async iterable of chunks, so a 2 GB
 * upload costs one 64 KB chunk of memory and reports every byte as it leaves.
 */
import { randomBytes } from 'node:crypto';

const CRLF = '\r\n';

/** RFC 7578 §5.1: escape quotes and strip the CR/LF that would end the header. */
function escapeHeaderValue(value) {
  return String(value).replace(/[\r\n]/g, ' ').replace(/"/g, '%22');
}

/**
 * @param {object} options
 * @param {Array<[string,string]>} [options.fields] repeatable, order preserved
 * @param {{field?:string, filename:string, contentType?:string, stream:AsyncIterable<Uint8Array>}} [options.file]
 * @param {(n:number)=>void} [options.onProgress] called with bytes of file payload
 * @returns {{contentType:string, boundary:string, body:ReadableStream<Uint8Array>}}
 */
export function buildMultipart({ fields = [], file, onProgress } = {}) {
  const boundary = `----TransmatBoundary${randomBytes(16).toString('hex')}`;
  const encoder = new TextEncoder();

  async function* generate() {
    for (const [name, value] of fields) {
      if (value === undefined || value === null) continue;
      yield encoder.encode(
        `--${boundary}${CRLF}` +
          `content-disposition: form-data; name="${escapeHeaderValue(name)}"${CRLF}${CRLF}` +
          `${value}${CRLF}`,
      );
    }

    if (file) {
      const fieldName = file.field ?? 'file';
      yield encoder.encode(
        `--${boundary}${CRLF}` +
          `content-disposition: form-data; name="${escapeHeaderValue(fieldName)}"; ` +
          `filename="${escapeHeaderValue(file.filename)}"${CRLF}` +
          `content-type: ${escapeHeaderValue(file.contentType || 'application/octet-stream')}${CRLF}${CRLF}`,
      );
      for await (const chunk of file.stream) {
        const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        onProgress?.(bytes.byteLength);
        yield bytes;
      }
      yield encoder.encode(CRLF);
    }

    yield encoder.encode(`--${boundary}--${CRLF}`);
  }

  return {
    boundary,
    contentType: `multipart/form-data; boundary=${boundary}`,
    /** The raw async iterable — what a node:http request wants (see upload.js). */
    parts: generate(),
    /** Lazy, because ReadableStream.from() starts nothing until it is read. */
    get body() {
      return ReadableStream.from(generate());
    },
  };
}
