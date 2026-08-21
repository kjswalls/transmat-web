//  App.swift — the menu bar shell.
//
//  No windows, no Dock icon (Info.plist: Application is agent = YES). The
//  whole app is a status item, a popover, and a quick-send panel summoned by
//  a global hotkey.

import SwiftUI
import AppKit
import ServiceManagement
import Carbon.HIToolbox
import os

private let log = Logger(subsystem: "com.kjswalls.transmat.desktop", category: "app")

@main
struct TransmatApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        // Everything lives in the status item. Settings gets a real window
        // because a popover is a miserable place to type a URL and a token.
        Settings {
            SettingsView()
                .environmentObject(delegate.store)
                .environmentObject(delegate.store.settings)
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let store = Store()

    private var statusItem: NSStatusItem!
    private var popover: NSPopover!
    private var quickSend: QuickSendPanel!
    private var hotKey: GlobalHotKey?
    private var observers: [Any] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildStatusItem()
        buildPopover()
        quickSend = QuickSendPanel(store: store)

        // ⌘⇧T from anywhere. Carbon rather than an event monitor: this works
        // without Accessibility permission and actually consumes the key.
        hotKey = GlobalHotKey(keyCode: UInt32(kVK_ANSI_T), modifiers: UInt32(cmdKey | shiftKey)) { [weak self] in
            self?.quickSend.toggle()
        }

        observers.append(
            NotificationCenter.default.addObserver(
                forName: .transmatDidReceive, object: nil, queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated { self?.handleArrival() }
            }
        )

        Task { await store.start() }
        registerLoginItem()
    }

    func applicationWillTerminate(_ notification: Notification) {
        observers.forEach(NotificationCenter.default.removeObserver)
        Task { await store.stop() }
    }

    // MARK: Status item

    private func buildStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        guard let button = statusItem.button else { return }
        button.image = NSImage(
            systemSymbolName: "arrow.up.circle", accessibilityDescription: "Transmat"
        )
        button.image?.isTemplate = true          // follows the menu bar's appearance
        button.action = #selector(togglePopover)
        button.target = self

        // Files dropped on the menu bar icon are sent. Cheap, and the first
        // thing anyone tries.
        button.window?.registerForDraggedTypes([.fileURL])
    }

    private func handleArrival() {
        updateBadge()
        switch store.settings.arrival {
        case .open:   showPopover()
        case .badge:  break        // the badge above is the whole notification
        case .silent: break
        }
    }

    private func updateBadge() {
        guard let button = statusItem.button else { return }
        button.image = NSImage(
            systemSymbolName: store.unseen > 0 ? "arrow.down.circle.fill" : "arrow.up.circle",
            accessibilityDescription: "Transmat"
        )
        button.image?.isTemplate = true
    }

    // MARK: Popover

    private func buildPopover() {
        popover = NSPopover()
        popover.behavior = .transient        // closes when you click away
        popover.animates = true
        popover.contentSize = NSSize(width: 420, height: 520)
        popover.contentViewController = NSHostingController(
            rootView: HubView()
                .environmentObject(store)
                .environmentObject(store.settings)
        )
    }

    @objc private func togglePopover() {
        popover.isShown ? popover.performClose(nil) : showPopover()
    }

    private func showPopover() {
        guard let button = statusItem.button else { return }
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        // Without this the popover appears behind whatever is frontmost.
        popover.contentViewController?.view.window?.makeKey()
        store.markSeen()
        updateBadge()
    }

    // MARK: Login item

    /// Resident by choice: this app has no push, so it has to be running to
    /// hear anything (README, "The one architectural decision worth knowing").
    private func registerLoginItem() {
        do {
            if SMAppService.mainApp.status != .enabled {
                try SMAppService.mainApp.register()
            }
        } catch {
            // Not fatal — the app works, it just will not come back after a
            // reboot until the user enables it in System Settings.
            log.info("could not register as a login item: \(error.localizedDescription, privacy: .public)")
        }
    }
}

// MARK: - Global hot key

/// A system-wide hot key via Carbon.
///
/// Carbon looks archaic and is: `RegisterEventHotKey` is the only supported
/// way to claim a system-wide shortcut without Accessibility permission, and
/// unlike `NSEvent.addGlobalMonitorForEvents` it actually *consumes* the key
/// so the frontmost app never sees it. It is still the standard answer.
final class GlobalHotKey {
    private var ref: EventHotKeyRef?
    private var handler: EventHandlerRef?
    private let action: () -> Void
    private static var registry: [UInt32: GlobalHotKey] = [:]
    private static var nextID: UInt32 = 1

    init?(keyCode: UInt32, modifiers: UInt32, action: @escaping () -> Void) {
        self.action = action

        let id = GlobalHotKey.nextID
        GlobalHotKey.nextID += 1
        GlobalHotKey.registry[id] = self

        var hotKeyID = EventHotKeyID(signature: OSType(0x544D_4154), id: id)  // 'TMAT'
        var eventType = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyPressed)
        )

        InstallEventHandler(GetApplicationEventTarget(), { _, event, _ -> OSStatus in
            var received = EventHotKeyID()
            GetEventParameter(
                event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                nil, MemoryLayout<EventHotKeyID>.size, nil, &received
            )
            if let target = GlobalHotKey.registry[received.id] {
                DispatchQueue.main.async { target.action() }
            }
            return noErr
        }, 1, &eventType, nil, &handler)

        let status = RegisterEventHotKey(
            keyCode, modifiers, hotKeyID, GetApplicationEventTarget(), 0, &ref
        )
        // Most likely cause of failure: another app already owns the combo.
        guard status == noErr else { return nil }
    }

    deinit {
        if let ref { UnregisterEventHotKey(ref) }
        if let handler { RemoveEventHandler(handler) }
    }
}
