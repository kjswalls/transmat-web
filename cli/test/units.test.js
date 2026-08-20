/**
 * Unit tests for the parts that are easy to get subtly wrong: the SSE parser,
 * filename safety, the multipart envelope, and config file permissions.
 *
 *   node --test test/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseSSE, backoffDelay } from '../src/sse.js';
import {
  safeFileName,
  safeIdSegment,
  resolveInside,
  openWithoutClobbering,
  guessMimeType,
} from '../src/files.js';
import { readReceipts, writeReceipts } from '../src/receipts.js';
import { postStream } from '../src/upload.js';
import { buildMultipart } from '../src/multipart.js';
import { formatBytes, formatRelative, table } from '../src/ui.js';
import { normalizeUrl, expandHome, writeConfigFile, readConfigFile, configPath } from '../src/config.js';

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'transmat-test-'));

/** A ReadableStream of the given strings, so we control exactly where chunks split. */
function streamOf(...chunks) {
  const encoder = new TextEncoder();
  return ReadableStream.from(chunks.map((c) => encoder.encode(c)));
}

async function collect(iterable) {
  const items = [];
  for await (const item of iterable) items.push(item);
  return items;
}

/* ------------------------------------------------------------------- SSE */

test('parseSSE reads a well-formed event', async () => {
  const events = await collect(
    parseSSE(streamOf('event: transfer.created\ndata: {"a":1}\n\n')),
  );
  assert.deepEqual(events, [
    { type: 'event', event: 'transfer.created', data: '{"a":1}', id: undefined, retry: undefined },
  ]);
});

test('parseSSE survives an event split across chunk boundaries', async () => {
  const events = await collect(
    parseSSE(streamOf('event: transfer.', 'created\ndata: {"tra', 'nsfer":{"id":1}}', '\n\nevent: x\ndata: 2\n\n')),
  );
  assert.equal(events.length, 2);
  assert.equal(events[0].event, 'transfer.created');
  assert.equal(events[0].data, '{"transfer":{"id":1}}');
  assert.equal(events[1].data, '2');
});

test('parseSSE handles CRLF, including a CRLF split across chunks', async () => {
  const events = await collect(parseSSE(streamOf('data: one\r', '\n\r\n')));
  assert.deepEqual(
    events.map((e) => e.data),
    ['one'],
  );
});

test('parseSSE joins multi-line data and surfaces comments separately', async () => {
  const events = await collect(
    parseSSE(streamOf(':keepalive 123\n\ndata: line1\ndata: line2\nretry: 4000\n\n')),
  );
  assert.deepEqual(events[0], { type: 'comment', text: 'keepalive 123' });
  assert.equal(events[1].data, 'line1\nline2');
  assert.equal(events[1].retry, 4000);
});

test('parseSSE ignores a trailing event with no blank line (still in flight)', async () => {
  const events = await collect(parseSSE(streamOf('data: complete\n\ndata: partial\n')));
  assert.equal(events.length, 1);
});

test('backoffDelay grows and is capped', () => {
  const noJitter = (n) => backoffDelay(n, { jitter: false });
  assert.equal(noJitter(1), 1000);
  assert.equal(noJitter(2), 2000);
  assert.equal(noJitter(3), 4000);
  assert.equal(noJitter(20), 30_000);
  for (let i = 1; i < 12; i += 1) {
    const d = backoffDelay(i);
    assert.ok(d > 0 && d <= 30_000, `attempt ${i} gave ${d}`);
  }
});

/* ----------------------------------------------------------------- files */

test('safeFileName refuses to escape the download directory', () => {
  assert.equal(safeFileName('../../etc/passwd'), 'passwd');
  assert.equal(safeFileName('/etc/shadow'), 'shadow');
  assert.equal(safeFileName('a/b/c/report.pdf'), 'report.pdf');
  assert.equal(safeFileName('re\u0000port.pdf'), 'report.pdf');
  assert.equal(safeFileName('..\\..\\windows\\system32\\evil.dll'), 'evil.dll');
});

test('safeFileName cleans hostile names and falls back when nothing is left', () => {
  assert.equal(safeFileName(''), 'transfer.bin');
  assert.equal(safeFileName('..'), 'transfer.bin');
  assert.equal(safeFileName(null, 'fallback.bin'), 'fallback.bin');
  assert.equal(safeFileName('-rf'), '_rf');
  assert.equal(safeFileName('plain.pdf'), 'plain.pdf');
  assert.equal(safeFileName('a:b|c?.txt'), 'a_b_c_.txt');
  assert.ok(safeFileName(`${'x'.repeat(500)}.txt`).length <= 200);
});

test('openWithoutClobbering never overwrites', () => {
  const dir = tmpdir();
  const first = openWithoutClobbering(dir, 'report.pdf');
  fs.writeSync(first.fd, 'one');
  fs.closeSync(first.fd);

  const second = openWithoutClobbering(dir, 'report.pdf');
  fs.writeSync(second.fd, 'two');
  fs.closeSync(second.fd);

  const third = openWithoutClobbering(dir, 'report.pdf');
  fs.closeSync(third.fd);

  assert.equal(path.basename(first.filePath), 'report.pdf');
  assert.equal(path.basename(second.filePath), 'report (2).pdf');
  assert.equal(path.basename(third.filePath), 'report (3).pdf');
  assert.equal(fs.readFileSync(first.filePath, 'utf8'), 'one');
  assert.equal(fs.readFileSync(second.filePath, 'utf8'), 'two');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('openWithoutClobbering handles extensionless names', () => {
  const dir = tmpdir();
  fs.closeSync(openWithoutClobbering(dir, 'Makefile').fd);
  const second = openWithoutClobbering(dir, 'Makefile');
  fs.closeSync(second.fd);
  assert.equal(path.basename(second.filePath), 'Makefile (2)');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('guessMimeType covers the common cases and defaults safely', () => {
  assert.equal(guessMimeType('a.pdf'), 'application/pdf');
  assert.equal(guessMimeType('IMG_0001.JPG'), 'image/jpeg');
  assert.equal(guessMimeType('archive.tar.gz'), 'application/gzip');
  assert.equal(guessMimeType('mystery'), 'application/octet-stream');
});

/* ------------------------------------------------------------- multipart */

test('buildMultipart produces a parseable envelope and reports progress', async () => {
  const payload = new Uint8Array([1, 2, 3, 4, 5]);
  let reported = 0;
  const { body, boundary, contentType } = buildMultipart({
    fields: [
      ['name', 'report.pdf'],
      ['to', 'all'],
      ['to', 'others'],
    ],
    file: { filename: 'report.pdf', contentType: 'application/pdf', stream: [payload] },
    onProgress: (n) => {
      reported += n;
    },
  });

  assert.ok(contentType.startsWith('multipart/form-data; boundary=----TransmatBoundary'));

  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('latin1');

  assert.equal(reported, payload.byteLength);
  // Repeated fields survive in order — "to" being repeatable is in the contract.
  assert.equal(raw.split('name="to"').length - 1, 2);
  assert.ok(raw.includes('content-disposition: form-data; name="name"\r\n\r\nreport.pdf\r\n'));
  assert.ok(raw.includes('filename="report.pdf"'));
  assert.ok(raw.includes('content-type: application/pdf'));
  assert.ok(raw.endsWith(`--${boundary}--\r\n`));
});

test('buildMultipart neutralises header injection in a filename', async () => {
  const { body } = buildMultipart({
    fields: [],
    file: {
      filename: 'evil"\r\ncontent-type: text/html\r\n\r\n<script>.txt',
      contentType: 'text/plain',
      stream: [],
    },
  });
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('latin1');
  const header = raw.split('\r\n\r\n')[0];
  const lines = header.split('\r\n');
  // Exactly: the boundary line, the disposition, and our content-type. The
  // filename's CRLFs became spaces, so it can't have opened a header of its own.
  assert.equal(lines.length, 3, header);
  assert.ok(lines[1].startsWith('content-disposition: form-data;'));
  assert.equal(lines[2], 'content-type: text/plain');
  assert.ok(!lines.some((l) => l === 'content-type: text/html'), 'injected header must not survive');
  assert.ok(header.includes('%22'), 'the quote should be escaped');
});

/* -------------------------------------------------------------------- ui */

test('formatBytes is readable at every scale', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(2516582), '2.4 MB');
  assert.equal(formatBytes(2 * 1024 ** 3), '2.0 GB');
  assert.equal(formatBytes(null), '—');
});

test('formatRelative reads like a person wrote it', () => {
  const now = Date.parse('2026-08-20T12:00:00Z');
  const at = (iso) => formatRelative(iso, now);
  assert.equal(at('2026-08-20T11:59:59Z'), 'just now');
  assert.equal(at('2026-08-20T11:59:30Z'), '30s ago');
  assert.equal(at('2026-08-20T11:30:00Z'), '30m ago');
  assert.equal(at('2026-08-19T12:00:00Z'), '1d ago');
  assert.equal(at('2026-08-27T12:00:00Z'), 'in 7d');
  assert.equal(at(null), '—');
});

test('table pads columns to the widest cell', () => {
  const rendered = table(
    [
      { key: 'a', label: 'name' },
      { key: 'b', label: 'size', align: 'right' },
    ],
    [
      { a: 'short', b: '1 B' },
      { a: 'a much longer name', b: '200 MB' },
    ],
  );
  const lines = rendered.split('\n');
  assert.equal(lines.length, 3);
  assert.ok(lines[1].startsWith('short             '));
  assert.ok(lines[1].endsWith('   1 B'));
});

/* ---------------------------------------------------------------- config */

test('normalizeUrl and expandHome tidy user input', () => {
  assert.equal(normalizeUrl('http://localhost:8787/'), 'http://localhost:8787');
  assert.equal(normalizeUrl('http://localhost:8787///'), 'http://localhost:8787');
  assert.equal(normalizeUrl('localhost:8787'), 'http://localhost:8787');
  assert.equal(normalizeUrl(' https://x.test '), 'https://x.test');
  assert.equal(expandHome('~/Downloads'), path.join(os.homedir(), 'Downloads'));
  assert.equal(expandHome('/tmp/x'), '/tmp/x');
});

test('the config file is written 0600 and round-trips', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'nested', 'config.json');
  const previous = process.env.TRANSMAT_CONFIG;
  process.env.TRANSMAT_CONFIG = file;
  try {
    assert.equal(configPath(), file);
    writeConfigFile({ url: 'http://localhost:8787', token: 'sekrit', device_id: 'abc' });
    const mode = fs.statSync(file).mode & 0o777;
    assert.equal(mode.toString(8), '600');
    const back = readConfigFile();
    assert.equal(back.token, 'sekrit');
    assert.equal(back.device_id, 'abc');
    assert.ok(back.updated_at);
    // A second write must not trip over its own temp file.
    writeConfigFile({ ...back, device_name: 'laptop' });
    assert.equal(readConfigFile().device_name, 'laptop');
    assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
  } finally {
    if (previous === undefined) delete process.env.TRANSMAT_CONFIG;
    else process.env.TRANSMAT_CONFIG = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------- regression: path containment */

test('safeFileName scrubs the fallback too — it is built from a server id', () => {
  // A transfer_id of "x/../../PWNED" used to reach the filesystem verbatim
  // through the fallback, writing outside the download directory.
  assert.equal(safeFileName(null, 'transfer-x/../../PWNED.bin'), 'PWNED.bin');
  assert.equal(safeFileName('..', '../../../etc/cron.d/evil'), 'evil');
  assert.equal(safeFileName(null, '..'), 'transfer.bin');
  assert.equal(safeFileName(null, ''), 'transfer.bin');
});

test('safeIdSegment cannot produce a path separator or a traversal', () => {
  assert.equal(safeIdSegment('x/../../PWNED'), 'x.PWNED');
  assert.equal(safeIdSegment('../../../etc/passwd'), 'etcpasswd');
  assert.equal(safeIdSegment('..'), 'unknown');
  assert.equal(safeIdSegment(''), 'unknown');
  assert.equal(safeIdSegment('9f1c-4c2e-b0aa'), '9f1c-4c2e-b0aa');
  assert.ok(!safeIdSegment('a'.repeat(500)).includes('/'));
  assert.ok(safeIdSegment('a'.repeat(500)).length <= 64);
});

test('resolveInside keeps every path under the download directory', () => {
  const dir = tmpdir();
  assert.equal(resolveInside(dir, 'ok.txt'), path.join(dir, 'ok.txt'));
  assert.equal(resolveInside(dir, 'sub/ok.txt'), path.join(dir, 'sub', 'ok.txt'));
  assert.throws(() => resolveInside(dir, '../escape.txt'), /refusing to write outside/);
  assert.throws(() => resolveInside(dir, 'a/../../escape.txt'), /refusing to write outside/);
  assert.throws(() => resolveInside(dir, '/etc/passwd'), /refusing to write outside/);
  assert.throws(() => resolveInside(dir, '.'), /refusing to write outside/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('openWithoutClobbering refuses a name that escapes the directory', () => {
  const dir = tmpdir();
  assert.throws(() => openWithoutClobbering(dir, '../escape.txt'), /refusing to write outside/);
  assert.deepEqual(fs.readdirSync(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

/* --------------------------------------------------------------- receipts */

test('receipts round-trip at 0600 and are capped', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'receipts.json');
  const map = new Map();
  for (let i = 0; i < 600; i += 1) {
    map.set(`t${i}`, { delivery_id: `d${i}`, path: `/tmp/f${i}`, acked: true, at: 'now' });
  }
  const kept = writeReceipts(map, file);
  assert.equal(kept, 500);
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');

  const back = readReceipts(file);
  assert.equal(back.size, 500);
  assert.equal(back.has('t0'), false, 'oldest entries are dropped');
  assert.equal(back.get('t599').delivery_id, 'd599');

  fs.writeFileSync(file, 'not json at all');
  assert.equal(readReceipts(file).size, 0, 'a corrupt ledger is a cache miss, not a crash');
  assert.equal(readReceipts(path.join(dir, 'nope.json')).size, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------- streaming upload leg */

test('postStream streams a body through node:http and returns the response', async () => {
  const { createServer } = await import('node:http');
  let received = 0;
  const server = createServer((req, res) => {
    req.on('data', (c) => { received += c.length; });
    req.on('end', () => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ transfer: { transfer_id: 'ok', bytes: received } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  async function* body() {
    for (let i = 0; i < 32; i += 1) yield new Uint8Array(1024).fill(65);
  }
  const response = await postStream({
    url: `http://127.0.0.1:${port}/v1/transfers`,
    headers: { 'content-type': 'multipart/form-data; boundary=x' },
    body: body(),
  });
  assert.equal(response.status, 201);
  assert.equal(response.ok, true);
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.deepEqual(JSON.parse(await response.text()).transfer, {
    transfer_id: 'ok',
    bytes: 32 * 1024,
  });
  server.close();
});

test('postStream surfaces an error status instead of throwing', async () => {
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'too_large', message: 'nope' } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const response = await postStream({
    url: `http://127.0.0.1:${port}/v1/transfers`,
    body: (async function* () { yield new Uint8Array([1, 2, 3]); })(),
  });
  assert.equal(response.status, 413);
  assert.equal(response.ok, false);
  assert.equal(JSON.parse(await response.text()).error.code, 'too_large');
  server.close();
});

test('postStream gives up on a server that accepts bytes and goes silent', async () => {
  const { createServer } = await import('node:http');
  const server = createServer((req) => {
    req.resume(); // ...and never answers
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const started = Date.now();
  await assert.rejects(
    postStream({
      url: `http://127.0.0.1:${port}/v1/transfers`,
      body: (async function* () { yield new Uint8Array([1]); })(),
      idleTimeoutMs: 300,
    }),
    /stalled/,
  );
  assert.ok(Date.now() - started < 5000, 'it must not hang');
  server.close();
});
