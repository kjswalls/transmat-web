/**
 * transmat rm <transfer_id...> — the kill switch.
 *
 * DELETE /v1/transfers/:id: the state goes to `revoked`, the bytes are deleted
 * server-side, and every connected device gets `transfer.revoked`. Copies
 * already downloaded are, of course, already downloaded.
 */
import { Api } from '../api.js';
import { requireSession } from '../config.js';
import { EXIT, usage } from '../errors.js';
import { color, err, json, out } from '../ui.js';

export const spec = {
  name: 'rm',
  summary: 'revoke a transfer (delete the bytes from the server)',
  usage: 'transmat rm <transfer_id...>',
  aliases: ['revoke'],
  options: {},
  help: `
Revoke one or more transfers. The server deletes the stored bytes, marks the
transfer revoked, and tells every connected device.

  transmat rm 01JABCDEF...
  transmat ls --json | jq -r '.transfers[].transfer_id' | xargs transmat rm

Already-downloaded copies on other devices are not recalled — nothing can do
that. This stops anything that hasn't been fetched yet.

options:
  --json   print the result as JSON
`.trim(),
};

export async function run({ values, positionals }) {
  if (!positionals.length) throw usage('rm needs at least one transfer id', spec.usage);
  const config = requireSession();
  const api = new Api(config);

  const results = [];
  let failed = 0;

  for (const id of positionals) {
    try {
      await api.revokeTransfer(id);
      results.push({ transfer_id: id, ok: true });
      if (!values.json) out(`${color.green('✓')} revoked ${color.bold(id)}`);
    } catch (cause) {
      failed += 1;
      results.push({ transfer_id: id, ok: false, error: cause.message, code: cause.code });
      if (positionals.length === 1 && !values.json) throw cause;
      err(`${color.red('✗')} ${id}: ${cause.message}`);
    }
  }

  if (values.json) json({ ok: failed === 0, revoked: results });
  return failed ? EXIT.ERROR : EXIT.OK;
}
