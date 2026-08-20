/**
 * transmat register [--name NAME]
 *
 * Registers this machine as a device — platform `cli`, push_channel `none`,
 * because a laptop has no APNs token. The returned device_id is what makes
 * `to=others` from the phone actually land somewhere.
 */
import os from 'node:os';
import { Api } from '../api.js';
import { loadConfig, readConfigFile, requireSession, writeConfigFile } from '../config.js';
import { EXIT } from '../errors.js';
import { color, json, out } from '../ui.js';

export const spec = {
  name: 'register',
  summary: 'register this machine as a device',
  usage: 'transmat register [--name <name>]',
  options: {
    name: { type: 'string', short: 'n' },
    force: { type: 'boolean', default: false },
  },
  help: `
Register this machine with the server as a device (platform "cli",
push_channel "none"), and remember its device_id in the config.

  transmat register
  transmat register --name "Kirby's MacBook"

The server upserts on name + platform, so running this twice with the same
name returns the same device rather than creating a duplicate.

options:
  -n, --name <name>   display name (default: this machine's hostname)
      --force         re-register even if this machine already has a device_id
      --json          print the device as JSON
`.trim(),
};

/** Hostnames like "MacBook-Pro.local" read better without the mDNS suffix. */
export function defaultDeviceName() {
  const host = os.hostname().replace(/\.local$/i, '');
  return host || `${os.userInfo().username}'s ${os.platform()}`;
}

export async function run({ values }) {
  const config = requireSession();
  const api = new Api(config);

  const existing = config.device_id;
  const name = values.name?.trim() || config.device_name || defaultDeviceName();

  if (existing && !values.force && !values.name) {
    // Confirm the server still knows it before claiming everything is fine —
    // a wiped .data directory would otherwise leave the CLI pointing at a ghost.
    const devices = await api.listDevices();
    const found = devices.find((d) => d.device_id === existing);
    if (found) {
      if (values.json) {
        json({ ok: true, created: false, device: found });
        return EXIT.OK;
      }
      out(`${color.green('✓')} already registered as ${color.bold(found.name)}`);
      out(color.dim(`  device_id ${found.device_id}`));
      out(color.dim('  re-register with --force, or rename with --name'));
      return EXIT.OK;
    }
  }

  const response = await api.registerDevice({ name, platform: 'cli', push_channel: 'none' });
  const device = response?.device ?? response;

  const onDisk = readConfigFile() ?? loadConfig();
  writeConfigFile({
    ...onDisk,
    url: config.url,
    token: config.token,
    device_id: device.device_id,
    device_name: device.name,
  });

  if (values.json) {
    json({ ok: true, created: device.device_id !== existing, device });
    return EXIT.OK;
  }

  out(`${color.green('✓')} registered as ${color.bold(device.name)} ${color.dim('(cli)')}`);
  out(color.dim(`  device_id ${device.device_id}`));
  out(color.dim('  next: transmat watch     (and send things here with --to ' + JSON.stringify(device.name) + ')'));
  return EXIT.OK;
}
