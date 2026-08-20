import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createClient, ApiError } from '../lib/api.js';
import { loadSettings, saveSettings, isConfigured, suggestDeviceName } from '../lib/settings.js';
import { isUrl } from '../lib/format.js';

/**
 * The whole client state machine: settings → self-registration → devices +
 * transfers + live SSE. One hook so the UI stays declarative.
 */
export function useTransmat() {
  const [settings, setSettings] = useState(loadSettings);
  const [devices, setDevices] = useState([]);
  const [transfers, setTransfers] = useState([]);
  const [pending, setPending] = useState([]); // optimistic outbound rows
  const [status, setStatus] = useState('idle'); // idle|connecting|live|down  (SSE)
  const [polling, setPolling] = useState(false); // SSE unavailable but HTTP works
  const [error, setError] = useState(null); // {code, message}
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const [toasts, setToasts] = useState([]);
  const toastSeq = useRef(0);

  const configured = isConfigured(settings);
  const client = useMemo(
    () => (configured ? createClient(settings) : null),
    [configured, settings.serverUrl, settings.token],
  );

  const toast = useCallback((text, opts = {}) => {
    const id = ++toastSeq.current;
    setToasts((t) => [...t, { id, text, ...opts }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), opts.ms || 3200);
  }, []);

  const update = useCallback((patch) => {
    setSettings((s) => saveSettings({ ...s, ...patch }));
  }, []);

  /**
   * Register this browser as a device: platform 'web', push_channel 'none'.
   *
   * If we already hold a device_id from a previous visit we PATCH it instead of
   * POSTing again. CONTRACT.md: with no `push_token`, POST /v1/devices upserts
   * on `name`+`platform` — so posting a renamed browser creates a SECOND device
   * row, orphans the old device_id, and leaves a ghost in every target picker.
   */
  const registerSelf = useCallback(async (c, s) => {
    const name = s.deviceName || suggestDeviceName();
    const keep = (device) => {
      setSettings((prev) => saveSettings({ ...prev, deviceId: device.device_id, deviceName: device.name }));
      return device;
    };
    if (s.deviceId) {
      try {
        const device = await c.renameDevice(s.deviceId, name);
        if (device?.device_id) return keep(device);
      } catch (e) {
        // 404 => this device was deleted server-side; fall through and re-register.
        if (e.code !== 'not_found') throw e;
      }
    }
    return keep(await c.registerDevice({ name, platform: 'web', push_channel: 'none' }));
  }, []);

  const refresh = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    try {
      const [ds, ts] = await Promise.all([client.listDevices(), client.listTransfers({ limit: 100 })]);
      setDevices(ds);
      setTransfers(ts);
      setError(null);
    } catch (e) {
      setError({ code: e.code || 'unreachable', message: e.message });
    } finally {
      setLoading(false);
    }
  }, [client]);

  // Boot: health → register self → load → subscribe.
  useEffect(() => {
    if (!client) { setReady(true); setStatus('idle'); return; }
    let cancelled = false;
    let unsubscribe = null;
    setReady(false);
    setStatus('connecting');

    (async () => {
      try {
        await client.health();
        if (cancelled) return;
        let selfId = settings.deviceId;
        try {
          const self = await registerSelf(client, settings);
          selfId = self.device_id;
        } catch (e) {
          if (e.code === 'unauthorized') throw e;
        }
        if (cancelled) return;
        const [ds, ts] = await Promise.all([client.listDevices(), client.listTransfers({ limit: 100 })]);
        if (cancelled) return;
        setDevices(ds);
        setTransfers(ts);
        setError(null);
        unsubscribe = client.events({
          onStatus: (s) => !cancelled && setStatus(s),
          onEvent: (name, data) => {
            if (cancelled) return;
            if (name === 'transfer.created' && data.transfer) {
              setTransfers((prev) =>
                prev.some((t) => t.transfer_id === data.transfer.transfer_id)
                  ? prev.map((t) => (t.transfer_id === data.transfer.transfer_id ? data.transfer : t))
                  : [data.transfer, ...prev],
              );
            } else if (name === 'transfer.revoked') {
              setTransfers((prev) =>
                prev.map((t) => (t.transfer_id === data.transfer_id ? { ...t, state: 'revoked' } : t)),
              );
            } else if (name === 'delivery.acked') {
              setTransfers((prev) =>
                prev.map((t) =>
                  t.transfer_id !== data.transfer_id
                    ? t
                    : {
                        ...t,
                        deliveries: (t.deliveries || []).map((d) =>
                          d.delivery_id === data.delivery_id
                            ? { ...d, state: 'downloaded', acked_at: new Date().toISOString() }
                            : d,
                        ),
                      },
                ),
              );
            }
          },
        });
      } catch (e) {
        if (!cancelled) {
          setStatus('down');
          setError({ code: e.code || 'unreachable', message: e.message });
        }
      } finally {
        if (!cancelled) setReady(true);
      }
    })();

    return () => { cancelled = true; unsubscribe?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  /**
   * Fallback when SSE is unavailable (an old proxy, or a server that forgets
   * CORS on the event stream): poll the list so the stream still updates.
   */
  useEffect(() => {
    if (!client || status === 'live' || status === 'idle') return;
    let stopped = false;
    const tick = async () => {
      try {
        const [ds, ts] = await Promise.all([client.listDevices(), client.listTransfers({ limit: 100 })]);
        if (stopped) return;
        setDevices(ds);
        setTransfers(ts);
        setError(null);
        setPolling(true);
      } catch (e) {
        if (stopped) return;
        setPolling(false);
        setError({ code: e.code || 'unreachable', message: e.message });
      }
    };
    if (status === 'down') tick(); // don't make the user wait a whole interval
    const id = setInterval(tick, 5000);
    return () => { stopped = true; clearInterval(id); };
  }, [client, status]);

  useEffect(() => { if (status === 'live') setPolling(false); }, [status]);

  /**
   * A rename saved in settings has to reach the server now — otherwise the
   * field reads as saved while every other device still sees the old name, and
   * the next reload forks a duplicate device.
   */
  const renameTried = useRef('');
  useEffect(() => {
    if (!client || !settings.deviceId || !settings.deviceName) return;
    const registered = devices.find((d) => d.device_id === settings.deviceId);
    if (!registered || registered.name === settings.deviceName) return;
    const attempt = `${settings.deviceId}:${settings.deviceName}`;
    if (renameTried.current === attempt) return; // don't retry on every poll
    renameTried.current = attempt;
    let cancelled = false;
    client
      .renameDevice(settings.deviceId, settings.deviceName)
      .then((d) => {
        if (cancelled || !d?.device_id) return;
        setDevices((prev) => prev.map((x) => (x.device_id === d.device_id ? d : x)));
      })
      .catch(() => { renameTried.current = ''; });
    return () => { cancelled = true; };
  }, [client, devices, settings.deviceId, settings.deviceName]);

  /**
   * Send a payload. `targets` is a list of device_ids, or ['all'] / ['others'].
   * Renders an optimistic row with real upload progress while it flies.
   */
  const send = useCallback(
    async ({ file, text, targets, expiresInDays = 7 }) => {
      if (!client) throw new ApiError('unauthorized', 'Not configured', 401);
      const kind = file ? 'file' : isUrl(text) ? 'link' : 'text';
      const tempId = `tmp_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      const optimistic = {
        transfer_id: tempId,
        kind,
        state: 'complete',
        file_name: file ? file.name : null,
        mime_type: file ? file.type || 'application/octet-stream' : null,
        size: file ? file.size : null,
        text: file ? null : text,
        from_device_id: settings.deviceId || null,
        from_device_name: settings.deviceName || null,
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + expiresInDays * 86400000).toISOString(),
        deliveries: resolveTargetNames(targets, devices, settings.deviceId).map((d) => ({
          delivery_id: `${tempId}_${d.device_id}`,
          device_id: d.device_id,
          device_name: d.name,
          state: 'pending',
          acked_at: null,
        })),
        _sending: 0,
      };
      setPending((p) => [optimistic, ...p]);
      try {
        const transfer = await client.send({
          file,
          text: file ? undefined : text,
          kind,
          name: file ? file.name : undefined,
          to: targets,
          from: settings.deviceId || undefined,
          expiresInDays,
          onProgress: (frac) =>
            setPending((p) => p.map((x) => (x.transfer_id === tempId ? { ...x, _sending: frac } : x))),
        });
        setPending((p) => p.filter((x) => x.transfer_id !== tempId));
        if (transfer) {
          setTransfers((prev) =>
            prev.some((t) => t.transfer_id === transfer.transfer_id) ? prev : [transfer, ...prev],
          );
        }
        const n = transfer?.deliveries?.length ?? optimistic.deliveries.length;
        toast(`Sent to ${n} device${n === 1 ? '' : 's'}`, { kind: 'ok' });
        return transfer;
      } catch (e) {
        setPending((p) => p.filter((x) => x.transfer_id !== tempId));
        toast(e.code === 'no_targets' ? 'Nothing to send to — pick a target' : `Send failed: ${e.message}`, { kind: 'err' });
        throw e;
      }
    },
    [client, devices, settings.deviceId, settings.deviceName, toast],
  );

  const download = useCallback(
    async (transfer) => {
      if (!client) return;
      try {
        await client.download(transfer);
        const mine = (transfer.deliveries || []).find((d) => d.device_id === settings.deviceId);
        if (mine && mine.state !== 'downloaded') {
          await client.ackDelivery(mine.delivery_id).catch(() => {});
        }
        toast(`Saved ${transfer.file_name || 'file'}`, { kind: 'ok' });
      } catch (e) {
        toast(e.code === 'expired' ? 'That one has expired' : `Download failed: ${e.message}`, { kind: 'err' });
      }
    },
    [client, settings.deviceId, toast],
  );

  const copyText = useCallback(
    async (transfer) => {
      try {
        await navigator.clipboard.writeText(transfer.text || '');
        toast('Copied to clipboard', { kind: 'ok' });
      } catch {
        toast('Clipboard blocked by the browser', { kind: 'err' });
      }
      const mine = (transfer.deliveries || []).find((d) => d.device_id === settings.deviceId);
      if (client && mine && mine.state !== 'downloaded') client.ackDelivery(mine.delivery_id).catch(() => {});
    },
    [client, settings.deviceId, toast],
  );

  const revoke = useCallback(
    async (transfer) => {
      if (!client) return;
      try {
        await client.revokeTransfer(transfer.transfer_id);
        setTransfers((prev) =>
          prev.map((t) => (t.transfer_id === transfer.transfer_id ? { ...t, state: 'revoked' } : t)),
        );
        toast('Revoked — bytes deleted');
      } catch (e) {
        toast(`Revoke failed: ${e.message}`, { kind: 'err' });
      }
    },
    [client, toast],
  );

  const all = useMemo(() => [...pending, ...transfers], [pending, transfers]);
  const selfDevice = useMemo(
    () => devices.find((d) => d.device_id === settings.deviceId) || null,
    [devices, settings.deviceId],
  );

  return {
    settings, update, configured, ready, loading,
    devices, selfDevice, transfers: all, status, polling, error,
    refresh, send, download, copyText, revoke, toasts, toast,
  };
}

function resolveTargetNames(targets, devices, selfId) {
  const out = new Map();
  for (const t of targets) {
    if (t === 'all') devices.forEach((d) => out.set(d.device_id, d));
    else if (t === 'others') devices.filter((d) => d.device_id !== selfId).forEach((d) => out.set(d.device_id, d));
    else {
      const d = devices.find((x) => x.device_id === t);
      if (d) out.set(d.device_id, d);
    }
  }
  return [...out.values()];
}
