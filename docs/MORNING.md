# Good morning ☕

Weekend 0's server, web client and CLI are **built, tested and working**. The iOS sources are written but have never seen a compiler. Here is the state of things, what I verified, what I couldn't, and what needs you.

---

## See it working in two minutes

```bash
cd transmat-web
(cd server && npm install) && (cd web && npm install) && (cd cli && npm install)

# terminal 1
cd server && npm run dev          # prints a dev token and the health URL

# terminal 2
cd web && npm run dev             # open the URL, paste the server URL + token into settings
```

No Cloudflare account, no Apple key, no secrets. Storage defaults to a local driver that signs its own URLs; push prints to your terminal. Everything works offline.

Then close the loop from a third terminal:

```bash
cd cli
node src/index.js login http://localhost:8787 <token>
node src/index.js register --name "MacBook Pro"
node src/index.js watch --dir ~/Downloads      # leave running
# from the web app, send yourself a file — it lands in ~/Downloads
```

---

## What I verified myself, by running it

Not agent claims — I ran these against a live server after the build:

- **218 server tests pass** from a clean checkout (`rm -rf node_modules .data .env && npm install && npm test`).
- **Byte-identical round trip** through the HTTP API: 300 KB file in, sha256 matched on the way out.
- **Byte-identical round trip** through the CLI: laptop A → server → laptop B over live SSE, sha256 matched, file written 0600.
- **Revoke** returns 410 afterwards and the blob is gone from disk (`blobs/` went 1 → 0).
- **Forged blob signature → 403. Tampered expiry → 403. Valid URL → 200.** Path traversal in a blob key → 404.
- **`no_targets` → 400** when the sender is the only device, and for an unknown device id.
- **SQL injection** through the search parameter is inert; the table survives.
- **64 KB text cap → 413** at 70 KB, 200 at 60 KB.
- **CORS is correct on the SSE stream and both blob hops** — one agent reported this as broken, but it was fixed later in the build and I confirmed the header is present on the live stream.
- **The web app drives the real server**: 68 transfers render, SSE says "live", ⌘K opens the command bar, keyboard navigation works, no horizontal overflow at 390 px, and the list scrolls inside the card rather than trapping content above the fold.
- **XSS is clean**: a transfer named `<img src=x onerror=alert(1)>.png` and a `javascript:` link both render as inert text — no dialog, no injected nodes, no anchor hrefs.
- **Every Swift `CodingKeys` mapping matches the server's actual JSON**, checked field by field against live responses. This was the highest-risk silent-breakage item and it is correct.

I also fixed two things I found in review: the transfer row was truncating the file size when the device list was long (the size is short and always relevant; the device list is expendable — now only the list truncates), and the spacing that fix disturbed.

---

## What I could NOT verify — treat as unproven

| Area | Why | What to do |
|---|---|---|
| **The whole iOS app** | No macOS, no Xcode, no Swift compiler here. ~3,000 lines never compiled. | Expect signature fixes. `transmat-mobile/NOTES.md §2` lists the ~10 specific Apple APIs that need checking — start there, it is a triage list, not a wall. |
| **APNs against Apple** | Tested against a local HTTP/2 server (JWT signing, headers, payload, 410 token clearing all correct) but never against `api.push.apple.com`. | TLS, the real `/3/device` behaviour and topic/bundle-id correctness need your `.p8`. |
| ~~**The R2 storage driver**~~ | **Now tested — and it was broken.** See below. | Nothing to do. |
| **The 2 GB file cap** | Proven by mechanism with a lowered cap over a real socket (abort is genuinely mid-stream, no partial blob lands) — but nobody sent 2 GB. | Fine to trust; the mechanism is what matters. |
| **Fonts in my screenshots** | This sandbox blocks `fonts.googleapis.com`, so screenshots show fallback faces, not Instrument Sans / IBM Plex Mono. | It will look better on your machine than in `web/screenshots/verified/`. |

---

## Done while you were out

**Found and fixed a real bug in the R2 driver.** It was listed as "unexercised" — so I exercised it, by running a local S3-compatible server (s3rver) and pointing the driver at it. Every upload failed with a 500: `Body: counted(body)` handed the AWS SDK a bare `AsyncGenerator`, which it does not accept. So the moment you set `STORAGE_DRIVER=r2`, storage would have been dead. Fixed with `Readable.from(...)`, which keeps the streaming byte-cap intact. Verified: 3 MB single-part and 20 MB real multipart both round-trip byte-identical through presigned GETs, and revoke deletes the object.

Nothing caught this because every other test ran the `local` driver — `r2` had never executed once. There is now `server/test/r2.test.js` covering the driver against a local S3 (no Cloudflare credentials needed); it skips cleanly if `s3rver` isn't installed. **225 tests pass.**

**Syntax-checked every Swift file.** No compiler here, but tree-sitter's Swift grammar parses all nine files in `Sources/` **without a single syntax error** — the unbalanced-brace and malformed-declaration class is ruled out before you open Xcode. One false positive is documented in `NOTES.md §8` so you don't chase it: the grammar can't handle `try? await` inside an optional-binding condition, which is valid Swift. This is not type checking — the ten unverified Apple signatures in `NOTES.md §2` are still open.

**Added deploy scaffolding** — `server/Dockerfile`, `server/fly.toml`, and [`docs/DEPLOY.md`](DEPLOY.md). The headline: **you don't need to deploy anything on Saturday.** `cloudflared tunnel --url http://localhost:8787` points a public HTTPS URL at your laptop, which is all APNs needs. Fly is there for when it becomes a daily driver. The image itself is unbuilt (no Docker daemon here) and labelled as such, but the lines that usually break — the production install and the production boot — are tested.

---

## Weekend 1 was started too

**Server half — built and tested (237 tests).** Uploads can now go *straight to storage*: reserve → PUT to a signed URL → complete. Verified end to end on both drivers, including a 1.5 MB file that went to S3 without the server seeing a byte.

The design decision behind it, which is not obvious: a background `URLSession` hands off to `nsurlsessiond` and **your process stops existing**, so multipart is out — every part uploads and `CompleteMultipartUpload` never fires ([aws-sdk-ios#3173](https://github.com/aws-amplify/aws-sdk-ios/issues/3173)). Hence a single PUT. And because a presigned URL cannot enforce `Content-Length`, the declared size is only a claim: `complete` stats what actually landed and deletes anything that does not match. Nothing is pushed or even listed until then.

**iOS half — written, uncompiled.** Share extension, notification service extension, and the reconciler that finishes uploads the extension started. See [`transmat-mobile/WEEKEND-1.md`](../../transmat-mobile/WEEKEND-1.md) for the Xcode target setup — two new targets and three capabilities that must match across all three, which is where the time will go.

The piece worth knowing about: when a background upload lands, iOS relaunches the *app*, not the extension, and the app has never heard of that transfer. So every upload writes a ledger record into the App Group before it starts, and any process can later read it and finish the job. Completion is idempotent server-side, so replaying is free.

## Your first hour: the Apple portal

This is the part only you can do, and it is the real risk in the weekend — not the code. Do it **before** writing any Swift.

1. **App ID** — developer.apple.com → Certificates, Identifiers & Profiles → Identifiers → new App ID. Bundle ID `com.kjswalls.transmat` (I defaulted to this; change it in one place if you prefer). Tick **Push Notifications**.
2. **APNs auth key** — Keys → new key → tick **Apple Push Notifications service (APNs)**. Download the `.p8`. **You get exactly one download.** Note the **Key ID** on the page and your **Team ID** from the top right.
3. Put it somewhere gitignored and fill in `.env`:
   ```
   PUSH_DRIVER=apns
   APNS_KEY_PATH=./secrets/AuthKey_XXXXXXXX.p8
   APNS_KEY_ID=...
   APNS_TEAM_ID=...
   APNS_BUNDLE_ID=com.kjswalls.transmat
   APNS_ENV=sandbox
   ```
4. **Prove a push lands before writing any UI.** Register your phone as a device, then send yourself a file with curl and watch the notification arrive. If that works by lunchtime, the rest is downhill.
5. Xcode: new iOS App project, drag in `transmat-mobile/Sources/`, add the Push Notifications capability, and copy the keys from `Support/Info-additions.plist`. Set **Swift Language Version = 5** — the code will emit strict-concurrency diagnostics under Swift 6 (noted in `NOTES.md §3`).

For iterating on how the notification *looks*, `xcrun simctl push` hits the simulator with no server round trip. Real end-to-end testing needs a physical device.

---

## Decisions waiting for you

1. **Bundle ID** — `com.kjswalls.transmat` unless you say otherwise.
2. **Nine contract amendments** the build needed (CORS, an SSE token fallback, `PUBLIC_BASE_URL`, an `internal` error code, clamping `expires_in_days` instead of rejecting, and four smaller ones). They are supersets, not changes. All recorded at the bottom of `docs/CONTRACT.md` — worth two minutes of reading to bless or veto.
3. **"People" in the command bar.** The design shows contacts; Weekend 0 has no accounts, so rather than fake Sam and Priya the group renders an honest one-line note saying contacts aren't here yet. Change it whenever contacts land.
4. **`online` is a client-side guess** (`last_seen_at` within 120 s) in both the CLI and the web app, because the contract's Device type has no such field. Worth making authoritative server-side if you want to trust it.

---

## Known rough edges, deliberately left

- `GET /v1/transfers` does an N+1 query per row. Correct, just slow at `limit=200`. Not worth restructuring for Weekend 0.
- Expiry countdowns floor, so a 3-day transfer can read "2d left" moments after creation. Under-promising on a deadline is the safe direction, and the artboard does the same.
- `transmat login <url> <token>` puts the token in argv, so it lands in shell history. Documented in `login --help`, with stdin and `TRANSMAT_TOKEN` alternatives.
- A client whose upload is refused mid-stream often sees `EPIPE` before it can read the 413. Inherent to answering before the body finishes.
- No share extension, no notification service extension, no SSE client on iOS, no pagination in the iOS app. All deliberate Weekend 1 material, listed in `NOTES.md §6`.

---

## Where things live

| Path | What |
|---|---|
| `server/` | The API. `npm test` runs 218 tests. |
| `web/` | The client — ⌘K command bar (Direction A) + live stream (Direction C). |
| `web/screenshots/verified/` | Screenshots I took against the real server. |
| `cli/` | `login`, `register`, `send`, `watch`, `ls`, `rm`, `status`. |
| `docs/CONTRACT.md` | The frozen API contract + the nine amendments. |
| `../transmat-mobile/` | Swift sources, `NOTES.md` (read this first), `Shortcut/README.md`. |
