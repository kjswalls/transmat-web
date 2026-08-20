import { kindIcon, IconX, IconSend } from '../lib/icons.jsx';
import { bytes, relativeTime, expiry, transferTitle, counterparty, direction } from '../lib/format.js';

/**
 * One line in the stream: icon by kind, name, from/to, relative time or expiry
 * countdown, and state. Clicking a file downloads it; clicking text copies it.
 *
 * The row and the revoke control are SIBLINGS inside `.row-wrap`, never nested
 * — a button inside a button is invalid, and a `role="button"` span with
 * tabIndex -1 makes a destructive action mouse-only.
 */
export default function TransferRow({ transfer: t, selfDeviceId, onOpen, onRevoke, now }) {
  const deliveries = t.deliveries || [];
  const dir = direction(t, selfDeviceId);
  const sending = typeof t._sending === 'number';
  const dead = t.state === 'expired' || t.state === 'revoked';
  const exp = expiry(t.expires_at, now);
  const Glyph = sending ? IconSend : kindIcon(t);
  const arriving =
    !sending && dir === 'in' && deliveries.some((d) => d.device_id === selfDeviceId && d.state !== 'downloaded');

  const glyphColor = dead ? '#6E7888' : sending ? '#9C8CF5' : arriving ? '#55C9A2' : '#A3ACBB';

  let right = { text: relativeTime(t.created_at, now), cls: '' };
  if (sending) right = { text: `sending ${Math.round(t._sending * 100)}%`, cls: 'live' };
  else if (t.state === 'revoked') right = { text: 'revoked', cls: '' };
  else if (t.state === 'expired' || exp.expired) right = { text: 'expired', cls: '' };
  else if (exp.soon) right = { text: exp.label, cls: 'soon' };

  const hint = dead ? null : t.kind === 'file' ? 'download' : 'copy';
  const title = transferTitle(t);
  const who = counterparty(t, selfDeviceId);
  const size = t.size != null ? `, ${bytes(t.size)}` : '';
  // Read out as one sentence rather than as four stray fragments.
  const label = `${title}, ${who}${size}, ${right.text}${hint ? `. Activate to ${hint}.` : ''}`;

  return (
    <div
      className={`row-wrap${sending ? ' fresh outgoing-live' : ''}${arriving ? ' unread' : ''}${dead ? ' dead' : ''}`}
      data-testid="transfer-row-wrap"
    >
      <button
        type="button"
        className="row"
        data-testid="transfer-row"
        data-kind={t.kind}
        data-direction={dir}
        aria-label={label}
        // aria-disabled, not disabled: an expired row still has to be readable
        // and reachable with Tab, it just has nothing to activate.
        aria-disabled={dead || undefined}
        onClick={() => !dead && onOpen(t)}
        title={t.text || t.file_name || ''}
      >
        <span className="row-icon"><Glyph size={14} stroke={glyphColor} /></span>
        <span className="row-name">{title}</span>

        {sending ? (
          <span className="progress out"><i style={{ width: `${Math.max(4, t._sending * 100)}%` }} /></span>
        ) : (
          <span className="row-mid">
            <span className="row-who">{who}</span>
            {t.size != null && <span className="row-size">{`\u00b7 ${bytes(t.size)}`}</span>}
          </span>
        )}

        {hint && <span className="row-hint mono" aria-hidden="true">{hint}</span>}
        <span className={`row-right mono ${right.cls}`} aria-hidden="true">{right.text}</span>
      </button>

      {!dead && dir === 'out' && (
        <button
          type="button"
          className="icon-btn revoke"
          aria-label={`Revoke ${title} — deletes the bytes`}
          title="Revoke — deletes the bytes"
          onClick={() => onRevoke(t)}
        >
          <IconX size={13} />
        </button>
      )}
    </div>
  );
}
