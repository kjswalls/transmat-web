import { useEffect, useRef, useState } from 'react';
import { IconGear, IconX, IconBrowser, IconCheck } from '../lib/icons.jsx';
import { platformLabel } from '../lib/format.js';

/**
 * Server URL + token. Persisted in localStorage, never in the repo.
 * Also shows this browser's device_id so it can be pasted into the Shortcut
 * (WEEKEND-0 Flow A step 5).
 */
export default function SettingsPanel({ open, onClose, settings, onSave, selfDevice, devices, status, error, firstRun }) {
  const [serverUrl, setServerUrl] = useState(settings.serverUrl);
  const [token, setToken] = useState(settings.token);
  const [deviceName, setDeviceName] = useState(settings.deviceName);
  const [copied, setCopied] = useState(false);
  const first = useRef(null);
  const sheetRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setServerUrl(settings.serverUrl);
    setToken(settings.token);
    setDeviceName(settings.deviceName);
    const id = requestAnimationFrame(() => first.current?.focus());
    return () => cancelAnimationFrame(id);
    // Seed from `settings` when the sheet opens and then leave the fields
    // alone: re-seeding on every settings write would wipe what the user is
    // halfway through typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const save = (e) => {
    e?.preventDefault();
    onSave({ serverUrl: serverUrl.trim().replace(/\/+$/, ''), token: token.trim(), deviceName: deviceName.trim() });
  };

  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !firstRun) onClose(); }}>
      <form
        className="sheet"
        ref={sheetRef}
        onSubmit={save}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        data-testid="settings"
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !firstRun) { e.preventDefault(); onClose(); }
          if (e.key === 'Tab') {
            // Focus trap.
            const f = sheetRef.current.querySelectorAll('input, button, [tabindex]:not([tabindex="-1"])');
            if (!f.length) return;
            const list = [...f].filter((el) => !el.disabled);
            const i = list.indexOf(document.activeElement);
            if (e.shiftKey && i <= 0) { e.preventDefault(); list[list.length - 1].focus(); }
            else if (!e.shiftKey && i === list.length - 1) { e.preventDefault(); list[0].focus(); }
          }
        }}
      >
        <div className="sheet-head">
          <IconGear size={16} stroke="#9C8CF5" />
          <h2>{firstRun ? 'Point this browser at your server' : 'Settings'}</h2>
          <span className="spacer" />
          {!firstRun && (
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close settings">
              <IconX size={14} />
            </button>
          )}
        </div>

        <div className="sheet-body">
          {firstRun && (
            <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-3)', lineHeight: 1.55 }}>
              No accounts in Weekend 0 — one shared bearer token, pasted by hand, so nothing secret ever lands in
              the repo. It is kept in this browser&apos;s localStorage.
            </p>
          )}

          <div className="field">
            <label htmlFor="s-url">Server URL</label>
            <input
              id="s-url"
              ref={first}
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder="http://localhost:8787"
              autoComplete="off"
              spellCheck={false}
              data-testid="settings-url"
            />
          </div>

          <div className="field">
            <label htmlFor="s-token">Access token</label>
            <input
              id="s-token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="paste TRANSMAT_TOKEN"
              autoComplete="off"
              spellCheck={false}
              data-testid="settings-token"
            />
            <span className="help">
              The same value as <code>TRANSMAT_TOKEN</code> in the server&apos;s <code>.env</code>.
            </span>
          </div>

          <div className="field">
            <label htmlFor="s-name">This device&apos;s name</label>
            <input
              id="s-name"
              value={deviceName}
              onChange={(e) => setDeviceName(e.target.value)}
              placeholder="Chrome on macOS"
              autoComplete="off"
              data-testid="settings-name"
            />
          </div>

          {selfDevice && (
            <div className="field">
              <label>Registered as</label>
              <div className="selfcard">
                <IconBrowser size={18} stroke="#55C9A2" />
                <span className="meta">
                  <span className="name">{selfDevice.name}</span>
                  <span className="idline mono">
                    {platformLabel(selfDevice.platform)} · push {selfDevice.push_channel} · {selfDevice.device_id}
                  </span>
                </span>
                <button
                  type="button"
                  className="pill-btn"
                  onClick={() => {
                    navigator.clipboard?.writeText(selfDevice.device_id);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1600);
                  }}
                >
                  {copied ? <IconCheck size={13} stroke="#55C9A2" /> : null}
                  {copied ? 'Copied' : 'Copy ID'}
                </button>
              </div>
              <span className="help">
                Paste this <code>device_id</code> into the Shortcut&apos;s <code>from</code> field.
              </span>
            </div>
          )}

          {!firstRun && (
            <div className="field">
              <label>Registered devices</label>
              <span className="help">
                {devices.length} device{devices.length === 1 ? '' : 's'} · live stream{' '}
                <span className="mono" style={{ color: status === 'live' ? 'var(--mint)' : 'var(--clay)' }}>
                  {status}
                </span>
                {error ? <> · <span className="mono" style={{ color: 'var(--clay)' }}>{error.message}</span></> : null}
              </span>
            </div>
          )}
        </div>

        <div className="sheet-foot">
          <span className="spacer" />
          {!firstRun && (
            <button type="button" className="pill-btn" onClick={onClose}>Cancel</button>
          )}
          <button type="submit" className="send-btn" data-testid="settings-save">
            {firstRun ? 'Connect' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}
