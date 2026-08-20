import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTransmat } from './hooks/useTransmat.js';
import Composer from './components/Composer.jsx';
import Stream from './components/Stream.jsx';
import CommandBar from './components/CommandBar.jsx';
import SettingsPanel from './components/SettingsPanel.jsx';
import { IconSend, IconGear, IconAllDevices, IconCheck, IconX, platformIcon } from './lib/icons.jsx';

const EMPTY_PAYLOAD = { file: null, text: '', source: '' };

const connLabel = (t) =>
  t.status === 'live' ? 'live'
  : t.polling ? 'polling'
  : !t.configured ? 'not configured'
  : t.status === 'down' ? 'offline'
  : 'connecting';

const connTone = (t) => (t.status === 'live' ? 'live' : t.polling ? '' : t.status === 'down' ? 'down' : '');

const connTitle = (t) =>
  t.status === 'live'
    ? 'Subscribed to /v1/events'
    : t.polling
      ? 'The event stream is unavailable — falling back to polling /v1/transfers'
      : 'Not connected';

export default function App() {
  const t = useTransmat();
  const [payload, setPayload] = useState(EMPTY_PAYLOAD);
  const [barOpen, setBarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [days, setDays] = useState(7);
  const [defaultTargets, setDefaultTargets] = useState(['others']);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const fileRef = useRef(null);

  const firstRun = t.ready && !t.configured;
  // Where focus was before a dialog opened, so Escape can put it back.
  const returnFocus = useRef(null);

  // Relative times and expiry countdowns stay honest without a reload.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  const others = useMemo(
    () => t.devices.filter((d) => d.device_id !== t.settings.deviceId),
    [t.devices, t.settings.deviceId],
  );

  /** Put focus back where the user left it, if that element still exists. */
  const restoreFocus = useCallback(() => {
    const el = returnFocus.current;
    returnFocus.current = null;
    if (!el) return;
    requestAnimationFrame(() => {
      if (document.contains(el) && typeof el.focus === 'function') el.focus();
    });
  }, []);

  // One modal at a time: a command bar stacked on the settings sheet is two
  // aria-modal dialogs fighting over focus, and over the non-dismissable
  // first-run sheet it is a dead end.
  const dialogOpen = barOpen || settingsOpen || firstRun;

  const openBar = useCallback(() => {
    if (settingsOpen || firstRun) return;
    returnFocus.current = document.activeElement;
    setBarOpen(true);
  }, [settingsOpen, firstRun]);
  const closeBar = useCallback(() => { setBarOpen(false); restoreFocus(); }, [restoreFocus]);

  const openSettings = useCallback(() => {
    if (barOpen) return;
    returnFocus.current = document.activeElement;
    setSettingsOpen(true);
  }, [barOpen]);
  const closeSettings = useCallback(() => { setSettingsOpen(false); restoreFocus(); }, [restoreFocus]);

  const pickFile = useCallback(() => fileRef.current?.click(), []);

  // Global keys: ⌘K summons the bar from anywhere, ⌘, opens settings.
  useEffect(() => {
    const onKey = (e) => {
      // Escape lives at the window, not on the dialog: between opening a dialog
      // and focus landing inside it there is a frame where a handler bound to
      // the dialog would never see the key, and Escape must ALWAYS close.
      if (e.key === 'Escape') {
        if (barOpen) { e.preventDefault(); closeBar(); }
        else if (settingsOpen && !firstRun) { e.preventDefault(); closeSettings(); }
        return;
      }
      const k = e.key.toLowerCase();
      if (k === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (barOpen) closeBar();
        else openBar();
      } else if (k === ',' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        openSettings();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [barOpen, settingsOpen, firstRun, openBar, closeBar, openSettings, closeSettings]);

  // Paste anywhere → the bar opens already carrying it.
  useEffect(() => {
    const onPaste = (e) => {
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
      const file = e.clipboardData?.files?.[0];
      const text = e.clipboardData?.getData('text/plain');
      if (file) { setPayload({ file, text: '', source: 'caught from clipboard' }); openBar(); }
      else if (text?.trim()) { setPayload({ file: null, text: text.trim(), source: 'caught from clipboard' }); openBar(); }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [openBar]);

  // Drop anywhere → same thing.
  useEffect(() => {
    const over = (e) => e.preventDefault();
    const drop = (e) => {
      e.preventDefault();
      const f = e.dataTransfer?.files?.[0];
      if (f) { setPayload({ file: f, text: '', source: 'dropped here' }); openBar(); }
    };
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => { window.removeEventListener('dragover', over); window.removeEventListener('drop', drop); };
  }, [openBar]);

  const doSend = useCallback(
    async ({ file, text, targets, expiresInDays }) => {
      setBusy(true);
      try {
        const res = await t.send({ file, text, targets, expiresInDays });
        setPayload(EMPTY_PAYLOAD);
        setDefaultTargets(targets);
        return res;
      } finally {
        setBusy(false);
      }
    },
    [t],
  );

  const openTransfer = useCallback(
    (transfer) => (transfer.kind === 'file' ? t.download(transfer) : t.copyText(transfer)),
    [t],
  );

  const targetLabel = useMemo(() => {
    if (defaultTargets.length === 1) {
      const only = defaultTargets[0];
      if (only === 'others' || only === 'all') return 'All my devices';
      return t.devices.find((d) => d.device_id === only)?.name || 'All my devices';
    }
    return `${defaultTargets.length} devices`;
  }, [defaultTargets, t.devices]);

  const TargetGlyph = useMemo(() => {
    if (defaultTargets.length === 1) {
      const d = t.devices.find((x) => x.device_id === defaultTargets[0]);
      if (d) return platformIcon(d.platform);
    }
    return IconAllDevices;
  }, [defaultTargets, t.devices]);

  return (
    <div className="page">
      <header className="masthead">
        <span className="wordmark">
          <IconSend size={15} stroke="#9C8CF5" />
          Transmat
        </span>
        <span className={`conn ${connTone(t)}`} data-testid="conn" title={connTitle(t)}>
          <span className={`dot ${connTone(t)}`} />
          {connLabel(t)}
        </span>
        <span className="spacer" />
        <button type="button" className="pill-btn primary" onClick={openBar} data-testid="open-bar">
          Send<span className="kbd">⌘K</span>
        </button>
        <button
          type="button"
          className="pill-btn"
          onClick={openSettings}
          aria-label="Settings"
          data-testid="open-settings"
        >
          <IconGear size={14} />
        </button>
      </header>

      <main className="shell">
        <Composer
          payload={payload}
          setPayload={setPayload}
          onPickFile={pickFile}
          targetLabel={targetLabel}
          TargetGlyph={TargetGlyph}
          onOpenBar={openBar}
          busy={busy}
          onSend={() => doSend({ file: payload.file, text: payload.text, targets: defaultTargets, expiresInDays: days })}
        />
        <Stream
          transfers={t.transfers}
          selfDeviceId={t.settings.deviceId}
          onOpen={openTransfer}
          onRevoke={t.revoke}
          error={t.error}
          onRetry={t.refresh}
          hasDevices={others.length > 0}
          now={now}
          dialogOpen={dialogOpen}
        />
      </main>

      <input
        ref={fileRef}
        type="file"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        data-testid="file-input"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) setPayload({ file: f, text: '', source: 'chosen from disk' });
          e.target.value = '';
        }}
      />

      <CommandBar
        open={barOpen}
        onClose={closeBar}
        payload={payload}
        onPickFile={pickFile}
        onClearPayload={() => setPayload(EMPTY_PAYLOAD)}
        onPayloadText={(text) => setPayload((p) => ({ ...p, file: null, text, source: 'typed' }))}
        devices={t.devices}
        selfDeviceId={t.settings.deviceId}
        onSend={doSend}
        days={days}
        setDays={setDays}
      />

      <SettingsPanel
        open={settingsOpen || firstRun}
        firstRun={firstRun}
        onClose={closeSettings}
        settings={t.settings}
        selfDevice={t.selfDevice}
        devices={t.devices}
        status={t.status}
        error={t.error}
        onSave={(patch) => { t.update(patch); setSettingsOpen(false); restoreFocus(); }}
      />

      <div className="toasts">
        {t.toasts.map((x) => (
          <div key={x.id} className={`toast${x.kind === 'err' ? ' err' : ''}`} data-testid="toast">
            {x.kind === 'err' ? <IconX size={14} stroke="#C98A72" /> : <IconCheck size={14} stroke="#55C9A2" />}
            {x.text}
          </div>
        ))}
      </div>
    </div>
  );
}
