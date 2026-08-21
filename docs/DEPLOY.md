# Getting the server where your phone can reach it

A real iPhone can only receive a push if APNs can reach your server. Three options, cheapest first.

## 1. A tunnel — do this on Saturday

**You do not need to deploy anything to test push on a real phone.** Point a tunnel at the server already running on your laptop:

```bash
# terminal 1
cd server && npm run dev

# terminal 2 — either of these
cloudflared tunnel --url http://localhost:8787
ngrok http 8787
```

Put the resulting `https://…` URL into the iOS app's settings and the Shortcut. That is the whole setup. Restarting the tunnel changes the URL, which is the only annoyance — fine for a weekend, wrong for a daily driver.

## 2. Fly.io — when it becomes your daily driver

`fly.toml` and `Dockerfile` are in `server/`.

```bash
cd server
fly launch --no-deploy --copy-config      # claim a name; edit primary_region first
fly volumes create transmat_data --size 3 # SQLite + blobs; without it a redeploy wipes everything
fly secrets set TRANSMAT_TOKEN="$(openssl rand -base64 32)"
fly deploy
```

Then the APNs secrets. The `.p8` is a file, so pass it as base64 and have the app write it out, or bake it into the image via a build secret — **do not commit it**:

```bash
fly secrets set APNS_KEY_ID=... APNS_TEAM_ID=... APNS_BUNDLE_ID=com.kjswalls.transmat APNS_ENV=sandbox
fly secrets set APNS_KEY_B64="$(base64 -w0 secrets/AuthKey_XXXXXXXX.p8)"
```

Two settings in `fly.toml` are deliberate and worth not "optimising" later: **`auto_stop_machines = false`** and **`min_machines_running = 1`**. A sleeping machine cannot send a push, and SSE clients hold long-lived connections that a scale-to-zero setup will keep tearing down.

Switching to R2 is then `fly secrets set STORAGE_DRIVER=r2 R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… R2_BUCKET=transmat`. The driver is tested (`server/test/r2.test.js` runs it against a local S3), but it has still never spoken to Cloudflare.

## 3. Anywhere else

The Dockerfile is unremarkable — Node 22 Alpine, `npm ci --omit=dev`, `node src/index.js` as PID 1. It needs exactly two things from the host: a writable volume at `DATA_DIR` and the env vars in `.env.example`. Railway, Render or a VPS all work the same way.

## Verified vs. not

| | |
|---|---|
| ✅ `npm ci --omit=dev` installs cleanly and the runtime needs no devDependency | tested |
| ✅ `NODE_ENV=production` refuses to boot without `TRANSMAT_TOKEN` | tested |
| ✅ Serves and authenticates under production env | tested |
| ✅ Exits cleanly on `SIGTERM` (matters when node is PID 1) | tested |
| ⚠️ **The image itself has never been built** — no Docker daemon in the environment that wrote it | unverified |
| ⚠️ `fly.toml` has never been deployed | unverified |

Expect a small fix or two on first deploy. The lines that usually break — the install and the production boot — are the ones that were tested.
