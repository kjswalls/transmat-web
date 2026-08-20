import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, parseEnv, MAX_FILE_BYTES, MAX_TEXT_BYTES } from '../src/config.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'transmat-config-'));

test('config', async (t) => {
  await t.test('parseEnv handles the shapes a .env actually contains', () => {
    const parsed = parseEnv(
      [
        '# a comment',
        '',
        'PORT=8787',
        'export TRANSMAT_TOKEN=abc123',
        'QUOTED="has spaces"',
        "SINGLE='also quoted'",
        'TRAILING=value # inline comment',
        'EMPTY=',
        'not a pair',
        '2BAD=nope',
      ].join('\n'),
    );
    assert.deepEqual(parsed, {
      PORT: '8787',
      TRANSMAT_TOKEN: 'abc123',
      QUOTED: 'has spaces',
      SINGLE: 'also quoted',
      TRAILING: 'value',
      EMPTY: '',
    });
  });

  await t.test('the contract defaults are the defaults', () => {
    const dir = tmp();
    const config = loadConfig({
      env: {},
      envFiles: [path.join(dir, '.env')],
      overrides: { TRANSMAT_TOKEN: 'tok', DATA_DIR: path.join(dir, '.data') },
      quiet: true,
    });
    assert.equal(config.port, 8787);
    assert.equal(config.storageDriver, 'local');
    assert.equal(config.pushDriver, 'console');
    assert.equal(config.blobSigningSecret, 'tok', 'defaults to TRANSMAT_TOKEN');
    assert.equal(config.publicBaseUrl, 'http://localhost:8787');
    assert.equal(config.defaultExpiryDays, 7);
    assert.equal(MAX_FILE_BYTES, 2 * 1024 * 1024 * 1024);
    assert.equal(MAX_TEXT_BYTES, 64 * 1024);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await t.test('BLOB_SIGNING_SECRET overrides the token when set', () => {
    const dir = tmp();
    const config = loadConfig({
      env: {},
      envFiles: [path.join(dir, '.env')],
      overrides: { TRANSMAT_TOKEN: 'tok', BLOB_SIGNING_SECRET: 'other', DATA_DIR: dir },
      quiet: true,
    });
    assert.equal(config.blobSigningSecret, 'other');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await t.test('a missing token in dev mints one and writes it to .env', () => {
    const dir = tmp();
    const envPath = path.join(dir, '.env');
    const config = loadConfig({
      env: {},
      envFiles: [envPath],
      overrides: { DATA_DIR: dir },
      quiet: true,
    });
    assert.ok(config.token.startsWith('dev_'));
    assert.equal(config.generatedToken, config.token);
    assert.ok(fs.existsSync(envPath), '.env should have been created');
    const written = parseEnv(fs.readFileSync(envPath, 'utf8'));
    assert.equal(written.TRANSMAT_TOKEN, config.token);

    // Second boot reuses it rather than minting a new one.
    const again = loadConfig({ env: {}, envFiles: [envPath], overrides: { DATA_DIR: dir }, quiet: true });
    assert.equal(again.token, config.token);
    assert.equal(again.generatedToken, null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await t.test('an existing .env with no token gets one appended, not a crash', () => {
    const dir = tmp();
    const envPath = path.join(dir, '.env');
    fs.writeFileSync(envPath, 'PORT=9999\n');
    const config = loadConfig({ env: {}, envFiles: [envPath], overrides: { DATA_DIR: dir }, quiet: true });
    assert.ok(config.token.startsWith('dev_'));
    assert.equal(config.port, 9999, 'the rest of the file is still honoured');
    assert.match(fs.readFileSync(envPath, 'utf8'), /TRANSMAT_TOKEN=dev_/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await t.test('production refuses to start without a token', () => {
    const dir = tmp();
    assert.throws(
      () =>
        loadConfig({
          env: { NODE_ENV: 'production' },
          envFiles: [path.join(dir, '.env')],
          overrides: { DATA_DIR: dir },
          quiet: true,
        }),
      /TRANSMAT_TOKEN is required/,
    );
    assert.ok(!fs.existsSync(path.join(dir, '.env')), 'and it writes nothing');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await t.test('the real process environment beats the .env file', () => {
    const dir = tmp();
    const envPath = path.join(dir, '.env');
    fs.writeFileSync(envPath, 'TRANSMAT_TOKEN=from-file\n');
    const config = loadConfig({
      env: { TRANSMAT_TOKEN: 'from-process' },
      envFiles: [envPath],
      overrides: { DATA_DIR: dir },
      quiet: true,
    });
    assert.equal(config.token, 'from-process');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await t.test('later .env files override earlier ones (root, then component)', () => {
    const dir = tmp();
    const rootEnv = path.join(dir, 'root.env');
    const localEnv = path.join(dir, 'local.env');
    fs.writeFileSync(rootEnv, 'TRANSMAT_TOKEN=shared\nPORT=1111\n');
    fs.writeFileSync(localEnv, 'PORT=2222\n');
    const config = loadConfig({
      env: {},
      envFiles: [rootEnv, localEnv],
      overrides: { DATA_DIR: dir },
      quiet: true,
    });
    assert.equal(config.token, 'shared');
    assert.equal(config.port, 2222);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await t.test('unknown drivers are rejected loudly', () => {
    const dir = tmp();
    const base = { env: {}, envFiles: [path.join(dir, '.env')], quiet: true };
    assert.throws(
      () => loadConfig({ ...base, overrides: { TRANSMAT_TOKEN: 't', DATA_DIR: dir, STORAGE_DRIVER: 's3' } }),
      /STORAGE_DRIVER/,
    );
    assert.throws(
      () => loadConfig({ ...base, overrides: { TRANSMAT_TOKEN: 't', DATA_DIR: dir, PUSH_DRIVER: 'fcm' } }),
      /PUSH_DRIVER/,
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await t.test('r2 and apns refuse to start half-configured', () => {
    const dir = tmp();
    const base = { env: {}, envFiles: [path.join(dir, '.env')], quiet: true };
    assert.throws(
      () => loadConfig({ ...base, overrides: { TRANSMAT_TOKEN: 't', DATA_DIR: dir, STORAGE_DRIVER: 'r2' } }),
      /R2_/,
    );
    assert.throws(
      () => loadConfig({ ...base, overrides: { TRANSMAT_TOKEN: 't', DATA_DIR: dir, PUSH_DRIVER: 'apns' } }),
      /APNS_/,
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
