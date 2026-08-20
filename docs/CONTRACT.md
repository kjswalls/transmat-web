# Weekend 0 API contract — FROZEN

Every component builds against this. Do not change it unilaterally; if something here is wrong, say so in your report rather than diverging.

Base URL `http://localhost:8787`. All routes under `/v1` require `Authorization: Bearer $TRANSMAT_TOKEN`.

## Routes

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| GET | `/health` | — | `{ok, storage, push, version}` (no auth) |
| POST | `/v1/devices` | `{name, platform, push_token?, push_channel?}` | `Device` — upsert on `push_token` when present, else on `name`+`platform` |
| GET | `/v1/devices` | — | `{devices: Device[]}` |
| PATCH | `/v1/devices/:id` | `{name?}` | `Device` |
| DELETE | `/v1/devices/:id` | — | `{ok: true}` |
| POST | `/v1/transfers` | multipart **or** JSON (below) | `{transfer: Transfer}` |
| GET | `/v1/transfers` | `?device_id&direction&kind&q&limit&cursor` | `{transfers: Transfer[], next_cursor?}` |
| GET | `/v1/transfers/:id` | — | `{transfer: Transfer}` |
| GET | `/v1/transfers/:id/blob` | — | **302** to a signed URL (local driver signs its own `/blob/...` route) |
| DELETE | `/v1/transfers/:id` | — | `{ok: true}` — revoke: state→`revoked`, blob deleted, SSE `transfer.revoked` |
| POST | `/v1/deliveries/:id/ack` | — | `{ok: true}` — state→`downloaded` |
| GET | `/v1/events` | `?device_id` | SSE stream (below) |
| GET | `/blob/:key` | `?exp&sig` | file bytes — **no bearer auth**, HMAC-signed, local driver only |

### POST /v1/transfers

Two content types, same result.

**`multipart/form-data`** (the Shortcut and the web app use this):
- `file` — the file part (optional if `text` given)
- `name` — display filename (optional; falls back to the part's filename)
- `kind` — `file` | `text` | `link` (default inferred: `file` if a file part exists, else `link` if `text` parses as an http(s) URL, else `text`)
- `text` — payload for `kind=text|link`
- `to` — `all` | `others` | a `device_id`. Repeatable for multiple targets. Default `others`.
- `from` — sender `device_id` (optional)
- `expires_in_days` — 1–30, default 7

**`application/json`** — same fields minus `file`; only valid for `kind=text|link`.

Rules:
- `others` = every device except `from`. If `from` is absent or unknown, `others` behaves as `all`.
- A transfer with zero resolved targets is a **400** (`no_targets`), not a silent success.
- Max file size 2 GB; over → **413** (`too_large`).
- `text` payload max 64 KB; over → **413**.

## Types

```ts
type Platform = 'ios' | 'android' | 'macos' | 'web' | 'cli';
type Kind = 'file' | 'text' | 'link';
type TransferState = 'complete' | 'revoked' | 'expired';
type DeliveryState = 'pending' | 'pushed' | 'downloaded';

interface Device {
  device_id: string;
  name: string;
  platform: Platform;
  push_channel: 'apns' | 'none';
  has_push_token: boolean;      // never expose the token itself
  last_seen_at: string;         // ISO 8601
  created_at: string;
}

interface Delivery {
  delivery_id: string;
  device_id: string;
  device_name: string;
  state: DeliveryState;
  acked_at: string | null;
}

interface Transfer {
  transfer_id: string;
  kind: Kind;
  state: TransferState;
  file_name: string | null;     // null for text/link
  mime_type: string | null;
  size: number | null;          // bytes; null for text/link
  text: string | null;          // null for file
  from_device_id: string | null;
  from_device_name: string | null;
  created_at: string;
  expires_at: string;
  deliveries: Delivery[];
}
```

## Errors

Always `{error: {code, message}}` with a matching HTTP status. Codes: `unauthorized` (401), `not_found` (404), `no_targets` (400), `bad_request` (400), `too_large` (413), `expired` (410), `revoked` (410), `signature_invalid` (403).

## SSE `/v1/events`

`text/event-stream`, one JSON object per `data:` line, plus a `:keepalive` comment every 25s.

```
event: transfer.created   data: {"transfer": Transfer}
event: transfer.revoked   data: {"transfer_id": "..."}
event: delivery.acked     data: {"transfer_id": "...", "delivery_id": "...", "device_id": "..."}
```

With `?device_id=X`, only events where X is a recipient or the sender.

## Amendments accepted during the build

The implementation needed these; they are supersets of the frozen contract, not changes to it. Recorded here so the docs match reality.

1. **CORS** is enabled (reflected origin, no credentials, `Authorization` allowed, `Content-Disposition`/`Content-Range`/`Accept-Ranges`/`Location` exposed) on every route including the SSE stream and both blob hops. Without it a browser client on another port cannot call the API at all. Bearer auth is unchanged.
2. **`GET /v1/events` also accepts `?access_token=`** as an auth fallback, because `EventSource` cannot set headers. The `Authorization` header still works and is preferred. (Our web client uses `fetch` + `ReadableStream`, so it sends the header.)
3. **`PUBLIC_BASE_URL`** (default `http://localhost:$PORT`) — the `local` driver has to put an absolute URL in its 302 and nothing else in Env supplies one.
4. **`internal` (500)** joins the error-code list, for genuine unhandled bugs.
5. **`expires_in_days` outside 1–30 is clamped, not rejected** (non-numeric is still a 400). Friendlier to a Shortcut sending something odd.
6. **`direction`** takes `in` | `out` | `both`; omitted means either side.
7. **`POST /v1/transfers` returns 200**, not 201, for consistency with every other route.
8. **`GET /blob/:key` supports HEAD and single-byte-range requests**, so an iOS background download can resume.
9. **Revoked and expired transfers keep `blob_key`** after the bytes are deleted, so an already-issued signed URL answers 410 rather than a misleading 404.

## Env

```
PORT=8787
TRANSMAT_TOKEN=            # required; server refuses to start without it
DATA_DIR=./.data
STORAGE_DRIVER=local       # local | r2
PUSH_DRIVER=console        # console | apns
BLOB_SIGNING_SECRET=       # defaults to TRANSMAT_TOKEN
R2_ACCOUNT_ID= R2_ACCESS_KEY_ID= R2_SECRET_ACCESS_KEY= R2_BUCKET=
APNS_KEY_PATH= APNS_KEY_ID= APNS_TEAM_ID= APNS_BUNDLE_ID= APNS_ENV=sandbox
```

**Defaults must run with zero cloud credentials.** `local` + `console` is the dev path: files land in `$DATA_DIR/blobs`, pushes print to stdout.

## Push payload (APNs)

```json
{
  "aps": {
    "alert": {"title": "report.pdf", "subtitle": "from Kirby's iPhone", "body": "2.4 MB · tap to receive"},
    "sound": "default", "category": "TRANSFER_ARRIVED", "mutable-content": 1, "thread-id": "transmat"
  },
  "transfer_id": "...", "delivery_id": "...", "kind": "file", "file_name": "report.pdf", "size": 2516582
}
```

## Storage driver interface

```ts
interface StorageDriver {
  put(key: string, body: Readable, meta: {contentType?: string}): Promise<{size: number}>;
  signedUrl(key: string, ttlSeconds: number, filename?: string): Promise<string>;
  delete(key: string): Promise<void>;
  name: 'local' | 'r2';
}
```

## Push driver interface

```ts
interface PushDriver {
  send(device: DeviceRow, payload: object): Promise<{ok: boolean; reason?: string}>;
  name: 'console' | 'apns';
}
```
