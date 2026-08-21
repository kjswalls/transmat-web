//  QuickSendView.swift — Direction A, the command bar.
//
//  ⌘⇧T from anywhere. It arrives already carrying whatever you copied, so the
//  common case is two keystrokes: summon, Enter.
//
//  It is an NSPanel rather than a window because a panel can take focus
//  without deactivating the app you were in, and can float above everything.

import SwiftUI
import AppKit

@MainActor
final class QuickSendPanel {
    private var panel: NSPanel?
    private let store: Store

    init(store: Store) { self.store = store }

    func toggle() {
        if panel?.isVisible == true { close() } else { open() }
    }

    func open() {
        if panel == nil { build() }
        guard let panel else { return }
        // Centre on the screen the mouse is on, not the primary one — with two
        // monitors, appearing on the wrong one feels broken.
        if let screen = NSScreen.screens.first(where: { $0.frame.contains(NSEvent.mouseLocation) })
            ?? NSScreen.main {
            let frame = panel.frame
            let x = screen.frame.midX - frame.width / 2
            let y = screen.frame.midY - frame.height / 2 + screen.frame.height * 0.12
            panel.setFrameOrigin(NSPoint(x: x, y: y))
        }
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
    }

    func close() {
        panel?.orderOut(nil)
    }

    private func build() {
        let view = QuickSendView(store: store, onClose: { [weak self] in self?.close() })
        let hosting = NSHostingController(rootView: view.environmentObject(store))

        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 560, height: 380),
            styleMask: [.titled, .fullSizeContentView, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isMovableByWindowBackground = true
        panel.level = .floating
        panel.hidesOnDeactivate = true
        panel.isReleasedWhenClosed = false
        panel.contentViewController = hosting
        panel.backgroundColor = .clear
        self.panel = panel
    }
}

struct QuickSendView: View {
    let store: Store
    let onClose: () -> Void

    @State private var payload: Payload = .none
    @State private var query = ""
    @State private var selected: Set<String> = []
    @State private var cursor = 0
    @FocusState private var focused: Bool

    enum Payload: Equatable {
        case none
        case file(URL)
        case text(String)

        var label: String {
            switch self {
            case .none: return "nothing attached yet"
            case .file(let url): return url.lastPathComponent
            case .text(let s): return s.count > 60 ? String(s.prefix(60)) + "…" : s
            }
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            payloadRow
            Divider().overlay(Theme.border)
            searchRow
            Divider().overlay(Theme.border)
            targets
            Divider().overlay(Theme.border)
            footer
        }
        .background(Theme.surface)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Theme.border))
        .onAppear {
            payload = Self.readClipboard()
            focused = true
            cursor = 0
        }
        .onExitCommand(perform: onClose)
    }

    private var payloadRow: some View {
        HStack(spacing: 11) {
            RoundedRectangle(cornerRadius: 6)
                .fill(Theme.raised)
                .frame(width: 36, height: 36)
                .overlay(Image(systemName: payloadSymbol).foregroundStyle(Theme.text2))
            VStack(alignment: .leading, spacing: 2) {
                Text(payload.label)
                    .font(Theme.ui(13, .medium))
                    .foregroundStyle(payload == .none ? Theme.text3 : Theme.text)
                    .lineLimit(1)
                Text(payload == .none ? "copy something, or drop a file here" : "caught from clipboard")
                    .font(Theme.mono(10.5))
                    .foregroundStyle(Theme.text3)
            }
            Spacer()
        }
        .padding(13)
        .onDrop(of: [.fileURL], isTargeted: nil) { providers in
            providers.first.map { p in
                _ = p.loadObject(ofClass: URL.self) { url, _ in
                    if let url, url.isFileURL { Task { @MainActor in payload = .file(url) } }
                }
            }
            return true
        }
    }

    private var payloadSymbol: String {
        switch payload {
        case .none: return "tray"
        case .file: return "doc"
        case .text: return "text.alignleft"
        }
    }

    private var searchRow: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass").foregroundStyle(Theme.text3)
            TextField("Send to…", text: $query)
                .textFieldStyle(.plain)
                .font(Theme.ui(15))
                .focused($focused)
                .onSubmit { send() }
            if !selected.isEmpty {
                Text("\(selected.count) selected")
                    .font(Theme.mono(11))
                    .foregroundStyle(Theme.mint)
            }
        }
        .padding(.horizontal, 15)
        .padding(.vertical, 13)
    }

    private var matches: [Device] {
        let mine = store.devices.filter { $0.deviceID != store.settings.deviceID }
        guard !query.isEmpty else { return mine }
        return mine.filter { $0.name.localizedCaseInsensitiveContains(query) }
    }

    private var targets: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                sectionLabel("YOUR DEVICES")
                ForEach(Array(matches.enumerated()), id: \.element.id) { index, device in
                    targetRow(device, isCursor: index == cursor)
                }
                if matches.isEmpty {
                    Text("No other devices yet. Register one with the CLI or the iOS app.")
                        .font(Theme.ui(12))
                        .foregroundStyle(Theme.text3)
                        .padding(.horizontal, 15).padding(.vertical, 10)
                }
            }
        }
        .frame(maxHeight: 200)
    }

    private func sectionLabel(_ text: String) -> some View {
        Text(text)
            .font(Theme.mono(10))
            .tracking(1.3)
            .foregroundStyle(Theme.text3)
            .padding(.horizontal, 15)
            .padding(.top, 10).padding(.bottom, 6)
    }

    private func targetRow(_ device: Device, isCursor: Bool) -> some View {
        HStack(spacing: 12) {
            Image(systemName: symbol(for: device.platform))
                .foregroundStyle(Theme.text2)
                .frame(width: 18)
            Text(device.name)
                .font(Theme.ui(14, selected.contains(device.deviceID) ? .medium : .regular))
                .foregroundStyle(Theme.text)
            Spacer()
            if device.isOnline {
                Text("online").font(Theme.mono(11)).foregroundStyle(Theme.mint)
            }
            if selected.contains(device.deviceID) {
                Image(systemName: "checkmark").foregroundStyle(Theme.lilac)
            }
        }
        .padding(.horizontal, 15)
        .frame(height: 44)
        .background(isCursor ? Theme.raised : .clear)
        .contentShape(Rectangle())
        .onTapGesture { toggle(device) }
    }

    private func symbol(for platform: Platform) -> String {
        switch platform {
        case .ios:     return "iphone"
        case .android: return "candybarphone"
        case .macos:   return "laptopcomputer"
        case .web:     return "globe"
        case .cli:     return "terminal"
        }
    }

    private var footer: some View {
        HStack(spacing: 14) {
            HStack(spacing: 6) {
                Image(systemName: "clock").font(.system(size: 10))
                Text("Expires in 7 days").font(Theme.mono(11))
            }
            .foregroundStyle(Theme.text2)
            Spacer()
            Text("↵ Send").font(Theme.mono(11)).foregroundStyle(Theme.text2)
            Text("esc").font(Theme.mono(11)).foregroundStyle(Theme.text3)
        }
        .padding(.horizontal, 15)
        .padding(.vertical, 11)
        .background(Theme.canvas.opacity(0.5))
    }

    private func toggle(_ device: Device) {
        if selected.contains(device.deviceID) { selected.remove(device.deviceID) }
        else { selected.insert(device.deviceID) }
    }

    private func send() {
        // Nothing explicitly chosen means "the one under the cursor" — so the
        // common path really is summon, Enter.
        var targets = Array(selected)
        if targets.isEmpty, matches.indices.contains(cursor) {
            targets = [matches[cursor].deviceID]
        }
        guard !targets.isEmpty else { return }

        let payload = self.payload
        Task {
            for target in targets {
                switch payload {
                case .file(let url): _ = await store.uploader.send(fileURL: url, to: target)
                case .text(let s):   _ = await store.uploader.sendText(s, to: target)
                case .none:          break
                }
            }
        }
        onClose()
    }

    private static func readClipboard() -> Payload {
        let pb = NSPasteboard.general
        if let urls = pb.readObjects(forClasses: [NSURL.self]) as? [URL],
           let first = urls.first, first.isFileURL {
            return .file(first)
        }
        if let text = pb.string(forType: .string), !text.isEmpty { return .text(text) }
        return .none
    }
}
