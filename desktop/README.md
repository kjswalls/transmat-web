# Transmat for macOS

The menu bar Transfer Hub: arrivals drop from the status bar, everything you have ever moved is one keystroke away, and you can drag a received file straight out into whatever asked for it.

> **Status: written, never compiled.** No macOS or Xcode in the environment that wrote this. Treat every Apple API signature as unverified — `NOTES.md` lists the ones to check first.

> **This should be its own repo.** It lives here because the machine that wrote it could not create `kjswalls/transmat-desktop`, and unpushed work would have been lost. To split it out with history intact:
> ```bash
> git subtree split --prefix=desktop -b desktop-only
> # create transmat-desktop on GitHub, then:
> git push git@github.com:kjswalls/transmat-desktop.git desktop-only:main
> ```

## The one architectural decision worth knowing

**This app does not use APNs.** It registers as a login item and holds an SSE connection to the server, so it already knows about a transfer the moment the server does — a push would tell it nothing it does not have.

That is not a shortcut, it is the right shape for a resident app, and it removes an entire category of pain: no push entitlement, no `aps-environment`, no provisioning profile juggling for a Developer-ID build, no `content-available` delivery rules. macOS only delivers background pushes to a *running* app anyway (ARCHITECTURE §3c), so for an app that is always running they add nothing.

If the app is not running when something arrives, it catches up on launch by listing transfers — same reconciliation the CLI does.

## What it does

| | |
|---|---|
| **Menu bar** | `NSStatusItem`, no Dock icon (`LSUIElement`). Click for the Hub. |
| **Arrival** | The Hub pops open (or just badges — configurable, so Focus is respected) with sender, size, retention control, and Accept/Decline. |
| **Library** | Everything, searchable, filterable by device and direction — Direction C from the design canvas. |
| **Quick send** | A global hotkey opens the command bar — Direction A. Carries whatever you copied. |
| **Drag out** | Pull a received file off the card and drop it anywhere. The reason this app is native. |
| **Drop target** | Drop files onto the Hub or the status item to send them. |
| **Auto-save** | Accepted files land in `~/Transmat` (configurable). |

## Xcode setup

1. **New project → macOS → App**, SwiftUI, name `Transmat`. Bundle id `com.kjswalls.transmat.desktop`.
2. Drag in `Transmat/` from this folder.
3. **Info.plist**: add `Application is agent (UIElement)` = `YES`. That is what removes the Dock icon.
4. **Signing & Capabilities**: add **App Sandbox** → tick *Outgoing Connections (Client)*, and *User Selected File* + *Downloads folder* read/write. Add **Keychain Sharing** if you want to share the token with a future iOS build on the same Mac (not required).
5. Build and run. On first launch, paste your server URL and token, exactly as with the iOS app.

There is no `.xcodeproj` here on purpose — one generated blind is a liability.

## Files

| Path | Role |
|---|---|
| `Transmat/App.swift` | `@main`, status item, popover, global hotkey, login item |
| `Transmat/Theme.swift` | The design tokens from `design/README.md` |
| `Transmat/Models/Settings.swift` | Server URL + token (Keychain), save folder, arrival behaviour |
| `Transmat/Models/API.swift` | The API client, including the presigned upload path |
| `Transmat/Models/Store.swift` | Observable transfer list, the single source of truth for the UI |
| `Transmat/Services/EventStream.swift` | SSE client with backoff and catch-up |
| `Transmat/Services/Receiver.swift` | Auto-download and save arrivals |
| `Transmat/Services/Uploader.swift` | Presigned upload, shared by drop target and quick send |
| `Transmat/Views/HubView.swift` | The popover — arrival + library |
| `Transmat/Views/QuickSendView.swift` | The command bar |
| `Transmat/Views/TransferRow.swift` | One row, including drag-out |
