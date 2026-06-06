import SwiftUI

struct SettingsView: View {
    @Binding var apiKey: String
    @Environment(\.dismiss) private var dismiss
    @State private var draft: String = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    SecureField("貼上你的 Gemini API 金鑰", text: $draft)
                        .font(Brand.mono(14))
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                } header: {
                    Text("GEMINI API 金鑰")
                        .font(Brand.mono(11))
                        .foregroundStyle(Brand.ash)
                } footer: {
                    Text(apiKey.isEmpty ? "尚未設定 — 翻譯需要金鑰。" : "已設定 · \(masked(apiKey))")
                        .font(Brand.sans(12))
                        .foregroundStyle(apiKey.isEmpty ? Brand.ash : Brand.vermilion)
                }

                Section {
                    Link("取得免費金鑰 · Google AI Studio →",
                         destination: URL(string: "https://aistudio.google.com/app/apikey")!)
                        .font(Brand.serif(15))
                        .foregroundStyle(Brand.vermilion)
                }
            }
            .navigationTitle("設定")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("關閉") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("儲存") {
                        apiKey = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                        dismiss()
                    }.disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .onAppear { draft = apiKey }
        }
    }

    private func masked(_ k: String) -> String {
        guard k.count > 8 else { return "••••" }
        return k.prefix(4) + "…" + k.suffix(4)
    }
}
