/**
 * The smallest possible static server for ./dist, so the verify harnesses can
 * drive the real built bundle without depending on a globally installed CLI.
 *
 *   WEB_PORT=4291 node scripts/serve-dist.mjs
 */
import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const PORT = Number(process.env.WEB_PORT || 4291);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

http
  .createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    let file = path.join(ROOT, decodeURIComponent(url.pathname));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    try {
      if (statSync(file).isDirectory()) file = path.join(file, 'index.html');
    } catch {
      file = path.join(ROOT, 'index.html'); // SPA fallback
    }
    let size;
    try { size = statSync(file).size; } catch { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Content-Length': size,
      'Cache-Control': 'no-store',
    });
    createReadStream(file).pipe(res);
  })
  .listen(PORT, () => console.log(`[dist] http://localhost:${PORT} -> ${ROOT}`));
