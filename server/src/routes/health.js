import { Hono } from 'hono';

/** GET /health — no auth, per the contract. */
export function healthRoutes(ctx) {
  const app = new Hono();
  app.get('/health', (c) =>
    c.json({
      ok: true,
      storage: ctx.storage.name,
      push: ctx.push.name,
      version: ctx.config.version,
    }),
  );
  return app;
}
export default healthRoutes;
