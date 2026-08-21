//  Theme.swift — the tokens from design/README.md, in one place.
//
//  Dark, dense, high contrast. Monospace carries anything technical (byte
//  sizes, expiry, device state) because those *are* technical values, not
//  decoration. Lilac and mint sit at matching lightness and chroma and differ
//  only in hue, so they read as a pair doing semantic work — outbound vs
//  inbound — rather than as two arbitrary accents.

import SwiftUI

enum Theme {
    // Surfaces
    static let canvas  = Color(hex: 0x0E1116)
    static let surface = Color(hex: 0x171B22)
    static let field   = Color(hex: 0x1F242D)
    static let raised  = Color(hex: 0x232936)
    static let border  = Color(hex: 0x2A303B)
    static let borderStrong = Color(hex: 0x363E4B)

    // Text
    static let text   = Color(hex: 0xECEFF4)
    static let text2  = Color(hex: 0xA3ACBB)
    static let text3  = Color(hex: 0x6E7888)

    // Semantic accents
    static let lilac = Color(hex: 0x9C8CF5)   // outbound, primary action
    static let mint  = Color(hex: 0x55C9A2)   // inbound, online, success
    static let clay  = Color(hex: 0xC98A72)   // expiring soon
    static let alert = Color(hex: 0xF08A80)   // decline, destructive

    // Type. The design uses Instrument Sans and IBM Plex Mono; neither ships
    // with macOS, so until the faces are bundled these fall back to the system
    // faces, which is a deliberate downgrade rather than an oversight.
    static func ui(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight)
    }
    static func mono(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }

    static let radius: CGFloat = 8
    static let radiusSmall: CGFloat = 5
}

extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red:   Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >>  8) & 0xFF) / 255,
            blue:  Double( hex        & 0xFF) / 255,
            opacity: 1
        )
    }
}
