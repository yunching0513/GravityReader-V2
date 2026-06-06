import SwiftUI

/// 昀氏閱讀 · fair-faced concrete + vermilion palette.
enum Brand {
    static let paper = Color(hex: 0xF1EFE9)
    static let paper2 = Color(hex: 0xEAE8E2)
    static let mist = Color(hex: 0xD6D3CB)
    static let stone = Color(hex: 0xBBB8AE)
    static let silver = Color(hex: 0xA6A399)
    static let ash = Color(hex: 0x807C73)
    static let graphite = Color(hex: 0x565347)
    static let ink = Color(hex: 0x1F1D19)
    static let sumi = Color(hex: 0x0E0D0B)
    static let vermilion = Color(hex: 0xC15F3C)
    static let vermilionDark = Color(hex: 0x9E4B2E)

    // Serif body works well with the system "New York" serif on iOS.
    static func serif(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .serif)
    }
    static func sans(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight)
    }
    static func mono(_ size: CGFloat) -> Font {
        .system(size: size, weight: .regular, design: .monospaced)
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: 1
        )
    }
}
