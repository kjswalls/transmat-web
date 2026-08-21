//  Settings.swift — server URL, token, and how arrivals should behave.
//
//  The token lives in the Keychain, never in UserDefaults and never in the
//  repo. Everything else is a plain preference.

import Foundation
import Combine
import os

private let log = Logger(subsystem: "com.kjswalls.transmat.desktop", category: "settings")

/// What should happen the moment something lands.
enum ArrivalBehaviour: String, CaseIterable, Identifiable {
    /// Open the Hub. Loud, and the whole point of the product.
    case open
    /// Badge the status item only. For when you are in Focus and mean it.
    case badge
    /// Save it and say nothing.
    case silent

    var id: String { rawValue }

    var label: String {
        switch self {
        case .open:   return "Open the Hub"
        case .badge:  return "Badge the menu bar"
        case .silent: return "Save quietly"
        }
    }
}

@MainActor
final class Settings: ObservableObject {
    static let shared = Settings()

    @Published var serverURLString: String {
        didSet { defaults.set(serverURLString, forKey: Key.serverURL) }
    }

    @Published var token: String {
        didSet { Keychain.set(token, for: Key.token) }
    }

    @Published var deviceID: String? {
        didSet { defaults.set(deviceID, forKey: Key.deviceID) }
    }

    @Published var deviceName: String {
        didSet { defaults.set(deviceName, forKey: Key.deviceName) }
    }

    @Published var arrival: ArrivalBehaviour {
        didSet { defaults.set(arrival.rawValue, forKey: Key.arrival) }
    }

    /// Where accepted files land. A security-scoped bookmark, because an app
    /// sandbox forgets a plain path the moment it relaunches.
    @Published var saveFolderBookmark: Data? {
        didSet { defaults.set(saveFolderBookmark, forKey: Key.saveFolder) }
    }

    /// Auto-accept anything from your own devices. Files from other people
    /// always ask — that distinction is the whole trust model.
    @Published var autoAcceptOwnDevices: Bool {
        didSet { defaults.set(autoAcceptOwnDevices, forKey: Key.autoAccept) }
    }

    private let defaults = UserDefaults.standard

    private enum Key {
        static let serverURL  = "transmat.serverURL"
        static let deviceID   = "transmat.deviceID"
        static let deviceName = "transmat.deviceName"
        static let arrival    = "transmat.arrival"
        static let saveFolder = "transmat.saveFolder"
        static let autoAccept = "transmat.autoAcceptOwn"
        static let token      = "api-token"
    }

    private init() {
        let d = UserDefaults.standard
        serverURLString = d.string(forKey: Key.serverURL) ?? "http://localhost:8787"
        token = Keychain.string(for: Key.token) ?? ""
        deviceID = d.string(forKey: Key.deviceID)
        deviceName = d.string(forKey: Key.deviceName) ?? Host.current().localizedName ?? "Mac"
        arrival = ArrivalBehaviour(rawValue: d.string(forKey: Key.arrival) ?? "") ?? .open
        saveFolderBookmark = d.data(forKey: Key.saveFolder)
        autoAcceptOwnDevices = d.object(forKey: Key.autoAccept) as? Bool ?? true
    }

    var serverURL: URL? { Settings.normalizedURL(serverURLString) }
    var isConfigured: Bool { serverURL != nil && !token.isEmpty }

    /// Same trap as on iOS: `URL(string: "192.168.1.24:8787")` parses the host
    /// as a *scheme* and every request then fails with a baffling error, while
    /// the field still looks correct. Anything without a scheme gets http://.
    static func normalizedURL(_ raw: String) -> URL? {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if !text.contains("://") { text = "http://" + text }
        guard let url = URL(string: text), url.host != nil else { return nil }
        return url
    }

    /// Resolve the save folder, falling back to ~/Transmat. Re-saves the
    /// bookmark when macOS reports it stale, which happens after the folder
    /// moves or the app is updated.
    func resolvedSaveFolder() -> URL {
        let fallback = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Transmat", isDirectory: true)

        guard let data = saveFolderBookmark else {
            try? FileManager.default.createDirectory(at: fallback, withIntermediateDirectories: true)
            return fallback
        }
        var stale = false
        guard let url = try? URL(
            resolvingBookmarkData: data,
            options: .withSecurityScope,
            relativeTo: nil,
            bookmarkDataIsStale: &stale
        ) else {
            return fallback
        }
        if stale, let refreshed = try? url.bookmarkData(options: .withSecurityScope) {
            saveFolderBookmark = refreshed
        }
        return url
    }
}
