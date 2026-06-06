import Foundation

/// One bilingual segment returned by the translator.
struct Segment: Identifiable, Codable, Hashable {
    var id = UUID()
    let en: String
    let zh: String

    enum CodingKeys: String, CodingKey { case en, zh }
}

enum GeminiError: LocalizedError {
    case noKey
    case http(Int, String)
    case badResponse

    var errorDescription: String? {
        switch self {
        case .noKey: return "尚未設定 Gemini API 金鑰,請到設定填入。"
        case .http(let code, let msg):
            if code == 429 { return "Gemini 額度或速率已達上限,請稍後再試。" }
            return "Gemini 錯誤 (\(code)): \(msg)"
        case .badResponse: return "無法解析翻譯結果。"
        }
    }
}

/// Talks to Gemini directly from the device (no backend). The user supplies the
/// key, so nothing is shipped in the app.
struct GeminiService {
    var apiKey: String
    var model: String = "models/gemini-flash-latest"

    /// Translate English prose into bilingual segments (en + Traditional Chinese).
    func translate(_ text: String, paragraph: Bool = false) async throws -> [Segment] {
        let key = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { throw GeminiError.noKey }

        let instruction = paragraph
            ? "Split the text by PARAGRAPHS. Translate each paragraph as a whole unit."
            : "Split the text by SENTENCES. Translate each sentence individually."
        let prompt = """
        You are a professional translator. Translate the following English text into fluent Traditional Chinese (Taiwan).

        Instruction: \(instruction)

        Strict Output Format: Return a raw JSON list of objects. Each object must have ONLY two fields:
        en: The original English text segment.
        zh: The Traditional Chinese translation. No notes or explanations.

        Text:
        \(text)
        """

        let raw = try await generate(prompt: prompt, key: key)
        return try parseSegments(raw)
    }

    /// Summarize text into ~`length` Traditional Chinese characters.
    func summarize(_ text: String, length: Int) async throws -> String {
        let key = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { throw GeminiError.noKey }
        let prompt = """
        You are a research assistant. Summarize the provided text into approximately \(length) Traditional Chinese words. Capture the main arguments and conclusions.

        Text:
        \(text)
        """
        return try await generate(prompt: prompt, key: key)
    }

    // MARK: - REST

    private func generate(prompt: String, key: String) async throws -> String {
        let urlStr = "https://generativelanguage.googleapis.com/v1beta/\(model):generateContent?key=\(key)"
        guard let url = URL(string: urlStr) else { throw GeminiError.badResponse }

        let body: [String: Any] = [
            "contents": [["parts": [["text": prompt]]]]
        ]
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw GeminiError.badResponse }
        guard (200..<300).contains(http.statusCode) else {
            let msg = String(data: data, encoding: .utf8) ?? ""
            throw GeminiError.http(http.statusCode, String(msg.prefix(160)))
        }

        guard
            let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            let candidates = json["candidates"] as? [[String: Any]],
            let content = candidates.first?["content"] as? [String: Any],
            let parts = content["parts"] as? [[String: Any]],
            let textOut = parts.first?["text"] as? String
        else { throw GeminiError.badResponse }
        return textOut
    }

    private func parseSegments(_ raw: String) throws -> [Segment] {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("```json") { s = String(s.dropFirst(7)) }
        else if s.hasPrefix("```") { s = String(s.dropFirst(3)) }
        if s.hasSuffix("```") { s = String(s.dropLast(3)) }
        s = s.trimmingCharacters(in: .whitespacesAndNewlines)

        guard let data = s.data(using: .utf8) else { throw GeminiError.badResponse }
        do {
            return try JSONDecoder().decode([Segment].self, from: data)
        } catch {
            throw GeminiError.badResponse
        }
    }
}
