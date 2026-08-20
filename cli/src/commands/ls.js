/**
 * transmat ls — recent transfers, from this machine's point of view.
 */
import { Api } from '../api.js';
import { loadConfig, requireSession } from '../config.js';
import { EXIT, usage } from '../errors.js';
import { color, formatBytes, formatRelative, json, out, table } from '../ui.js';

export const spec = {
  name: 'ls',
  summary: 'list recent transfers',
  usage: 'transmat ls [--in|--out] [--kind file|text|link] [--limit N]',
  aliases: ['list', 'transfers'],
  options: {
    in: { type: 'boolean', default: false },
    out: { type: 'boolean', default: false },
    kind: { type: 'string' },
    q: { type: 'string' },
    limit: { type: 'string' },
    all: { type: 'boolean', default: false },
  },
  help: `
List recent transfers. By default only the ones this machine is party to;
--all ignores this device entirely.

  transmat ls
  transmat ls --in --kind file
  transmat ls --json | jq '.transfers[] | {file_name, state}'

options:
      --in           only transfers addressed to this device
      --out          only transfers sent from this device
      --kind <k>     file | text | link
      --q <text>     filename search
      --limit <n>    default 20
      --all          every transfer on the server, not just this device's
      --json         print the raw contract objects
`.trim(),
};

export async function run({ values }) {
  const config = requireSession();
  const api = new Api(config);

  if (values.in && values.out) throw usage('--in and --out are mutually exclusive');
  const limit = values.limit ? Number(values.limit) : 20;
  if (!Number.isInteger(limit) || limit < 1) throw usage('--limit must be a positive integer');
  if (values.kind && !['file', 'text', 'link'].includes(values.kind)) {
    throw usage('--kind must be file, text or link');
  }

  const direction = values.in ? 'in' : values.out ? 'out' : undefined;
  const { transfers, next_cursor } = await api.listTransfers({
    device_id: values.all ? undefined : config.device_id,
    direction,
    kind: values.kind,
    q: values.q,
    limit,
  });

  if (values.json) {
    json({ transfers, next_cursor: next_cursor ?? null });
    return EXIT.OK;
  }

  if (!transfers.length) {
    out('nothing yet');
    return EXIT.OK;
  }

  const me = loadConfig().device_id;
  const rows = transfers.map((t) => {
    const mine = t.from_device_id && t.from_device_id === me;
    const to = (t.deliveries ?? []).map((d) => d.device_name || d.device_id);
    return {
      dir: mine ? color.cyan('↑') : color.green('↓'),
      what: t.kind === 'file' ? t.file_name ?? '(file)' : truncate(t.text ?? '', 40),
      size: t.kind === 'file' ? formatBytes(t.size) : color.dim(t.kind),
      peer: mine ? `→ ${to.join(', ') || '—'}` : `← ${t.from_device_name ?? 'unknown'}`,
      state: stateLabel(t),
      when: formatRelative(t.created_at),
      id: color.dim(t.transfer_id),
    };
  });

  out(
    table(
      [
        { key: 'dir', label: '' },
        { key: 'what', label: 'what' },
        { key: 'size', label: 'size', align: 'right' },
        { key: 'peer', label: 'with' },
        { key: 'state', label: 'state' },
        { key: 'when', label: 'when', align: 'right' },
        { key: 'id', label: 'transfer id' },
      ],
      rows,
    ),
  );
  if (next_cursor) out(color.dim(`  … more available (--limit ${limit + 20})`));
  return EXIT.OK;
}

function stateLabel(t) {
  if (t.state === 'revoked') return color.red('revoked');
  if (t.state === 'expired') return color.gray('expired');
  const deliveries = t.deliveries ?? [];
  const done = deliveries.filter((d) => d.state === 'downloaded').length;
  if (!deliveries.length) return color.dim('no targets');
  if (done === deliveries.length) return color.green('downloaded');
  return color.yellow(`${done}/${deliveries.length} downloaded`);
}

function truncate(s, n) {
  const flat = String(s).replace(/\s+/g, ' ');
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}
