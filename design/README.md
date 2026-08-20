# Design source

Working files for the **[Transmat UI Directions](https://claude.ai/code/artifact/a9c192c8-2b7c-4828-b55a-160f385fb1eb)** canvas.

| File | Artboard |
|---|---|
| `Main.dc.html` | Direction A — Command bar |
| `Launchpad.dc.html` | Direction B — Launch pad |
| `Stream.dc.html` | Direction C — Stream |
| `Arrival.dc.html` | The arrival moment, macOS + iOS |
| `Handoff.dc.html` | iOS share sheet + library |
| `Delight.dc.html` | Eight delight candidates |
| `canvas.json` | Layout, pages, notes |

These are the source of truth — the published canvas is re-seeded from them, and the seeded `.html` is a build output (gitignored, ~2 MB).

## Visual language

Dark, dense, high-contrast. Monospace carries anything technical (byte sizes, expiry, device state) because those *are* technical values, not decoration.

| Token | Value | Use |
|---|---|---|
| Canvas | `#0E1116` | Behind the app window |
| Surface | `#171B22` | App background |
| Raised | `#232936` | Selected rows, thumbnails |
| Border | `#2A303B` | Dividers, card edges |
| Text | `#ECEFF4` / `#A3ACBB` / `#6E7888` | Primary / secondary / faint |
| **Lilac** | `#9C8CF5` | Sending, primary action |
| **Mint** | `#55C9A2` | Arriving, online, success |
| Clay | `#C98A72` | Expiring soon |

Lilac and mint sit at matching lightness and chroma, differing only in hue — so they read as a pair doing semantic work (out vs. in) rather than as decoration.

Type: **Instrument Sans** for UI, **IBM Plex Mono** for metadata. Icons are inline stroke SVG on a 20px grid at 1.4–1.6 stroke — never emoji.
