/**
 * Rate limiting.
 *
 * The server has one shared bearer token, so "per user" does not exist here —
 * every authenticated caller is the same principal. Limiting is therefore per
 * client IP, which is the only thing that distinguishes callers.
 *
 * WHAT THIS DOES AND DOES NOT PROTECT
 *
 * The valuable surfaces are the ones reachable WITHOUT the bearer token,
 * because those are what a stranger who finds your tunnel URL can touch:
 *
 *   · POST /blob/:key   — a signed upload. Needs a valid HMAC, so it is not
 *                         open, but a leaked URL is reusable until it expires
 *                         and each use can carry the declared size.
 *   · GET  /blob/:key   — a signed download, same reasoning.
 *   · GET  /health      — unauthenticated by design.
 *
 * And the expensive authenticated ones: reserving an upload parks a slot out
 * of a global 64, so a loop of reservations is a denial of service against
 * everyone else even with a valid token.
 *
 * Deliberately NOT limited: GET /v1/events. An SSE client holds exactly one
 * long-lived connection; counting it against a per-minute budget would drop
 * legitimate reconnects during a flaky-network storm, which is precisely when
 * the product needs to reconnect most.
 *
 * This is an in-process token bucket. It resets on restart and does not span
 * instances — fine for a single-box personal server, and stated plainly so
 * nobody assumes otherwise when they scale out.
 */

/** @typedef {{capacity:number, refillPerSecond:number, label:string}} Tier */

/** Tiers, chosen so a human never notices and a loop does immediately. */
export const TIERS = {
  /** Reserving an upload parks one of 64 global slots. */
  reserve: { capacity: 20, refillPerSecond: 20 / 60, label: 'upload reservations' },
  /** Signed blob traffic — the unauthenticated surface. */
  blob: { capacity: 120, refillPerSecond: 2, label: 'blob transfers' },
  /** Everything else under /v1: listing, acking, registering, revoking. */
  api: { capacity: 300, refillPerSecond: 5, label: 'API requests' },
  /** Unauthenticated liveness checks. */
  health: { capacity: 60, refillPerSecond: 1, label: 'health checks' },
};

export class RateLimiter {
  /**
   * @param {{now?:() => number, maxKeys?:number}} [options]
   *   `now` is injectable so tests can drive the clock instead of sleeping.
   */
  constructor({ now = Date.now, maxKeys = 10_000 } = {}) {
    this.now = now;
    this.maxKeys = maxKeys;
    /** @type {Map<string, {tokens:number, updated:number}>} */
    this.buckets = new Map();
  }

  /**
   * Take one token.
   * @param {string} key   caller identity, usually an IP
   * @param {Tier} tier
   * @returns {{ok:true} | {ok:false, retryAfterSeconds:number, tier:Tier}}
   */
  take(key, tier) {
    const id = `${tier.label}:${key}`;
    const t = this.now();
    let bucket = this.buckets.get(id);

    if (!bucket) {
      // A bounded map, because the key space is attacker-controlled: a
      // spoofed X-Forwarded-For per request would otherwise grow this
      // without limit and turn the limiter itself into the memory leak.
      if (this.buckets.size >= this.maxKeys) this.evictOldest();
      bucket = { tokens: tier.capacity, updated: t };
      this.buckets.set(id, bucket);
    }

    const elapsedSeconds = Math.max(0, (t - bucket.updated) / 1000);
    bucket.tokens = Math.min(tier.capacity, bucket.tokens + elapsedSeconds * tier.refillPerSecond);
    bucket.updated = t;

    if (bucket.tokens < 1) {
      const needed = (1 - bucket.tokens) / tier.refillPerSecond;
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(needed)), tier };
    }
    bucket.tokens -= 1;
    return { ok: true };
  }

  /** Drop the least recently touched quarter. Cheap and rarely reached. */
  evictOldest() {
    const entries = [...this.buckets.entries()].sort((a, b) => a[1].updated - b[1].updated);
    for (const [id] of entries.slice(0, Math.ceil(entries.length / 4))) this.buckets.delete(id);
  }

  /** Test seam: how many tokens a key has left, without spending one. */
  peek(key, tier) {
    const bucket = this.buckets.get(`${tier.label}:${key}`);
    if (!bucket) return tier.capacity;
    const elapsedSeconds = Math.max(0, (this.now() - bucket.updated) / 1000);
    return Math.min(tier.capacity, bucket.tokens + elapsedSeconds * tier.refillPerSecond);
  }

  reset() {
    this.buckets.clear();
  }
}

/**
 * Best-effort client identity.
 *
 * `X-Forwarded-For` is trusted only when the server is told it sits behind a
 * proxy (`TRUST_PROXY=true`), because otherwise anyone can set it and pick
 * their own bucket — which would make the limiter worse than useless, since it
 * would still consume memory while enforcing nothing.
 */
export function clientKey(c, { trustProxy = false } = {}) {
  if (trustProxy) {
    const forwarded = c.req.header('x-forwarded-for');
    if (forwarded) {
      const first = forwarded.split(',')[0]?.trim();
      if (first) return first;
    }
    const real = c.req.header('x-real-ip');
    if (real) return real.trim();
  }
  // Hono's node adapter exposes the socket here; fall back to a single shared
  // bucket rather than throwing if the shape ever changes.
  return (
    c.env?.incoming?.socket?.remoteAddress ??
    c.env?.incoming?.connection?.remoteAddress ??
    'unknown'
  );
}
