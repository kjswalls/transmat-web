//  TransferRow.swift — one line in the stream, and the drag-out that
//  justifies this being a native app at all.

import SwiftUI
import UniformTypeIdentifiers

struct TransferRow: View {
    let transfer: Transfer
    let localFile: URL?
    let isDownloading: Bool
    let onTap: () -> Void

    @State private var hovering = false

    var body: some View {
        HStack(spacing: 11) {
            icon
            VStack(alignment: .leading, spacing: 2) {
                Text(transfer.displayName)
                    .font(Theme.ui(13))
                    .foregroundStyle(dead ? Theme.text3 : Theme.text)
                    .strikethrough(dead)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(subtitle)
                    .font(Theme.mono(10.5))
                    .foregroundStyle(Theme.text3)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            trailing
        }
        .padding(.horizontal, 12)
        .frame(height: 46)
        .background(hovering ? Theme.raised.opacity(0.5) : .clear)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .onTapGesture(perform: onTap)
        // The whole point. A file already on disk can be pulled straight out
        // of the popover into any app — no Downloads-folder detour.
        .ifLet(localFile) { view, url in
            view.onDrag { NSItemProvider(contentsOf: url) ?? NSItemProvider() }
        }
        .contextMenu { contextMenu }
        .help(localFile != nil ? "Drag out, or click to reveal in Finder" : transfer.displayName)
    }

    private var dead: Bool {
        transfer.state == .expired || transfer.state == .revoked || transfer.state == .cancelled
    }

    private var icon: some View {
        ZStack {
            RoundedRectangle(cornerRadius: Theme.radiusSmall)
                .fill(Theme.field)
                .frame(width: 26, height: 26)
            Image(systemName: symbol)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(localFile != nil ? Theme.mint : Theme.text2)
        }
    }

    private var symbol: String {
        switch transfer.kind {
        case .link: return "link"
        case .text: return "text.alignleft"
        case .file:
            guard let mime = transfer.mimeType else { return "doc" }
            if mime.hasPrefix("image/") { return "photo" }
            if mime.hasPrefix("video/") { return "film" }
            if mime.hasPrefix("audio/") { return "waveform" }
            return "doc"
        }
    }

    private var subtitle: String {
        var parts: [String] = []
        if let from = transfer.fromDeviceName { parts.append("from \(from)") }
        if let size = transfer.size { parts.append(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file)) }
        if localFile != nil { parts.append("saved") }
        return parts.joined(separator: " · ")
    }

    @ViewBuilder private var trailing: some View {
        if isDownloading {
            ProgressView().controlSize(.small).scaleEffect(0.6)
        } else {
            Text(rightLabel)
                .font(Theme.mono(10.5))
                .foregroundStyle(expiringSoon ? Theme.clay : Theme.text3)
        }
    }

    private var expiringSoon: Bool {
        !dead && transfer.expires.timeIntervalSinceNow < 2 * 86400
    }

    private var rightLabel: String {
        if dead { return transfer.state.rawValue }
        if expiringSoon {
            let days = max(0, Int(transfer.expires.timeIntervalSinceNow / 86400))
            return days == 0 ? "today" : "\(days)d left"
        }
        return Self.relative.localizedString(for: transfer.created, relativeTo: Date())
    }

    private static let relative: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .abbreviated
        return f
    }()

    @ViewBuilder private var contextMenu: some View {
        if let localFile {
            Button("Reveal in Finder") { NSWorkspace.shared.activateFileViewerSelecting([localFile]) }
            Button("Open") { NSWorkspace.shared.open(localFile) }
        }
        if transfer.kind != .file, let text = transfer.text {
            Button("Copy") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(text, forType: .string)
            }
        }
    }
}

extension View {
    /// Apply a modifier only when an optional has a value. Keeps `.onDrag`
    /// off rows with nothing to drag, rather than handing back an empty
    /// provider and letting the drag fail silently mid-gesture.
    @ViewBuilder
    func ifLet<T, Content: View>(_ value: T?, transform: (Self, T) -> Content) -> some View {
        if let value { transform(self, value) } else { self }
    }
}
