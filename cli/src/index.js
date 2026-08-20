#!/usr/bin/env node
/**
 * transmat — the CLI.
 *
 * This file does three things and nothing else: parse argv, dispatch to a
 * command, and turn whatever comes back (a value or a thrown CliError) into
 * an exit code and at most two lines of explanation.
 */
import { parseArgs } from 'node:util';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CliError, EXIT } from './errors.js';
import { color, err, out } from './ui.js';

import * as login from './commands/login.js';
import * as register from './commands/register.js';
import * as devices from './commands/devices.js';
import * as send from './commands/send.js';
import * as watch from './commands/watch.js';
import * as ls from './commands/ls.js';
import * as rm from './commands/rm.js';
import * as status from './commands/status.js';

const MODULES = [login, register, devices, send, watch, ls, rm, status];

/** @type {Map<string, typeof login>} */
const COMMANDS = new Map();
for (const mod of MODULES) {
  COMMANDS.set(mod.spec.name, mod);
  for (const alias of mod.spec.aliases ?? []) COMMANDS.set(alias, mod);
}

/** Options every command understands. */
const GLOBAL_OPTIONS = {
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', short: 'V', default: false },
  json: { type: 'boolean', default: false },
  'no-color': { type: 'boolean', default: false },
};

function version() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  try {
    return JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

function topHelp() {
  const width = Math.max(...MODULES.map((m) => m.spec.name.length));
  const lines = MODULES.map(
    (m) => `  ${m.spec.name.padEnd(width)}  ${m.spec.summary}`,
  );
  return `
${color.bold('transmat')} — move files between your devices

usage: transmat <command> [options]

commands:
${lines.join('\n')}

global options:
  -h, --help       this help, or help for a command: transmat send --help
  -V, --version    print the version
      --json       machine-readable output (read commands)
      --no-color   plain text, no ANSI

getting started:
  transmat login http://localhost:8787 <token>
  transmat register
  transmat watch &
  transmat send ~/Downloads/report.pdf --to "Kirby's iPhone"

exit codes: 0 ok · 1 error · 2 usage · 3 not logged in · 4 bad token ·
            5 server unreachable · 6 not found
`.trim();
}

export async function main(argv = process.argv.slice(2)) {
  // --no-color has to take effect before anything is rendered, and ui.js reads
  // the environment at import time — so translate it into NO_COLOR immediately.
  if (argv.includes('--no-color')) process.env.NO_COLOR = '1';

  const first = argv.find((a) => !a.startsWith('-'));
  const wantsHelp = argv.includes('--help') || argv.includes('-h');

  if (argv.includes('--version') || argv.includes('-V')) {
    out(version());
    return EXIT.OK;
  }

  if (!first) {
    // `transmat --help` asked for this; a bare `transmat` did not, so that one
    // is a usage error even though the output is identical.
    out(topHelp());
    return wantsHelp ? EXIT.OK : EXIT.USAGE;
  }

  if (first === 'help') {
    const topic = argv.filter((a) => !a.startsWith('-'))[1];
    if (!topic) {
      out(topHelp());
      return EXIT.OK;
    }
    const mod = COMMANDS.get(topic);
    if (!mod) throw unknownCommand(topic);
    out(mod.spec.help);
    return EXIT.OK;
  }

  const mod = COMMANDS.get(first);
  if (!mod) throw unknownCommand(first);

  if (wantsHelp) {
    out(mod.spec.help);
    return EXIT.OK;
  }

  const rest = argv.slice(argv.indexOf(first) + 1);
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: { ...GLOBAL_OPTIONS, ...(mod.spec.options ?? {}) },
      allowPositionals: true,
      strict: true,
    });
  } catch (cause) {
    throw parseError(cause, mod);
  }

  return (await mod.run(parsed)) ?? EXIT.OK;
}

function unknownCommand(name) {
  const known = [...new Set([...COMMANDS.keys()])];
  const near = known.filter((c) => c.startsWith(name[0]) || name.startsWith(c[0]));
  return new CliError(`unknown command "${name}"`, {
    exitCode: EXIT.USAGE,
    hint: near.length ? `did you mean: ${near.join(', ')}?  (transmat --help)` : 'transmat --help',
  });
}

function parseError(cause, mod) {
  const message = String(cause?.message ?? cause).replace(/\s+/g, ' ');
  return new CliError(message, {
    exitCode: EXIT.USAGE,
    hint: `${mod.spec.usage}   (transmat ${mod.spec.name} --help)`,
    cause,
  });
}

/* ---------------------------------------------------------------- runtime */

/**
 * True when this file *is* the program being run. realpath matters: `npm link`
 * installs `transmat` as a symlink, and a naive argv[1] comparison would make
 * the linked binary a silent no-op.
 */
const isEntry = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === import.meta.filename;
  } catch {
    return false;
  }
})();

if (isEntry) {
  // `transmat ls | head -1` closes our stdout; that's not an error worth a stack.
  process.stdout.on('error', (e) => {
    if (e.code === 'EPIPE') process.exit(EXIT.OK);
  });

  main()
    .then((code) => {
      process.exitCode = code ?? EXIT.OK;
    })
    .catch((error) => {
      if (error instanceof CliError) {
        err(`${color.red('error:')} ${error.message}`);
        if (error.hint) err(color.dim(`  ${error.hint}`));
        process.exitCode = error.exitCode;
      } else if (error?.name === 'AbortError') {
        process.exitCode = EXIT.OK;
      } else {
        err(`${color.red('error:')} ${error?.message ?? error}`);
        if (process.env.TRANSMAT_DEBUG) err(String(error?.stack ?? ''));
        else err(color.dim('  run again with TRANSMAT_DEBUG=1 for a stack trace'));
        process.exitCode = EXIT.ERROR;
      }
    });
}
