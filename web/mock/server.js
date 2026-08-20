/**
 * Mock Transmat server — implements docs/CONTRACT.md exactly enough to drive the web client.
 *
 * This exists ONLY so the web client can be exercised while the real server is being
 * built in parallel at ../server. The client talks to it with the same code path it
 * uses against the real thing: bearer auth, multipart POST /v1/transfers, SSE /v1/events.
 *
 *   node mock/server.js            # PORT=8787 TRANSMAT_TOKEN=dev-token-change-me
 *   MOCK_EMPTY=1 node mock/server.js   # no devices, no transfers (first-run state)
 */
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT || 8787);
const TOKEN = process.env.TRANSMAT_TOKEN || 'dev-token-change-me';
const SECRET = process.env.BLOB_SIGNING_SECRET || TOKEN;
const EMPTY = process.env.MOCK_EMPTY === '1';

const now = () => new Date().toISOString();
const iso = (msFromNow) => new Date(Date.now() + msFromNow).toISOString();
const id = (p) => `${p}_${crypto.randomBytes(9).toString('hex')}`;
const DAY = 86400000;

/** @type {Map<string, any>} */
const devices = new Map();
/** @type {any[]} */
let transfers = [];
/** @type {Map<string, {body: Buffer, contentType: string, name: string}>} */
const blobs = new Map();
/** @type {Set<{res: http.ServerResponse, deviceId: string|null}>} */
const clients = new Set();

function addDevice(name, platform, opts = {}) {
  const d = {
    device_id: id('dev'),
    name,
    platform,
    push_channel: opts.push_channel || (platform === 'ios' ? 'apns' : 'none'),
    has_push_token: !!opts.push_token,
    last_seen_at: opts.last_seen_at || now(),
    created_at: iso(-30 * DAY),
  };
  devices.set(d.device_id, d);
  return d;
}

function seed() {
  if (EMPTY) return;
  const mac = addDevice("MacBook Pro", 'macos', { last_seen_at: now() });
  const phone = addDevice("Kirby's iPhone", 'ios', { push_token: 'x', last_seen_at: iso(-4 * 60000) });
  const ipad = addDevice('iPad Air', 'ios', { push_token: 'y', last_seen_at: iso(-2 * 3600000) });
  const cli = addDevice('studio-linux', 'cli', { last_seen_at: iso(-26 * 3600000) });

  const mk = (t) => {
    const tr = {
      transfer_id: id('trf'),
      kind: t.kind,
      state: t.state || 'complete',
      file_name: t.file_name ?? null,
      mime_type: t.mime_type ?? null,
      size: t.size ?? null,
      text: t.text ?? null,
      from_device_id: t.from?.device_id ?? null,
      from_device_name: t.from?.name ?? null,
      created_at: iso(-t.agoMs),
      expires_at: iso(t.expiresInMs),
      deliveries: (t.to || []).map((dev) => ({
        delivery_id: id('del'),
        device_id: dev.device_id,
        device_name: dev.name,
        state: t.deliveryState || 'pending',
        acked_at: t.deliveryState === 'downloaded' ? iso(-t.agoMs + 4000) : null,
      })),
    };
    tr._adopt = t.adopt || null;
    if (t.blob) {
      const key = id('blob');
      blobs.set(key, { body: Buffer.from(t.blob), contentType: t.mime_type || 'application/octet-stream', name: t.file_name });
      tr._key = key;
    }
    transfers.push(tr);
    return tr;
  };

  mk({ kind: 'file', file_name: 'keynote-final.mov', mime_type: 'video/quicktime', size: 184_320_998,
       from: phone, to: [mac], agoMs: 40_000, expiresInMs: 7 * DAY, blob: 'fake movie bytes', adopt: 'in' });
  mk({ kind: 'text', text: 'wifi password for the flat: hunter2-correct-horse',
       from: mac, to: [phone], agoMs: 4 * 60000, expiresInMs: 7 * DAY, deliveryState: 'downloaded', adopt: 'out' });
  mk({ kind: 'file', file_name: 'Screenshot 14.22.png', mime_type: 'image/png', size: 1_468_006,
       from: phone, to: [mac], agoMs: 5 * 3600000, expiresInMs: 2 * DAY + 3600000, blob: 'PNG bytes here', adopt: 'in' });
  mk({ kind: 'link', text: 'https://figma.com/file/tXm2QpLd/transmat-directions',
       from: mac, to: [phone, ipad, cli], agoMs: 27 * 3600000, expiresInMs: 5 * DAY, deliveryState: 'downloaded', adopt: 'out' });
  mk({ kind: 'file', file_name: 'quarterly-notes.pdf', mime_type: 'application/pdf', size: 402_113,
       from: cli, to: [mac, phone], agoMs: 2 * DAY, expiresInMs: 4 * DAY, blob: '%PDF-1.4 fake', adopt: 'in' });
  mk({ kind: 'text', text: 'ssh -J bastion.internal deploy@10.4.2.19 -L 5432:localhost:5432',
       from: ipad, to: [mac], agoMs: 3 * DAY, expiresInMs: 3 * DAY, adopt: 'in' });
  mk({ kind: 'file', file_name: 'tax-return-2025.pdf', mime_type: 'application/pdf', size: 2_516_582,
       state: 'expired', from: mac, to: [phone], agoMs: 9 * DAY, expiresInMs: -2 * DAY, adopt: 'out' });
  transfers.sort((a, b) => b.created_at.localeCompare(a.created_at));
}
/**
 * ARCHITECTURE §7: deliveries are materialized lazily when a user registers a
 * new device, so a device added later still sees unexpired transfers. The mock
 * does exactly that for the browser, and also re-attributes a couple of seeded
 * sends to it so the stream shows both directions on first load.
 */
let adopted = false;
function adoptWebDevice(dev) {
  if (adopted || EMPTY) return;
  adopted = true;
  for (const t of transfers) {
    if (t._adopt === 'in' && !t.deliveries.some((d) => d.device_id === dev.device_id)) {
      t.deliveries.push({
        delivery_id: id('del'), device_id: dev.device_id, device_name: dev.name,
        state: 'pending', acked_at: null,
      });
    } else if (t._adopt === 'out') {
      t.from_device_id = dev.device_id;
      t.from_device_name = dev.name;
    }
  }
}
seed();

function broadcast(event, data, involved) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    if (c.deviceId && involved && !involved.includes(c.deviceId)) continue;
    c.res.write(payload);
  }
}

function sign(key, exp) {
  return crypto.createHmac('sha256', SECRET).update(`${key}:${exp}`).digest('hex').slice(0, 32);
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Expose-Headers': 'Content-Disposition, Location',
};

function send(res, status, obj, extra = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS, ...extra });
  res.end(body);
}
function fail(res, status, code, message) {
  send(res, status, { error: { code, message } });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Minimal multipart/form-data parser — good enough for the client's own requests. */
function parseMultipart(buf, boundary) {
  const out = { fields: {}, repeated: {}, file: null };
  const sep = Buffer.from(`--${boundary}`);
  let idx = buf.indexOf(sep);
  while (idx !== -1) {
    const start = idx + sep.length;
    if (buf.slice(start, start + 2).toString() === '--') break;
    const next = buf.indexOf(sep, start);
    if (next === -1) break;
    const part = buf.slice(start + 2, next - 2); // strip leading CRLF and trailing CRLF
    const headEnd = part.indexOf('\r\n\r\n');
    const head = part.slice(0, headEnd).toString();
    const body = part.slice(headEnd + 4);
    const nameM = /name="([^"]*)"/.exec(head);
    const fileM = /filename="([^"]*)"/.exec(head);
    const typeM = /Content-Type:\s*([^\r\n]+)/i.exec(head);
    const name = nameM ? nameM[1] : '';
    if (fileM) {
      out.file = { filename: fileM[1], contentType: typeM ? typeM[1].trim() : 'application/octet-stream', body };
    } else {
      const v = body.toString();
      out.fields[name] = v;
      (out.repeated[name] ||= []).push(v);
    }
    idx = next;
  }
  return out;
}

function resolveTargets(toList, fromId) {
  const all = [...devices.values()];
  const set = new Map();
  for (const t of toList) {
    if (t === 'all') all.forEach((d) => set.set(d.device_id, d));
    else if (t === 'others') {
      const known = fromId && devices.has(fromId);
      all.filter((d) => !known || d.device_id !== fromId).forEach((d) => set.set(d.device_id, d));
    } else if (devices.has(t)) set.set(t, devices.get(t));
  }
  return [...set.values()];
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

  if (path === '/health') {
    return send(res, 200, { ok: true, storage: 'local', push: 'console', version: '0.0.0-mock' });
  }

  // Signed blob route — no bearer auth.
  if (path.startsWith('/blob/')) {
    const key = decodeURIComponent(path.slice('/blob/'.length));
    const exp = Number(url.searchParams.get('exp'));
    const sig = url.searchParams.get('sig');
    if (!exp || sig !== sign(key, exp)) return fail(res, 403, 'signature_invalid', 'bad signature');
    if (Date.now() > exp) return fail(res, 410, 'expired', 'link expired');
    const b = blobs.get(key);
    if (!b) return fail(res, 404, 'not_found', 'no blob');
    res.writeHead(200, {
      'Content-Type': b.contentType,
      'Content-Length': b.body.length,
      'Content-Disposition': `attachment; filename="${b.name || 'download'}"`,
      ...CORS,
    });
    return res.end(b.body);
  }

  if (!path.startsWith('/v1/')) return fail(res, 404, 'not_found', 'no route');

  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${TOKEN}`) return fail(res, 401, 'unauthorized', 'bad or missing token');

  // ---- devices ----
  if (path === '/v1/devices' && req.method === 'GET') {
    return send(res, 200, { devices: [...devices.values()] });
  }
  if (path === '/v1/devices' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString() || '{}');
    if (!body.name || !body.platform) return fail(res, 400, 'bad_request', 'name and platform required');
    let existing = null;
    for (const d of devices.values()) {
      if (body.push_token && d.has_push_token && d._token === body.push_token) existing = d;
      else if (!body.push_token && d.name === body.name && d.platform === body.platform) existing = d;
      if (existing) break;
    }
    if (existing) {
      existing.name = body.name;
      existing.last_seen_at = now();
      if (existing.platform === 'web') adoptWebDevice(existing);
      return send(res, 200, existing);
    }
    const d = addDevice(body.name, body.platform, { push_token: body.push_token, push_channel: body.push_channel });
    d._token = body.push_token;
    if (d.platform === 'web') adoptWebDevice(d);
    return send(res, 200, d);
  }
  const devMatch = /^\/v1\/devices\/([^/]+)$/.exec(path);
  if (devMatch) {
    const d = devices.get(devMatch[1]);
    if (!d) return fail(res, 404, 'not_found', 'no device');
    if (req.method === 'PATCH') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      if (body.name) d.name = body.name;
      return send(res, 200, d);
    }
    if (req.method === 'DELETE') { devices.delete(d.device_id); return send(res, 200, { ok: true }); }
  }

  // ---- events (SSE) ----
  if (path === '/v1/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      ...CORS,
    });
    res.write(': connected\n\n');
    const client = { res, deviceId: url.searchParams.get('device_id') };
    clients.add(client);
    const ka = setInterval(() => res.write(':keepalive\n\n'), 25000);
    req.on('close', () => { clearInterval(ka); clients.delete(client); });
    return;
  }

  // ---- transfers ----
  if (path === '/v1/transfers' && req.method === 'GET') {
    const q = url.searchParams;
    let list = transfers.filter((t) => {
      if (q.get('kind') && t.kind !== q.get('kind')) return false;
      const dev = q.get('device_id');
      if (dev) {
        const isRecipient = t.deliveries.some((d) => d.device_id === dev);
        const isSender = t.from_device_id === dev;
        const dir = q.get('direction');
        if (dir === 'sent' && !isSender) return false;
        if (dir === 'received' && !isRecipient) return false;
        if (!dir && !isRecipient && !isSender) return false;
      }
      const term = (q.get('q') || '').toLowerCase();
      if (term) {
        const hay = `${t.file_name || ''} ${t.text || ''} ${t.from_device_name || ''}`.toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });
    const limit = Math.min(Number(q.get('limit')) || 50, 200);
    return send(res, 200, { transfers: list.slice(0, limit).map(strip) });
  }

  const trMatch = /^\/v1\/transfers\/([^/]+)(\/blob)?$/.exec(path);
  if (trMatch) {
    const t = transfers.find((x) => x.transfer_id === trMatch[1]);
    if (!t) return fail(res, 404, 'not_found', 'no transfer');
    if (trMatch[2] === '/blob') {
      if (t.state === 'revoked') return fail(res, 410, 'revoked', 'revoked');
      if (t.state === 'expired') return fail(res, 410, 'expired', 'expired');
      if (!t._key) return fail(res, 404, 'not_found', 'no blob');
      const exp = Date.now() + 300_000;
      const loc = `http://localhost:${PORT}/blob/${t._key}?exp=${exp}&sig=${sign(t._key, exp)}`;
      res.writeHead(302, { Location: loc, ...CORS });
      return res.end();
    }
    if (req.method === 'DELETE') {
      t.state = 'revoked';
      if (t._key) blobs.delete(t._key);
      broadcast('transfer.revoked', { transfer_id: t.transfer_id });
      return send(res, 200, { ok: true });
    }
    return send(res, 200, { transfer: strip(t) });
  }

  const ackMatch = /^\/v1\/deliveries\/([^/]+)\/ack$/.exec(path);
  if (ackMatch && req.method === 'POST') {
    for (const t of transfers) {
      const d = t.deliveries.find((x) => x.delivery_id === ackMatch[1]);
      if (d) {
        d.state = 'downloaded';
        d.acked_at = now();
        broadcast('delivery.acked', { transfer_id: t.transfer_id, delivery_id: d.delivery_id, device_id: d.device_id });
        return send(res, 200, { ok: true });
      }
    }
    return fail(res, 404, 'not_found', 'no delivery');
  }

  if (path === '/v1/transfers' && req.method === 'POST') {
    const ct = req.headers['content-type'] || '';
    let fields = {}, repeated = {}, file = null;
    if (ct.includes('multipart/form-data')) {
      const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(ct);
      const raw = await readBody(req);
      ({ fields, repeated, file } = parseMultipart(raw, (boundary?.[1] || boundary?.[2] || '').trim()));
    } else {
      fields = JSON.parse((await readBody(req)).toString() || '{}');
      repeated = { to: Array.isArray(fields.to) ? fields.to : fields.to ? [fields.to] : [] };
    }
    const toList = (repeated.to && repeated.to.length ? repeated.to : ['others']).flatMap((v) => String(v).split(','));
    const fromId = fields.from || null;
    const targets = resolveTargets(toList, fromId);
    if (!targets.length) return fail(res, 400, 'no_targets', 'transfer had no resolved targets');

    const text = fields.text ?? null;
    if (text && Buffer.byteLength(text) > 65536) return fail(res, 413, 'too_large', 'text over 64KB');
    let kind = fields.kind;
    if (!kind) kind = file ? 'file' : /^https?:\/\/\S+$/i.test((text || '').trim()) ? 'link' : 'text';

    const days = Math.min(30, Math.max(1, Number(fields.expires_in_days) || 7));
    const tr = {
      transfer_id: id('trf'),
      kind,
      state: 'complete',
      file_name: kind === 'file' ? (fields.name || file?.filename || 'file') : null,
      mime_type: kind === 'file' ? file?.contentType || 'application/octet-stream' : null,
      size: kind === 'file' ? file?.body.length ?? 0 : null,
      text: kind === 'file' ? null : text,
      from_device_id: fromId,
      from_device_name: fromId && devices.get(fromId) ? devices.get(fromId).name : null,
      created_at: now(),
      expires_at: iso(days * DAY),
      deliveries: targets.map((d) => ({
        delivery_id: id('del'), device_id: d.device_id, device_name: d.name, state: 'pending', acked_at: null,
      })),
    };
    if (file) {
      const key = id('blob');
      blobs.set(key, { body: file.body, contentType: tr.mime_type, name: tr.file_name });
      tr._key = key;
    }
    transfers.unshift(tr);
    broadcast('transfer.created', { transfer: strip(tr) }, [fromId, ...targets.map((d) => d.device_id)].filter(Boolean));
    return send(res, 200, { transfer: strip(tr) });
  }

  return fail(res, 404, 'not_found', 'no route');
});

function strip(t) {
  const { _key, _adopt, ...rest } = t;
  return rest;
}

server.listen(PORT, () => {
  console.log(`[mock] transmat mock server on http://localhost:${PORT} (token: ${TOKEN})${EMPTY ? ' [EMPTY]' : ''}`);
});
