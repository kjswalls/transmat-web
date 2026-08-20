# Transmat

*Email-to-self, minus email.* Async, store-and-forward file transfer between your devices and contacts — AirDrop's sending ergonomics, a doorbell on the receiving end.

- 📐 **[Architecture](docs/ARCHITECTURE.md)** — stack options weighed, transfer flow, data model, the iOS deep-dive, settled decisions, build order
- 🔨 **[Weekend 0 spec](docs/WEEKEND-0.md)** — the end-to-end MVP flow: API surface, push payload, iOS callbacks, definition of done
- 📦 **[Plain English explainer](docs/EXPLAINER.md)** — the same system with no jargon, an ELI10 of every piece including encryption, and what's buildable in a weekend

Repos: `transmat-web` (API + web app), [`transmat-mobile`](https://github.com/kjswalls/transmat-mobile) (iOS/Android client).

Status: brainstorm / pre-code. Next step is **Weekend 0** — the doorbell proof: a minimal native iOS receive app on real APNs, sending via an iOS Shortcut, spanning both repos.
