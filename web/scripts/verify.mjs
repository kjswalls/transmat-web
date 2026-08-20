/**
 * Drives the real built client against the mock server with Playwright and
 * saves screenshots to ./screenshots. Run: npm run build && npm run verify
 *
 * Playwright is installed globally in this image; browsers live in
 * PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers.
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire('/opt/node22/lib/node_modules/playwright/');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'screenshots');
const TOKEN = 'dev-token-change-me';
const MOCK_PORT = Number(process.env.MOCK_PORT || 8899);
const MOCK_EMPTY_PORT = Number(process.env.MOCK_EMPTY_PORT || 8900);
const WEB_PORT = Number(process.env.WEB_PORT || 4199);
const APP = `http://localhost:${WEB_PORT}`;

rmSync(SHOTS, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });

const procs = [];
function run(cmd, args, env, name) {
  const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => process.env.VERBOSE && console.log(`[${name}] ${d}`));
  p.stderr.on('data', (d) => console.error(`[${name}!] ${d}`));
  procs.push(p);
  return p;
}
const stop = () => procs.forEach((p) => { try { p.kill('SIGKILL'); } catch {} });
process.on('exit', stop);

async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok || r.status === 401) return; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${url}`);
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
};

const api = (port, path, opts = {}) =>
  fetch(`http://localhost:${port}${path}`, { ...opts, headers: { Authorization: `Bearer ${TOKEN}`, ...opts.headers } });

async function main() {
  run('node', ['mock/server.js'], { PORT: String(MOCK_PORT), TRANSMAT_TOKEN: TOKEN }, 'mock');
  run('node', ['mock/server.js'], { PORT: String(MOCK_EMPTY_PORT), TRANSMAT_TOKEN: TOKEN, MOCK_EMPTY: '1' }, 'mock-empty');
  run('node_modules/.bin/vite', ['preview', '--port', String(WEB_PORT), '--strictPort'], {}, 'web');

  await waitFor(`http://localhost:${MOCK_PORT}/health`);
  await waitFor(`http://localhost:${MOCK_EMPTY_PORT}/health`);
  await waitFor(APP);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1180, height: 820 },
    deviceScaleFactor: 2,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  ctx.on('weberror', (e) => console.error('[page error]', e.error()?.message));

  const seed = (port) => `(() => { localStorage.setItem('transmat.settings.v1', JSON.stringify({
      serverUrl: 'http://localhost:${port}', token: '${TOKEN}', deviceName: 'Chrome on macOS', deviceId: ''
    })); })()`;

  // ---------------------------------------------------------------- 1. stream
  const page = await ctx.newPage();
  await page.addInitScript(seed(MOCK_PORT));
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="transfer-row"]');
  await page.waitForFunction(() => document.fonts.ready.then(() => true));
  await page.waitForTimeout(400);

  const rowCount = await page.locator('[data-testid="transfer-row"]').count();
  check('stream renders seeded transfers', rowCount >= 5, `${rowCount} rows`);
  check('SSE reports live', (await page.getByTestId('conn').innerText()).trim() === 'live');

  const outbound = await page.locator('[data-testid="transfer-row"][data-direction="out"]').count();
  const inbound = await page.locator('[data-testid="transfer-row"][data-direction="in"]').count();
  check('stream shows both directions', outbound > 0 && inbound > 0, `${outbound} out / ${inbound} in`);

  await page.mouse.move(4, 4);
  await page.screenshot({ path: path.join(SHOTS, '01-stream.png') });

  // ------------------------------------------------- 2. live SSE arrival
  const before = rowCount;
  await api(MOCK_PORT, '/v1/transfers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'text', text: 'sent while the browser was watching', to: ['all'] }),
  });
  await page.waitForFunction(
    (n) => document.querySelectorAll('[data-testid="transfer-row"]').length > n,
    before,
    { timeout: 5000 },
  );
  check('SSE pushes a new transfer into the stream live', true);
  await page.mouse.move(4, 4);
  await page.screenshot({ path: path.join(SHOTS, '02-stream-live-arrival.png') });

  // ------------------------------------------------------ 3. filters + search
  await page.getByTestId('filter-links').click();
  await page.waitForTimeout(200);
  const linkRows = await page.locator('[data-testid="transfer-row"][data-kind="link"]').count();
  const anyRows = await page.locator('[data-testid="transfer-row"]').count();
  check('Links filter narrows the stream', linkRows === anyRows && linkRows > 0, `${linkRows} link rows`);
  await page.mouse.move(4, 4);
  await page.screenshot({ path: path.join(SHOTS, '03-filter-links.png') });

  await page.getByTestId('filter-expiring').click();
  await page.waitForTimeout(150);
  check('Expiring filter returns something', (await page.locator('[data-testid="transfer-row"]').count()) > 0);
  await page.getByTestId('filter-all').click();

  await page.getByTestId('stream-search').fill('keynote');
  await page.waitForTimeout(200);
  check('search narrows to one row', (await page.locator('[data-testid="transfer-row"]').count()) === 1);
  await page.mouse.move(4, 4);
  await page.screenshot({ path: path.join(SHOTS, '04-search.png') });
  await page.getByTestId('stream-search').fill('');

  // ------------------------------------------------------- 4. the command bar
  await page.keyboard.press('Control+k');
  await page.waitForSelector('[data-testid="command-bar"]');
  await page.getByTestId('cmd-payload-text').fill('the wifi is hunter2-correct-horse');
  await page.getByTestId('cmd-filter').focus();

  // Keyboard: ↓ to move, Tab to add another.
  await page.keyboard.press('Tab');            // select row 0, advance
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Tab');            // select row 2, advance
  await page.waitForTimeout(150);
  const selectedCount = await page.getByTestId('cmd-selected-count').innerText();
  check('Tab multi-selects targets', /2 selected/.test(selectedCount), selectedCount.trim());

  const selectedRows = await page.locator('.cmd-row[data-selected="true"]').count();
  check('two rows render as selected', selectedRows === 2, `${selectedRows}`);

  // Retention control in the footer.
  await page.keyboard.press('Control+e');
  await page.waitForTimeout(100);
  const retention = (await page.getByTestId('cmd-retention').innerText()).replace(/\s+/g, ' ').trim();
  check('⌃E cycles retention', /Expires in 30 days/.test(retention), retention);
  await page.getByTestId('cmd-retention').click(); // back around to 1 day
  await page.getByTestId('cmd-retention').click(); // 7 days
  await page.waitForTimeout(100);
  check('retention cycles back to the 7-day default',
    /Expires in 7 days/.test((await page.getByTestId('cmd-retention').innerText())));

  await page.mouse.move(4, 4);
  await page.screenshot({ path: path.join(SHOTS, '05-command-bar.png') });
  await page.locator('[data-testid="command-bar"]').screenshot({ path: path.join(SHOTS, '05b-command-bar-closeup.png') });

  // Focus trap: focus never escapes the dialog.
  const trapped = await page.evaluate(() =>
    document.querySelector('[data-testid="command-bar"]').contains(document.activeElement));
  check('focus is trapped inside the command bar', trapped);

  // Filtering targets.
  await page.getByTestId('cmd-filter').fill('mac');
  await page.waitForTimeout(150);
  const filtered = await page.locator('[data-testid="cmd-row-device"]').count();
  check('typing filters the target list', filtered === 1, `${filtered} device rows for "mac"`);
  await page.getByTestId('cmd-filter').fill('');

  // Enter sends.
  const rowsBeforeSend = await page.locator('[data-testid="transfer-row"]').count();
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-testid="command-bar"]', { state: 'detached', timeout: 5000 });
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid="transfer-row"]').length > n, rowsBeforeSend, { timeout: 5000 });
  const top = await page.locator('[data-testid="transfer-row"]').first().innerText();
  check('Enter sends and the sent item lands at the top of the stream', /hunter2/.test(top), top.split('\n')[0]);
  check('sent item is outbound',
    (await page.locator('[data-testid="transfer-row"]').first().getAttribute('data-direction')) === 'out');
  await page.mouse.move(4, 4);
  await page.screenshot({ path: path.join(SHOTS, '06-after-send.png') });

  // Escape closes.
  await page.keyboard.press('Control+k');
  await page.waitForSelector('[data-testid="command-bar"]');
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-testid="command-bar"]', { state: 'detached' });
  check('Escape closes the command bar', true);

  // ------------------------------------------------------- 5. row interactions
  await page.waitForTimeout(3400); // let the "Sent" toast expire so the next one is unambiguous
  const textRow = page.locator('[data-testid="transfer-row"][data-kind="text"]').first();
  await textRow.click();
  await page.waitForSelector('[data-testid="toast"]');
  const copyToast = await page.getByTestId('toast').first().innerText();
  check('clicking a text row copies it', /Copied/.test(copyToast), copyToast.trim());
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  check('clipboard actually holds the payload', clip.length > 0, clip.slice(0, 40));

  const dl = page.waitForEvent('download', { timeout: 8000 });
  await page.locator('[data-testid="transfer-row"][data-kind="file"]').first().click();
  const download = await dl;
  check('clicking a file row downloads it', !!download.suggestedFilename(), download.suggestedFilename());
  await page.mouse.move(4, 4);
  await page.screenshot({ path: path.join(SHOTS, '07-toast.png') });

  // --------------------------------------------------------- 6. settings sheet
  await page.keyboard.press('Control+,');
  await page.waitForSelector('[data-testid="settings"]');
  const selfId = await page.locator('.selfcard .idline').innerText();
  check('settings shows this browser registered as a web device with push none',
    /Web · push none · dev_/.test(selfId), selfId.trim());
  await page.mouse.move(4, 4);
  await page.screenshot({ path: path.join(SHOTS, '08-settings.png') });
  await page.keyboard.press('Escape');

  // Confirm registration really happened server-side.
  const devs = await api(MOCK_PORT, '/v1/devices').then((r) => r.json());
  const web = devs.devices.find((d) => d.platform === 'web');
  check('browser registered itself over the API', !!web && web.push_channel === 'none',
    web ? `${web.name} / ${web.platform} / ${web.push_channel}` : 'missing');

  await page.close();

  // ----------------------------------------------------- 7. first run (no token)
  const p2 = await ctx.newPage();
  await p2.addInitScript("localStorage.clear()");
  await p2.goto(APP, { waitUntil: 'domcontentloaded' });
  await p2.waitForSelector('[data-testid="settings"]');
  check('first run asks for server URL and token', await p2.getByTestId('settings-token').isVisible());
  await p2.mouse.move(4, 4);
  await p2.screenshot({ path: path.join(SHOTS, '09-first-run.png') });

  // Fill it in by hand, exactly as a human would, and land on the empty stream.
  await p2.getByTestId('settings-url').fill(`http://localhost:${MOCK_EMPTY_PORT}`);
  await p2.getByTestId('settings-token').fill(TOKEN);
  await p2.getByTestId('settings-save').click();
  await p2.waitForSelector('[data-testid="empty-first-run"]', { timeout: 8000 });
  check('empty first-run state renders once connected', true);
  await p2.waitForTimeout(400);
  await p2.mouse.move(4, 4);
  await p2.screenshot({ path: path.join(SHOTS, '10-empty-first-run.png') });

  // Command bar with no other devices.
  await p2.keyboard.press('Control+k');
  await p2.waitForSelector('[data-testid="cmd-no-targets"]');
  check('command bar explains there are no targets yet', true);
  await p2.mouse.move(4, 4);
  await p2.screenshot({ path: path.join(SHOTS, '11-command-bar-no-targets.png') });
  await p2.keyboard.press('Escape');
  await p2.close();

  // -------------------------------------------------------- 8. server unreachable
  const p3 = await ctx.newPage();
  await p3.addInitScript(seed(9)); // nothing listens on port 9
  await p3.goto(APP, { waitUntil: 'domcontentloaded' });
  await p3.waitForSelector('[data-testid="error-banner"]', { timeout: 10000 });
  check('unreachable server shows an error banner', true);
  await p3.waitForTimeout(300);
  await p3.mouse.move(4, 4);
  await p3.screenshot({ path: path.join(SHOTS, '12-server-unreachable.png') });
  await p3.close();

  await browser.close();
  stop();

  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
}

main().catch((e) => { console.error(e); stop(); process.exit(1); });
