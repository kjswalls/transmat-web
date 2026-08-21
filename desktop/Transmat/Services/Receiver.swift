//  Receiver.swift — catching what arrives.
//
//  Downloads to a temporary file first and moves it into place only once the
//  bytes are all there. A partially-written file in ~/Transmat that looks
//  complete is worse than no file at all.

import Foundation
import UserNotifications
import os

private let log = Logger(subsystem: "com.kjswalls.transmat.desktop", category: "receive")

@MainActor
final class Receiver: ObservableObject {
    /// Files this app has saved, by transfer, so the Hub can offer them for
    /// drag-out and reveal-in-Finder without hitting the network again.
    @Published private(set) var saved: [String: URL] = [:]

    @Published private(set) var downloading: Set<String> = []

    private let api: () -> APIClient?
    private let settings: Settings

    init(api: @escaping () -> APIClient?, settings: Settings) {
        self.api = api
        self.settings = settings
        self.saved = Receiver.loadIndex()
    }

    func localFile(for transferID: String) -> URL? {
        guard let url = saved[transferID],
              FileManager.default.fileExists(atPath: url.path) else { return nil }
        return url
    }

    /// Download and save. Idempotent: an already-saved transfer returns its
    /// existing file rather than fetching it twice.
    @discardableResult
    func accept(_ transfer: Transfer) async -> URL? {
        if let existing = localFile(for: transfer.transferID) { return existing }
        guard transfer.isFile, let client = api() else { return nil }
        guard !downloading.contains(transfer.transferID) else { return nil }

        downloading.insert(transfer.transferID)
        defer { downloading.remove(transfer.transferID) }

        do {
            let request = client.blobRequest(transferID: transfer.transferID)
            let (temp, response) = try await URLSession.shared.download(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                throw APIError(code: "download_failed", message: "Could not download the file.", status: 0)
            }

            let folder = settings.resolvedSaveFolder()
            let scoped = folder.startAccessingSecurityScopedResource()
            defer { if scoped { folder.stopAccessingSecurityScopedResource() } }
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)

            let destination = uniqueURL(in: folder, named: transfer.fileName ?? "file")
            // Move, never copy-then-delete: on the same volume this is atomic,
            // so nothing ever observes a half-written file at the final path.
            try FileManager.default.moveItem(at: temp, to: destination)

            saved[transfer.transferID] = destination
            Receiver.saveIndex(saved)

            if let delivery = deliveryForThisDevice(transfer) {
                try? await client.ack(deliveryID: delivery.deliveryID)
            }
            log.info("saved \(destination.lastPathComponent, privacy: .public)")
            return destination
        } catch {
            log.error("could not save \(transfer.displayName, privacy: .public): \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    private func deliveryForThisDevice(_ transfer: Transfer) -> Delivery? {
        guard let me = settings.deviceID else { return transfer.deliveries.first }
        return transfer.deliveries.first { $0.deviceID == me } ?? transfer.deliveries.first
    }

    /// `report.pdf`, then `report (2).pdf`. Never clobber something already there.
    private func uniqueURL(in folder: URL, named name: String) -> URL {
        let base = (name as NSString).deletingPathExtension
        let ext = (name as NSString).pathExtension
        var candidate = folder.appendingPathComponent(name)
        var n = 2
        while FileManager.default.fileExists(atPath: candidate.path) {
            let next = ext.isEmpty ? "\(base) (\(n))" : "\(base) (\(n)).\(ext)"
            candidate = folder.appendingPathComponent(next)
            n += 1
        }
        return candidate
    }

    // The index is a convenience cache, not a source of truth — if it is lost,
    // the files are still on disk and the server still has the history.
    private static let indexKey = "transmat.savedFiles"

    private static func loadIndex() -> [String: URL] {
        guard let raw = UserDefaults.standard.dictionary(forKey: indexKey) as? [String: String] else { return [:] }
        return raw.compactMapValues { URL(fileURLWithPath: $0) }
    }

    private static func saveIndex(_ index: [String: URL]) {
        UserDefaults.standard.set(index.mapValues(\.path), forKey: indexKey)
    }
}
