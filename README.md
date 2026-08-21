# Transmat

*Email-to-self, minus email.* Async, store-and-forward file transfer between your devices and contacts — AirDrop's sending ergonomics, a doorbell on the receiving end.

- ☕ **[Morning handoff](docs/MORNING.md)** — what's built, what's verified, what needs you, and the Apple portal sequence
- 📐 **[Architecture](docs/ARCHITECTURE.md)** — stack options weighed, transfer flow, data model, the iOS deep-dive, settled decisions, build order
- 🚀 **[Deploy](docs/DEPLOY.md)** — tunnel for Saturday, Fly for later
- 🔨 **[Weekend 0 spec](docs/WEEKEND-0.md)** — the end-to-end MVP flow: API surface, push payload, iOS callbacks, definition of done
- 📦 **[Plain English explainer](docs/EXPLAINER.md)** — the same system with no jargon, an ELI10 of every piece including encryption, and what's buildable in a weekend

Repos: `transmat-web` (API + web app), [`transmat-mobile`](https://github.com/kjswalls/transmat-mobile) (iOS/Android client).

## Run it

```bash
(cd server && npm install && npm run dev)   # terminal 1 — prints a dev token
(cd web && npm install && npm run dev)      # terminal 2 — paste the token into settings
```

No cloud credentials needed: storage defaults to a local driver, push prints to your terminal.

| | |
|---|---|
| `server/` | Hono + node:sqlite API. 237 tests. Pluggable storage (local / R2) and push (console / APNs). |
| `web/` | ⌘K command bar for sending, live stream for browsing. |
| `cli/` | `transmat send` / `watch` — makes a laptop a real device. |
| [`transmat-mobile`](https://github.com/kjswalls/transmat-mobile) | SwiftUI receive app + share/notification extensions. **Uncompiled** — needs Xcode. |
| `desktop/` | macOS menu bar Transfer Hub. **Uncompiled** — needs Xcode. Belongs in its own repo; see `desktop/README.md`. |

Status: Weekend 0 server, web and CLI are working end to end. iOS is written and waiting on a compiler.
