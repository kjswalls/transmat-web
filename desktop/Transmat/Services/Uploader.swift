//  Uploader.swift — sending, via the presigned path.
//
//  The Mac has no extension-memory problem, so it could stream multipart
//  through the server like the web app does. It uses the presigned path
//  anyway, for two reasons: the bytes skip the server entirely, and it means
//  the path iOS depends on is exercised by a client that is easy to debug.

import AppKit
import Foundation
import UniformTypeIdentifiers
import os

private let log = Logger(subsystem: "com.kjswalls.transmat.desktop", category: "upload")

@MainActor
final class Uploader: ObservableObject {
    struct Job: Identifiable, Equatable {
        let id = UUID()
        let fileName: String
        var progress: Double
        var failed: String?
    }

    @Published private(set) var jobs: [Job] = []

    private let api: () -> APIClient?
    private let deviceID: () -> String?

    init(api: @escaping () -> APIClient?, deviceID: @escaping () -> String?) {
        self.api = api
        self.deviceID = deviceID
    }

    /// Send one file. Reserve, PUT, complete.
    @discardableResult
    func send(fileURL: URL, to target: String = "others") async -> Transfer? {
        guard let client = api() else { return nil }

        // A security-scoped resource must be opened before it can be read and
        // closed exactly once afterwards, or the sandbox leaks the grant.
        let scoped = fileURL.startAccessingSecurityScopedResource()
        defer { if scoped { fileURL.stopAccessingSecurityScopedResource() } }

        let name = fileURL.lastPathComponent
        let size = (try? FileManager.default.attributesOfItem(atPath: fileURL.path)[.size] as? Int) ?? 0
        let mime = UTType(filenameExtension: fileURL.pathExtension)?.preferredMIMEType
            ?? "application/octet-stream"

        var job = Job(fileName: name, progress: 0, failed: nil)
        jobs.append(job)
        defer { jobs.removeAll { $0.id == job.id } }

        do {
            let reservation = try await client.reserveUpload(
                fileName: name, mimeType: mime, size: size ?? 0,
                to: target, from: deviceID()
            )
            guard let uploadURL = URL(string: reservation.upload.url) else {
                throw APIError(code: "bad_request", message: "The server returned an unusable upload URL.", status: 0)
            }

            var request = URLRequest(url: uploadURL)
            request.httpMethod = reservation.upload.method
            for (key, value) in reservation.upload.headers {
                request.setValue(value, forHTTPHeaderField: key)
            }
            // fromFile, not httpBody: streams from disk, so a 2 GB video never
            // becomes 2 GB of resident memory.
            _ = try await URLSession.shared.upload(for: request, fromFile: fileURL)

            let transfer = try await client.completeUpload(transferID: reservation.transfer.transferID)
            log.info("sent \(name, privacy: .public)")
            return transfer
        } catch {
            job.failed = error.localizedDescription
            log.error("send failed for \(name, privacy: .public): \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    /// Whatever is on the clipboard: a file if there is one, otherwise text,
    /// otherwise nothing. This is the ⌘V case in the quick-send bar.
    @discardableResult
    func sendClipboard(to target: String = "others") async -> Transfer? {
        let pasteboard = NSPasteboard.general

        if let urls = pasteboard.readObjects(forClasses: [NSURL.self]) as? [URL],
           let first = urls.first, first.isFileURL {
            return await send(fileURL: first, to: target)
        }
        if let text = pasteboard.string(forType: .string), !text.isEmpty {
            return await sendText(text, to: target)
        }
        return nil
    }

    @discardableResult
    func sendText(_ text: String, to target: String = "others") async -> Transfer? {
        guard let client = api() else { return nil }
        let looksLikeURL = text.hasPrefix("http://") || text.hasPrefix("https://")
        do {
            return try await client.sendText(
                text, kind: looksLikeURL ? .link : .text, to: target, from: deviceID()
            )
        } catch {
            log.error("send text failed: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }
}
