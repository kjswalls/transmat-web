# Transmat — web client

Vite + React, plain JS. Two surfaces from the design canvas, combined:

- **Command bar** (Direction A) — `⌘K` from anywhere. Carries whatever you are sending
  (a dropped file, pasted clipboard text, a pasted link) and a filterable target list.
  `↑↓` move, `⇥` adds another target, `↵` sends, `esc` closes, `⌃E` cycles retention,
  `⌘U` attaches a file. Focus is trapped while it is open.
- **Stream** (Direction C) — composer strip, filter row (All / Sent / Received / Links /
  Expiring) with `⌘F` search, and a dense chronological list of everything that has moved.
  Clicking a file row downloads it; clicking a text or link row copies it.

## Run it

```bash
npm install
npm run dev:mock     # mock API on :8787 + app on :5173, zero credentials
```

Or against the real server:

```bash
cd ../server && npm install && npm run dev     # :8787
cd ../web && npm run dev                       # :5173
```

First launch asks for the **server URL** and **access token** (the server's
`TRANSMAT_TOKEN`). Both live in `localStorage` — nothing secret is ever in the repo.
The browser registers itself over `POST /v1/devices` as `platform: "web"`,
`push_channel: "none"`, so it can receive; its `device_id` is shown in settings (`⌘,`)
ready to paste into the iOS Shortcut's `from` field.

## Verify

```bash
npm run build
npm run verify                                   # happy path vs. the mock       -> screenshots/
npm run verify:hostile                           # adversarial pass              -> screenshots/hostile/
REAL_SERVER=http://localhost:8901 npm run verify:real
```

All three drive the **built** bundle with Playwright and write PNGs.

`verify` proves the product works. `verify:hostile` tries to break it, against
`mock/hostile.js`: markup and `javascript:` / `data:` URLs in every string field, a
200-character filename, a 40-line note, an 85-character device name, 500 rows, byte
and expiry boundary values, transfers with no `deliveries` array, duplicated and
malformed SSE frames, a stream that gets dropped mid-flight, a stream with no CORS
header, an unreachable server, a rejected token, and viewports from 1280 down to
320px. It also checks the keyboard path end to end — open, navigate, select, send,
revoke, Escape, and where focus lands afterwards.

Ports are env-overridable on every harness (`MOCK_PORT`, `WEB_PORT`,
`HOSTILE_PORT`, …) so a run doesn't collide with a server you already have up.

## Layout

| Path | What |
|---|---|
| `src/lib/api.js` | The whole API surface from `docs/CONTRACT.md`, plus SSE-over-fetch |
| `src/lib/format.js` | Bytes, relative time, expiry countdowns, direction |
| `src/lib/icons.jsx` | Inline stroke SVG on a 20px grid — no emoji, no icon font |
| `src/hooks/useTransmat.js` | Settings → self-registration → devices + transfers + live events |
| `src/components/` | `CommandBar`, `Composer`, `Stream`, `TransferRow`, `SettingsPanel` |
| `src/styles/app.css` | Design tokens as custom properties; no Tailwind |
| `mock/server.js` | Contract-shaped mock so the UI runs with nothing else installed |
| `mock/hostile.js` | The same contract, filled with data designed to break the client |

## Notes

- `EventSource` cannot send an `Authorization` header and `/v1/events` is a bearer
  route, so the stream is read with `fetch` + `ReadableStream`. Same endpoint, same
  wire format, with reconnect backoff.
- If the event stream is unavailable the client falls back to polling
  `GET /v1/transfers` every 5s and the status pill reads `polling` instead of `live`.
- **Nothing from the server is ever turned into an `href` or into markup.** Link rows
  render as text, and a non-`http(s)` URL keeps its scheme on screen so a
  `javascript:` payload cannot pose as an ordinary link.
- **This browser's identity is stable.** With no `push_token`, `POST /v1/devices`
  upserts on `name`+`platform` (CONTRACT.md), so re-posting a renamed browser would
  create a second device and orphan the old `device_id`. Once we hold a `device_id`
  we `PATCH /v1/devices/:id` instead, and only fall back to `POST` on a 404 — which
  is also what makes pointing the app at a different server work.
- The typeface comes from Google Fonts. Offline, the fallback stack
  (`system-ui` / `ui-monospace`) takes over and the layout is unaffected, but the
  page is not pixel-identical to the artboards.
