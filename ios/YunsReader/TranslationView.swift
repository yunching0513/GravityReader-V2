import SwiftUI

/// Bottom sheet showing the bilingual segments for a translated selection.
struct TranslationView: View {
    let segments: [Segment]
    let onSpeak: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    ForEach(Array(segments.enumerated()), id: \.element.id) { idx, seg in
                        VStack(alignment: .leading, spacing: 12) {
                            HStack(alignment: .top) {
                                Text(String(format: "%02d", idx + 1))
                                    .font(Brand.serif(15).italic())
                                    .foregroundStyle(Brand.silver)
                                Spacer()
                                Button { onSpeak(seg.en) } label: {
                                    Image(systemName: "speaker.wave.2")
                                        .foregroundStyle(Brand.ash)
                                }
                            }
                            Text(seg.en)
                                .font(Brand.serif(18))
                                .foregroundStyle(Brand.ink)
                            Rectangle().fill(Brand.stone).frame(height: 1)
                            Text(seg.zh)
                                .font(Brand.serif(17))
                                .foregroundStyle(Brand.graphite)
                                .lineSpacing(6)
                        }
                        .padding(20)
                        .background(Brand.paper2)
                        .overlay(Rectangle().stroke(Brand.stone, lineWidth: 1))
                    }
                }
                .padding(20)
            }
            .background(Brand.paper)
            .navigationTitle("對譯精讀")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
        }
    }
}
