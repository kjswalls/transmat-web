import { useRef, useState } from 'react';
import { IconSend, IconChevron, IconX, kindIcon } from '../lib/icons.jsx';
import { bytes, isUrl } from '../lib/format.js';

/**
 * The composer strip: drop a file, paste, or type a note. Target pill on the right.
 * Enter sends straight away; ⌘K opens the command bar for multi-target picking.
 */
export default function Composer({ payload, setPayload, onPickFile, targetLabel, TargetGlyph, onOpenBar, onSend, busy }) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);

  const hasPayload = !!payload.file || !!(payload.text ?? '').trim();

  const submit = () => { if (hasPayload && !busy) onSend(); };

  return (
    <div
      className={`composer${dragging ? ' dragging' : ''}`}
      data-testid="composer"
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const f = e.dataTransfer.files?.[0];
        if (f) setPayload({ file: f, text: '', source: 'dropped here' });
      }}
    >
      <div className="composer-field">
        <IconSend size={15} stroke="#9C8CF5" />
        {payload.file ? (
          <div className="attached">
            {(() => {
              const G = kindIcon({ kind: 'file', mime_type: payload.file.type });
              return <G size={15} stroke="#A3ACBB" />;
            })()}
            <span className="meta">
              <span className="name">{payload.file.name}</span>
              <span className="sub mono">{bytes(payload.file.size)} · {payload.source || 'attached'}</span>
            </span>
            <button
              type="button"
              className="icon-btn"
              aria-label="Remove attachment"
              onClick={() => setPayload({ file: null, text: '', source: '' })}
            >
              <IconX size={13} />
            </button>
          </div>
        ) : (
          <input
            ref={inputRef}
            value={payload.text || ''}
            placeholder={dragging ? 'Drop it' : 'Send a file, link, or note…'}
            aria-label="Send a file, link, or note"
            data-testid="composer-input"
            spellCheck={false}
            onChange={(e) => setPayload({ file: null, text: e.target.value, source: 'typed' })}
            onPaste={(e) => {
              const f = e.clipboardData?.files?.[0];
              if (f) { e.preventDefault(); setPayload({ file: f, text: '', source: 'caught from clipboard' }); }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); submit(); }
            }}
          />
        )}
        {!payload.file && (
          <button type="button" className="icon-btn" aria-label="Attach a file" title="Attach a file" onClick={onPickFile}>
            <IconAttach />
          </button>
        )}
      </div>

      <button type="button" className="target-pill" onClick={onOpenBar} data-testid="target-pill" title="Choose targets (⌘K)">
        <TargetGlyph size={14} stroke="#ECEFF4" />
        <span>{targetLabel}</span>
        <IconChevron size={11} stroke="#6E7888" />
      </button>

      <button type="button" className="send-btn" onClick={submit} disabled={!hasPayload || busy} data-testid="composer-send">
        {busy ? 'Sending…' : isUrl(payload.text) ? 'Send link' : payload.file ? 'Send file' : 'Send'}
      </button>
    </div>
  );
}

const IconAttach = () => (
  <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14.5 9.5l-4.9 4.9a3 3 0 01-4.24-4.24l6-6a2 2 0 012.83 2.83l-5.83 5.83a1 1 0 01-1.42-1.41L12.4 6" />
  </svg>
);
