/**
 * Same client, pointed at the REAL server in ../server instead of the mock.
 *
 *   cd ../server && PORT=8901 TRANSMAT_TOKEN=… DATA_DIR=/tmp/x node src/index.js
 *   cd ../web && npm run build && REAL_SERVER=http://localhost:8901 node scripts/verify-real.mjs
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire('/opt/node22/lib/node_modules/playwright/');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'screenshots');
const SERVER = process.env.REAL_SERVER || 'http://localhost:8901';
const TOKEN = process.env.TRANSMAT_TOKEN || 'dev-token-change-me';
const WEB_PORT = 4198;
const APP = `http://localhost:${WEB_PORT}`;
mkdirSync(SHOTS, { recursive: true });

const procs = [];
const stop = () => procs.forEach((p) => { try { p.kill('SIGKILL'); } catch {} });
process.on('exit', stop);

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
};

const api = (p, opts = {}) =>
  fetch(SERVER + p, { ...opts, headers: { Authorization: `Bearer ${TOKEN}`, ...opts.headers } });

async function seedServer() {
  const dev = async (name, platform, extra = {}) =>
    (await api('/v1/devices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, platform, ...extra }),
    })).json();

  const phone = await dev("Kirby's iPhone", 'ios', { push_channel: 'apns', push_token: 'a'.repeat(64) });
  const cli = await dev('studio-linux', 'cli', { push_channel: 'none' });

  await api('/v1/transfers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'link', text: 'https://figma.com/file/tXm2QpLd/transmat-directions', to: 'all', from: cli.device_id }),
  });
  await api('/v1/transfers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'text', text: 'wifi password for the flat: hunter2-correct-horse', to: 'all', from: phone.device_id }),
  });

  // A real multipart upload, exactly like the Shortcut and the web client do.
  const fd = new FormData();
  fd.append('file', new Blob(['%PDF-1.4 fake but real bytes\n'.repeat(400)], { type: 'application/pdf' }), 'quarterly-notes.pdf');
  fd.append('to', 'all');
  fd.append('from', phone.device_id);
  fd.append('expires_in_days', '7');
  const r = await api('/v1/transfers', { method: 'POST', body: fd });
  check('real server accepted a multipart upload', r.ok, `${r.status}`);
  return { phone, cli };
}

async function main() {
  const health = await fetch(`${SERVER}/health`).then((r) => r.json());
  check('real server is up', health.ok === true, JSON.stringify(health));
  await seedServer();

  const web = spawn('node_modules/.bin/vite', ['preview', '--port', String(WEB_PORT), '--strictPort'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
  });
  procs.push(web);
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(APP)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1180, height: 820 },
    deviceScaleFactor: 2,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && console.error('[console]', m.text()));
  await page.addInitScript(`localStorage.setItem('transmat.settings.v1', JSON.stringify({
    serverUrl: '${SERVER}', token: '${TOKEN}', deviceName: 'Chrome on macOS', deviceId: ''
  }))`);
  await page.goto(APP, { waitUntil: 'domcontentloaded' });

  await page.waitForSelector('[data-testid="transfer-row"]', { timeout: 15000 });
  const rows = await page.locator('[data-testid="transfer-row"]').count();
  check('client renders transfers from the real server', rows >= 3, `${rows} rows`);
  const conn = (await page.getByTestId('conn').innerText()).trim();
  check('client is connected to the real server (SSE live, or polling fallback)',
    conn === 'live' || conn === 'polling', conn);
  if (conn !== 'live') {
    console.warn('  NOTE: /v1/events returned no Access-Control-Allow-Origin, so EventSource-over-fetch is blocked.\n' +
                 '        The client fell back to polling. Server-side fix needed (see report).');
  }

  // Whatever the transport, a transfer created server-side must reach the UI.
  const beforeLive = await page.locator('[data-testid="transfer-row"]').count();
  await api('/v1/transfers', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'text', text: 'arrived while the browser was watching', to: 'all' }),
  });
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid="transfer-row"]').length > n,
    beforeLive, { timeout: 12000 });
  check('a transfer created server-side reaches the open UI', true);

  const devs = await api('/v1/devices').then((r) => r.json());
  const self = devs.devices.find((d) => d.platform === 'web');
  check('browser registered itself on the real server as platform web / push none',
    !!self && self.push_channel === 'none', self ? `${self.name} ${self.device_id}` : 'missing');

  await page.mouse.move(4, 4);
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOTS, '20-real-server-stream.png') });

  // Send a note through the command bar to a real device.
  await page.keyboard.press('Control+k');
  await page.waitForSelector('[data-testid="command-bar"]');
  await page.getByTestId('cmd-payload-text').fill('sent from the browser through the real server');
  await page.getByTestId('cmd-filter').focus();
  await page.keyboard.press('Tab');
  await page.waitForTimeout(120);
  await page.mouse.move(4, 4);
  await page.screenshot({ path: path.join(SHOTS, '21-real-server-command-bar.png') });
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-testid="command-bar"]', { state: 'detached', timeout: 8000 });
  await page.waitForFunction(
    (n) => document.querySelectorAll('[data-testid="transfer-row"]').length > n, rows, { timeout: 8000 });
  const top = await page.locator('[data-testid="transfer-row"]').first().innerText();
  check('command-bar send round-trips through the real server', /sent from the browser/.test(top), top.split('\n')[0]);

  // And it really exists server-side.
  const list = await api('/v1/transfers?limit=5').then((r) => r.json());
  check('the sent transfer is in GET /v1/transfers',
    list.transfers.some((t) => (t.text || '').includes('sent from the browser')));

  // Download a real blob through the 302 → signed URL path.
  const dl = page.waitForEvent('download', { timeout: 10000 });
  await page.locator('[data-testid="transfer-row"][data-kind="file"]').first().click();
  const d = await dl;
  check('file row downloads through the real 302 → signed blob URL', d.suggestedFilename() === 'quarterly-notes.pdf', d.suggestedFilename());

  await page.mouse.move(4, 4);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, '22-real-server-after-send.png') });

  await browser.close();
  stop();
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed against the real server`);
}

main().catch((e) => { console.error(e); stop(); process.exit(1); });
