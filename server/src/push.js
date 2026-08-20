/**
 * PushDriver — the contract's interface, two implementations.
 *
 *   interface PushDriver {
 *     send(device: DeviceRow, payload: object): Promise<{ok: boolean; reason?: string}>
 *     name: 'console' | 'apns'
 *   }
 *
 * `console` is the default and the whole dev path: it prints the push that
 * *would* have been sent, formatted so you can read it at a glance.
 *
 * `apns` signs an ES256 JWT from a .p8 key and POSTs over HTTP/2 to
 * api.push.apple.com using node:http2 — no dependency. The JWT is cached and
 * refreshed before Apple's one-hour expiry, and a 410 / `Unregistered` /
 * `BadDeviceToken` response clears the device's push_token so we stop
 * hammering a dead token.
 */
import fs from 'node:fs';
import http2 from 'node:http2';
import crypto from 'node:crypto';

/* -------------------------------------------------------------------------- */
/* payload                                                                    */
/* -------------------------------------------------------------------------- */

/** Human byte sizes, matching the contract's "2.4 MB · tap to receive". */
export function formatBytes(bytes) {
  if (bytes == null) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes);
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  const rounded = i === 0 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '');
  return `${rounded} ${units[i]}`;
}

/**
 * Build the APNs payload from the contract.
 * @param {object} transfer transfer row
 * @param {string} deliveryId
 * @param {string|null} fromName
 */
export function buildPushPayload(transfer, deliveryId, fromName) {
  const isFile = transfer.kind === 'file';
  const title = isFile
    ? transfer.file_name || 'A file'
    : transfer.kind === 'link'
      ? 'A link'
      : 'Text';
  const body = isFile
    ? `${formatBytes(transfer.size)} · tap to receive`
    : truncate(transfer.text ?? '', 120);

  return {
    aps: {
      alert: {
        title,
        subtitle: fromName ? `from ${fromName}` : 'from an unknown device',
        body,
      },
      sound: 'default',
      category: 'TRANSFER_ARRIVED',
      'mutable-content': 1,
      'thread-id': 'transmat',
    },
    transfer_id: transfer.id,
    delivery_id: deliveryId,
    kind: transfer.kind,
    file_name: transfer.file_name ?? null,
    size: transfer.size ?? null,
  };
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/* -------------------------------------------------------------------------- */
/* console driver                                                             */
/* -------------------------------------------------------------------------- */

export function createConsolePush({ out = process.stdout } = {}) {
  return {
    name: /** @type {'console'} */ ('console'),
    /**
     * @param {import('./db.js').DeviceRow} device
     * @param {object} payload
     */
    async send(device, payload) {
      const alert = payload?.aps?.alert ?? {};
      const bar = '━'.repeat(58);
      out.write(
        `\n┏${bar}┓\n` +
          `  📲 PUSH → ${device.name} (${device.platform})\n` +
          `     device_id: ${device.id}\n` +
          `     channel:   ${device.push_channel}${device.push_token ? ` token=${maskToken(device.push_token)}` : ''}\n` +
          `  ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n` +
          `     ${alert.title ?? ''}\n` +
          `     ${alert.subtitle ?? ''}\n` +
          `     ${alert.body ?? ''}\n` +
          `  ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n` +
          `     transfer_id: ${payload.transfer_id}\n` +
          `     delivery_id: ${payload.delivery_id}\n` +
          `┗${bar}┛\n\n`,
      );
      return { ok: true };
    },
    async close() {},
  };
}

function maskToken(token) {
  return token.length <= 12 ? token : `${token.slice(0, 6)}…${token.slice(-4)}`;
}

/* -------------------------------------------------------------------------- */
/* apns driver                                                                */
/* -------------------------------------------------------------------------- */

const APNS_HOSTS = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
};

/** Apple rejects tokens older than 1h; refresh comfortably before that. */
const JWT_TTL_MS = 50 * 60 * 1000;

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

/**
 * ES256-sign an APNs provider token.
 * node's `dsaEncoding: 'ieee-p1363'` gives the raw r||s JOSE signature Apple
 * wants — the default DER encoding is silently rejected.
 * @param {crypto.KeyObject} privateKey
 * @param {string} keyId
 * @param {string} teamId
 */
export function signApnsJwt(privateKey, keyId, teamId, iat = Math.floor(Date.now() / 1000)) {
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
  const claims = base64url(JSON.stringify({ iss: teamId, iat }));
  const signingInput = `${header}.${claims}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${signature.toString('base64url')}`;
}

/**
 * @param {import('./config.js').Config} config
 * @param {{clearPushToken(id:string):void}} db
 */
export function createApnsPush(config, db) {
  const { keyPath, keyId, teamId, bundleId } = config.apns;
  const host = config.apns.host || APNS_HOSTS[config.apns.env] || APNS_HOSTS.sandbox;
  const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath, 'utf8'));

  /** @type {{token:string, mintedAt:number}|null} */
  let cachedJwt = null;
  /** @type {import('node:http2').ClientHttp2Session|null} */
  let session = null;

  function jwt() {
    if (cachedJwt && Date.now() - cachedJwt.mintedAt < JWT_TTL_MS) return cachedJwt.token;
    cachedJwt = { token: signApnsJwt(privateKey, keyId, teamId), mintedAt: Date.now() };
    return cachedJwt.token;
  }

  function getSession() {
    if (session && !session.closed && !session.destroyed) return session;
    session = http2.connect(host);
    session.setTimeout(30_000, () => session?.close());
    // A dead session must not take the process with it.
    session.on('error', () => {
      session?.destroy();
      session = null;
    });
    session.on('close', () => {
      session = null;
    });
    session.unref();
    return session;
  }

  return {
    name: /** @type {'apns'} */ ('apns'),

    /**
     * @param {import('./db.js').DeviceRow} device
     * @param {object} payload
     * @returns {Promise<{ok:boolean, reason?:string}>}
     */
    async send(device, payload) {
      if (!device.push_token) return { ok: false, reason: 'no_push_token' };
      const body = Buffer.from(JSON.stringify(payload));

      return new Promise((resolve) => {
        let settled = false;
        const done = (result) => {
          if (settled) return;
          settled = true;
          resolve(result);
        };

        let req;
        try {
          req = getSession().request({
            ':method': 'POST',
            ':path': `/3/device/${device.push_token}`,
            authorization: `bearer ${jwt()}`,
            'apns-topic': bundleId,
            'apns-push-type': 'alert',
            'apns-priority': '10',
            'apns-expiration': String(Math.floor(Date.now() / 1000) + 24 * 3600),
            'content-type': 'application/json',
            'content-length': body.length,
          });
        } catch (err) {
          return done({ ok: false, reason: String(err?.message ?? err) });
        }

        let status = 0;
        let apnsId = '';
        const chunks = [];

        req.setTimeout(15_000, () => {
          req.close(http2.constants.NGHTTP2_CANCEL);
          done({ ok: false, reason: 'timeout' });
        });
        req.on('response', (headers) => {
          status = Number(headers[':status']) || 0;
          apnsId = String(headers['apns-id'] ?? '');
        });
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('error', (err) => done({ ok: false, reason: String(err?.message ?? err) }));
        req.on('end', () => {
          if (status === 200) return done({ ok: true, reason: apnsId || undefined });
          let reason = `http_${status}`;
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (parsed?.reason) reason = parsed.reason;
          } catch {
            /* Apple sometimes sends an empty body */
          }
          // Dead token: stop pushing to it. Apple's contract for this is
          // status 410, plus 400/Unregistered|BadDeviceToken in practice.
          if (status === 410 || reason === 'Unregistered' || reason === 'BadDeviceToken') {
            try {
              db.clearPushToken(device.id);
            } catch {
              /* best effort */
            }
            return done({ ok: false, reason: 'unregistered' });
          }
          if (status === 403 && (reason === 'ExpiredProviderToken' || reason === 'InvalidProviderToken')) {
            cachedJwt = null; // force a fresh mint on the next send
          }
          done({ ok: false, reason });
        });

        req.end(body);
      });
    },

    async close() {
      session?.close();
      session = null;
    },
  };
}

/**
 * @param {import('./config.js').Config} config
 * @param {{clearPushToken(id:string):void}} db
 */
export function createPush(config, db) {
  if (config.pushDriver === 'apns') return createApnsPush(config, db);
  return createConsolePush();
}

export default createPush;
