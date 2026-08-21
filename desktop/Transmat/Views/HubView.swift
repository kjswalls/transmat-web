//  HubView.swift — the popover. Direction C (the stream) with Direction A's
//  arrival card on top when something just landed.

import SwiftUI
import UniformTypeIdentifiers

struct HubView: View {
    @EnvironmentObject private var store: Store
    @EnvironmentObject private var settings: Settings

    @State private var query = ""
    @State private var filter: HubFilter = .all
    @State private var dropTargeted = false

    var body: some View {
        VStack(spacing: 0) {
            header
            if let arriving = store.arriving, arriving.state == .complete {
                ArrivalCard(transfer: arriving)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
            composer
            filters
            Divider().overlay(Theme.border)
            list
        }
        .frame(width: 420, height: 520)
        .background(Theme.surface)
        .animation(.easeOut(duration: 0.18), value: store.arriving)
        .onDrop(of: [.fileURL], isTargeted: $dropTargeted) { providers in
            handleDrop(providers)
            return true
        }
        .overlay {
            if dropTargeted {
                RoundedRectangle(cornerRadius: Theme.radius)
                    .strokeBorder(Theme.lilac, style: StrokeStyle(lineWidth: 2, dash: [6, 4]))
                    .padding(6)
            }
        }
        .onAppear { store.markSeen() }
    }

    private var header: some View {
        HStack(spacing: 9) {
            Image(systemName: "arrow.up.circle.fill")
                .foregroundStyle(Theme.lilac)
            Text("TRANSMAT")
                .font(Theme.mono(11, .medium))
                .tracking(1.4)
                .foregroundStyle(Theme.text)
            statusDot
            Spacer()
            Button { openSettings() } label: {
                Image(systemName: "gearshape")
            }
            .buttonStyle(.plain)
            .foregroundStyle(Theme.text3)
        }
        .padding(.horizontal, 13)
        .padding(.vertical, 11)
    }

    private var statusDot: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(store.status == .live ? Theme.mint : Theme.text3)
                .frame(width: 5, height: 5)
            Text(statusLabel)
                .font(Theme.mono(10))
                .foregroundStyle(store.status == .live ? Theme.mint : Theme.text3)
        }
    }

    private var statusLabel: String {
        switch store.status {
        case .live:       return "live"
        case .connecting: return "connecting"
        case .idle:       return "idle"
        case .offline:    return "offline"
        }
    }

    private var composer: some View {
        HStack(spacing: 8) {
            Image(systemName: "arrow.up")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Theme.lilac)
            Text("Drop a file, or press ⌘V to send your clipboard")
                .font(Theme.ui(12.5))
                .foregroundStyle(Theme.text3)
            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(Theme.field)
        .clipShape(RoundedRectangle(cornerRadius: Theme.radius))
        .padding(.horizontal, 13)
        .padding(.bottom, 10)
        .onTapGesture { Task { await store.uploader.sendClipboard() } }
    }

    private var filters: some View {
        HStack(spacing: 4) {
            ForEach(HubFilter.allCases) { f in
                Button { filter = f } label: {
                    Text(f.label)
                        .font(Theme.mono(10.5))
                        .padding(.horizontal, 9)
                        .padding(.vertical, 4)
                        .background(filter == f ? Theme.raised : .clear)
                        .foregroundStyle(filter == f ? Theme.text : Theme.text3)
                        .clipShape(RoundedRectangle(cornerRadius: Theme.radiusSmall))
                }
                .buttonStyle(.plain)
            }
            Spacer()
            Image(systemName: "magnifyingglass")
                .font(.system(size: 10))
                .foregroundStyle(Theme.text3)
            TextField("Search", text: $query)
                .textFieldStyle(.plain)
                .font(Theme.ui(11.5))
                .frame(width: 110)
        }
        .padding(.horizontal, 13)
        .padding(.bottom, 9)
    }

    @ViewBuilder private var list: some View {
        let rows = store.filtered(query: query, filter: filter)
        if rows.isEmpty {
            VStack(spacing: 7) {
                Spacer()
                Text(store.transfers.isEmpty ? "Nothing yet" : "Nothing matches")
                    .font(Theme.ui(13))
                    .foregroundStyle(Theme.text2)
                Text(store.transfers.isEmpty
                     ? "Send something from your phone and it lands here."
                     : "Try a different filter.")
                    .font(Theme.ui(11.5))
                    .foregroundStyle(Theme.text3)
                Spacer()
            }
            .frame(maxWidth: .infinity)
        } else {
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(rows) { t in
                        TransferRow(
                            transfer: t,
                            localFile: store.receiver.localFile(for: t.transferID),
                            isDownloading: store.receiver.downloading.contains(t.transferID)
                        ) {
                            Task { await handleTap(t) }
                        }
                        Divider().overlay(Theme.border.opacity(0.5))
                    }
                }
            }
        }
    }

    private func handleTap(_ t: Transfer) async {
        if t.kind != .file, let text = t.text {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
            return
        }
        if let existing = store.receiver.localFile(for: t.transferID) {
            NSWorkspace.shared.activateFileViewerSelecting([existing])
        } else {
            _ = await store.receiver.accept(t)
        }
    }

    private func handleDrop(_ providers: [NSItemProvider]) {
        for provider in providers {
            _ = provider.loadObject(ofClass: URL.self) { url, _ in
                guard let url, url.isFileURL else { return }
                Task { await store.uploader.send(fileURL: url) }
            }
        }
    }

    private func openSettings() {
        NSApp.activate(ignoringOtherApps: true)
        // The modern selector; the old showPreferencesWindow: was removed.
        NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)
    }
}

/// The arrival card — sender, size, retention, and the two decisions.
private struct ArrivalCard: View {
    @EnvironmentObject private var store: Store
    let transfer: Transfer

    var body: some View {
        VStack(alignment: .leading, spacing: 11) {
            HStack(spacing: 12) {
                RoundedRectangle(cornerRadius: 7)
                    .fill(Theme.raised)
                    .frame(width: 52, height: 52)
                    .overlay(
                        Image(systemName: "photo")
                            .foregroundStyle(Theme.text2)
                    )
                VStack(alignment: .leading, spacing: 4) {
                    Text(transfer.displayName)
                        .font(Theme.ui(14, .semibold))
                        .foregroundStyle(Theme.text)
                        .lineLimit(1)
                    if let from = transfer.fromDeviceName {
                        Text("from \(from)").font(Theme.ui(12)).foregroundStyle(Theme.text2)
                    }
                    if let size = transfer.size {
                        Text(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file))
                            .font(Theme.mono(10.5))
                            .foregroundStyle(Theme.text3)
                    }
                }
                Spacer()
            }

            HStack(spacing: 8) {
                // Retention is on the card, not in settings: the moment you
                // first see a file is the one moment you know how long you
                // want it. (No endpoint yet — see NOTES; this is display only.)
                HStack(spacing: 5) {
                    Image(systemName: "clock").font(.system(size: 10))
                    Text("Keeps 7 days").font(Theme.mono(10.5))
                }
                .foregroundStyle(Theme.text2)
                .padding(.horizontal, 9).padding(.vertical, 5)
                .background(Theme.field)
                .clipShape(RoundedRectangle(cornerRadius: Theme.radiusSmall))

                Spacer()

                Button("Dismiss") { store.markSeen() }
                    .buttonStyle(.plain)
                    .font(Theme.ui(12.5))
                    .foregroundStyle(Theme.text2)

                Button("Save") {
                    Task {
                        _ = await store.receiver.accept(transfer)
                        store.markSeen()
                    }
                }
                .buttonStyle(.plain)
                .font(Theme.ui(12.5, .semibold))
                .foregroundStyle(Theme.canvas)
                .padding(.horizontal, 14).padding(.vertical, 6)
                .background(Theme.lilac)
                .clipShape(RoundedRectangle(cornerRadius: Theme.radiusSmall))
            }
        }
        .padding(13)
        .background(Theme.raised.opacity(0.45))
        .overlay(alignment: .bottom) { Divider().overlay(Theme.border) }
    }
}
