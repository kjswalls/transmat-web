import { Hono } from 'hono';
import { badRequest, notFound } from '../errors.js';
import {
  PLATFORMS,
  MAX_DEVICE_BODY_BYTES,
  MAX_DEVICE_NAME_CHARS,
  MAX_PUSH_TOKEN_CHARS,
} from '../config.js';
import { readJsonBody } from '../body.js';
import { serializeDevice } from '../serialize.js';

/** @param {{db:import('../db.js').Db}} ctx */
export function deviceRoutes(ctx) {
  const app = new Hono();
  const { db } = ctx;

  // POST /v1/devices — upsert on push_token when present, else name+platform.
  app.post('/', async (c) => {
    const body = await readJson(c);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const platform = typeof body.platform === 'string' ? body.platform.trim().toLowerCase() : '';

    if (!name) throw badRequest('name is required');
    if (name.length > MAX_DEVICE_NAME_CHARS) {
      throw badRequest(`name must be at most ${MAX_DEVICE_NAME_CHARS} characters`);
    }
    if (!PLATFORMS.includes(platform)) {
      throw badRequest(`platform must be one of ${PLATFORMS.join(', ')} (got "${body.platform}")`);
    }
    if (body.push_token != null && typeof body.push_token !== 'string') {
      throw badRequest('push_token must be a string');
    }
    if (typeof body.push_token === 'string' && body.push_token.length > MAX_PUSH_TOKEN_CHARS) {
      throw badRequest(`push_token must be at most ${MAX_PUSH_TOKEN_CHARS} characters`);
    }
    if (body.push_channel != null && !['apns', 'none'].includes(body.push_channel)) {
      throw badRequest('push_channel must be "apns" or "none"');
    }

    const pushToken = typeof body.push_token === 'string' ? body.push_token.trim() : '';
    const device = db.upsertDevice({
      name,
      platform,
      push_token: pushToken || null,
      push_channel: body.push_channel ?? null,
    });
    return c.json(serializeDevice(device), 200);
  });

  // GET /v1/devices
  app.get('/', (c) => c.json({ devices: db.listDevices().map(serializeDevice) }));

  // PATCH /v1/devices/:id
  app.patch('/:id', async (c) => {
    const body = await readJson(c);
    const id = c.req.param('id');
    if (!db.getDevice(id)) throw notFound(`no device ${id}`);
    if (body.name != null) {
      const name = String(body.name).trim();
      if (!name) throw badRequest('name cannot be empty');
      if (name.length > MAX_DEVICE_NAME_CHARS) {
        throw badRequest(`name must be at most ${MAX_DEVICE_NAME_CHARS} characters`);
      }
      db.renameDevice(id, name);
    } else {
      db.touchDevice(id);
    }
    return c.json(serializeDevice(db.getDevice(id)));
  });

  // DELETE /v1/devices/:id
  app.delete('/:id', (c) => {
    const id = c.req.param('id');
    if (!db.deleteDevice(id)) throw notFound(`no device ${id}`);
    return c.json({ ok: true });
  });

  return app;
}

/**
 * JSON body reader for the device routes. A device registration is a name, a
 * platform and maybe a push token — there is no legitimate multi-megabyte body
 * here, and reading one unbounded is a trivial memory/disk DoS for anyone
 * holding the bearer token. Cap it while streaming.
 */
export async function readJson(c) {
  return readJsonBody(c, MAX_DEVICE_BODY_BYTES);
}

export default deviceRoutes;
