//  Store.swift — one source of truth for the UI.
//
//  Everything the Hub and the quick-send bar render comes from here. The
//  store owns the stream, the device list and the transfer list, and it is
//  the only thing that decides what "arriving" means.

import Foundation
import Combine
import os

private let log = Logger(subsystem: "com.kjswalls.transmat.desktop", category: "store")

@MainActor
final class Store: ObservableObject {
    @Published private(set) var transfers: [Transfer] = []
    @Published private(set) var devices: [Device] = []
    @Published private(set) var status: EventStream.Status = .idle
    @Published private(set) var lastError: String?

    /// Set when something lands and has not been looked at yet. The status
    /// item badges on this, and the Hub clears it when it opens.
    @Published var unseen: Int = 0

    /// The most recent arrival, for the Hub's arrival card.
    @Published private(set) var arriving: Transfer?

    let settings: Settings
    private(set) lazy var uploader = Uploader(
        api: { [weak self] in self?.client },
        deviceID: { [weak self] in self?.settings.deviceID }
    )
    private(set) lazy var receiver = Receiver(
        api: { [weak self] in self?.client },
        settings: settings
    )

    private var stream: EventStream?

    init(settings: Settings = .shared) {
        self.settings = settings
    }

    var client: APIClient? {
        guard let url = settings.serverURL, !settings.token.isEmpty else { return nil }
        return APIClient(baseURL: url, token: settings.token)
    }

    // MARK: Lifecycle

    func start() async {
        guard settings.isConfigured else {
            status = .offline("Not configured yet")
            return
        }
        await registerIfNeeded()
        await refresh()
        await connect()
    }

    func stop() async {
        await stream?.stop()
        stream = nil
    }

    /// Re-register on every launch: the name can change, and the server
    /// upserts, so this is cheap and keeps `last_seen_at` honest.
    private func registerIfNeeded() async {
        guard let client else { return }
        do {
            let device = try await client.registerDevice(name: settings.deviceName)
            settings.deviceID = device.deviceID
        } catch {
            log.error("register failed: \(error.localizedDescription, privacy: .public)")
            lastError = error.localizedDescription
        }
    }

    func refresh() async {
        guard let client else { return }
        do {
            async let list = client.transfers()
            async let devs = client.devices()
            transfers = try await list
            devices = try await devs
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
    }

    private func connect() async {
        let stream = EventStream(
            onTransfer: { [weak self] transfer in await self?.handleArrival(transfer) },
            onRevoked:  { [weak self] id in await self?.handleRevoked(id) },
            onStatus:   { [weak self] s in await MainActor.run { self?.status = s } },
            onReconnect: { [weak self] in await self?.refresh() }
        )
        self.stream = stream
        await stream.start(
            baseURL: settings.serverURL!,
            token: settings.token,
            deviceID: settings.deviceID
        )
    }

    // MARK: Events

    private func handleArrival(_ transfer: Transfer) async {
        upsert(transfer)

        // Something we sent is not an arrival — do not badge our own outbox.
        let isOurs = transfer.fromDeviceID != nil && transfer.fromDeviceID == settings.deviceID
        guard !isOurs else { return }

        arriving = transfer
        unseen += 1

        if settings.autoAcceptOwnDevices, transfer.isFile {
            // "Auto-accept from your own devices" is the setting; with no
            // accounts yet every device is one of yours, so this is every file.
            // When contacts land, gate this on the sender being you.
            _ = await receiver.accept(transfer)
        }
        NotificationCenter.default.post(name: .transmatDidReceive, object: transfer.transferID)
    }

    private func handleRevoked(_ transferID: String) async {
        transfers.removeAll { $0.transferID == transferID }
        if arriving?.transferID == transferID { arriving = nil }
    }

    private func upsert(_ transfer: Transfer) {
        if let i = transfers.firstIndex(where: { $0.transferID == transfer.transferID }) {
            transfers[i] = transfer
        } else {
            transfers.insert(transfer, at: 0)
        }
        transfers.sort { $0.created > $1.created }
    }

    // MARK: Queries the views use

    func filtered(query: String, filter: HubFilter) -> [Transfer] {
        transfers.filter { t in
            guard filter.matches(t, myDeviceID: settings.deviceID) else { return false }
            guard !query.isEmpty else { return true }
            let needle = query.lowercased()
            return t.displayName.lowercased().contains(needle)
                || (t.fromDeviceName ?? "").lowercased().contains(needle)
        }
    }

    func markSeen() {
        unseen = 0
        arriving = nil
    }
}

enum HubFilter: String, CaseIterable, Identifiable {
    case all, sent, received, links, expiring
    var id: String { rawValue }
    var label: String { rawValue.capitalized }

    func matches(_ t: Transfer, myDeviceID: String?) -> Bool {
        switch self {
        case .all:      return true
        case .sent:     return t.fromDeviceID != nil && t.fromDeviceID == myDeviceID
        case .received: return t.fromDeviceID == nil || t.fromDeviceID != myDeviceID
        case .links:    return t.kind == .link
        case .expiring: return t.expires.timeIntervalSinceNow < 2 * 86400
        }
    }
}

extension Notification.Name {
    static let transmatDidReceive = Notification.Name("transmat.didReceive")
}
