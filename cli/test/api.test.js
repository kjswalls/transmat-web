/**
 * The API client against a real HTTP server (node:http, no dependencies):
 * bearer headers, the contract's error envelope, exit-code mapping, and the
 * 302-to-signed-URL dance on GET /v1/transfers/:id/blob.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { Api } from '../src/api.js';
import { EXIT } from '../src/errors.js';

/** Start a throwaway server; returns {url, close, requests}. */
async function serve(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: { ...req.headers } });
    handler(req, res, requests);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

test('every /v1 call carries the bearer token', async () => {
  const s = await serve((req, res) => json(res, 200, { devices: [] }));
  try {
    const api = new Api({ url: s.url, token: 'sekrit' });
    await api.listDevices();
    assert.equal(s.requests[0].headers.authorization, 'Bearer sekrit');
  } finally {
    await s.close();
  }
});

test('401 maps to exit code 4 and keeps the server message', async () => {
  const s = await serve((req, res) =>
    json(res, 401, { error: { code: 'unauthorized', message: 'bearer token does not match' } }),
  );
  try {
    const api = new Api({ url: s.url, token: 'wrong' });
    await assert.rejects(api.listDevices(), (err) => {
      assert.equal(err.exitCode, EXIT.AUTH);
      assert.equal(err.code, 'unauthorized');
      assert.match(err.message, /bearer token does not match/);
      assert.ok(err.hint, 'a 401 should tell the user how to fix it');
      return true;
    });
  } finally {
    await s.close();
  }
});

test('404 and 410 map to exit code 6', async () => {
  const s = await serve((req, res) => {
    if (req.url.includes('gone')) {
      json(res, 410, { error: { code: 'revoked', message: 'this transfer was revoked' } });
    } else {
      json(res, 404, { error: { code: 'not_found', message: 'no transfer x' } });
    }
  });
  try {
    const api = new Api({ url: s.url, token: 't' });
    await assert.rejects(api.getTransfer('x'), (e) => e.exitCode === EXIT.NOT_FOUND);
    await assert.rejects(api.getTransfer('gone'), (e) => {
      assert.equal(e.code, 'revoked');
      return e.exitCode === EXIT.NOT_FOUND;
    });
  } finally {
    await s.close();
  }
});

test('a non-envelope error body still produces a usable message', async () => {
  const s = await serve((req, res) => {
    res.writeHead(502, { 'content-type': 'text/html' });
    res.end('<html>bad gateway</html>');
  });
  try {
    const api = new Api({ url: s.url, token: 't' });
    await assert.rejects(api.listDevices(), (e) => {
      assert.match(e.message, /bad gateway/);
      assert.match(e.message, /HTTP 502/);
      return true;
    });
  } finally {
    await s.close();
  }
});

test('a refused connection is exit code 5 with an actionable hint', async () => {
  // Bind, note the port, then close it: nothing is listening there now.
  const s = await serve(() => {});
  const url = s.url;
  await s.close();

  const api = new Api({ url, token: 't' });
  await assert.rejects(api.listDevices(), (e) => {
    assert.equal(e.exitCode, EXIT.NETWORK);
    assert.match(e.message, /connection refused/);
    assert.ok(e.hint);
    return true;
  });
});

test('openBlob follows the 302 and does not leak the token to the signed URL', async () => {
  const body = Buffer.from('blob bytes');
  const s = await serve((req, res) => {
    if (req.url.startsWith('/v1/transfers/')) {
      res.writeHead(302, { location: '/blob/abc?exp=1&sig=deadbeef' });
      res.end();
      return;
    }
    if (req.url.startsWith('/blob/')) {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length });
      res.end(body);
      return;
    }
    json(res, 404, { error: { code: 'not_found', message: 'nope' } });
  });
  try {
    const api = new Api({ url: s.url, token: 'sekrit' });
    const response = await api.openBlob('t1');
    assert.equal(Buffer.from(await response.arrayBuffer()).toString(), 'blob bytes');

    assert.equal(s.requests.length, 2);
    assert.equal(s.requests[0].headers.authorization, 'Bearer sekrit');
    assert.equal(
      s.requests[1].headers.authorization,
      undefined,
      'the signed URL must be fetched without our bearer token',
    );
  } finally {
    await s.close();
  }
});

test('query parameters are built from the contract, skipping empties', async () => {
  const s = await serve((req, res) => json(res, 200, { transfers: [] }));
  try {
    const api = new Api({ url: s.url, token: 't' });
    await api.listTransfers({ device_id: 'abc', direction: 'in', limit: 100, kind: undefined, q: '' });
    const url = new URL(s.requests[0].url, s.url);
    assert.equal(url.pathname, '/v1/transfers');
    assert.equal(url.searchParams.get('device_id'), 'abc');
    assert.equal(url.searchParams.get('direction'), 'in');
    assert.equal(url.searchParams.get('limit'), '100');
    assert.equal(url.searchParams.has('kind'), false);
    assert.equal(url.searchParams.has('q'), false);
  } finally {
    await s.close();
  }
});

test('a streamed multipart upload arrives intact, with repeated targets', async () => {
  let received = '';
  const s = await serve((req, res) => {
    req.setEncoding('latin1');
    req.on('data', (c) => {
      received += c;
    });
    req.on('end', () => json(res, 200, { transfer: { transfer_id: 't1' } }));
  });
  try {
    const api = new Api({ url: s.url, token: 't' });
    const payload = Buffer.alloc(300_000, 7);
    let progress = 0;
    const transfer = await api.createFileTransfer({
      fields: [
        ['name', 'big.bin'],
        ['to', 'all'],
        ['to', 'others'],
      ],
      file: { filename: 'big.bin', contentType: 'application/octet-stream', stream: [payload] },
      onProgress: (n) => {
        progress += n;
      },
    });
    assert.equal(transfer.transfer_id, 't1');
    assert.equal(progress, payload.length);
    assert.match(s.requests[0].headers['content-type'], /^multipart\/form-data; boundary=/);
    assert.ok(received.includes('filename="big.bin"'));
    assert.equal(received.split('name="to"').length - 1, 2);
    // The payload survived the stream byte for byte.
    assert.ok(received.includes(String.fromCharCode(7).repeat(1000)));
  } finally {
    await s.close();
  }
});

test('the SSE stream is opened with the right accept header and device filter', async () => {
  const s = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: transfer.created\ndata: {"transfer":{"transfer_id":"t9"}}\n\n');
    res.end();
  });
  try {
    const api = new Api({ url: s.url, token: 't' });
    const response = await api.openEvents({ deviceId: 'dev-1' });
    const text = await response.text();
    assert.match(text, /transfer\.created/);
    assert.equal(s.requests[0].headers.accept, 'text/event-stream');
    assert.match(s.requests[0].url, /device_id=dev-1/);
  } finally {
    await s.close();
  }
});
