//  EventStream.swift — the live connection, and the reason this app needs no push.
//
//  A resident login item holding an SSE connection knows about a transfer the
//  moment the server does. APNs would tell it nothing it does not already
//  have, and macOS only delivers background pushes to a running app anyway.
//
//  Two things this must get right, because both are silent when wrong:
//    · reconnect with backoff, and never stack connections
//    · catch up on reconnect, because anything that arrived while the socket
//      was down never produced an event

import Foundation
import os

private let log = Logger(subsystem: "com.kjswalls.transmat.desktop", category: "sse")

actor EventStream {
    enum Status: Equatable { case idle, connecting, live, offline(String) }

    private var task: Task<Void, Never>?
    private var attempt = 0

    /// Called for every transfer event. The store decides what to do.
    private let onTransfer: @Sendable (Transfer) async -> Void
    private let onRevoked: @Sendable (String) async -> Void
    private let onStatus: @Sendable (Status) async -> Void
    /// Called after every successful (re)connect so the caller can backfill
    /// whatever arrived while we were not listening.
    private let onReconnect: @Sendable () async -> Void

    init(
        onTransfer: @escaping @Sendable (Transfer) async -> Void,
        onRevoked: @escaping @Sendable (String) async -> Void,
        onStatus: @escaping @Sendable (Status) async -> Void,
        onReconnect: @escaping @Sendable () async -> Void
    ) {
        self.onTransfer = onTransfer
        self.onRevoked = onRevoked
        self.onStatus = onStatus
        self.onReconnect = onReconnect
    }

    func start(baseURL: URL, token: String, deviceID: String?) {
        stop()   // never stack connections
        task = Task { [weak self] in
            await self?.loop(baseURL: baseURL, token: token, deviceID: deviceID)
        }
    }

    func stop() {
        task?.cancel()
        task = nil
        attempt = 0
    }

    private func loop(baseURL: URL, token: String, deviceID: String?) async {
        while !Task.isCancelled {
            await onStatus(.connecting)
            do {
                try await connect(baseURL: baseURL, token: token, deviceID: deviceID)
                // A clean end of stream is still a disconnect: fall through to backoff.
            } catch is CancellationError {
                return
            } catch {
                await onStatus(.offline(error.localizedDescription))
                log.info("stream dropped: \(error.localizedDescription, privacy: .public)")
            }
            guard !Task.isCancelled else { return }

            attempt += 1
            // 1s, 2s, 4s … capped at 15s. Long enough not to hammer a server
            // that is restarting, short enough that a laptop waking from sleep
            // reconnects before you notice.
            let delay = min(pow(2.0, Double(attempt - 1)), 15)
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
        }
    }

    private func connect(baseURL: URL, token: String, deviceID: String?) async throws {
        var components = URLComponents(
            url: baseURL.appendingPathComponent("v1/events"),
            resolvingAgainstBaseURL: false
        )!
        if let deviceID {
            components.queryItems = [URLQueryItem(name: "device_id", value: deviceID)]
        }
        var request = URLRequest(url: components.url!)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        // The stream is meant to stay open; a request timeout would kill it on
        // a quiet connection between keepalives.
        request.timeoutInterval = .infinity

        let (bytes, response) = try await URLSession.shared.bytes(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw APIError(
                code: "stream_failed",
                message: "Event stream refused (\((response as? HTTPURLResponse)?.statusCode ?? 0)).",
                status: (response as? HTTPURLResponse)?.statusCode ?? 0
            )
        }

        attempt = 0
        await onStatus(.live)
        await onReconnect()   // backfill anything missed while we were away

        var event = ""
        var data = ""
        for try await line in bytes.lines {
            if Task.isCancelled { throw CancellationError() }

            if line.isEmpty {                      // blank line ends an event
                await dispatch(event: event, data: data)
                event = ""; data = ""
                continue
            }
            if line.hasPrefix(":") { continue }    // keepalive comment
            if line.hasPrefix("event:") {
                event = line.dropFirst(6).trimmingCharacters(in: .whitespaces)
            } else if line.hasPrefix("data:") {
                data += line.dropFirst(5).trimmingCharacters(in: .whitespaces)
            }
        }
    }

    private func dispatch(event: String, data: String) async {
        guard !data.isEmpty, let raw = data.data(using: .utf8) else { return }
        switch event {
        case "transfer.created":
            struct Payload: Codable { let transfer: Transfer }
            if let p = try? JSONDecoder().decode(Payload.self, from: raw) {
                await onTransfer(p.transfer)
            }
        case "transfer.revoked":
            struct Payload: Codable {
                let transferID: String
                enum CodingKeys: String, CodingKey { case transferID = "transfer_id" }
            }
            if let p = try? JSONDecoder().decode(Payload.self, from: raw) {
                await onRevoked(p.transferID)
            }
        case "delivery.acked":
            break   // the store refreshes on its own; nothing to do here yet
        default:
            break
        }
    }
}
