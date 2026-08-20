# Transmat API server

The spine. Every other component talks to this. Built exactly to
[`docs/CONTRACT.md`](../docs/CONTRACT.md).

```bash
npm install
npm run dev      # http://localhost:8787
npm test
```

**Zero credentials required.** With no `.env` present the server mints a
development token, writes it to `server/.env`, and prints it on boot. Storage
defaults to `local` (bytes in `$DATA_DIR/blobs`, download URLs signed with
HMAC-SHA256 against our own `/blob/:key` route) and push defaults to `console`
(pushes are printed to stdout).

## Layout

| File | Does |
|---|---|
| `src/config.js` | Env loading, contract defaults, dev-token generation |
| `src/db.js` | `node:sqlite` schema + query functions (no raw handle escapes) |
| `src/storage.js` | `StorageDriver`: `local` (signed `/blob/:key`) and `r2` (presigned S3) |
| `src/push.js` | `PushDriver`: `console` and `apns` (ES256 JWT over HTTP/2, `node:http2`) |
| `src/events.js` | SSE hub — per-device filtering, 25s keepalives, leak-free teardown |
| `src/multipart.js` | Streaming `multipart/form-data`; caps enforced mid-stream |
| `src/transfers.js` | Targeting, kind inference, expiry, push fan-out |
| `src/routes/*.js` | One file per route group |
| `src/sweep.js` | Expiry sweep — deletes bytes, keeps history |
| `src/body.js` | Capped request-body reader — no JSON route ever buffers unbounded |
| `src/app.js` | Hono app: CORS, bearer auth on `/v1`, error envelope |
| `src/index.js` | Boot, banner, graceful shutdown |

## Environment

Everything in the contract's `Env` block, plus two additions:

| Var | Default | Why |
|---|---|---|
| `PUBLIC_BASE_URL` | `http://localhost:$PORT` | The `local` driver has to put an absolute URL in its 302 |
| `APNS_HOST` | Apple's host for `APNS_ENV` | Lets the APNs driver be pointed at a test server |
| `DB_PATH` | `$DATA_DIR/transmat.db` | Convenience |
| `SWEEP_INTERVAL_MS` | `60000` | Expiry sweep cadence |
| `LOG_REQUESTS` | `true` | Per-request log line |

A `.env` is read from the repo root first, then `server/`, then the current
directory — later files win, and real environment variables beat all of them.

## Switching to the cloud path

```
STORAGE_DRIVER=r2   R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… R2_BUCKET=…
PUSH_DRIVER=apns    APNS_KEY_PATH=… APNS_KEY_ID=… APNS_TEAM_ID=… APNS_BUNDLE_ID=… APNS_ENV=sandbox
```

Both are validated at boot: a half-configured driver refuses to start rather
than failing on the first upload.

## Request limits

The contract fixes the first two; the rest exist because the only thing that
may be unbounded on this server is a multipart *file* part, and that one
streams straight into the storage driver instead of into memory.

| Limit | Value | Over the limit |
|---|---|---|
| File part | 2 GB | `413 too_large`, aborted mid-stream |
| `text` payload | 64 KB | `413 too_large` |
| JSON body on `POST /v1/transfers` | 80 KB | `413 too_large` |
| JSON body on the `/v1/devices` routes | 16 KB | `413 too_large` |
| Device `name` | 200 chars | `400 bad_request` |
| Device `push_token` | 512 chars | `400 bad_request` |
| Undelivered SSE per subscriber | 8 MB | the stream is dropped |
