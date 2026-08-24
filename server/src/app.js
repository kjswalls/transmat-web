/**
 * Wires the Hono app. Everything it needs is injected, so tests can build a
 * complete server against a throwaway data directory.
 */
import crypto from 'node:crypto';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { AppError, renderError, unauthorized } from './errors.js';
import { healthRoutes } from './routes/health.js';
import { deviceRoutes } from './routes/devices.js';
import { transferRoutes } from './routes/transfers.js';
import { deliveryRoutes } from './routes/deliveries.js';
import { eventRoutes } from './routes/events.js';
import { blobRoutes } from './routes/blob.js';
import { RateLimiter, TIERS, clientKey } from './ratelimit.js';

/** Constant-time bearer comparison — no early exit on the first wrong byte. */
export function tokenMatches(expected, presented) {
  if (typeof presented !== 'string' || presented.length === 0) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  if (a.length !== b.length) {
    // Still burn a comparison so length isn't a fast-path oracle.
    crypto.timingSafeEqual(a, a);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

/**
 * @typedef {object} AppContext
 * @property {import('./config.js').Config} config
 * @property {import('./db.js').Db} db
 * @property {any} storage
 * @property {any} push
 * @property {ReturnType<import('./events.js').createEventHub>} events
 */

/** @param {AppContext} ctx */
export function createApp(ctx) {
  const app = new Hono();

  // The web app is served from another origin in dev (Vite on :5173) and the
  // API is bearer-authenticated rather than cookie-authenticated, so a
  // reflected origin with no credentials is the right posture here.
  app.use(
    '*',
    cors({
      origin: (origin) => origin ?? '*',
      allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
      allowHeaders: ['Authorization', 'Content-Type', 'Accept', 'Range'],
      exposeHeaders: ['Content-Disposition', 'Content-Range', 'Accept-Ranges', 'Location'],
      maxAge: 600,
    }),
  );

  // ---- rate limiting ------------------------------------------------------
  // Before auth, so a flood of bad tokens is cheap to refuse, and before the
  // routes so an unauthenticated /blob PUT is covered too.
  const limiter = ctx.rateLimiter ?? new RateLimiter();
  ctx.rateLimiter = limiter;

  if (ctx.config.rateLimitEnabled) {
    app.use('*', async (c, next) => {
      const path = new URL(c.req.url).pathname;

      // One long-lived connection per client, and reconnect storms are exactly
      // when we must not refuse. See ratelimit.js.
      if (path === '/v1/events') return next();

      let tier = TIERS.api;
      if (path.startsWith('/blob/')) tier = TIERS.blob;
      else if (path === '/health') tier = TIERS.health;
      else if (path === '/v1/transfers' && c.req.method === 'POST') {
        // Only the reservation branch parks a global slot; a text transfer is
        // an ordinary write. Cheap sniff: reservations are JSON.
        const type = (c.req.header('content-type') ?? '').toLowerCase();
        if (type.startsWith('application/json')) tier = TIERS.reserve;
      }

      const verdict = limiter.take(clientKey(c, { trustProxy: ctx.config.trustProxy }), tier);
      if (!verdict.ok) {
        c.header('Retry-After', String(verdict.retryAfterSeconds));
        return c.json(
          {
            error: {
              code: 'rate_limited',
              message: `Too many ${verdict.tier.label}. Try again in ${verdict.retryAfterSeconds}s.`,
            },
          },
          429,
        );
      }
      return next();
    });
  }

  if (ctx.config.logRequests) {
    app.use('*', async (c, next) => {
      const started = Date.now();
      await next();
      console.log(
        `[transmat] ${c.req.method} ${new URL(c.req.url).pathname} → ${c.res.status} (${Date.now() - started}ms)`,
      );
    });
  }

  // ---- auth: /v1 only -----------------------------------------------------
  app.use('/v1/*', async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    let presented = m ? m[1].trim() : null;

    // EventSource cannot set headers; allow the token on the SSE query string.
    if (!presented && new URL(c.req.url).pathname === '/v1/events') {
      presented = c.req.query('access_token') ?? c.req.query('token') ?? null;
    }

    if (!presented || !tokenMatches(ctx.config.token, presented)) {
      throw unauthorized(
        header ? 'bearer token does not match TRANSMAT_TOKEN' : 'missing Authorization: Bearer <token>',
      );
    }
    await next();
  });

  // ---- routes -------------------------------------------------------------
  app.route('/', healthRoutes(ctx));
  app.route('/blob', blobRoutes(ctx));
  app.route('/v1/devices', deviceRoutes(ctx));
  app.route('/v1/transfers', transferRoutes(ctx));
  app.route('/v1/deliveries', deliveryRoutes(ctx));
  app.route('/v1/events', eventRoutes(ctx));

  app.notFound((c) =>
    c.json({ error: { code: 'not_found', message: `no route for ${c.req.method} ${new URL(c.req.url).pathname}` } }, 404),
  );
  app.onError((err, c) => renderError(err, c));

  return app;
}

export { AppError };
export default createApp;
