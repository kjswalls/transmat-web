/**
 * A minimal Server-Sent Events parser, per the WHATWG event-stream rules.
 *
 * Enough of the spec to be correct against docs/CONTRACT.md and any other
 * conforming server: CRLF/LF/CR line endings, one optional space after the
 * colon, multi-line `data:` joined with newlines, `:` comments (the
 * keepalives) surfaced separately so a caller can use them as a liveness
 * signal, and `retry:` respected as a reconnect hint.
 */

/**
 * @param {ReadableStream<Uint8Array>} stream
 * @yields {{type:'event'|'comment', event?:string, data?:string, id?:string, retry?:number, text?:string}}
 */
export async function* parseSSE(stream) {
  const decoder = new TextDecoder();
  let buffer = '';
  /** @type {{event:string|null, data:string[], id:string|null, retry:number|null}} */
  let current = fresh();

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });

    let index;
    // Normalise line endings as we go; a CRLF split across chunks is handled
    // because we only ever consume up to a \n or a \r that is not last.
    while ((index = indexOfLineBreak(buffer)) !== -1) {
      const { line, rest } = splitAt(buffer, index);
      buffer = rest;

      if (line === '') {
        if (current.data.length || current.event || current.id || current.retry !== null) {
          yield {
            type: 'event',
            event: current.event ?? 'message',
            data: current.data.join('\n'),
            id: current.id ?? undefined,
            retry: current.retry ?? undefined,
          };
        }
        current = fresh();
        continue;
      }

      if (line.startsWith(':')) {
        yield { type: 'comment', text: line.slice(1).trim() };
        continue;
      }

      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);

      switch (field) {
        case 'event':
          current.event = value;
          break;
        case 'data':
          current.data.push(value);
          break;
        case 'id':
          if (!value.includes('\0')) current.id = value;
          break;
        case 'retry': {
          const ms = Number(value);
          if (Number.isInteger(ms) && ms >= 0) current.retry = ms;
          break;
        }
        default:
          /* unknown field: ignore, per spec */
          break;
      }
    }
  }
}

function fresh() {
  return { event: null, data: [], id: null, retry: null };
}

/** Index of the first \n or of a \r that we know isn't half of a split CRLF. */
function indexOfLineBreak(buffer) {
  for (let i = 0; i < buffer.length; i += 1) {
    const ch = buffer[i];
    if (ch === '\n') return i;
    if (ch === '\r') {
      // A trailing \r might be the first half of a CRLF still in flight.
      if (i === buffer.length - 1) return -1;
      return i;
    }
  }
  return -1;
}

function splitAt(buffer, index) {
  const line = buffer.slice(0, index);
  let next = index + 1;
  if (buffer[index] === '\r' && buffer[next] === '\n') next += 1;
  return { line, rest: buffer.slice(next) };
}

/**
 * Exponential backoff with full jitter, so a server restart doesn't bring
 * every watcher back in the same millisecond.
 *
 * @param {number} attempt 1-based
 * @param {object} [options]
 */
export function backoffDelay(attempt, { base = 1000, max = 30_000, jitter = true } = {}) {
  const raw = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  if (!jitter) return raw;
  // Full jitter, but never below a quarter of the window: still fast, still spread.
  return Math.round(raw * (0.25 + Math.random() * 0.75));
}
