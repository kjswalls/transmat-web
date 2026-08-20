/**
 * Transmat API client — docs/CONTRACT.md.
 *
 * Note on SSE: `EventSource` cannot send an `Authorization` header, and
 * `GET /v1/events` is a bearer route, so the stream is consumed with
 * fetch + ReadableStream instead. Same wire format, same endpoint.
 */

export class ApiError extends Error {
  constructor(code, message, status) {
    super(message || code);
    this.code = code;
    this.status = status;
  }
}

export function createClient({ serverUrl, token }) {
  const base = (serverUrl || '').replace(/\/+$/, '');
  const auth = () => ({ Authorization: `Bearer ${token}` });

  async function req(path, { method = 'GET', body, headers, redirect } = {}) {
    let res;
    try {
      res = await fetch(base + path, { method, body, redirect, headers: { ...auth(), ...headers } });
    } catch (e) {
      throw new ApiError('unreachable', `Cannot reach ${base}`, 0);
    }
    if (res.status === 204) return null;
    const ct = res.headers.get('content-type') || '';
    if (!res.ok) {
      let code = 'bad_request', message = res.statusText;
      if (ct.includes('application/json')) {
        const j = await res.json().catch(() => null);
        if (j?.error) ({ code, message } = j.error);
      }
      throw new ApiError(code, message, res.status);
    }
    return ct.includes('application/json') ? res.json() : res;
  }

  return {
    base,
    health: () => req('/health'),

    listDevices: () => req('/v1/devices').then((r) => r.devices || []),

    registerDevice: ({ name, platform, push_channel = 'none', push_token }) =>
      req('/v1/devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, platform, push_channel, ...(push_token ? { push_token } : {}) }),
      }),

    renameDevice: (deviceId, name) =>
      req(`/v1/devices/${encodeURIComponent(deviceId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      }),

    deleteDevice: (deviceId) => req(`/v1/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE' }),

    listTransfers: (params = {}) => {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) if (v != null && v !== '') q.set(k, v);
      const qs = q.toString();
      return req(`/v1/transfers${qs ? `?${qs}` : ''}`).then((r) => r.transfers || []);
    },

    getTransfer: (id) => req(`/v1/transfers/${encodeURIComponent(id)}`).then((r) => r.transfer),

    revokeTransfer: (id) => req(`/v1/transfers/${encodeURIComponent(id)}`, { method: 'DELETE' }),

    ackDelivery: (deliveryId) => req(`/v1/deliveries/${encodeURIComponent(deliveryId)}/ack`, { method: 'POST' }),

    /**
     * POST /v1/transfers as multipart/form-data (the shape the Shortcut uses too).
     * XHR rather than fetch so upload progress is observable.
     * @returns {Promise<import('./types.js').Transfer>}
     */
    send({ file, text, kind, name, to = [], from, expiresInDays = 7, onProgress }) {
      const fd = new FormData();
      if (file) fd.append('file', file, name || file.name);
      if (name) fd.append('name', name);
      if (kind) fd.append('kind', kind);
      if (text != null && text !== '') fd.append('text', text);
      for (const t of to.length ? to : ['others']) fd.append('to', t);
      if (from) fd.append('from', from);
      fd.append('expires_in_days', String(expiresInDays));

      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${base}/v1/transfers`);
        xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        xhr.upload.onprogress = (e) => {
          if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total);
        };
        xhr.onload = () => {
          let payload = null;
          try { payload = JSON.parse(xhr.responseText); } catch { /* non-JSON */ }
          if (xhr.status >= 200 && xhr.status < 300) resolve(payload?.transfer ?? payload);
          else reject(new ApiError(payload?.error?.code || 'bad_request', payload?.error?.message || xhr.statusText, xhr.status));
        };
        xhr.onerror = () => reject(new ApiError('unreachable', `Cannot reach ${base}`, 0));
        xhr.send(fd);
      });
    },

    /**
     * GET /v1/transfers/:id/blob — 302 to a signed URL. fetch follows the
     * redirect; we then hand the bytes to the browser as a download.
     */
    async download(transfer) {
      const res = await req(`/v1/transfers/${encodeURIComponent(transfer.transfer_id)}/blob`);
      const blob = await (res instanceof Response ? res.blob() : res);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = transfer.file_name || 'download';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      return blob.size;
    },

    /**
     * SSE over fetch. Calls `onEvent(name, data)`; reconnects with backoff.
     * @returns {() => void} unsubscribe
     */
    events({ deviceId, onEvent, onStatus }) {
      let closed = false;
      let ctrl = null;
      let attempt = 0;

      const run = async () => {
        while (!closed) {
          ctrl = new AbortController();
          try {
            const qs = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : '';
            const res = await fetch(`${base}/v1/events${qs}`, {
              headers: { ...auth(), Accept: 'text/event-stream' },
              signal: ctrl.signal,
            });
            if (!res.ok || !res.body) throw new Error(`sse ${res.status}`);
            attempt = 0;
            onStatus?.('live');
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buf = '';
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              buf += decoder.decode(value, { stream: true });
              let sep;
              while ((sep = buf.indexOf('\n\n')) !== -1) {
                const chunk = buf.slice(0, sep);
                buf = buf.slice(sep + 2);
                let name = 'message';
                const dataLines = [];
                for (const line of chunk.split('\n')) {
                  if (line.startsWith(':')) continue;
                  if (line.startsWith('event:')) name = line.slice(6).trim();
                  else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
                }
                if (!dataLines.length) continue;
                try { onEvent(name, JSON.parse(dataLines.join('\n'))); }
                catch { /* ignore malformed frame */ }
              }
            }
          } catch {
            if (closed) return;
          }
          if (closed) return;
          onStatus?.('down');
          attempt += 1;
          await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** (attempt - 1), 15_000)));
        }
      };
      run();
      return () => { closed = true; ctrl?.abort(); };
    },
  };
}
