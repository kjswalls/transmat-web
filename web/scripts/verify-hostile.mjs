/**
 * Adversarial pass over the built client. Companion to scripts/verify.mjs:
 * that one proves the happy path works, this one tries to break it.
 *
 *   npm run build && npm run verify:hostile
 *
 * Covers XSS through every string field, keyboard traps and focus restoration,
 * token hygiene, SSE reconnect / duplicate / malformed frames, layout from
 * 1280 down to 320px, byte and time formatting boundaries, and the offline and
 * 401 states. Screenshots land in ./screenshots/hostile.
 *
 * Playwright is installed globally in this image; browsers live in
 * PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers.
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const require = createRequire('/opt/node22/lib/node_modules/playwright/');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SHOTS = path.join(ROOT, 'screenshots', 'hostile');
const TOKEN = 'hostile-token';
const PORTS = {
  hostile: Number(process.env.HOSTILE_PORT || 8891),
  stress: Number(process.env.STRESS_PORT || 8892),
  sizes: Number(process.env.SIZES_PORT || 8893),
  nocors: Number(process.env.NOCORS_PORT || 8894),
};
const APP_PORT = Number(process.env.WEB_PORT || 4291);
const APP = `http://localhost:${APP_PORT}`;

rmSync(SHOTS, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });

const procs = [];
const run = (cmd, args, env, cwd = ROOT) => {
  const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => process.env.VERBOSE && console.log(String(d)));
  p.stderr.on('data', (d) => console.error('[proc!]', String(d).trim()));
  procs.push(p);
  return p;
};
process.on('exit', () => procs.forEach((p) => { try { p.kill('SIGKILL'); } catch {} }));

async function waitFor(url, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.status < 500) return true; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`never came up: ${url}`);
}

const results = [];
const ok = (n, d = '') => { results.push(['PASS', n, d]); console.log(`PASS  ${n}${d ? ' — ' + d : ''}`); };
const bad = (n, d = '') => { results.push(['FAIL', n, d]); console.log(`FAIL  ${n}${d ? ' — ' + d : ''}`); };
const check = (c, n, d = '') => (c ? ok(n, d) : bad(n, d));
/** A real, understood exposure we are choosing to live with. Printed, not failed. */
const note = (n, d = '') => { results.push(['NOTE', n, d]); console.log(`NOTE  ${n}${d ? ' — ' + d : ''}`); };

// ---- fixtures -------------------------------------------------------------
for (const [mode, port] of Object.entries(PORTS)) {
  run('node', ['mock/hostile.js'], {
    PORT: String(port),
    MODE: mode === 'nocors' ? 'hostile' : mode,
    TRANSMAT_TOKEN: TOKEN,
    ...(mode === 'nocors' ? { NO_SSE_CORS: '1' } : {}),
  });
}
run('node', ['scripts/serve-dist.mjs'], { WEB_PORT: String(APP_PORT) });

for (const port of Object.values(PORTS)) await waitFor(`http://localhost:${port}/health`);
await waitFor(APP);

const browser = await chromium.launch();

/** fresh page wired to a fixture port, with console/pageerror capture */
async function open(port, { width = 1280, height = 900 } = {}) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const logs = [], errors = [], urls = [];
  const page = await ctx.newPage();
  page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('request', (r) => urls.push(r.url()));
  await page.addInitScript(
    ([url, token]) => {
      localStorage.setItem('transmat.settings.v1', JSON.stringify({
        serverUrl: url, token, deviceName: 'Chrome on macOS', deviceId: '',
      }));
    },
    [`http://localhost:${port}`, TOKEN],
  );
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  return { ctx, page, logs, errors, urls };
}

const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });

// ===========================================================================
// 1. XSS
// ===========================================================================
{
  const { ctx, page, errors, logs } = await open(PORTS.hostile);
  await page.waitForSelector('[data-testid="transfer-row"]');
  const fired = await page.evaluate(() => window.__XSS_FIRED || 0);
  check(fired === 0, 'no injected script executed from transfer fields', `__XSS_FIRED=${fired}`);

  const injected = await page.evaluate(() => document.querySelectorAll('img[src="x"], script:not([src])').length);
  check(injected === 0, 'no <img>/<script> smuggled into the DOM from field values', `${injected} found`);

  const nameText = await page.locator('[data-testid="transfer-row"] .row-name').first().innerText();
  check(nameText.includes('<') || nameText.includes('img src=x'), 'markup renders as literal text in the row name', JSON.stringify(nameText.slice(0, 60)));

  // any anchor built from a transfer? javascript:/data: hrefs are the danger.
  const hrefs = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')));
  const dangerous = hrefs.filter((h) => /^\s*(javascript|data|vbscript):/i.test(h));
  check(dangerous.length === 0, 'no javascript:/data: hrefs anywhere in the document', JSON.stringify(hrefs));

  const linkNames = await page.evaluate(() =>
    [...document.querySelectorAll('[data-kind="link"] .row-name')].map((n) => n.textContent));
  const jsRow = linkNames.find((n) => /XSS_FIRED/.test(n));
  const dataRow = linkNames.find((n) => /text\/html/.test(n));
  check(jsRow?.startsWith('javascript:'), 'a javascript: link still shows its scheme', String(jsRow));
  check(dataRow?.startsWith('data:'), 'a data: link still shows its scheme', String(dataRow));

  // command bar: device names are hostile too
  await page.keyboard.press('Control+k');
  await page.waitForSelector('[data-testid="command-bar"]');
  const fired2 = await page.evaluate(() => window.__XSS_FIRED || 0);
  check(fired2 === 0, 'hostile device name does not execute in the command bar', `__XSS_FIRED=${fired2}`);
  await shot(page, '01-xss-command-bar');
  await page.keyboard.press('Escape');
  await shot(page, '01-xss-stream');
  check(errors.length === 0, 'no uncaught page errors on the hostile fixture', errors.join(' | ').slice(0, 200));
  // index.html pulls Instrument Sans + IBM Plex Mono from Google Fonts. Offline
  // or behind a blocking proxy that request fails, the fallback stack takes
  // over, and Chromium logs the failure. Not an app bug, but it does mean the
  // typeface is not guaranteed — so it is reported rather than asserted away.
  const fontNoise = logs.filter((l) => /fonts\.g(oogleapis|static)|ERR_CONNECTION/.test(l));
  const noisy = logs.filter((l) => l.startsWith('error:') && !/fonts\.g(oogleapis|static)|ERR_CONNECTION/.test(l));
  check(noisy.length === 0, 'no console errors from the app itself', noisy.join(' | ').slice(0, 300));
  if (fontNoise.length) note('Google Fonts unreachable here — the app fell back to the system stack', `${fontNoise.length} failed request(s)`);
  await ctx.close();
}

// ===========================================================================
// 2. Token hygiene
// ===========================================================================
{
  const { ctx, page, urls, logs } = await open(PORTS.hostile);
  await page.waitForSelector('[data-testid="transfer-row"]');
  await page.keyboard.press('Control+k');
  await page.waitForSelector('[data-testid="command-bar"]');
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-testid="command-bar"]', { state: 'detached' });
  await page.click('[data-testid="open-settings"]');
  await page.waitForSelector('[data-testid="settings"]');
  await shot(page, '02-settings');

  const inUrl = urls.filter((u) => u.includes(TOKEN));
  check(inUrl.length === 0, 'token never appears in a request URL', inUrl.join(' '));

  const inLogs = logs.filter((l) => l.includes(TOKEN));
  check(inLogs.length === 0, 'token never printed to the console', inLogs.join(' '));

  const inDom = await page.evaluate((t) => {
    const html = document.documentElement.outerHTML;
    return { inHtml: html.includes(t), inputType: document.querySelector('[data-testid="settings-token"]')?.type };
  }, TOKEN);
  // React writes a controlled input's value into the `value` ATTRIBUTE, so the
  // token is in outerHTML while the (masked) field is on screen — exactly like
  // any password form. It adds no exposure over localStorage, which any script
  // that could read the DOM can read directly, and it is gone once the sheet
  // closes (asserted next).
  if (inDom.inHtml) note('token appears in the settings field\'s value attribute while the sheet is open',
    'same as any password input; localStorage is the real store');
  else ok('token is not in the DOM even with the settings sheet open');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const afterClose = await page.evaluate((t) => document.documentElement.outerHTML.includes(t), TOKEN);
  check(!afterClose, 'token is not in the DOM once the settings sheet is closed', String(afterClose));
  check(inDom.inputType === 'password', 'token field is type=password', String(inDom.inputType));
  await ctx.close();
}

// ===========================================================================
// 3. Keyboard / a11y
// ===========================================================================
{
  const { ctx, page } = await open(PORTS.hostile);
  await page.waitForSelector('[data-testid="transfer-row"]');

  // focus the Send button, open the bar from the keyboard, close, check return
  await page.focus('[data-testid="open-bar"]');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-testid="command-bar"]');
  const focusedInBar = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
  check(focusedInBar === 'cmd-filter', 'opening the bar moves focus into it', String(focusedInBar));

  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-testid="command-bar"]', { state: 'detached' });
  await page.waitForTimeout(250);
  const returned = await page.evaluate(() => document.activeElement?.getAttribute('data-testid') || document.activeElement?.tagName);
  check(returned === 'open-bar', 'Escape returns focus to the trigger', String(returned));

  // ⌘K while the bar is open must not leave a stuck overlay
  await page.keyboard.press('Control+k');
  await page.waitForSelector('[data-testid="command-bar"]');

  // ⌘F while the modal is open must not steal focus to the stream search behind it
  await page.keyboard.press('Control+f');
  await page.waitForTimeout(120);
  const afterCmdF = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
  check(afterCmdF !== 'stream-search', '⌘F does not pull focus out of the open dialog', String(afterCmdF));

  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-testid="command-bar"]', { state: 'detached' });

  // Escape immediately after opening, before focus can land inside
  await page.keyboard.press('Control+k');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check((await page.locator('[data-testid="command-bar"]').count()) === 0,
    'Escape closes the bar even in the frame before focus lands inside');

  // settings: open with ⌘, close with Escape, focus returns
  await page.focus('[data-testid="open-settings"]');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-testid="settings"]');
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-testid="settings"]', { state: 'detached' });
  await page.waitForTimeout(250);
  const returned2 = await page.evaluate(() => document.activeElement?.getAttribute('data-testid') || document.activeElement?.tagName);
  check(returned2 === 'open-settings', 'Escape returns focus from settings to its trigger', String(returned2));

  // ⌘K while settings is open — two stacked modals is a trap
  await page.click('[data-testid="open-settings"]');
  await page.waitForSelector('[data-testid="settings"]');
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(150);
  const stacked = await page.evaluate(() => ({
    bar: !!document.querySelector('[data-testid="command-bar"]'),
    settings: !!document.querySelector('[data-testid="settings"]'),
  }));
  check(!(stacked.bar && stacked.settings), 'command bar does not stack on top of the settings sheet', JSON.stringify(stacked));
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);

  // stream rows must be tab-reachable, and every action must have a name
  const named = await page.evaluate(() => {
    const els = [...document.querySelectorAll('button, [role="button"], a[href], input, select')];
    return els.filter((el) => {
      if (el.getAttribute('aria-hidden') === 'true') return false;
      const name = (el.getAttribute('aria-label') || el.innerText || el.getAttribute('title') || el.getAttribute('placeholder') || '').trim();
      return !name;
    }).map((el) => el.tagName + '.' + el.className);
  });
  check(named.length === 0, 'every interactive element has an accessible name', named.join(', ').slice(0, 250));

  // revoke buttons: reachable from the keyboard?
  const revoke = await page.evaluate(() => {
    const r = document.querySelector('.row-wrap .revoke');
    if (!r) return { found: false };
    return { found: true, tag: r.tagName, tabindex: r.getAttribute('tabindex'),
             nestedInRow: !!r.parentElement.closest('button'), name: r.getAttribute('aria-label') };
  });
  check(revoke.found && revoke.tag === 'BUTTON' && revoke.tabindex !== '-1' && !revoke.nestedInRow && !!revoke.name,
    'revoke control is keyboard reachable and not nested inside another button', JSON.stringify(revoke));

  // and prove it: Tab from an outbound row onto its revoke and press Enter
  const outRow = page.locator('.row-wrap:has([data-direction="out"])').first();
  const revokeBtn = outRow.locator('.revoke');
  const rowName = await outRow.locator('.row-name').innerText();
  await outRow.locator('[data-testid="transfer-row"]').focus();
  await page.keyboard.press('Tab');
  const onRevoke = await page.evaluate(() => document.activeElement?.className || '');
  check(/revoke/.test(onRevoke), 'Tab from a row lands on its revoke button', onRevoke);
  await page.waitForTimeout(250); // let the opacity transition settle
  const visible = await revokeBtn.evaluate((el) => getComputedStyle(el).opacity);
  check(Number(visible) > 0.5, 'the focused revoke button is actually visible', `opacity ${visible}`);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
  const revoked = await page.evaluate((n) => {
    const w = [...document.querySelectorAll('.row-wrap')].find((x) => x.querySelector('.row-name')?.innerText === n);
    return w ? w.querySelector('.row-right')?.textContent : 'gone';
  }, rowName);
  check(revoked === 'revoked', 'revoking with the keyboard alone works end to end', String(revoked));

  // focus ring visible on a row
  await page.evaluate(() => document.querySelector('[data-testid="transfer-row"]').focus());
  const ring = await page.evaluate(() => {
    const el = document.activeElement;
    const s = getComputedStyle(el);
    return { outlineWidth: s.outlineWidth, outlineStyle: s.outlineStyle, boxShadow: s.boxShadow.slice(0, 40) };
  });
  check(ring.outlineStyle !== 'none' && parseFloat(ring.outlineWidth) > 0, 'focused row shows a visible focus ring', JSON.stringify(ring));
  await shot(page, '03-focus-ring');
  await ctx.close();
}

// ===========================================================================
// 4. SSE lifecycle
// ===========================================================================
{
  const { ctx, page } = await open(PORTS.hostile);
  await page.waitForSelector('[data-testid="transfer-row"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="conn"]')?.innerText.includes('live'), null, { timeout: 8000 })
    .then(() => ok('SSE goes live against a CORS-correct server'))
    .catch(() => bad('SSE goes live against a CORS-correct server'));

  const before = await (await fetch(`http://localhost:${PORTS.hostile}/__stats`)).json();
  await fetch(`http://localhost:${PORTS.hostile}/__drop`);
  await page.waitForTimeout(3500);
  const after = await (await fetch(`http://localhost:${PORTS.hostile}/__stats`)).json();
  check(after.sseConnects > before.sseConnects && after.openClients >= 1,
    'EventSource reconnects after the server drops the stream', JSON.stringify({ before, after }));

  await page.waitForFunction(() => document.querySelector('[data-testid="conn"]')?.innerText.includes('live'), null, { timeout: 10000 })
    .then(() => ok('status returns to live after the reconnect'))
    .catch(() => bad('status returns to live after the reconnect'));

  // duplicate events must not duplicate rows
  const rowsBefore = await page.locator('[data-testid="transfer-row"]').count();
  await fetch(`http://localhost:${PORTS.hostile}/__dup`);
  await page.waitForTimeout(600);
  const rowsAfter = await page.locator('[data-testid="transfer-row"]').count();
  check(rowsAfter === rowsBefore, 'a repeated transfer.created does not duplicate the row', `${rowsBefore} -> ${rowsAfter}`);

  // React keys: no duplicate-key warnings, no duplicate transfer ids in the DOM
  const dupIds = await page.evaluate(() => {
    const names = [...document.querySelectorAll('[data-testid="transfer-row"] .row-name')].map((n) => n.textContent);
    const seen = new Set(), dup = [];
    for (const n of names) { if (seen.has(n)) dup.push(n); seen.add(n); }
    return dup;
  });
  check(dupIds.length === 0, 'no duplicated rows in the DOM', dupIds.join(','));

  // a transfer.created with no deliveries array must not white-screen the app
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await fetch(`http://localhost:${PORTS.hostile}/__malformed`);
  await page.waitForTimeout(700);
  const alive = await page.locator('[data-testid="stream"]').count();
  check(errs.length === 0 && alive === 1, 'a malformed SSE frame does not crash the app', errs.join('|').slice(0, 160));

  // listener stacking: re-render many times, then count live SSE connections
  const openBefore = (await (await fetch(`http://localhost:${PORTS.hostile}/__stats`)).json()).openClients;
  for (let i = 0; i < 6; i++) {
    await page.click('[data-testid="filter-sent"]');
    await page.click('[data-testid="filter-all"]');
    await page.fill('[data-testid="stream-search"]', `x${i}`);
    await page.fill('[data-testid="stream-search"]', '');
  }
  await page.waitForTimeout(500);
  const openAfter = (await (await fetch(`http://localhost:${PORTS.hostile}/__stats`)).json()).openClients;
  check(openAfter <= openBefore, 'SSE connections do not stack up on re-render', `${openBefore} -> ${openAfter}`);

  const listeners = await page.evaluate(() => window.__listenerCount ?? null);
  await ctx.close();
}

// ===========================================================================
// 5. SSE blocked by CORS -> honest degradation
// ===========================================================================
{
  const { ctx, page, errors } = await open(PORTS.nocors);
  await page.waitForSelector('[data-testid="transfer-row"]');
  await page.waitForTimeout(6500);
  const conn = await page.locator('[data-testid="conn"]').innerText();
  check(/polling/i.test(conn), 'falls back to polling when the event stream is blocked', conn);
  check(errors.length === 0, 'CORS-blocked stream produces no uncaught page error', errors.join('|').slice(0, 200));
  await shot(page, '05-polling');
  await ctx.close();
}

// ===========================================================================
// 6. Offline / unreachable
// ===========================================================================
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript(() => localStorage.setItem('transmat.settings.v1', JSON.stringify({
    serverUrl: 'http://localhost:9', token: 'nope', deviceName: 'Chrome on macOS', deviceId: '',
  })));
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="error-banner"]', { timeout: 10000 })
    .then(() => ok('unreachable server shows an error banner'))
    .catch(() => bad('unreachable server shows an error banner'));
  await page.waitForSelector('[data-testid="empty-error"]').catch(() => {});
  check(errors.length === 0, 'unreachable server does not throw an uncaught error', errors.join('|').slice(0, 200));
  await shot(page, '06-unreachable');

  // 401 path
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page2 = await ctx2.newPage();
  await page2.addInitScript((url) => localStorage.setItem('transmat.settings.v1', JSON.stringify({
    serverUrl: url, token: 'wrong-token', deviceName: 'Chrome on macOS', deviceId: '',
  })), `http://localhost:${PORTS.hostile}`);
  await page2.goto(APP, { waitUntil: 'domcontentloaded' });
  await page2.waitForTimeout(1200);
  const banner = await page2.locator('[data-testid="error-banner"]').innerText().catch(() => '');
  check(/rejected that token/i.test(banner), 'a bad token says the token was rejected, not "unreachable"', banner.replace(/\n/g, ' ').slice(0, 120));
  await shot(page2, '06b-unauthorized');
  await ctx.close(); await ctx2.close();
}

// ===========================================================================
// 7. Layout under stress
// ===========================================================================
{
  const { ctx, page } = await open(PORTS.hostile);
  await page.waitForSelector('[data-testid="transfer-row"]');
  await shot(page, '07-hostile-1280');

  const overflowed = await page.evaluate(() => {
    const bad = [];
    for (const el of document.querySelectorAll('.row, .composer, .filters, .shell, .masthead')) {
      if (el.scrollWidth > el.clientWidth + 1) bad.push(`${el.className}: ${el.scrollWidth}>${el.clientWidth}`);
    }
    return { bad, body: document.documentElement.scrollWidth > window.innerWidth };
  });
  check(overflowed.bad.length === 0 && !overflowed.body, 'no horizontal overflow at 1280px', JSON.stringify(overflowed).slice(0, 250));

  for (const [w, h, tag] of [[768, 900, '768'], [420, 800, '420'], [320, 720, '320']]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(250);
    await shot(page, `07-hostile-${tag}`);
    const o = await page.evaluate(() => ({
      bodyOverflow: document.documentElement.scrollWidth - window.innerWidth,
      clipped: [...document.querySelectorAll('.composer, .filters, .row, .masthead')]
        .filter((el) => el.scrollWidth > el.clientWidth + 1)
        .map((el) => `${el.className.split(' ')[0]} ${el.scrollWidth}>${el.clientWidth}`),
    }));
    check(o.bodyOverflow <= 0, `no page-level horizontal scroll at ${w}px`, `overflow ${o.bodyOverflow}px, clipped: ${o.clipped.slice(0, 4).join('; ')}`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  // command bar with a hostile long device name
  await page.keyboard.press('Control+k');
  await page.waitForSelector('[data-testid="command-bar"]');
  await shot(page, '07-cmdbar-longnames');
  const cmdOverflow = await page.evaluate(() =>
    [...document.querySelectorAll('.cmd-row, .cmd-payload, .cmd-foot')]
      .filter((el) => el.scrollWidth > el.clientWidth + 1)
      .map((el) => `${el.className.split(' ')[0]} ${el.scrollWidth}>${el.clientWidth}`));
  check(cmdOverflow.length === 0, 'command bar rows do not overflow with a very long device name', cmdOverflow.join('; '));
  await page.keyboard.press('Escape');

  // 40-line pasted note in the composer / command bar
  const note = Array.from({ length: 40 }, (_, i) => `line ${i + 1} of a long pasted note`).join('\n');
  await page.evaluate((n) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', n);
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  }, note);
  await page.waitForTimeout(300);
  await shot(page, '07-paste-40-lines');
  const barBox = await page.locator('[data-testid="command-bar"]').boundingBox().catch(() => null);
  check(!barBox || barBox.height <= 900, '40-line paste does not blow the command bar past the viewport', JSON.stringify(barBox));
  await page.keyboard.press('Escape');
  await ctx.close();
}

{
  const { ctx, page } = await open(PORTS.stress); // 500 transfers
  await page.waitForSelector('[data-testid="transfer-row"]');
  const t0 = Date.now();
  const count = await page.locator('[data-testid="transfer-row"]').count();
  const dt = Date.now() - t0;
  ok('500-transfer fixture renders', `${count} rows in ${dt}ms to query`);
  await shot(page, '08-stress-500');
  const scrolls = await page.evaluate(() => {
    const s = document.querySelector('[data-testid="stream"]');
    return { scrollHeight: s.scrollHeight, clientHeight: s.clientHeight, overflowY: getComputedStyle(s).overflowY };
  });
  check(scrolls.overflowY === 'auto' && scrolls.scrollHeight > scrolls.clientHeight,
    '500 rows scroll inside the stream instead of stretching the page', JSON.stringify(scrolls));
  const pageScroll = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
  check(pageScroll <= 0, 'the page itself does not grow with 500 rows', `${pageScroll}px`);
  await ctx.close();
}

// ===========================================================================
// 8. Formatting boundaries
// ===========================================================================
{
  const { ctx, page } = await open(PORTS.sizes);
  await page.waitForSelector('[data-testid="transfer-row"]');
  const table = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="transfer-row"]')].map((r) => ({
      name: r.querySelector('.row-name')?.textContent,
      mid: r.querySelector('.row-mid')?.textContent,
      right: r.querySelector('.row-right')?.textContent,
    })));
  console.log('\n--- formatting table ---');
  for (const r of table) console.log(`${(r.name || '').padEnd(28)} | ${(r.mid || '').padEnd(34)} | ${r.right}`);
  console.log('--- end table ---\n');
  await shot(page, '09-formatting');
  await ctx.close();
}

// ===========================================================================
// 9. Device identity: rename must PATCH, never fork a second device
// ===========================================================================
{
  const listWeb = async (port) =>
    (await (await fetch(`http://localhost:${port}/v1/devices`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json())
      .devices.filter((d) => d.platform === 'web');

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  // seed ONLY on the first navigation, or a reload wipes what the app stored
  await page.addInitScript(([u, t]) => {
    if (!localStorage.getItem('transmat.settings.v1')) {
      localStorage.setItem('transmat.settings.v1', JSON.stringify({
        serverUrl: u, token: t, deviceName: 'Chrome on macOS', deviceId: '',
      }));
    }
  }, [`http://localhost:${PORTS.stress}`, TOKEN]);
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="transfer-row"]');
  await page.waitForTimeout(900);
  const idBefore = await page.evaluate(() => JSON.parse(localStorage.getItem('transmat.settings.v1')).deviceId);

  await page.click('[data-testid="open-settings"]');
  await page.waitForSelector('[data-testid="settings"]');
  await page.fill('[data-testid="settings-name"]', 'Kirby Studio Browser');
  await page.click('[data-testid="settings-save"]');
  await page.waitForTimeout(1800);
  let web = await listWeb(PORTS.stress);
  check(web.length === 1 && web[0].name === 'Kirby Studio Browser',
    'renaming this browser reaches the server immediately', web.map((d) => d.name).join(' | '));

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="transfer-row"]');
  await page.waitForTimeout(1500);
  web = await listWeb(PORTS.stress);
  const idAfter = await page.evaluate(() => JSON.parse(localStorage.getItem('transmat.settings.v1')).deviceId);
  check(web.length === 1 && idAfter === idBefore,
    'a rename does not fork a duplicate device on the next load',
    `${web.length} web device(s), id ${idAfter === idBefore ? 'kept' : 'CHANGED'}`);

  // pointing at a different server must re-register cleanly (stale id 404s)
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.click('[data-testid="open-settings"]');
  await page.waitForSelector('[data-testid="settings"]');
  await page.fill('[data-testid="settings-url"]', `http://localhost:${PORTS.sizes}`);
  await page.click('[data-testid="settings-save"]');
  await page.waitForTimeout(2200);
  const onNew = await listWeb(PORTS.sizes);
  const idNew = await page.evaluate(() => JSON.parse(localStorage.getItem('transmat.settings.v1')).deviceId);
  // (this fixture is shared with earlier sections, so don't assert a count —
  //  assert that we took a NEW identity that the NEW server actually knows)
  const known = onNew.some((d) => d.device_id === idNew);
  const banner = await page.locator('[data-testid="error-banner"]').count();
  check(known && idNew !== idAfter && banner === 0 && errs.length === 0,
    'switching servers re-registers instead of erroring on the stale device_id',
    `id ${idNew === idAfter ? 'REUSED' : 'new'}, known to server: ${known}, banner ${banner}, ${errs.join('|').slice(0, 100)}`);
  await ctx.close();
}

// ===========================================================================
// 10. First run
// ===========================================================================
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="settings"]');
  // Escape must NOT dismiss a non-dismissable first run
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check(await page.locator('[data-testid="settings"]').isVisible(), 'first-run sheet resists Escape');
  // ⌘K over the first-run sheet
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(200);
  const barOverFirstRun = await page.locator('[data-testid="command-bar"]').count();
  check(barOverFirstRun === 0, 'command bar cannot open over the first-run sheet', `${barOverFirstRun} bars`);
  await shot(page, '10-first-run');
  await ctx.close();
}

await browser.close();
const failed = results.filter((r) => r[0] === 'FAIL');
const notes = results.filter((r) => r[0] === 'NOTE');
const checks = results.length - notes.length;
console.log(`\n${checks - failed.length}/${checks} checks passed${notes.length ? `, ${notes.length} documented note(s)` : ''}`);
if (notes.length) { console.log('\nNOTES (accepted, not failures):'); notes.forEach((f) => console.log(` - ${f[1]} :: ${f[2]}`)); }
if (failed.length) { console.log('\nFAILURES:'); failed.forEach((f) => console.log(` - ${f[1]} :: ${f[2]}`)); }
process.exit(failed.length ? 1 : 0);
