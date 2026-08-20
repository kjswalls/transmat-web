/**
 * transmat login <url> <token>
 *
 * Writes ~/.config/transmat/config.json at 0600. The token is never echoed —
 * not on success, not in an error, not in --json output.
 */
import { Api } from '../api.js';
import { configPath, normalizeUrl, readConfigFile, writeConfigFile } from '../config.js';
import { CliError, EXIT, usage } from '../errors.js';
import { color, err, json, out } from '../ui.js';

export const spec = {
  name: 'login',
  summary: 'save the server URL and access token',
  usage: 'transmat login <url> <token>',
  options: {
    'no-verify': { type: 'boolean', default: false },
  },
  help: `
Store the server URL and access token for this machine.

  transmat login http://localhost:8787 dev-token-change-me
  transmat login https://transmat.example.com < token.txt

The token is written to ${configPath()} with 0600 permissions and is never
printed back to the terminal. If the token argument is omitted and stdin is a
pipe, the token is read from stdin.

Passing the token as an argument puts it in this process's command line, which
on a shared machine is readable by other users (ps, /proc/<pid>/cmdline) for as
long as the command runs — and in your shell history afterwards. Prefer the
stdin form above, or set TRANSMAT_URL and TRANSMAT_TOKEN and skip login.

options:
  --no-verify   don't call the server to check the URL and token first
  --json        print the result as JSON
`.trim(),
};

export async function run({ values, positionals }) {
  const [rawUrl] = positionals;
  if (!rawUrl) throw usage('login needs a server URL', spec.usage);

  const url = normalizeUrl(rawUrl);
  const token = positionals[1] ?? (await readTokenFromStdin());
  if (!token) {
    throw usage('login needs an access token', 'transmat login <url> <token>');
  }
  if (positionals.length > 2) {
    throw usage(
      'too many arguments — a token containing spaces must be quoted',
      spec.usage,
    );
  }

  const api = new Api({ url, token });
  let health = null;

  if (!values['no-verify']) {
    health = await api.health().catch((cause) => {
      if (cause instanceof CliError && cause.exitCode === EXIT.NETWORK) {
        throw new CliError(cause.message, {
          exitCode: EXIT.NETWORK,
          hint: 'nothing was saved. Start the server, or pass --no-verify to save anyway.',
          cause,
        });
      }
      throw cause;
    });
    // /health needs no auth, so it proves the URL but not the token. This does.
    await api.listDevices();
  }

  const previous = readConfigFile() ?? {};
  const sameServer = normalizeUrl(previous.url ?? '') === url;
  const config = {
    url,
    token,
    // A device_id is meaningful only on the server that issued it.
    device_id: sameServer ? previous.device_id : undefined,
    device_name: sameServer ? previous.device_name : undefined,
    download_dir: previous.download_dir,
  };
  const file = writeConfigFile(config);

  if (values.json) {
    json({
      ok: true,
      url,
      config_path: file,
      verified: !values['no-verify'],
      device_id: config.device_id ?? null,
      health,
    });
    return EXIT.OK;
  }

  out(`${color.green('✓')} logged in to ${color.bold(url)}`);
  if (health) {
    out(
      color.dim(
        `  storage ${health.storage} · push ${health.push} · server ${health.version ?? '?'}`,
      ),
    );
  }
  out(color.dim(`  token saved to ${file} (0600)`));
  if (previous.device_id && !sameServer) {
    err(color.yellow('  note: server changed, so the old device registration was cleared'));
  }
  if (!config.device_id) out(color.dim('  next: transmat register'));
  return EXIT.OK;
}

/** How long to wait for a token on stdin before deciding nobody is sending one. */
const STDIN_TOKEN_TIMEOUT_MS = Number(process.env.TRANSMAT_STDIN_TIMEOUT_MS) || 30_000;

/**
 * Only when stdin is a pipe: `transmat login <url> < token.txt`.
 *
 * Say so, and give up eventually. Inherited-but-never-closed stdin is normal
 * under systemd, cron and CI, and without both of these `transmat login <url>`
 * sits there silently forever looking like a crash.
 */
async function readTokenFromStdin() {
  if (process.stdin.isTTY) return null;
  err(color.dim('reading the token from stdin…'));

  const chunks = [];
  const timer = setTimeout(() => process.stdin.destroy(new Error('timeout')), STDIN_TOKEN_TIMEOUT_MS);
  timer.unref?.();
  try {
    for await (const chunk of process.stdin) chunks.push(chunk);
  } catch {
    throw usage(
      `no token arrived on stdin within ${STDIN_TOKEN_TIMEOUT_MS / 1000}s`,
      'pass it as an argument, pipe it in (`… < token.txt`), or set TRANSMAT_TOKEN',
    );
  } finally {
    clearTimeout(timer);
  }
  return Buffer.concat(chunks).toString('utf8').trim() || null;
}
