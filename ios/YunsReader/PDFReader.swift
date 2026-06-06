import SwiftUI
import PDFKit

/// Owns the PDFView so SwiftUI can read the current text selection.
final class PDFController: ObservableObject {
    let pdfView = PDFView()
    @Published var hasDocument = false

    init() {
        pdfView.autoScales = true
        pdfView.displayMode = .singlePageContinuous
        pdfView.displayDirection = .vertical
        pdfView.backgroundColor = UIColor(Brand.mist)
        pdfView.usePageViewController(false)
    }

    func load(url: URL) {
        // Security-scoped access for files picked from the Files app.
        let needsScope = url.startAccessingSecurityScopedResource()
        defer { if needsScope { url.stopAccessingSecurityScopedResource() } }
        if let doc = PDFDocument(url: url) {
            pdfView.document = doc
            hasDocument = true
        }
    }

    var selectedText: String? {
        let s = pdfView.currentSelection?.string?.trimmingCharacters(in: .whitespacesAndNewlines)
        return (s?.isEmpty ?? true) ? nil : s
    }

    var fullText: String {
        pdfView.document?.string ?? ""
    }
}

struct PDFReaderView: UIViewRepresentable {
    let controller: PDFController
    func makeUIView(context: Context) -> PDFView { controller.pdfView }
    func updateUIView(_ uiView: PDFView, context: Context) {}
}
