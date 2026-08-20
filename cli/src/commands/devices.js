/**
 * transmat devices — who can receive things right now.
 *
 * "Online" isn't in the contract, and shouldn't be: the server only records
 * last_seen_at, which every authenticated call touches. A device seen inside
 * the window is one that is talking to the server (a phone in the foreground,
 * a laptop running `transmat watch`), which is exactly the useful signal.
 */
import { Api } from '../api.js';
import { requireSession } from '../config.js';
import { EXIT } from '../errors.js';
import { color, formatRelative, json, out, table } from '../ui.js';

/** A watcher touches the server on connect and on every ack; SSE keepalives don't. */
export const ONLINE_WINDOW_MS = 2 * 60 * 1000;

export const spec = {
  name: 'devices',
  summary: 'list the devices registered with this server',
  usage: 'transmat devices [--json]',
  options: {
    all: { type: 'boolean', default: false },
  },
  help: `
List every device registered with the server, newest activity first.

  transmat devices
  transmat devices --json | jq -r '.devices[].name'

A device counts as online when the server has heard from it in the last
${Math.round(ONLINE_WINDOW_MS / 1000)} seconds.

options:
  --json   print the raw contract objects
`.trim(),
};

export async function run({ values }) {
  const config = requireSession();
  const api = new Api(config);
  const devices = await api.listDevices();

  if (values.json) {
    json({
      devices: devices.map((d) => ({ ...d, online: isOnline(d), this_device: d.device_id === config.device_id })),
    });
    return EXIT.OK;
  }

  if (!devices.length) {
    out('no devices registered yet');
    out(color.dim('  run `transmat register` here, and register the app on your phone'));
    return EXIT.OK;
  }

  const sorted = [...devices].sort(
    (a, b) => Date.parse(b.last_seen_at ?? 0) - Date.parse(a.last_seen_at ?? 0),
  );

  const rows = sorted.map((d) => {
    const online = isOnline(d);
    const mine = d.device_id === config.device_id;
    return {
      state: online ? color.green('● online') : color.gray('○ offline'),
      name: mine ? `${color.bold(d.name)} ${color.dim('(this machine)')}` : d.name,
      platform: d.platform,
      push: d.push_channel === 'none' ? color.dim('none') : `${d.push_channel}${d.has_push_token ? '' : color.yellow(' (no token)')}`,
      seen: formatRelative(d.last_seen_at),
      id: color.dim(d.device_id),
    };
  });

  out(
    table(
      [
        { key: 'state', label: '' },
        { key: 'name', label: 'name' },
        { key: 'platform', label: 'platform' },
        { key: 'push', label: 'push' },
        { key: 'seen', label: 'last seen', align: 'right' },
        { key: 'id', label: 'device id' },
      ],
      rows,
    ),
  );
  return EXIT.OK;
}

export function isOnline(device, now = Date.now()) {
  const seen = Date.parse(device?.last_seen_at ?? '');
  return Number.isFinite(seen) && now - seen <= ONLINE_WINDOW_MS;
}
