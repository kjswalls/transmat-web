/**
 * Rate limiting.
 *
 * The server is meant to be reachable from a phone, which means reachable from
 * the internet — and it has one shared bearer token, so there is no per-user
 * anything to limit against. Per-IP token buckets are the whole defence.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter, TIERS, clientKey } from '../src/ratelimit.js';
import { makeListeningServer, registerDevice, TEST_TOKEN } from './helpers.js';

const auth = { authorization: `Bearer ${TEST_TOKEN}` };

describe('token bucket', () => {
  test('spends down to the capacity, then refuses', () => {
    const rl = new RateLimiter({ now: () => 1000 });
    const tier = { capacity: 3, refillPerSecond: 1, label: 't' };
    assert.deepEqual([1, 2, 3].map(() => rl.take('a', tier).ok), [true, true, true]);
    const refused = rl.take('a', tier);
    assert.equal(refused.ok, false);
    assert.ok(refused.retryAfterSeconds >= 1, 'no Retry-After hint');
  });

  test('refills over time rather than resetting on a boundary', () => {
    let clock = 1000;
    const rl = new RateLimiter({ now: () => clock });
    const tier = { capacity: 2, refillPerSecond: 1, label: 't' };
    rl.take('a', tier); rl.take('a', tier);
    assert.equal(rl.take('a', tier).ok, false);

    clock += 1000;                       // one second, one token
    assert.equal(rl.take('a', tier).ok, true);
    assert.equal(rl.take('a', tier).ok, false, 'refilled more than it should have');

    clock += 60_000;                     // long idle
    assert.ok(rl.peek('a', tier) <= tier.capacity, 'refill exceeded capacity');
  });

  test('buckets are per key, so one noisy caller cannot starve another', () => {
    const rl = new RateLimiter({ now: () => 1000 });
    const tier = { capacity: 1, refillPerSecond: 1, label: 't' };
    assert.equal(rl.take('noisy', tier).ok, true);
    assert.equal(rl.take('noisy', tier).ok, false);
    assert.equal(rl.take('quiet', tier).ok, true, 'a second caller was starved');
  });

  test('tiers are independent — blob traffic does not eat the API budget', () => {
    const rl = new RateLimiter({ now: () => 1000 });
    for (let i = 0; i < TIERS.blob.capacity; i++) rl.take('a', TIERS.blob);
    assert.equal(rl.take('a', TIERS.blob).ok, false);
    assert.equal(rl.take('a', TIERS.api).ok, true, 'tiers share a bucket');
  });

  test('the key map is bounded, since the key space is attacker-controlled', () => {
    const rl = new RateLimiter({ now: () => 1000, maxKeys: 100 });
    const tier = { capacity: 1, refillPerSecond: 1, label: 't' };
    for (let i = 0; i < 500; i++) rl.take(`spoofed-${i}`, tier);
    assert.ok(rl.buckets.size <= 100, `map grew to ${rl.buckets.size} — that is the leak`);
  });
});

describe('client identity', () => {
  const withHeaders = (headers) => ({
    req: { header: (n) => headers[n.toLowerCase()] },
    env: { incoming: { socket: { remoteAddress: '10.0.0.1' } } },
  });

  test('X-Forwarded-For is ignored unless we are told to trust a proxy', () => {
    const c = withHeaders({ 'x-forwarded-for': '1.2.3.4' });
    assert.equal(clientKey(c, { trustProxy: false }), '10.0.0.1',
      'a spoofed header picked the bucket');
    assert.equal(clientKey(c, { trustProxy: true }), '1.2.3.4');
  });

  test('takes the first hop of a forwarded chain', () => {
    const c = withHeaders({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' });
    assert.equal(clientKey(c, { trustProxy: true }), '1.2.3.4');
  });

  test('falls back to a shared bucket rather than throwing', () => {
    assert.equal(clientKey({ req: { header: () => undefined }, env: {} }), 'unknown');
  });
});

describe('over HTTP', () => {
  test('a reservation flood is refused with 429 and Retry-After', async () => {
    const h = await makeListeningServer({ overrides: { RATE_LIMIT: 'true' } });
    await registerDevice(h, { name: 'P', platform: 'ios' });

    const reserve = () => fetch(h.url('/v1/transfers'), {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'presigned', name: 'x.bin', size: 4, to: 'all' }),
    });

    let limited = null;
    for (let i = 0; i < TIERS.reserve.capacity + 5; i++) {
      const res = await reserve();
      if (res.status === 429) { limited = res; break; }
      await res.body?.cancel();
    }
    assert.ok(limited, `no 429 after ${TIERS.reserve.capacity + 5} reservations`);
    assert.ok(Number(limited.headers.get('retry-after')) >= 1, 'no Retry-After header');
    assert.equal((await limited.json()).error.code, 'rate_limited');
  });

  test('reads are not throttled at the reservation rate', async () => {
    const h = await makeListeningServer({ overrides: { RATE_LIMIT: 'true' } });
    // Comfortably past the reserve tier, well inside the api tier.
    for (let i = 0; i < TIERS.reserve.capacity + 10; i++) {
      const res = await fetch(h.url('/v1/transfers'), { headers: auth });
      assert.equal(res.status, 200, `listing was throttled on request ${i + 1}`);
      await res.body?.cancel();
    }
  });

  test('a bad token is refused before it can be checked repeatedly', async () => {
    const h = await makeListeningServer({ overrides: { RATE_LIMIT: 'true' } });
    let sawLimit = false;
    for (let i = 0; i < TIERS.api.capacity + 20; i++) {
      const res = await fetch(h.url('/v1/devices'), {
        headers: { authorization: 'Bearer wrong-token' },
      });
      await res.body?.cancel();
      // 401 until the bucket empties, then 429 — the point is that guessing
      // costs the attacker, rather than being free forever.
      assert.ok(res.status === 401 || res.status === 429, `unexpected ${res.status}`);
      if (res.status === 429) { sawLimit = true; break; }
    }
    assert.ok(sawLimit, 'token guessing was never rate limited');
  });

  test('SSE is exempt — reconnect storms are when we least want to refuse', async () => {
    const h = await makeListeningServer({ overrides: { RATE_LIMIT: 'true' } });
    for (let i = 0; i < 10; i++) {
      const controller = new AbortController();
      const res = await fetch(h.url('/v1/events'), { headers: auth, signal: controller.signal });
      assert.equal(res.status, 200, `SSE reconnect ${i + 1} was refused`);
      controller.abort();
    }
  });

  test('limiting is off by default in tests, so the rest of the suite is unaffected', async () => {
    const h = await makeListeningServer();
    for (let i = 0; i < TIERS.reserve.capacity + 5; i++) {
      const res = await fetch(h.url('/health'));
      assert.equal(res.status, 200);
      await res.body?.cancel();
    }
  });
});
