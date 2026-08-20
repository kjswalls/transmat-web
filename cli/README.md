# transmat CLI

The half of the loop that makes a laptop a real device: `transmat watch` gives a
file sent from the phone somewhere to land, and `transmat send` puts things the
other way.

Plain JavaScript, ESM, **zero runtime dependencies** — Node 22's `fetch`,
`node:util`'s `parseArgs`, and `node:crypto` are the whole toolbox.

```bash
cd cli && npm install          # installs nothing; there is nothing to install
node src/index.js --help
npm link                       # optional: puts `transmat` on your PATH
```

## The five-minute version

```bash
# 1. point at a server (token is stored 0600 and never printed back)
transmat login http://localhost:8787 dev-token-change-me

# 2. become a device
transmat register --name "Kirby's MacBook"

# 3. leave the receiver running
transmat watch &

# 4. send something the other way
transmat send ~/Desktop/report.pdf --to "Kirby's iPhone"
```

## Commands

| Command | What it does |
|---|---|
| `login <url> <token>` | Saves `~/.config/transmat/config.json` at 0600. Verifies the URL and token first; saves nothing if the token is rejected. Omit the token and it is read from stdin — on a shared machine prefer that, since an argument is visible in `ps` while the command runs. |
| `register [--name]` | Registers this machine — platform `cli`, `push_channel: none`. Upserts, so running it twice is safe. |
| `devices` | Every registered device, with an online marker derived from `last_seen_at`. |
| `send <path...>` | One transfer per file, streamed as `multipart/form-data`. `-` reads stdin. `--text` / `--link` send clipboard-style payloads. |
| `watch` | SSE receiver: downloads what's addressed here, acks it, prints a line. |
| `ls` | Recent transfers, in or out, with delivery state. |
| `rm <transfer_id...>` | Revoke: the server deletes the bytes and tells every device. |
| `status` | What config is in effect, whether the server answers, whether the token works. |

`--json` on `devices`, `ls`, `status`, `send` and `watch` gives machine-readable
output; `watch --json` emits newline-delimited JSON, one object per arrival.

```bash
transmat devices --json | jq -r '.devices[] | select(.online) | .name'
transmat watch --json | while read -r line; do open "$(jq -r .path <<<"$line")"; done
```

## Things worth knowing

**Nothing is buffered.** A 1 GB send and its matching receive each peak around
105 MB of RSS, flat in the size of the file: the upload is a hand-rolled
multipart generator wrapped around a read stream, and the download is a
`pipeline()` into a file.

The upload leg deliberately uses `node:http` rather than `fetch`. Undici
accumulates a streaming request body instead of applying socket backpressure —
measured on Node 22.22.2, the same 1 GB file through `fetch` peaked at 1047 MB
RSS, which at the contract's 2 GB ceiling is an out-of-memory kill. Response
bodies stream fine, so everything else still goes through `fetch`.

**Files never clobber.** `report.pdf` arriving twice becomes `report.pdf` and
`report (2).pdf`. The name is claimed with `O_EXCL`, so two watchers on one
directory can't both win it, and bytes land in a hidden `.part` file first — the
real name only ever appears complete.

**Everything from the network is untrusted, not just filenames.**
`../../etc/passwd` lands as `passwd`; control characters and `<>:"|?*` are
stripped. The same goes for `transfer_id`, which is pasted into the `.part`
filename, and for the fallback name used when `file_name` is null — both are
scrubbed, and every path is checked to resolve inside the download directory
before anything is opened.

**`watch` survives the server going away.** It reconnects with exponential
backoff and full jitter (1s → 30s), and on every reconnect it polls
`GET /v1/transfers` for anything sent while it was gone. The poll runs *after*
the stream is live so the two windows overlap and nothing falls between them,
and it follows `next_cursor` rather than looking only at the newest page — 105
things sent to an offline laptop all arrive, not the newest 100. Every transfer
is remembered by id, so seeing it twice costs nothing.

**A silent connection counts as a dropped one.** Three missed keepalives (75s)
and the stream is dropped and re-established, which is what makes a sleeping
laptop or a changed network resume instead of sitting there looking connected.
A download that delivers no bytes for 60s is abandoned the same way; nothing on
the receive path waits without a deadline.

**A download that fails is not acked** — it gets retried on the next reconnect.
A revoked or expired one is dropped rather than retried forever.

**An ack that fails does not cause a second download.** The bytes are already
on disk, so the transfer is recorded in `receipts.json` (next to the config,
0600, most recent 500) and the ack is retried instead. Without it a server that
dies between the last byte and the ack leaves you with `report (2).pdf`.

**The bearer token is never sent to the signed blob URL.** `GET
/v1/transfers/:id/blob` returns a 302; the redirect is followed by hand with the
`Authorization` header dropped, because on a real deployment that URL points at
R2.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | fine |
| 1 | something failed |
| 2 | usage error — unknown flag, missing argument |
| 3 | not logged in, or not registered |
| 4 | the server rejected the token |
| 5 | the server is unreachable |
| 6 | no such transfer / device / file |

## Configuration

`~/.config/transmat/config.json` (or `$XDG_CONFIG_HOME/transmat/`), written
0600 inside a 0700 directory. Environment variables override it:

| Variable | Effect |
|---|---|
| `TRANSMAT_CONFIG` | use a different config file entirely |
| `TRANSMAT_URL` | override the server URL |
| `TRANSMAT_TOKEN` | override the token |
| `TRANSMAT_DEVICE_ID` | act as a different device |
| `NO_COLOR` | plain output (so does `--no-color`) |
| `TRANSMAT_DEBUG` | print a stack trace on an unexpected error |

## Tests

```bash
npm test          # 39 unit tests, no network, no server
npm run test:e2e  # starts ../server for real and moves actual bytes
```

The end-to-end script registers two devices against a live server, sends a 4 MB
file from one, receives it on the other, and compares sha256 at both ends — then
exercises text/link/stdin, collisions, ack, revoke, catch-up-after-disconnect,
and every exit code.
