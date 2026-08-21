//  SettingsView.swift — a real window, because a popover is a miserable place
//  to type a URL and a token.

import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var store: Store
    @EnvironmentObject private var settings: Settings
    @State private var checking = false
    @State private var health: String?

    var body: some View {
        Form {
            Section("Server") {
                TextField("Server URL", text: $settings.serverURLString)
                SecureField("Access token", text: $settings.token)
                HStack {
                    Button(checking ? "Checking…" : "Test connection") { check() }
                        .disabled(checking || !settings.isConfigured)
                    if let health {
                        Text(health).font(Theme.mono(11)).foregroundStyle(Theme.text2)
                    }
                }
                Text("The same value as TRANSMAT_TOKEN in the server's .env.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section("This Mac") {
                TextField("Device name", text: $settings.deviceName)
                if let id = settings.deviceID {
                    LabeledContent("Device ID") {
                        Text(id).font(Theme.mono(10)).textSelection(.enabled)
                    }
                }
            }

            Section("Arrivals") {
                Picker("When something lands", selection: $settings.arrival) {
                    ForEach(ArrivalBehaviour.allCases) { Text($0.label).tag($0) }
                }
                Toggle("Save files from my devices automatically", isOn: $settings.autoAcceptOwnDevices)
                LabeledContent("Saved to") {
                    Text(settings.resolvedSaveFolder().path)
                        .font(Theme.mono(10))
                        .lineLimit(1).truncationMode(.middle)
                }
                Button("Choose folder…") { chooseFolder() }
            }
        }
        .formStyle(.grouped)
        .frame(width: 460)
        .padding()
    }

    private func check() {
        checking = true
        health = nil
        Task {
            defer { checking = false }
            guard let client = store.client else { return }
            do {
                let h = try await client.health()
                health = "ok · storage \(h.storage) · push \(h.push) · v\(h.version)"
                await store.start()
            } catch {
                health = error.localizedDescription
            }
        }
    }

    private func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        // A security-scoped bookmark, not a path: a sandboxed app forgets a
        // plain path the moment it relaunches.
        settings.saveFolderBookmark = try? url.bookmarkData(options: .withSecurityScope)
    }
}
