/** Settings live in localStorage. The token is NEVER hardcoded or committed. */

const KEY = 'transmat.settings.v1';

export const DEFAULTS = {
  serverUrl: 'http://localhost:8787',
  token: '',
  deviceName: '',
  deviceId: '',
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS, deviceName: suggestDeviceName() };
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, deviceName: suggestDeviceName(), ...parsed };
  } catch {
    return { ...DEFAULTS, deviceName: suggestDeviceName() };
  }
}

export function saveSettings(s) {
  localStorage.setItem(KEY, JSON.stringify(s));
  return s;
}

export function isConfigured(s) {
  return !!(s.serverUrl && s.token);
}

/** "Chrome on macOS" — matches the naming convention in ARCHITECTURE §7. */
export function suggestDeviceName() {
  if (typeof navigator === 'undefined') return 'Web';
  const ua = navigator.userAgent;
  const browser =
    /Firefox\//.test(ua) ? 'Firefox' :
    /Edg\//.test(ua) ? 'Edge' :
    /Chrome\//.test(ua) ? 'Chrome' :
    /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os =
    /Mac OS X/.test(ua) ? 'macOS' :
    /Windows/.test(ua) ? 'Windows' :
    /Android/.test(ua) ? 'Android' :
    /(iPhone|iPad)/.test(ua) ? 'iOS' :
    /Linux/.test(ua) ? 'Linux' : 'this machine';
  return `${browser} on ${os}`;
}
