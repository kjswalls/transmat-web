/**
 * GET /v1/events?device_id=… — Server-Sent Events.
 *
 * Two write paths, one lifecycle. Under @hono/node-server we take over the raw
 * ServerResponse (flush control, and a reliable 'close' on client disconnect);
 * when the app is driven by `app.fetch` directly — tests, or any non-Node
 * adapter — we fall back to a web ReadableStream. Either way the keepalive
 * interval and the hub subscription are torn down exactly once.
 */
import { Hono } from 'hono';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';

/** Undelivered bytes past which an SSE client is treated as gone. */
const MAX_SSE_BACKLOG_BYTES = 8 * 1024 * 1024;

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
};

export function eventRoutes(ctx) {
  const app = new Hono();
  const { events, db } = ctx;

  app.get('/', (c) => {
    const deviceId = c.req.query('device_id') || null;
    if (deviceId && db.getDevice(deviceId)) db.touchDevice(deviceId);

    const res = c.env?.outgoing;
    const req = c.env?.incoming;

    if (res && typeof res.write === 'function') {
      /* ---- raw Node path (production) ---- */
      // Taking over the socket means Hono never gets to apply the headers that
      // middleware (CORS, above all) has already staged on `c.res`. Merge them
      // in by hand or a browser EventSource on another origin cannot read a
      // single byte of this stream.
      res.writeHead(200, { ...stagedHeaders(c), ...SSE_HEADERS });
      let closed = false;
      /** @type {() => void} */
      let unsubscribe = () => {};
      const teardown = () => {
        if (closed) return;
        closed = true;
        unsubscribe(); // clears the keepalive interval — no leak
        try {
          res.end();
        } catch {
          /* socket already gone */
        }
      };
      ({ unsubscribe } = events.subscribe({
        deviceId,
        write: (chunk) => {
          if (closed) return;
          // A subscriber that has stopped reading must not become an unbounded
          // buffer in this process. Past this much undelivered SSE the client
          // is gone in every sense that matters; drop it.
          if (res.writableLength > MAX_SSE_BACKLOG_BYTES) {
            console.warn('[transmat] SSE client is not reading; dropping the stream');
            teardown();
            return;
          }
          res.write(chunk);
        },
      }));
      req?.on('close', teardown);
      req?.on('error', teardown);
      res.on('close', teardown);
      res.on('error', teardown);

      res.write(`retry: 3000\n:connected ${new Date().toISOString()}\n\n`);
      return RESPONSE_ALREADY_SENT;
    }

    /* ---- portable ReadableStream path (tests / other adapters) ---- */
    const encoder = new TextEncoder();
    let unsubscribe = () => {};
    const stream = new ReadableStream({
      start(controller) {
        let closed = false;
        const sub = events.subscribe({
          deviceId,
          write: (chunk) => {
            if (closed) return;
            try {
              controller.enqueue(encoder.encode(chunk));
            } catch {
              closed = true;
              sub.unsubscribe();
            }
          },
        });
        unsubscribe = () => {
          if (closed) return;
          closed = true;
          sub.unsubscribe();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        };
        controller.enqueue(encoder.encode(`retry: 3000\n:connected ${new Date().toISOString()}\n\n`));
      },
      cancel() {
        unsubscribe();
      },
    });

    return new Response(stream, { status: 200, headers: SSE_HEADERS });
  });

  return app;
}

/**
 * Headers that middleware has already put on the response Hono was building,
 * before this handler decided to write the socket itself.
 * @param {import('hono').Context} c
 * @returns {Record<string,string>}
 */
function stagedHeaders(c) {
  /** @type {Record<string,string>} */
  const out = {};
  try {
    for (const [k, v] of c.res.headers) {
      // Hono's default Response carries a content-type we must not send on an
      // event stream, and a length that would truncate it.
      if (k === 'content-type' || k === 'content-length') continue;
      out[k] = v;
    }
  } catch {
    /* no staged response — nothing to merge */
  }
  return out;
}
export default eventRoutes;
