/**
 * transmat status — "is this thing on?"
 *
 * The first command to run when something isn't working: it says what config
 * is in effect, whether the server answers, and whether the token is good,
 * without ever printing the token.
 */
import fs from 'node:fs';
import { Api } from '../api.js';
import { configPath, loadConfig } from '../config.js';
import { EXIT } from '../errors.js';
import { color, json, out } from '../ui.js';
import { isOnline } from './devices.js';

export const spec = {
  name: 'status',
  summary: 'show the current config and whether the server is reachable',
  usage: 'transmat status [--json]',
  options: {},
  help: `
Show which server this machine is pointed at, whether it answers, whether the
token still works, and which device this machine is registered as.

  transmat status
  transmat status --json

Exit code is 0 when the server is reachable and the token is accepted.
`.trim(),
};

export async function run({ values }) {
  const config = loadConfig();
  const file = configPath();
  const exists = fs.existsSync(file);
  const mode = exists ? (fs.statSync(file).mode & 0o777).toString(8).padStart(3, '0') : null;

  const report = {
    config_path: file,
    config_exists: exists,
    config_mode: mode,
    url: config.url ?? null,
    token_set: Boolean(config.token),
    device_id: config.device_id ?? null,
    device_name: config.device_name ?? null,
    server: null,
    authorized: null,
    device_registered: null,
    error: null,
  };

  let exitCode = EXIT.OK;

  if (!config.url || !config.token) {
    report.error = 'not logged in';
    exitCode = EXIT.NO_CONFIG;
  } else {
    const api = new Api(config);
    try {
      report.server = await api.health();
      const devices = await api.listDevices();
      report.authorized = true;
      report.device_count = devices.length;
      report.device_registered = config.device_id
        ? devices.some((d) => d.device_id === config.device_id)
        : false;
      const me = devices.find((d) => d.device_id === config.device_id);
      if (me) report.online = isOnline(me);
    } catch (cause) {
      report.error = cause.message;
      report.authorized = cause.status === 401 ? false : report.authorized;
      exitCode = cause.exitCode ?? EXIT.ERROR;
    }
  }

  if (values.json) {
    json(report);
    return exitCode;
  }

  out(`${color.bold('config')}   ${file}${mode ? color.dim(` (${mode})`) : color.dim(' (missing)')}`);
  out(`${color.bold('server')}   ${report.url ?? color.dim('— not logged in')}`);
  if (report.server) {
    out(
      `${color.bold('health')}   ${color.green('ok')} ${color.dim(
        `· storage ${report.server.storage} · push ${report.server.push} · v${report.server.version ?? '?'}`,
      )}`,
    );
    out(`${color.bold('token')}    ${report.authorized ? color.green('accepted') : color.red('rejected')}`);
  } else if (report.error && report.url) {
    out(`${color.bold('health')}   ${color.red(report.error)}`);
  } else if (report.error) {
    out(`${color.bold('health')}   ${color.dim('—')}`);
  }
  if (report.device_id) {
    const suffix = report.device_registered
      ? report.online
        ? color.green(' · online')
        : ''
      : color.yellow(' · unknown to this server — run `transmat register`');
    out(`${color.bold('device')}   ${report.device_name ?? '?'} ${color.dim(report.device_id)}${suffix}`);
  } else {
    out(`${color.bold('device')}   ${color.yellow('not registered')} ${color.dim('— run `transmat register`')}`);
  }
  return exitCode;
}
