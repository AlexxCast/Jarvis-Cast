import SwiftUI

// MARK: - Palette Colori Neon Jarvis
extension Color {
    static let jarvisDarkBg = Color(red: 0.05, green: 0.07, blue: 0.09)
    static let jarvisCardBg = Color(red: 0.10, green: 0.13, blue: 0.16)
    static let jarvisNeonGreen = Color(red: 0.13, green: 0.90, blue: 0.45)
    static let jarvisCyan = Color(red: 0.13, green: 0.83, blue: 0.93)
    static let jarvisAmber = Color(red: 0.96, green: 0.62, blue: 0.10)
    static let jarvisRed = Color(red: 0.97, green: 0.44, blue: 0.44)
}

struct NeonCardModifier: ViewModifier {
    func body(content: Content) -> some View {
        content
            .background(Color.jarvisCardBg)
            .cornerRadius(16)
            .overlay(
                RoundedRectangle(cornerRadius: 16)
                    .stroke(Color.jarvisNeonGreen.opacity(0.25), lineWidth: 1)
            )
    }
}

extension View {
    func neonCard() -> some View {
        self.modifier(NeonCardModifier())
    }
}
