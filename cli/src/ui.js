/**
 * Terminal output: colour, tables, sizes, relative times, progress bars.
 *
 * Two rules hold the whole file together:
 *  - data goes to stdout, chatter and progress go to stderr, so `--json` output
 *    stays pipe-clean even while a 400 MB upload is drawing a bar;
 *  - colour and progress only happen on a TTY, and never when NO_COLOR is set.
 */

const ESC = '[';

const colorEnabled =
  !process.env.NO_COLOR &&
  process.env.TERM !== 'dumb' &&
  (Boolean(process.stdout.isTTY) || Boolean(process.stderr.isTTY));

const wrap = (open, close) => (s) =>
  colorEnabled ? `${ESC}${open}m${s}${ESC}${close}m` : String(s);

export const color = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

export function out(line = '') {
  process.stdout.write(`${line}\n`);
}

export function err(line = '') {
  process.stderr.write(`${line}\n`);
}

export function json(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/* ------------------------------------------------------------------ format */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** @param {number|null|undefined} bytes */
export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || Number.isNaN(Number(bytes))) return '—';
  let n = Number(bytes);
  if (n < 1024) return `${n} B`;
  let i = 0;
  while (n >= 1024 && i < UNITS.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${UNITS[i]}`;
}

/** "3s ago", "5m ago", "2d ago" — and "in 6d" for things in the future. */
export function formatRelative(iso, now = Date.now()) {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return String(iso);
  const deltaSec = Math.round((now - t) / 1000);
  const abs = Math.abs(deltaSec);
  if (abs < 5) return deltaSec >= 0 ? 'just now' : 'now';
  const spans = [
    [60, 1, 's'],
    [3600, 60, 'm'],
    [86400, 3600, 'h'],
    [2592000, 86400, 'd'],
  ];
  let text = `${Math.round(abs / 2592000)}mo`;
  for (const [limit, divisor, suffix] of spans) {
    if (abs < limit) {
      text = `${Math.max(0, Math.floor(abs / divisor))}${suffix}`;
      break;
    }
  }
  return deltaSec >= 0 ? `${text} ago` : `in ${text}`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

/* ------------------------------------------------------------------- table */

const ANSI_RE = new RegExp(`${ESC.replace('[', '\\[')}[0-9;]*m`, 'g');

/** Visible width, ignoring the ANSI escapes we may have added. */
const visibleWidth = (s) => String(s).replace(ANSI_RE, '').length;

function pad(cell, width, align) {
  const gap = Math.max(0, width - visibleWidth(cell));
  return align === 'right' ? ' '.repeat(gap) + cell : cell + ' '.repeat(gap);
}

/**
 * @param {Array<{key:string,label:string,align?:'left'|'right'}>} columns
 * @param {Array<Record<string,string>>} rows
 */
export function table(columns, rows) {
  if (!rows.length) return '';
  const widths = columns.map((col) =>
    Math.max(visibleWidth(col.label), ...rows.map((row) => visibleWidth(row[col.key] ?? ''))),
  );
  const header = columns
    .map((col, i) => color.dim(pad(col.label.toUpperCase(), widths[i], col.align)))
    .join('  ')
    .trimEnd();
  const body = rows.map((row) =>
    columns
      .map((col, i) => pad(row[col.key] ?? '', widths[i], col.align))
      .join('  ')
      .trimEnd(),
  );
  return [header, ...body].join('\n');
}

/* ---------------------------------------------------------------- progress */

/** Below this, a progress bar is just flicker. */
export const PROGRESS_THRESHOLD_BYTES = 512 * 1024;

const CLEAR_LINE = `\r${ESC}2K`;

/**
 * A single-line progress bar on stderr. `total` may be null (a stream of
 * unknown length, e.g. stdin), in which case it counts bytes instead of
 * drawing a bar.
 *
 * @param {string} label
 * @param {number|null} total
 * @param {object} [options]
 * @param {boolean} [options.enabled] force on/off (tests, --no-progress)
 */
export function progress(label, total, { enabled } = {}) {
  const active =
    enabled ??
    (Boolean(process.stderr.isTTY) && (total === null || total >= PROGRESS_THRESHOLD_BYTES));
  const started = Date.now();
  let lastRender = 0;
  let done = 0;

  const render = (final = false) => {
    if (!active) return;
    const now = Date.now();
    if (!final && now - lastRender < 80) return;
    lastRender = now;
    const elapsed = Math.max(0.001, (now - started) / 1000);
    const rate = done / elapsed;
    const speed = `${formatBytes(rate)}/s`;
    let line;
    if (total && total > 0) {
      const ratio = Math.min(1, done / total);
      const width = Math.max(10, Math.min(28, (process.stderr.columns || 80) - 46));
      const filled = Math.round(ratio * width);
      const bar = `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
      const eta = final ? formatDuration(elapsed) : formatDuration((total - done) / (rate || 1));
      line =
        `${label} ${bar} ${String(Math.round(ratio * 100)).padStart(3)}%  ` +
        `${formatBytes(done)}/${formatBytes(total)}  ${speed}  ${final ? 'in' : 'eta'} ${eta}`;
    } else {
      line = `${label} ${formatBytes(done)}  ${speed}  ${formatDuration(elapsed)}`;
    }
    process.stderr.write(`${CLEAR_LINE}${color.dim(line)}`);
  };

  return {
    get active() {
      return active;
    },
    get bytes() {
      return done;
    },
    /** @param {number} n bytes since the last call */
    tick(n) {
      done += n;
      render(false);
    },
    /** Erase the bar; the command prints its own summary line afterwards. */
    finish() {
      if (!active) return;
      render(true);
      process.stderr.write(CLEAR_LINE);
    },
  };
}
