/**
 * ~/.config/transmat/config.json — the only state the CLI keeps.
 *
 * It holds a bearer token, so the file is written 0600 inside a 0700 directory
 * and is never echoed back to the terminal. Environment variables override it
 * so CI and one-off shells can drive the CLI without touching the user's
 * config at all.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CliError, EXIT } from './errors.js';

/**
 * @typedef {object} Config
 * @property {string} url            server base URL, no trailing slash
 * @property {string} token          bearer token
 * @property {string} [device_id]    set by `transmat register`
 * @property {string} [device_name]
 * @property {string} [download_dir] default landing zone for `watch`
 * @property {string} [updated_at]
 */

/** ~/.config/transmat — ours, so ours to keep at 0700. */
export function defaultConfigDir() {
  const base = process.env.XDG_CONFIG_HOME?.trim()
    ? path.resolve(process.env.XDG_CONFIG_HOME)
    : path.join(os.homedir(), '.config');
  return path.join(base, 'transmat');
}

export function configPath() {
  if (process.env.TRANSMAT_CONFIG) return path.resolve(process.env.TRANSMAT_CONFIG);
  return path.join(defaultConfigDir(), 'config.json');
}

/** @returns {Config|null} null when the file doesn't exist yet. */
export function readConfigFile() {
  const file = configPath();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new CliError(`could not read ${file}: ${err.message}`, { cause: err });
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
    return parsed;
  } catch (err) {
    throw new CliError(`${file} is not valid JSON (${err.message})`, {
      hint: 'delete it and run `transmat login <url> <token>` again',
    });
  }
}

/**
 * Write the config atomically with 0600 permissions.
 * @param {Config} config
 */
export function writeConfigFile(config) {
  const file = configPath();
  const dir = path.dirname(file);
  const created = fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdirSync's mode is masked by umask, so tighten what we made ourselves.
  // Only what we made: TRANSMAT_CONFIG can point anywhere, and silently
  // chmod-ing someone's existing directory to 0700 is not our call. The file
  // itself is 0600 either way, which is what actually guards the token.
  if (created || dir === defaultConfigDir()) {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      /* not fatal — a shared config dir may not be ours to chmod */
    }
  }

  const body = `${JSON.stringify({ ...config, updated_at: new Date().toISOString() }, null, 2)}\n`;
  const tmp = `${file}.${process.pid}.tmp`;
  // 0600 at create time: the token must never exist on disk world-readable,
  // not even for the instant between write and chmod.
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, body);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
  return file;
}

/** Environment overrides, applied on top of whatever is on disk. */
function withEnv(config) {
  const merged = { ...(config ?? {}) };
  const url = process.env.TRANSMAT_URL || process.env.TRANSMAT_SERVER;
  if (url) merged.url = normalizeUrl(url);
  if (process.env.TRANSMAT_TOKEN) merged.token = process.env.TRANSMAT_TOKEN;
  if (process.env.TRANSMAT_DEVICE_ID) merged.device_id = process.env.TRANSMAT_DEVICE_ID;
  return merged;
}

/** @returns {Config} */
export function loadConfig() {
  return withEnv(readConfigFile());
}

/**
 * The session every authenticated command needs.
 * @returns {Config & {url: string, token: string}}
 */
export function requireSession() {
  const config = loadConfig();
  if (!config.url || !config.token) {
    throw new CliError('not logged in', {
      exitCode: EXIT.NO_CONFIG,
      hint: 'run `transmat login <server-url> <token>` first (or set TRANSMAT_URL and TRANSMAT_TOKEN)',
    });
  }
  return /** @type {any} */ (config);
}

/** Same, but also insists this machine has been registered as a device. */
export function requireDevice() {
  const config = requireSession();
  if (!config.device_id) {
    throw new CliError('this machine is not registered as a device', {
      exitCode: EXIT.NO_CONFIG,
      hint: 'run `transmat register` first',
    });
  }
  return /** @type {any} */ (config);
}

/** Trailing slashes make every joined path wrong exactly once. Strip them here. */
export function normalizeUrl(url) {
  const trimmed = String(url ?? '').trim();
  if (!trimmed) return trimmed;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withScheme.replace(/\/+$/, '');
}

/** Expand a leading ~ — shells do this, but not when the path came from a config file. */
export function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}
