/**
 * transmat send <path...> [--to …] [--expires …] [--text …] [--link …]
 *
 * One transfer per file, streamed as multipart/form-data — the same endpoint
 * the iOS Shortcut posts to. Nothing is buffered: a 2 GB file costs one chunk
 * of memory and draws a progress bar while it goes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Api } from '../api.js';
import { requireSession } from '../config.js';
import { CliError, EXIT, usage } from '../errors.js';
import { guessMimeType, safeFileName } from '../files.js';
import { color, err, formatBytes, json, out, progress } from '../ui.js';

export const spec = {
  name: 'send',
  summary: 'send files, text, or a link to your other devices',
  usage: 'transmat send <path...> [--to <device>] [--expires <days>]',
  options: {
    to: { type: 'string', multiple: true },
    expires: { type: 'string' },
    text: { type: 'string' },
    link: { type: 'string' },
    name: { type: 'string' },
    quiet: { type: 'boolean', short: 'q', default: false },
  },
  help: `
Send one or more files (or a snippet of text, or a link) to your devices.

  transmat send report.pdf
  transmat send *.png --to "Kirby's iPhone"
  transmat send big.zip --to all --expires 30
  transmat send --text "the wifi password is hunter2"
  transmat send --link https://example.com/thing
  pg_dump mydb | gzip | transmat send - --name db.sql.gz

arguments:
  <path...>            files to send. "-" reads stdin (name it with --name)

options:
      --to <target>    a device name, a device_id, "all", or "others".
                       Repeatable, or comma-separated.
                       Default: others (every device but this one)
      --expires <days> 1-30, default 7
      --text <string>  send text instead of a file (clipboard-style)
      --link <url>     send a URL instead of a file
      --name <name>    display filename; required for stdin, and applies to a
                       single file only
  -q, --quiet          no progress bar
      --json           print the created transfers as JSON
`.trim(),
};

const CHUNK_SIZE = 64 * 1024;

export async function run({ values, positionals }) {
  const config = requireSession();
  const api = new Api(config);

  const hasInline = values.text !== undefined || values.link !== undefined;
  if (values.text !== undefined && values.link !== undefined) {
    throw usage('use --text or --link, not both');
  }
  if (hasInline && positionals.length) {
    throw usage('--text/--link send a payload of their own; drop the file arguments');
  }
  if (!hasInline && !positionals.length) {
    throw usage('send needs at least one file (or --text / --link)', spec.usage);
  }
  if (values.name && positionals.length > 1) {
    throw usage('--name applies to a single file; send them one at a time to rename');
  }

  const expiresInDays = parseExpires(values.expires);
  const targets = await resolveTargets(api, values.to, config);

  const results = [];
  let failed = 0;

  if (hasInline) {
    const isLink = values.link !== undefined;
    const payload = isLink ? values.link : values.text;
    if (!String(payload ?? '').length) throw usage(`--${isLink ? 'link' : 'text'} needs a value`);
    if (isLink && !/^https?:\/\//i.test(payload)) {
      throw usage(`--link needs an http(s) URL (got "${payload}")`);
    }
    const transfer = await api.createTextTransfer({
      kind: isLink ? 'link' : 'text',
      text: payload,
      to: targets,
      from: config.device_id,
      expires_in_days: expiresInDays,
    });
    results.push({ ok: true, transfer });
    if (!values.json) printInlineSent(transfer);
  } else {
    for (const target of positionals) {
      try {
        const transfer = await sendOnePath(api, target, {
          targets,
          from: config.device_id,
          expiresInDays,
          name: values.name,
          quiet: values.quiet,
          json: values.json,
        });
        results.push(transfer);
        if (!values.json) printFileSent(transfer);
      } catch (cause) {
        failed += 1;
        if (positionals.length === 1) throw cause;
        err(`${color.red('✗')} ${target}: ${cause.message}`);
        results.push({ ok: false, path: target, error: cause.message });
      }
    }
  }

  if (values.json) json({ ok: failed === 0, sent: results });
  return failed ? EXIT.ERROR : EXIT.OK;
}

/* --------------------------------------------------------------- one file */

async function sendOnePath(api, filePath, options) {
  const fromStdin = filePath === '-';

  let size = null;
  let displayName;
  let stream;

  if (fromStdin) {
    displayName = safeFileName(options.name ?? 'stdin.bin', 'stdin.bin');
    if (process.stdin.isTTY) {
      err(color.dim('reading from stdin — end with ctrl-D'));
    }
    stream = process.stdin;
  } else {
    const resolved = path.resolve(filePath);
    let stat;
    try {
      stat = fs.statSync(resolved);
    } catch (cause) {
      if (cause.code === 'ENOENT') {
        throw new CliError(`no such file: ${filePath}`, { exitCode: EXIT.NOT_FOUND, cause });
      }
      if (cause.code === 'EACCES') {
        throw new CliError(`permission denied reading ${filePath}`, { cause });
      }
      throw new CliError(`could not read ${filePath}: ${cause.message}`, { cause });
    }
    if (stat.isDirectory()) {
      throw new CliError(`${filePath} is a directory`, {
        hint: `send an archive instead: tar czf - ${filePath} | transmat send - --name ${path.basename(resolved)}.tar.gz`,
      });
    }
    if (!stat.isFile()) throw new CliError(`${filePath} is not a regular file`);
    size = stat.size;
    displayName = safeFileName(options.name ?? path.basename(resolved), 'file.bin');
    stream = fs.createReadStream(resolved, { highWaterMark: CHUNK_SIZE });
  }

  const bar = progress(
    `${color.cyan('↑')} ${displayName}`,
    size,
    options.quiet || options.json ? { enabled: false } : {},
  );
  const hash = createHash('sha256');
  let bytes = 0;

  const counted = (async function* () {
    for await (const chunk of stream) {
      const view = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      hash.update(view);
      bytes += view.byteLength;
      yield view;
    }
  })();

  const fields = [['name', displayName]];
  for (const target of options.targets) fields.push(['to', target]);
  if (options.from) fields.push(['from', options.from]);
  if (options.expiresInDays) fields.push(['expires_in_days', String(options.expiresInDays)]);

  try {
    const transfer = await api.createFileTransfer({
      fields,
      file: {
        filename: displayName,
        contentType: guessMimeType(displayName),
        stream: counted,
      },
      onProgress: (n) => bar.tick(n),
    });
    bar.finish();
    return { ok: true, path: fromStdin ? '-' : filePath, bytes, sha256: hash.digest('hex'), transfer };
  } catch (cause) {
    bar.finish();
    throw cause;
  }
}

/* ---------------------------------------------------------------- targets */

/**
 * Turn what the user typed into what the contract accepts: "all", "others",
 * or a device_id. Device *names* are resolved here so nobody has to paste a
 * UUID to send a file to their phone.
 */
export async function resolveTargets(api, requested, config) {
  const wanted = (requested ?? []).flatMap((v) => String(v).split(',')).map((v) => v.trim()).filter(Boolean);
  if (!wanted.length) return ['others'];

  const keywords = new Set(['all', 'others']);
  const needsLookup = wanted.some((w) => !keywords.has(w.toLowerCase()));
  const devices = needsLookup ? await api.listDevices() : [];

  const resolved = [];
  for (const raw of wanted) {
    const lower = raw.toLowerCase();
    if (keywords.has(lower)) {
      resolved.push(lower);
      continue;
    }
    const byId = devices.find((d) => d.device_id === raw);
    if (byId) {
      resolved.push(byId.device_id);
      continue;
    }
    const byName = devices.filter((d) => d.name.toLowerCase() === lower);
    const byPrefix = byName.length
      ? byName
      : devices.filter((d) => d.name.toLowerCase().startsWith(lower));
    if (byPrefix.length === 1) {
      resolved.push(byPrefix[0].device_id);
      continue;
    }
    if (byPrefix.length > 1) {
      throw new CliError(
        `"${raw}" matches ${byPrefix.length} devices: ${byPrefix.map((d) => d.name).join(', ')}`,
        { exitCode: EXIT.USAGE, hint: 'use the full name or the device_id — see `transmat devices`' },
      );
    }
    throw new CliError(`no device named "${raw}"`, {
      exitCode: EXIT.NOT_FOUND,
      hint: devices.length
        ? `known devices: ${devices.map((d) => d.name).join(', ')}`
        : 'no devices are registered yet — run `transmat register`',
    });
  }

  if (config?.device_id && resolved.length === 1 && resolved[0] === config.device_id) {
    err(color.dim('note: sending to this machine — `transmat watch` here will download it'));
  }
  return [...new Set(resolved)];
}

function parseExpires(value) {
  if (value === undefined) return undefined;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > 30) {
    throw usage(`--expires must be a whole number of days between 1 and 30 (got "${value}")`);
  }
  return days;
}

/* ----------------------------------------------------------------- output */

function recipients(transfer) {
  const names = (transfer?.deliveries ?? []).map((d) => d.device_name || d.device_id);
  if (!names.length) return 'nobody';
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 2).join(', ')} +${names.length - 2} more`;
}

function printFileSent(result) {
  const t = result.transfer;
  out(
    `${color.green('✓')} sent ${color.bold(t.file_name ?? result.path)} ` +
      `${color.dim(`(${formatBytes(t.size ?? result.bytes)})`)} → ${color.bold(recipients(t))}`,
  );
  out(color.dim(`  ${t.transfer_id} · expires ${new Date(t.expires_at).toLocaleString()}`));
}

function printInlineSent(t) {
  const preview = (t.text ?? '').replace(/\s+/g, ' ').slice(0, 60);
  out(
    `${color.green('✓')} sent ${color.bold(t.kind)} ${color.dim(`"${preview}${(t.text ?? '').length > 60 ? '…' : ''}"`)} → ${color.bold(recipients(t))}`,
  );
  out(color.dim(`  ${t.transfer_id}`));
}
