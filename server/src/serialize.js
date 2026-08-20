/**
 * Row -> contract type. The wire shapes in docs/CONTRACT.md are the only thing
 * clients may rely on; nothing here leaks a push token or a blob key.
 */

/**
 * @param {import('./db.js').DeviceRow} row
 * @returns {{device_id:string,name:string,platform:string,push_channel:'apns'|'none',has_push_token:boolean,last_seen_at:string,created_at:string}}
 */
export function serializeDevice(row) {
  return {
    device_id: row.id,
    name: row.name,
    platform: row.platform,
    push_channel: row.push_channel === 'apns' ? 'apns' : 'none',
    has_push_token: Boolean(row.push_token),
    last_seen_at: row.last_seen_at,
    created_at: row.created_at,
  };
}

export function serializeDelivery(row) {
  return {
    delivery_id: row.delivery_id ?? row.id,
    device_id: row.device_id,
    device_name: row.device_name ?? '(deleted device)',
    state: row.state,
    acked_at: row.acked_at ?? null,
  };
}

/**
 * @param {import('./db.js').Db} db
 * @param {object} row transfers row
 */
export function serializeTransfer(db, row) {
  const deliveries = db.listDeliveries(row.id).map(serializeDelivery);
  const fromDevice = row.from_device_id ? db.getDevice(row.from_device_id) : null;
  return {
    transfer_id: row.id,
    kind: row.kind,
    state: row.state,
    file_name: row.file_name ?? null,
    mime_type: row.mime_type ?? null,
    size: row.size ?? null,
    text: row.text ?? null,
    from_device_id: row.from_device_id ?? null,
    from_device_name: fromDevice ? fromDevice.name : null,
    created_at: row.created_at,
    expires_at: row.expires_at,
    deliveries,
  };
}

/** Everyone who should hear about this transfer: recipients + sender. */
export function transferAudience(db, row) {
  const ids = db.deviceIdsForTransfer(row.id);
  if (row.from_device_id) ids.push(row.from_device_id);
  return ids;
}

/** Opaque keyset cursor over (created_at, id). */
export function encodeCursor(row) {
  return Buffer.from(`${row.created_at}|${row.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor) {
  if (!cursor) return undefined;
  try {
    const raw = Buffer.from(String(cursor), 'base64url').toString('utf8');
    const idx = raw.indexOf('|');
    if (idx === -1) return undefined;
    const created_at = raw.slice(0, idx);
    const id = raw.slice(idx + 1);
    if (!created_at || !id) return undefined;
    return { created_at, id };
  } catch {
    return undefined;
  }
}
