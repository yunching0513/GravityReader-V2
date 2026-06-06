import SwiftUI
import UniformTypeIdentifiers

struct ContentView: View {
    @AppStorage("geminiKey") private var apiKey: String = ""
    @StateObject private var pdf = PDFController()
    @StateObject private var speech = SpeechService()

    @State private var showImporter = false
    @State private var showSettings = false
    @State private var segments: [Segment]? = nil
    @State private var translating = false
    @State private var errorMsg: String? = nil
    @State private var paragraphMode = false

    var body: some View {
        NavigationStack {
            ZStack {
                Brand.mist.ignoresSafeArea()

                if pdf.hasDocument {
                    PDFReaderView(controller: pdf)
                        .ignoresSafeArea(edges: .bottom)
                } else {
                    emptyState
                }

                VStack { Spacer(); actionBar }
            }
            .navigationTitle("昀氏閱讀")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    HStack(spacing: 18) {
                        Button { showImporter = true } label: { Image(systemName: "doc.badge.plus") }
                        Button { showSettings = true } label: { Image(systemName: "key") }
                    }
                    .tint(Brand.graphite)
                }
            }
            .toolbarBackground(Brand.paper, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
        }
        .tint(Brand.vermilion)
        .fileImporter(isPresented: $showImporter, allowedContentTypes: [.pdf]) { result in
            if case .success(let url) = result { pdf.load(url: url) }
        }
        .sheet(isPresented: $showSettings) { SettingsView(apiKey: $apiKey) }
        .sheet(item: Binding(get: { segments.map { SegmentsBox(items: $0) } },
                             set: { segments = $0?.items })) { box in
            TranslationView(segments: box.items) { speech.speak($0) }
                .presentationDetents([.medium, .large])
        }
        .alert("提醒", isPresented: Binding(get: { errorMsg != nil }, set: { if !$0 { errorMsg = nil } })) {
            Button("好") { errorMsg = nil }
        } message: { Text(errorMsg ?? "") }
    }

    private var brand: some View {
        HStack(spacing: 8) {
            Text("Yun's ").font(Brand.serif(17, .semibold)).foregroundStyle(Brand.ink)
            + Text("Reader").font(Brand.serif(17, .semibold)).foregroundStyle(Brand.vermilion)
        }
    }

    private var emptyState: some View {
        VStack(spacing: 14) {
            brand.padding(.bottom, 8)
            Text("空").font(Brand.serif(72, .bold)).foregroundStyle(Brand.stone)
            Text("Open a PDF").font(Brand.serif(20).italic()).foregroundStyle(Brand.silver)
            Button {
                showImporter = true
            } label: {
                Text("選擇 PDF 開始閱讀").font(Brand.serif(15)).padding(.horizontal, 22).padding(.vertical, 12)
                    .overlay(Rectangle().stroke(Brand.silver, lineWidth: 1))
            }
            .tint(Brand.graphite)
            .padding(.top, 6)
        }
    }

    private var actionBar: some View {
        HStack(spacing: 10) {
            Toggle("逐段", isOn: $paragraphMode)
                .toggleStyle(.button)
                .font(Brand.sans(13))
                .tint(Brand.ink)

            Button(action: translateSelection) {
                HStack(spacing: 6) {
                    if translating { ProgressView().tint(.white) }
                    Image(systemName: "character.book.closed")
                    Text("翻譯選取")
                }
                .font(Brand.sans(15, .medium))
                .foregroundStyle(.white)
                .padding(.vertical, 12).frame(maxWidth: .infinity)
                .background(Brand.vermilion)
            }
            .disabled(translating)

            Button {
                if let t = pdf.selectedText { speech.speak(t) } else { errorMsg = "請先在 PDF 中選取文字。" }
            } label: {
                Image(systemName: speech.isSpeaking ? "stop.fill" : "speaker.wave.2.fill")
                    .font(.system(size: 16))
                    .foregroundStyle(Brand.graphite)
                    .padding(12)
                    .overlay(Rectangle().stroke(Brand.silver, lineWidth: 1))
            }
            .onTapGesture { if speech.isSpeaking { speech.stop() } }
        }
        .padding(12)
        .background(Brand.paper2.opacity(0.96))
        .overlay(Rectangle().fill(Brand.stone).frame(height: 1), alignment: .top)
        .opacity(pdf.hasDocument ? 1 : 0)
    }

    private func translateSelection() {
        guard let text = pdf.selectedText else { errorMsg = "請先在 PDF 中選取文字。"; return }
        guard !apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            errorMsg = "尚未設定 Gemini API 金鑰,請點右上角鑰匙圖示。"; return
        }
        translating = true
        Task {
            do {
                let svc = GeminiService(apiKey: apiKey)
                let segs = try await svc.translate(text, paragraph: paragraphMode)
                await MainActor.run { segments = segs; translating = false }
            } catch {
                await MainActor.run { errorMsg = error.localizedDescription; translating = false }
            }
        }
    }
}

/// Identifiable wrapper so `.sheet(item:)` can present the segment list.
private struct SegmentsBox: Identifiable {
    let id = UUID()
    let items: [Segment]
}
