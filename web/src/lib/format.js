/** Formatting helpers. Everything technical renders in IBM Plex Mono. */

const KB = 1024, MB = KB * 1024, GB = MB * 1024;

/** @param {number|null|undefined} n */
export function bytes(n) {
  if (n == null) return '';
  if (n < KB) return `${n} B`;
  if (n < MB) return `${(n / KB).toFixed(n < 10 * KB ? 1 : 0)} KB`;
  if (n < GB) return `${(n / MB).toFixed(n < 10 * MB ? 1 : 0)} MB`;
  return `${(n / GB).toFixed(1)} GB`;
}

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

/** "now" · "4m ago" · "5h ago" · "yesterday" · "3d ago" · "12 Jun" */
export function relativeTime(isoString, now = Date.now()) {
  const t = Date.parse(isoString);
  if (Number.isNaN(t)) return '';
  const d = now - t;
  if (d < 45_000) return 'now';
  if (d < HOUR) return `${Math.round(d / MIN)}m ago`;
  if (d < DAY) return `${Math.round(d / HOUR)}h ago`;
  if (d < 2 * DAY) return 'yesterday';
  if (d < 7 * DAY) return `${Math.floor(d / DAY)}d ago`;
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/**
 * Countdown to expiry.
 * @returns {{label: string, soon: boolean, expired: boolean, ms: number}}
 */
export function expiry(isoString, now = Date.now()) {
  const t = Date.parse(isoString);
  if (Number.isNaN(t)) return { label: '', soon: false, expired: false, ms: 0 };
  const ms = t - now;
  if (ms <= 0) return { label: 'expired', soon: false, expired: true, ms };
  if (ms < HOUR) return { label: `${Math.max(1, Math.round(ms / MIN))}m left`, soon: true, expired: false, ms };
  if (ms < DAY) return { label: `${Math.round(ms / HOUR)}h left`, soon: true, expired: false, ms };
  const days = Math.floor(ms / DAY);
  return { label: `${days}d left`, soon: days < 3, expired: false, ms };
}

/** Human name for a transfer row. */
export function transferTitle(t) {
  if (t.kind === 'file') return t.file_name || 'file';
  if (t.kind === 'link') return prettyUrl(t.text || '');
  return (t.text || '').split('\n')[0] || 'note';
}

const clip = (s, n = 34) => (s.length > n ? `${s.slice(0, n - 1)}\u2026` : s);

/**
 * Display form of a link. Only http(s) get the friendly host+path treatment —
 * anything else keeps its scheme, verbatim and visible.
 *
 * Dropping the scheme off `javascript:alert(1)` or `data:text/html,<script>…`
 * renders a hostile payload as an innocuous-looking link. Nothing here ever
 * becomes an href, but a row must not disguise what it is holding.
 */
export function prettyUrl(raw) {
  const s = (raw || '').trim();
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return clip(s);
    const tail = (u.pathname + u.search).replace(/\/$/, '');
    return clip(u.host.replace(/^www\./, '') + tail);
  } catch {
    return clip(s);
  }
}

export function isUrl(s) {
  return /^https?:\/\/\S+$/i.test((s || '').trim());
}

/**
 * Direction of a transfer relative to this browser's registered device.
 * 'out'   — we sent it
 * 'in'    — we are a recipient
 * 'other' — it moved between two of the account's other devices
 * @returns {'out'|'in'|'other'}
 */
export function direction(t, selfDeviceId) {
  if (!selfDeviceId) return t.from_device_id ? 'other' : 'out';
  if (t.from_device_id === selfDeviceId) return 'out';
  if ((t.deliveries || []).some((d) => d.device_id === selfDeviceId)) return 'in';
  return 'other';
}

/** "to iPhone" / "to all my devices" / "from Sam Okafor" / "iPad → MacBook Pro" */
export function counterparty(t, selfDeviceId) {
  const dir = direction(t, selfDeviceId);
  const names = (t.deliveries || []).map((d) => d.device_name).filter(Boolean);
  const to =
    names.length === 0 ? 'no one' :
    names.length === 1 ? names[0] :
    names.length === 2 ? names.join(' + ') :
    'All my devices';  // matches the command-bar row and Stream.dc.html
  if (dir === 'out') return `to ${to}`;
  if (dir === 'in') return t.from_device_name ? `from ${t.from_device_name}` : 'received';
  return `${t.from_device_name || 'somewhere'} \u2192 ${to}`;
}

export function initials(name) {
  return (name || '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}

export function platformLabel(p) {
  return { ios: 'iOS', android: 'Android', macos: 'macOS', web: 'Web', cli: 'CLI' }[p] || p;
}
