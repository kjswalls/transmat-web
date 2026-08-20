/**
 * One command that gives you a working app with nothing installed and no
 * credentials: the mock server plus the Vite dev server.
 *
 *   npm run dev:mock
 *
 * Point the app at the real server instead by editing the URL in settings (⌘,).
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOCK_PORT = process.env.MOCK_PORT || '8787';
const TOKEN = process.env.TRANSMAT_TOKEN || 'dev-token-change-me';

const kids = [];
const run = (cmd, args, env, tag, color) => {
  const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env } });
  const pipe = (stream, to) =>
    stream.on('data', (d) =>
      String(d).split('\n').filter(Boolean).forEach((l) => to.write(`\x1b[${color}m${tag}\x1b[0m ${l}\n`)));
  pipe(p.stdout, process.stdout);
  pipe(p.stderr, process.stderr);
  kids.push(p);
};

run('node', ['mock/server.js'], { PORT: MOCK_PORT, TRANSMAT_TOKEN: TOKEN }, 'mock', '35');
run('node_modules/.bin/vite', [], {}, 'web ', '36');

console.log(`\n  Transmat web — dev\n  mock API  http://localhost:${MOCK_PORT}  (token: ${TOKEN})\n  app       http://localhost:5173\n`);

const bye = () => { kids.forEach((k) => k.kill('SIGTERM')); process.exit(0); };
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
