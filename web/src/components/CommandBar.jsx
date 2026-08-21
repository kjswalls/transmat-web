import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  IconSearch, IconCheck, IconClock, IconAllDevices, IconText, IconLink, IconX,
  kindIcon, platformIcon,
} from '../lib/icons.jsx';
import { bytes, relativeTime, initials, isUrl, prettyUrl } from '../lib/format.js';

const RETENTIONS = [1, 7, 30];

/**
 * Direction A — the command bar.
 * Summoned with ⌘K. Carries whatever you are sending; you only choose where.
 * Fully keyboard driven, focus trapped while open.
 */
export default function CommandBar({
  open, onClose, payload, onPickFile, onClearPayload, onPayloadText,
  devices, selfDeviceId, onSend, days, setDays,
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [active, setActive] = useState(0);
  const [sending, setSending] = useState(false);
  const inputRef = useRef(null);
  const noteRef = useRef(null);
  const listRef = useRef(null);
  const barRef = useRef(null);

  const others = useMemo(() => devices.filter((d) => d.device_id !== selfDeviceId), [devices, selfDeviceId]);

  /** Selectable rows, in visual order. */
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (s) => !q || s.toLowerCase().includes(q);
    const out = [];
    for (const d of others) {
      if (match(d.name) || match(d.platform)) out.push({ type: 'device', id: d.device_id, device: d });
    }
    if (others.length && match('all my devices')) {
      out.push({ type: 'all', id: selfDeviceId ? 'others' : 'all', count: others.length });
    }
    return out;
  }, [others, query, selfDeviceId]);

  useEffect(() => { setActive(0); }, [query]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelected(new Set());
    setActive(0);
    setSending(false);
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  // Scroll the active row into view.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector('[data-active="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, open, rows.length]);

  const toggle = useCallback((id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const submit = useCallback(async () => {
    let targets = [...selected];
    if (!targets.length && rows[active]) targets = [rows[active].id];
    if (!targets.length) return;
    const hasPayload = payload.file || (payload.text ?? '').trim();
    if (!hasPayload) { noteRef.current?.focus(); return; }
    setSending(true);
    try {
      await onSend({ file: payload.file, text: payload.text, targets, expiresInDays: days });
      onClose();
    } catch {
      setSending(false);
    }
  }, [selected, rows, active, payload, days, onSend, onClose]);

  const onKeyDown = useCallback(
    (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((a) => (rows.length ? (a + 1) % rows.length : 0));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => (rows.length ? (a - 1 + rows.length) % rows.length : 0));
        return;
      }
      if (e.key === 'Tab') {
        // "⇥ Add another" — toggle the active row and step on. Focus never leaves the bar.
        e.preventDefault();
        if (!rows.length) return;
        toggle(rows[active].id);
        setActive((a) => (e.shiftKey ? (a - 1 + rows.length) % rows.length : (a + 1) % rows.length));
        return;
      }
      if (e.key === 'Enter') { e.preventDefault(); submit(); return; }
      if (e.key.toLowerCase() === 'e' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        setDays(RETENTIONS[(RETENTIONS.indexOf(days) + 1) % RETENTIONS.length]);
        return;
      }
      if (e.key.toLowerCase() === 'u' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onPickFile();
      }
    },
    [rows, active, toggle, submit, onClose, days, setDays, onPickFile],
  );

  if (!open) return null;

  const cycleDays = () => setDays(RETENTIONS[(RETENTIONS.indexOf(days) + 1) % RETENTIONS.length]);

  return (
    <div
      className="scrim"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      data-testid="scrim"
    >
      <div
        className="cmdbar"
        role="dialog"
        aria-modal="true"
        aria-label="Send with Transmat"
        ref={barRef}
        onKeyDown={onKeyDown}
        data-testid="command-bar"
        // Focus trap: anything that escapes the bar bounces back to the filter input.
        onBlur={(e) => {
          if (!e.relatedTarget || !barRef.current?.contains(e.relatedTarget)) {
            requestAnimationFrame(() => {
              if (barRef.current && !barRef.current.contains(document.activeElement)) inputRef.current?.focus();
            });
          }
        }}
      >
        <Payload
          payload={payload}
          noteRef={noteRef}
          onPickFile={onPickFile}
          onClearPayload={onClearPayload}
          onPayloadText={onPayloadText}
        />

        <div className="cmd-search">
          <IconSearch size={17} stroke="#6E7888" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Send to…"
            aria-label="Filter targets"
            data-testid="cmd-filter"
            autoComplete="off"
            spellCheck={false}
          />
          {selected.size > 0 && (
            <span className="cmd-count mono" data-testid="cmd-selected-count">
              <span className="dot live" />
              {selected.size} selected
            </span>
          )}
        </div>

        <div className="cmd-list" ref={listRef} role="listbox" aria-multiselectable="true">
          {rows.length === 0 && (
            <div className="cmd-note" data-testid="cmd-no-targets">
              {others.length === 0
                ? 'No other devices registered yet. Register a phone or run the CLI, then they show up here.'
                : `Nothing matches “${query}”.`}
            </div>
          )}

          {rows.some((r) => r.type === 'device') && <div className="cmd-group mono">Your devices</div>}
          {rows.map((r, i) =>
            r.type === 'device' ? (
              <DeviceRow
                key={r.id}
                row={r}
                index={i}
                active={i === active}
                selected={selected.has(r.id)}
                onHover={() => setActive(i)}
                onClick={() => { toggle(r.id); setActive(i); }}
              />
            ) : (
              <button
                key={r.id}
                type="button"
                className="cmd-row"
                role="option"
                aria-selected={selected.has(r.id)}
                data-active={i === active}
                data-selected={selected.has(r.id)}
                data-testid="cmd-row-all"
                onMouseEnter={() => setActive(i)}
                onClick={() => { toggle(r.id); setActive(i); }}
                tabIndex={-1}
              >
                <IconAllDevices size={19} stroke="#9C8CF5" />
                <span className="label">All my devices</span>
                <span className="state mono">{r.count} device{r.count === 1 ? '' : 's'}</span>
                {selected.has(r.id) && <IconCheck size={17} stroke="#9C8CF5" className="check" />}
              </button>
            ),
          )}

          <div className="cmd-group mono">People</div>
          <div className="cmd-note" data-testid="cmd-people-note">
            Sending to other people needs accounts and contacts — not in Weekend 0. Today Transmat moves
            things between <em>your</em> devices.
          </div>
        </div>

        <div className="cmd-foot">
          <button type="button" className="retention" onClick={cycleDays} tabIndex={-1} data-testid="cmd-retention">
            <IconClock size={14} stroke="#6E7888" />
            <span className="mono">Expires in {days} day{days === 1 ? '' : 's'}</span>
            <span className="kbd mono">⌃E</span>
          </button>
          <div className="spacer" />
          <div className="hints">
            <span className="hint strong mono">{sending ? 'sending…' : '↵ Send'}</span>
            <span className="hint mono">⇥ Add another</span>
            <span className="hint mono">esc</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function DeviceRow({ row, active, selected, onHover, onClick }) {
  const d = row.device;
  const Glyph = platformIcon(d.platform);
  const online = Date.now() - Date.parse(d.last_seen_at) < 120_000;
  return (
    <button
      type="button"
      className="cmd-row"
      role="option"
      aria-selected={selected}
      data-active={active}
      data-selected={selected}
      data-testid="cmd-row-device"
      data-device-name={d.name}
      onMouseEnter={onHover}
      onClick={onClick}
      tabIndex={-1}
    >
      <Glyph size={19} stroke={selected ? '#ECEFF4' : '#A3ACBB'} />
      <span className="label">{d.name}</span>
      <span className={`state mono${online ? ' online' : ''}`}>
        {online ? 'online' : relativeTime(d.last_seen_at)}
      </span>
      {selected && <IconCheck size={17} stroke="#9C8CF5" className="check" />}
    </button>
  );
}

function Payload({ payload, noteRef, onPickFile, onClearPayload, onPayloadText }) {
  const { file, text, source } = payload;

  if (file) {
    const Glyph = kindIcon({ kind: 'file', mime_type: file.type });
    return (
      <div className="cmd-payload" data-testid="cmd-payload">
        <div className="thumb"><Glyph size={18} stroke="#A3ACBB" /></div>
        <div className="meta">
          <div className="name">{file.name}</div>
          <div className="sub mono">{bytes(file.size)} · {source || 'attached'}</div>
        </div>
        <button type="button" className="swap mono" onClick={onPickFile} tabIndex={-1}>⌘U to swap</button>
        <button type="button" className="icon-btn" onClick={onClearPayload} aria-label="Remove attachment" tabIndex={-1}>
          <IconX size={14} />
        </button>
      </div>
    );
  }

  const link = isUrl(text);
  return (
    <div className="cmd-payload" data-testid="cmd-payload">
      <div className="thumb">{link ? <IconLink size={18} stroke="#9C8CF5" /> : <IconText size={18} stroke="#A3ACBB" />}</div>
      <div className="meta">
        <input
          ref={noteRef}
          className="note"
          value={text || ''}
          onChange={(e) => onPayloadText(e.target.value)}
          placeholder="Type a note, or paste a link…"
          aria-label="Payload"
          data-testid="cmd-payload-text"
          spellCheck={false}
        />
        <div className="sub mono">
          {text ? (link ? `link · ${prettyUrl(text)}` : `note · ${text.length} characters`) : 'nothing attached yet'}
        </div>
      </div>
      <button type="button" className="swap mono" onClick={onPickFile} tabIndex={-1}>⌘U to attach</button>
    </div>
  );
}
