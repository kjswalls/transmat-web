//  API.swift — the Transmat API, exactly as docs/CONTRACT.md describes it.
//
//  Keys are snake_case on the wire and camelCase in Swift, mapped explicitly
//  with CodingKeys rather than a global strategy, so a mismatch is a compile
//  error in one place instead of a nil at runtime in several.

import Foundation

// MARK: - Wire types

enum Platform: String, Codable { case ios, android, macos, web, cli }
enum Kind: String, Codable { case file, text, link }

enum TransferState: String, Codable {
    case complete, revoked, expired
    /// Reserved, bytes not yet verified. Never listed to recipients.
    case uploading
    /// Reserved then abandoned or rejected.
    case cancelled
}

enum DeliveryState: String, Codable { case pending, pushed, downloaded }

struct Device: Codable, Identifiable, Hashable {
    let deviceID: String
    let name: String
    let platform: Platform
    let pushChannel: String
    let hasPushToken: Bool
    let lastSeenAt: String
    let createdAt: String

    var id: String { deviceID }

    /// The server has no `online` field, so this is an inference, not a fact —
    /// every authenticated call touches `last_seen_at`. Treat it as a hint.
    var isOnline: Bool {
        guard let seen = ISO8601DateFormatter.transmat.date(from: lastSeenAt) else { return false }
        return Date().timeIntervalSince(seen) < 120
    }

    enum CodingKeys: String, CodingKey {
        case deviceID = "device_id"
        case name, platform
        case pushChannel = "push_channel"
        case hasPushToken = "has_push_token"
        case lastSeenAt = "last_seen_at"
        case createdAt = "created_at"
    }
}

struct Delivery: Codable, Identifiable, Hashable {
    let deliveryID: String
    let deviceID: String
    let deviceName: String
    let state: DeliveryState
    let ackedAt: String?

    var id: String { deliveryID }

    enum CodingKeys: String, CodingKey {
        case deliveryID = "delivery_id"
        case deviceID = "device_id"
        case deviceName = "device_name"
        case state
        case ackedAt = "acked_at"
    }
}

struct Transfer: Codable, Identifiable, Hashable {
    let transferID: String
    let kind: Kind
    let state: TransferState
    let fileName: String?
    let mimeType: String?
    let size: Int?
    let text: String?
    let fromDeviceID: String?
    let fromDeviceName: String?
    let createdAt: String
    let expiresAt: String
    let deliveries: [Delivery]

    var id: String { transferID }

    var displayName: String { fileName ?? text ?? "Untitled" }
    var isFile: Bool { kind == .file }

    var created: Date { ISO8601DateFormatter.transmat.date(from: createdAt) ?? .distantPast }
    var expires: Date { ISO8601DateFormatter.transmat.date(from: expiresAt) ?? .distantFuture }

    enum CodingKeys: String, CodingKey {
        case transferID = "transfer_id"
        case kind, state, size, text, deliveries
        case fileName = "file_name"
        case mimeType = "mime_type"
        case fromDeviceID = "from_device_id"
        case fromDeviceName = "from_device_name"
        case createdAt = "created_at"
        case expiresAt = "expires_at"
    }
}

struct PresignedUpload: Codable {
    let method: String
    let url: String
    let headers: [String: String]
    let expiresAt: String

    enum CodingKeys: String, CodingKey {
        case method, url, headers
        case expiresAt = "expires_at"
    }
}

struct PresignedReservation: Codable {
    let transfer: Transfer
    let upload: PresignedUpload
}

struct Health: Codable {
    let ok: Bool
    let storage: String
    let push: String
    let version: String
}

struct APIError: Error, LocalizedError {
    let code: String
    let message: String
    let status: Int

    var errorDescription: String? { message }
    var isUnauthorized: Bool { status == 401 || code == "unauthorized" }

    /// Retrying will never help for these.
    var isPermanent: Bool {
        ["not_found", "too_large", "bad_request", "revoked", "expired"].contains(code)
    }

    struct Envelope: Codable {
        struct Body: Codable { let code: String; let message: String }
        let error: Body
    }
}

extension ISO8601DateFormatter {
    /// The server emits fractional seconds; the default formatter refuses them,
    /// which silently turns every date into `.distantPast` and sorts the list
    /// backwards. Learned the hard way on the iOS side.
    static let transmat: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
}

// MARK: - Client

struct APIClient {
    let baseURL: URL
    let token: String

    private func request(_ path: String, method: String = "GET") -> URLRequest {
        var req = URLRequest(url: baseURL.appendingPathComponent(path))
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.timeoutInterval = 20
        return req
    }

    private func send<T: Decodable>(_ req: URLRequest, as type: T.Type) async throws -> T {
        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw APIError(code: "network", message: "No response from the server.", status: 0)
        }
        guard (200..<300).contains(http.statusCode) else {
            if let envelope = try? JSONDecoder().decode(APIError.Envelope.self, from: data) {
                throw APIError(code: envelope.error.code, message: envelope.error.message, status: http.statusCode)
            }
            throw APIError(code: "http_\(http.statusCode)", message: "Request failed.", status: http.statusCode)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    // MARK: Devices

    private struct DevicesResponse: Codable { let devices: [Device] }
    private struct TransfersResponse: Codable {
        let transfers: [Transfer]
        let nextCursor: String?
        enum CodingKeys: String, CodingKey { case transfers; case nextCursor = "next_cursor" }
    }
    private struct TransferResponse: Codable { let transfer: Transfer }
    private struct OKResponse: Codable { let ok: Bool }

    func registerDevice(name: String) async throws -> Device {
        var req = request("v1/devices", method: "POST")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: [
            "name": name,
            "platform": Platform.macos.rawValue,
            // No push token: this app is resident and lives on SSE. See README.
            "push_channel": "none",
        ])
        return try await send(req, as: Device.self)
    }

    func devices() async throws -> [Device] {
        try await send(request("v1/devices"), as: DevicesResponse.self).devices
    }

    // MARK: Transfers

    func transfers(limit: Int = 100) async throws -> [Transfer] {
        try await send(request("v1/transfers?limit=\(limit)"), as: TransfersResponse.self).transfers
    }

    func transfer(id: String) async throws -> Transfer {
        try await send(request("v1/transfers/\(escape(id))"), as: TransferResponse.self).transfer
    }

    /// The 302 target. Handed to a download task rather than fetched here.
    func blobRequest(transferID: String) -> URLRequest {
        request("v1/transfers/\(escape(transferID))/blob")
    }

    @discardableResult
    func ack(deliveryID: String) async throws -> Bool {
        try await send(request("v1/deliveries/\(escape(deliveryID))/ack", method: "POST"), as: OKResponse.self).ok
    }

    @discardableResult
    func revoke(transferID: String) async throws -> Bool {
        try await send(request("v1/transfers/\(escape(transferID))", method: "DELETE"), as: OKResponse.self).ok
    }

    // MARK: Sending

    /// Phase one of the presigned upload — see CONTRACT.md "Presigned upload".
    /// A single PUT, not multipart, for the same reason as on iOS.
    func reserveUpload(
        fileName: String, mimeType: String, size: Int,
        to: String = "others", from: String? = nil
    ) async throws -> PresignedReservation {
        var body: [String: Any] = [
            "mode": "presigned",
            "name": fileName,
            "mime_type": mimeType,
            "size": size,
            "to": to,
        ]
        if let from { body["from"] = from }
        var req = request("v1/transfers", method: "POST")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        return try await send(req, as: PresignedReservation.self)
    }

    /// Phase two. Idempotent, so retrying costs one request and never harms.
    @discardableResult
    func completeUpload(transferID: String) async throws -> Transfer {
        try await send(
            request("v1/transfers/\(escape(transferID))/complete", method: "POST"),
            as: TransferResponse.self
        ).transfer
    }

    /// Text and links have no blob leg — they ride the JSON body.
    @discardableResult
    func sendText(_ text: String, kind: Kind = .text, to: String = "others", from: String? = nil) async throws -> Transfer {
        var body: [String: Any] = ["kind": kind.rawValue, "text": text, "to": to]
        if let from { body["from"] = from }
        var req = request("v1/transfers", method: "POST")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        return try await send(req, as: TransferResponse.self).transfer
    }

    func health() async throws -> Health {
        var req = URLRequest(url: baseURL.appendingPathComponent("health"))
        req.timeoutInterval = 8
        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw APIError(code: "network", message: "Server unreachable.", status: 0)
        }
        return try JSONDecoder().decode(Health.self, from: data)
    }

    private func escape(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? s
    }
}
