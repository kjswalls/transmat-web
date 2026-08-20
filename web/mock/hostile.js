/**
 * Hostile fixture server — the adversarial twin of mock/server.js.
 *
 * mock/server.js serves plausible data so the app can be used. This one serves
 * data designed to break it: markup and javascript:/data: URLs in every string
 * field, a 200-character filename, a 40-line note, an 85-character device name,
 * 500 rows, byte- and time-boundary values, transfers with no deliveries array
 * at all, and an SSE stream that can be dropped or made to repeat itself on
 * command. scripts/verify-hostile.mjs drives the built client against it.
 *
 *   PORT=8891 MODE=hostile node mock/hostile.js
 *   MODE=stress   -> 500 transfers
 *   MODE=sizes    -> byte / relative-time / expiry boundary table
 *   NO_SSE_CORS=1 -> /v1/events answers without Access-Control-Allow-Origin,
 *                    reproducing a server that forgets CORS on the stream
 *
 * Control routes for the harness (fixture only, no auth): /__drop, /__dup,
 * /__new, /__malformed, /__stats.
 */
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT || 8891);
const TOKEN = process.env.TRANSMAT_TOKEN || 'hostile-token';
const MODE = process.env.MODE || 'hostile';
const NO_SSE_CORS = process.env.NO_SSE_CORS === '1';

const DAY = 86400000;
const now = () => new Date().toISOString();
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const id = (p) => `${p}_${crypto.randomBytes(9).toString('hex')}`;

const devices = new Map();
let transfers = [];
const clients = new Set();

function addDevice(name, platform, opts = {}) {
  const d = {
    device_id: opts.device_id || id('dev'),
    name,
    platform,
    push_channel: opts.push_channel || 'none',
    has_push_token: false,
    last_seen_at: opts.last_seen_at || now(),
    created_at: iso(-30 * DAY),
  };
  devices.set(d.device_id, d);
  return d;
}

const XSS_IMG = '"><img src=x onerror="window.__XSS_FIRED=(window.__XSS_FIRED||0)+1">';
const XSS_SCRIPT = '<script>window.__XSS_FIRED=(window.__XSS_FIRED||0)+1</script>';
const LONG_NAME = 'a-really-unreasonably-long-filename-that-nobody-should-ever-produce-but-here-we-are-' +
  'because-someone-exported-from-a-tool-that-concatenates-every-parameter-into-the-name-' +
  'v2-final-FINAL-approved.pdf'; // ~200 chars
const NOTE_40 = Array.from({ length: 40 }, (_, i) => `line ${i + 1}: the quick brown fox jumps over the lazy dog and keeps going`).join('\n');

const mac = addDevice('MacBook Pro', 'macos');
const phone = addDevice("Kirby's iPhone", 'ios');
const longDev = addDevice(
  'Kirbys-Extremely-Long-Hostname-Workstation-In-The-Back-Room-Behind-The-Server-Rack-01',
  'cli',
  { last_seen_at: iso(-3 * 3600000) },
);
const xssDev = addDevice(XSS_IMG + ' PwnBook', 'macos', { last_seen_at: iso(-90 * 60000) });

function mk(t) {
  const tr = {
    transfer_id: id('trf'),
    kind: t.kind,
    state: t.state || 'complete',
    file_name: t.file_name ?? null,
    mime_type: t.mime_type ?? null,
    size: t.size ?? null,
    text: t.text ?? null,
    from_device_id: t.from ? t.from.device_id : null,
    from_device_name: t.from ? t.from.name : null,
    created_at: iso(-(t.agoMs || 1000)),
    expires_at: iso(t.expiresInMs == null ? 7 * DAY : t.expiresInMs),
    deliveries: (t.to || []).map((d) => ({
      delivery_id: id('del'), device_id: d.device_id, device_name: d.name,
      state: t.deliveryState || 'pending', acked_at: null,
    })),
  };
  if (t.noDeliveries) tr.deliveries = [];
  transfers.push(tr);
  return tr;
}

/** the browser registers itself; we adopt it so rows have a real "in" direction */
let webDev = null;
function adopt(d) {
  webDev = d;
  for (const t of transfers) {
    if (t._wantIn && !t.deliveries.some((x) => x.device_id === d.device_id)) {
      t.deliveries.push({ delivery_id: id('del'), device_id: d.device_id, device_name: d.name, state: 'pending', acked_at: null });
    }
    if (t._wantOut) { t.from_device_id = d.device_id; t.from_device_name = d.name; }
  }
}

function seedHostile() {
  mk({ kind: 'file', file_name: XSS_IMG + 'invoice.pdf', mime_type: 'application/pdf', size: 12345, from: xssDev, to: [mac], agoMs: 30_000 })._wantIn = true;
  mk({ kind: 'file', file_name: XSS_SCRIPT + 'report.pdf', mime_type: 'application/pdf', size: 512, from: phone, to: [mac], agoMs: 60_000 })._wantIn = true;
  mk({ kind: 'link', text: 'javascript:window.__XSS_FIRED=(window.__XSS_FIRED||0)+1', from: mac, to: [phone], agoMs: 120_000 })._wantOut = true;
  mk({ kind: 'link', text: 'data:text/html,<script>window.__XSS_FIRED=1</script>', from: mac, to: [phone], agoMs: 130_000 })._wantOut = true;
  mk({ kind: 'link', text: 'https://evil.example.com/"><img src=x onerror="window.__XSS_FIRED=1">', from: phone, to: [mac], agoMs: 140_000 })._wantIn = true;
  mk({ kind: 'text', text: XSS_SCRIPT + ' plain note', from: phone, to: [mac], agoMs: 150_000 })._wantIn = true;
  mk({ kind: 'file', file_name: LONG_NAME, mime_type: 'application/pdf', size: 98_765_432, from: longDev, to: [mac, phone], agoMs: 200_000 })._wantIn = true;
  mk({ kind: 'text', text: NOTE_40, from: mac, to: [longDev], agoMs: 300_000 })._wantOut = true;
  mk({ kind: 'file', file_name: 'no-recipients.bin', mime_type: 'application/octet-stream', size: 1, from: mac, to: [], noDeliveries: true, agoMs: 400_000 });
  mk({ kind: 'file', file_name: 'expiring-soon.zip', mime_type: 'application/zip', size: 4096, from: phone, to: [mac], agoMs: 500_000, expiresInMs: 40 * 60000 })._wantIn = true;
  mk({ kind: 'file', file_name: 'already-gone.dmg', mime_type: 'application/octet-stream', size: 900_000_000, state: 'expired', from: mac, to: [phone], agoMs: 9 * DAY, expiresInMs: -2 * DAY })._wantOut = true;
  mk({ kind: 'file', file_name: 'killed.tar.gz', size: 700, state: 'revoked', from: mac, to: [phone], agoMs: 8 * DAY })._wantOut = true;
}

function seedSizes() {
  const sizes = [0, 1, 512, 1023, 1024, 1536, 10_239, 10_240, 999_999, 1_048_576, 1_500_000, 10_485_760,
    1_073_741_824, 2_147_483_648];
  sizes.forEach((s, i) => mk({ kind: 'file', file_name: `size-${s}.bin`, size: s, from: mac, to: [phone], agoMs: (i + 1) * 1000 })._wantOut = true);
  const times = [
    ['t+0s', 10, 7 * DAY], ['t-30s', 30_000, 7 * DAY], ['t-5m', 5 * 60000, 7 * DAY],
    ['t-90m', 90 * 60000, 7 * DAY], ['t-25h', 25 * 3600000, 7 * DAY], ['t-3d', 3 * DAY, 7 * DAY],
    ['t-20d', 20 * DAY, 7 * DAY],
  ];
  times.forEach(([label, ago, exp]) => mk({ kind: 'text', text: label, from: mac, to: [phone], agoMs: ago, expiresInMs: exp })._wantOut = true);
  const exps = [
    ['exp-30d', 30 * DAY], ['exp-7d', 7 * DAY], ['exp-6d23h', 6 * DAY + 23 * 3600000],
    ['exp-3d', 3 * DAY], ['exp-2d', 2 * DAY], ['exp-25h', 25 * 3600000], ['exp-90m', 90 * 60000],
    ['exp-30s', 30_000], ['exp-past', -1000],
  ];
  exps.forEach(([label, ms]) => mk({ kind: 'text', text: label, from: mac, to: [phone], agoMs: 2000, expiresInMs: ms })._wantOut = true);
}

function seedStress() {
  for (let i = 0; i < 500; i++) {
    mk({
      kind: i % 3 === 0 ? 'file' : i % 3 === 1 ? 'text' : 'link',
      file_name: i % 3 === 0 ? `bulk-file-${String(i).padStart(4, '0')}.bin` : null,
      text: i % 3 === 1 ? `bulk note ${i}` : i % 3 === 2 ? `https://example.com/thing/${i}` : null,
      size: i % 3 === 0 ? i * 1024 : null,
      mime_type: i % 3 === 0 ? 'application/octet-stream' : null,
      from: i % 2 ? mac : phone,
      to: [i % 2 ? phone : mac],
      agoMs: i * 60_000,
    })[i % 2 ? '_wantOut' : '_wantIn'] = true;
  }
}

if (MODE === 'stress') seedStress();
else if (MODE === 'sizes') seedSizes();
else seedHostile();
transfers.sort((a, b) => b.created_at.localeCompare(a.created_at));

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
};
const send = (res, status, obj, extra = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS, ...extra });
  res.end(JSON.stringify(obj));
};
const fail = (res, status, code, message) => send(res, status, { error: { code, message } });
const strip = (t) => { const { _wantIn, _wantOut, ...r } = t; return r; };

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(payload);
}

let sseConnects = 0;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

  // control plane for the test harness (no auth, fixture only)
  if (p === '/__drop') { for (const c of clients) c.destroy(); clients.clear(); return send(res, 200, { dropped: true }); }
  if (p === '/__stats') return send(res, 200, { sseConnects, openClients: clients.size });
  if (p === '/__dup') {
    // emit the SAME transfer.created event three times
    const t = transfers[0];
    broadcast('transfer.created', { transfer: strip(t) });
    broadcast('transfer.created', { transfer: strip(t) });
    broadcast('transfer.created', { transfer: strip(t) });
    return send(res, 200, { ok: true, transfer_id: t.transfer_id });
  }
  if (p === '/__malformed') {
    // a transfer.created frame with no deliveries array at all
    broadcast('transfer.created', { transfer: {
      transfer_id: 'trf_malformed_' + Date.now(), kind: 'file', state: 'complete',
      file_name: 'no-deliveries-key.bin', mime_type: null, size: 4096, text: null,
      from_device_id: null, from_device_name: null,
      created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString(),
    } });
    return send(res, 200, { ok: true });
  }
  if (p === '/__new') {
    const t = mk({ kind: 'file', file_name: `pushed-${Date.now()}.bin`, size: 2048, from: phone, to: webDev ? [webDev] : [mac], agoMs: 0 });
    transfers.sort((a, b) => b.created_at.localeCompare(a.created_at));
    broadcast('transfer.created', { transfer: strip(t) });
    return send(res, 200, { ok: true });
  }

  if (p === '/health') return send(res, 200, { ok: true, storage: 'local', push: 'console', version: 'adv' });

  if (!p.startsWith('/v1/')) return fail(res, 404, 'not_found', 'no route');
  if ((req.headers.authorization || '') !== `Bearer ${TOKEN}`) return fail(res, 401, 'unauthorized', 'bad or missing token');

  if (p === '/v1/devices' && req.method === 'GET') return send(res, 200, { devices: [...devices.values()] });
  if (p === '/v1/devices' && req.method === 'POST') {
    const body = JSON.parse(await text(req) || '{}');
    let existing = [...devices.values()].find((d) => d.name === body.name && d.platform === body.platform);
    if (!existing) existing = addDevice(body.name, body.platform, { push_channel: body.push_channel });
    existing.last_seen_at = now();
    if (existing.platform === 'web' && !webDev) adopt(existing);
    return send(res, 200, existing);
  }

  const devPatch = /^\/v1\/devices\/([^/]+)$/.exec(p);
  if (devPatch) {
    const d = devices.get(devPatch[1]);
    if (!d) return fail(res, 404, 'not_found', 'no device');
    if (req.method === 'PATCH') {
      const body = JSON.parse((await text(req)) || '{}');
      if (body.name) d.name = body.name;
      return send(res, 200, d);
    }
    if (req.method === 'DELETE') { devices.delete(d.device_id); return send(res, 200, { ok: true }); }
  }

  if (p === '/v1/events' && req.method === 'GET') {
    sseConnects += 1;
    const headers = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' };
    if (!NO_SSE_CORS) Object.assign(headers, CORS);
    res.writeHead(200, headers);
    res.write(': connected\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (p === '/v1/transfers' && req.method === 'GET') {
    const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 1000);
    return send(res, 200, { transfers: transfers.slice(0, limit).map(strip) });
  }
  if (p === '/v1/transfers' && req.method === 'POST') {
    const t = mk({ kind: 'text', text: 'posted', from: webDev || mac, to: [phone], agoMs: 0 });
    return send(res, 200, { transfer: strip(t) });
  }
  const tr = /^\/v1\/transfers\/([^/]+)$/.exec(p);
  if (tr && req.method === 'DELETE') {
    const t = transfers.find((x) => x.transfer_id === tr[1]);
    if (t) { t.state = 'revoked'; broadcast('transfer.revoked', { transfer_id: t.transfer_id }); }
    return send(res, 200, { ok: true });
  }
  if (/^\/v1\/transfers\/[^/]+\/blob$/.test(p)) return fail(res, 404, 'not_found', 'fixture has no bytes');
  if (/^\/v1\/deliveries\/[^/]+\/ack$/.test(p)) return send(res, 200, { ok: true });
  return fail(res, 404, 'not_found', 'no route');
});

function text(req) {
  return new Promise((r) => { const c = []; req.on('data', (x) => c.push(x)); req.on('end', () => r(Buffer.concat(c).toString())); });
}

server.listen(PORT, () => console.log(`[hostile:${MODE}] http://localhost:${PORT} token=${TOKEN} noSseCors=${NO_SSE_CORS}`));
