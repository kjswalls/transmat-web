# What to check first, before trusting any of this

Nothing here has been compiled. These are the specific things most likely to be wrong.

## 1. Apple APIs I could not verify

| API | File | Why it is risky |
|---|---|---|
| `RegisterEventHotKey` / `InstallEventHandler` | `App.swift` | Carbon, C callbacks, and a static registry to get from the C handler back to an instance. Most likely thing here to not compile. If it fights you, drop the hotkey first and keep the status item. |
| `SMAppService.mainApp.register()` | `App.swift` | Throws if the app is not signed or not in `/Applications`. Non-fatal by design — the app runs, it just will not relaunch after a reboot. |
| `NSApp.sendAction(Selector(("showSettingsWindow:")))` | `HubView.swift` | The modern spelling; the older `showPreferencesWindow:` is gone. Selector-by-string means a typo fails silently at runtime. |
| `NSItemProvider(contentsOf:)` for drag-out | `TransferRow.swift` | The whole reason this app is native. Verify a real drag into Finder and into Mail early. |
| `URLSession.bytes(for:)` line iteration | `EventStream.swift` | The SSE parse depends on `.lines` behaving on a stream that never ends. |
| `url.bookmarkData(options: .withSecurityScope)` | `Settings.swift`, `SettingsView.swift` | Sandbox-only semantics. Without the right entitlement this returns nil and the save folder silently reverts to `~/Transmat`. |
| `MainActor.assumeIsolated` | `App.swift` | Used inside a NotificationCenter block. If this trips an assertion at runtime, replace with `Task { @MainActor in … }`. |

## 2. Design decisions, so they read as decisions and not oversights

- **No APNs.** See the README. A resident login item on SSE already knows everything a push would tell it, and macOS only delivers background pushes to a running app anyway. This removes the entire push-entitlement problem from a Developer-ID build.
- **The retention control on the arrival card is display-only.** There is no per-recipient retention endpoint in the v1 contract — `expires_in_days` is write-once at creation. The control is drawn because the design calls for it; wire it when the API grows a `recipients` resource.
- **No Decline.** Same reason: nothing to call. "Dismiss" is honest about what it does — it clears the card and leaves the file alone.
- **Auto-accept is currently every file.** The setting says "from my devices", but with no accounts yet every device is one of yours. Gate it on sender identity when contacts land.

## 3. Known gaps

- Pagination is ignored (`limit: 100`), same as every other client.
- `online` is inferred from `last_seen_at` within 120s — a hint, not a fact. The web app currently uses 5 minutes for the same idea, which is drift worth fixing in one place.
- The quick-send bar has no keyboard navigation of the target list yet (arrow keys do not move `cursor`); click or type-to-filter works, and Enter sends to the cursor row.
- Nothing prunes old entries from the saved-files index if you delete files by hand — it self-heals on read (`localFile` checks existence) but the dictionary grows.
