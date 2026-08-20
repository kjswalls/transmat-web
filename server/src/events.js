/**
 * SSE hub.
 *
 * Subscribers are plain callbacks; the HTTP layer owns the socket. Every event
 * carries an `audience` — the set of device ids it concerns (recipients plus
 * the sender) — and a subscriber that named a `device_id` only sees events
 * whose audience contains it, per the contract.
 *
 * The classic bug here is a leaked keepalive interval when a client
 * disconnects. Each subscription owns exactly one interval, `unsubscribe()` is
 * idempotent, and the HTTP route calls it from every close/error path.
 */

/** Keepalive comment cadence, from the contract. */
export const KEEPALIVE_MS = 25_000;

/**
 * @typedef {object} Subscriber
 * @property {string} id
 * @property {string|null} deviceId
 * @property {(chunk:string)=>void} write
 */

export function createEventHub({ keepaliveMs = KEEPALIVE_MS } = {}) {
  /** @type {Map<string, {sub:Subscriber, timer:NodeJS.Timeout, closed:boolean}>} */
  const subscribers = new Map();
  let counter = 0;

  /**
   * @param {object} options
   * @param {string|null} [options.deviceId] filter: only events this device is party to
   * @param {(chunk:string)=>void} options.write raw SSE writer
   * @param {(err:unknown)=>void} [options.onError]
   * @returns {{id:string, unsubscribe:()=>void}}
   */
  function subscribe({ deviceId = null, write, onError }) {
    const id = `sse_${++counter}_${Date.now().toString(36)}`;

    const safeWrite = (chunk) => {
      try {
        write(chunk);
      } catch (err) {
        onError?.(err);
        unsubscribe(id);
      }
    };

    const timer = setInterval(() => safeWrite(`:keepalive ${Date.now()}\n\n`), keepaliveMs);
    // Never hold the event loop open on account of an idle SSE client.
    timer.unref?.();

    subscribers.set(id, { sub: { id, deviceId, write: safeWrite }, timer, closed: false });
    return { id, unsubscribe: () => unsubscribe(id) };
  }

  /** Idempotent: safe to call from 'close', 'error' and an explicit shutdown. */
  function unsubscribe(id) {
    const entry = subscribers.get(id);
    if (!entry) return false;
    entry.closed = true;
    clearInterval(entry.timer);
    subscribers.delete(id);
    return true;
  }

  /**
   * @param {string} event event name, e.g. 'transfer.created'
   * @param {object} data JSON-serializable payload
   * @param {{audience?: Iterable<string|null|undefined>}} [options] device ids
   *   this event concerns; omit for a broadcast everyone receives.
   */
  function publish(event, data, options = {}) {
    const audience = options.audience ? new Set([...options.audience].filter(Boolean)) : null;
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    let delivered = 0;
    for (const { sub } of [...subscribers.values()]) {
      if (sub.deviceId && audience && !audience.has(sub.deviceId)) continue;
      sub.write(frame);
      delivered += 1;
    }
    return delivered;
  }

  /** Close every stream — used on shutdown and in tests. */
  function closeAll() {
    for (const id of [...subscribers.keys()]) unsubscribe(id);
  }

  return {
    subscribe,
    unsubscribe,
    publish,
    closeAll,
    get size() {
      return subscribers.size;
    },
    /** Test/debug helper. */
    listDeviceFilters: () => [...subscribers.values()].map((e) => e.sub.deviceId),
  };
}

export default createEventHub;
