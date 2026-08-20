import { useEffect, useMemo, useRef, useState } from 'react';
import TransferRow from './TransferRow.jsx';
import { IconSearch, IconInbox, IconPlug, IconAllDevices } from '../lib/icons.jsx';
import { direction, expiry } from '../lib/format.js';

const TABS = [
  { id: 'all', label: 'All' },
  { id: 'sent', label: 'Sent' },
  { id: 'received', label: 'Received' },
  { id: 'links', label: 'Links' },
  { id: 'expiring', label: 'Expiring' },
];

/**
 * Direction C — the stream. Filter row plus a dense chronological list of
 * everything that has moved.
 */
export default function Stream({ transfers, selfDeviceId, onOpen, onRevoke, error, onRetry, hasDevices, now, dialogOpen }) {
  const [tab, setTab] = useState('all');
  const [q, setQ] = useState('');
  const searchRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => {
      // Never reach past an open dialog — pulling focus to a control behind a
      // modal is how a keyboard user gets lost.
      if (dialogOpen) return;
      if (e.key.toLowerCase() === 'f' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialogOpen]);

  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    return transfers.filter((t) => {
      if (tab === 'links' && t.kind !== 'link') return false;
      if (tab === 'sent' && direction(t, selfDeviceId) !== 'out') return false;
      if (tab === 'received' && direction(t, selfDeviceId) !== 'in') return false;
      if (tab === 'expiring') {
        const e = expiry(t.expires_at, now);
        if (e.expired || !e.soon || t.state !== 'complete') return false;
      }
      if (term) {
        const hay = `${t.file_name || ''} ${t.text || ''} ${t.from_device_name || ''} ${(t.deliveries || [])
          .map((d) => d.device_name)
          .join(' ')}`.toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });
  }, [transfers, tab, q, selfDeviceId, now]);

  return (
    <>
      {error && (
        <div className="banner" data-testid="error-banner">
          <IconPlug size={16} stroke="#C98A72" />
          <span>
            {error.code === 'unauthorized'
              ? 'The server rejected that token.'
              : "Can't reach the server."}{' '}
            <code>{error.message}</code>
          </span>
          <span className="spacer" />
          <button type="button" onClick={onRetry}>Retry</button>
        </div>
      )}

      <div className="filters" role="tablist" aria-label="Filter transfers">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            className="filter-tab mono"
            aria-selected={tab === t.id}
            data-testid={`filter-${t.id}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
        <span className="spacer" />
        <label className="search">
          <IconSearch size={15} stroke="#6E7888" />
          <input
            ref={searchRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search"
            aria-label="Search transfers"
            data-testid="stream-search"
            spellCheck={false}
          />
          <span className="kbd">⌘F</span>
        </label>
      </div>

      <div className="stream" data-testid="stream">
        {shown.length > 0 ? (
          shown.map((t) => (
            <TransferRow
              key={t.transfer_id}
              transfer={t}
              selfDeviceId={selfDeviceId}
              onOpen={onOpen}
              onRevoke={onRevoke}
              now={now}
            />
          ))
        ) : transfers.length === 0 ? (
          <EmptyStream hasDevices={hasDevices} error={error} />
        ) : (
          <div className="empty" data-testid="empty-filter">
            <div className="glyph"><IconSearch size={20} stroke="#6E7888" /></div>
            <h2>Nothing here</h2>
            <p>
              No transfers match {q ? <>“{q}”</> : `the ${TABS.find((x) => x.id === tab).label.toLowerCase()} filter`}.
            </p>
          </div>
        )}
      </div>
    </>
  );
}

function EmptyStream({ hasDevices, error }) {
  if (error) {
    return (
      <div className="empty" data-testid="empty-error">
        <div className="glyph"><IconPlug size={20} stroke="#C98A72" /></div>
        <h2>Nothing to show while the server is unreachable</h2>
        <p>
          Start it with <span className="mono">npm run dev</span> in <span className="mono">server/</span>, then hit
          Retry. Check the URL and token in settings if it keeps failing.
        </p>
      </div>
    );
  }
  if (!hasDevices) {
    return (
      <div className="empty" data-testid="empty-first-run">
        <div className="glyph"><IconAllDevices size={20} stroke="#9C8CF5" /></div>
        <h2>This browser is your first device</h2>
        <p>
          It is registered and listening. Add a second one — the CLI, or the Shortcut on your phone — and things
          you send will land here as they arrive.
        </p>
        <p className="mono">⌘K to send · ⌘, for settings</p>
      </div>
    );
  }
  return (
    <div className="empty" data-testid="empty-stream">
      <div className="glyph"><IconInbox size={20} stroke="#6E7888" /></div>
      <h2>Nothing has moved yet</h2>
      <p>Drop a file above, paste a link, or hit ⌘K. Everything you send or receive shows up here.</p>
    </div>
  );
}
