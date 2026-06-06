import AVFoundation

/// Offline read-aloud via the OS speech synthesizer (free, no network).
final class SpeechService: NSObject, ObservableObject {
    private let synth = AVSpeechSynthesizer()
    @Published var isSpeaking = false
    var rate: Float = AVSpeechUtteranceDefaultSpeechRate

    override init() {
        super.init()
        synth.delegate = self
    }

    func speak(_ text: String, language: String = "en-US") {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        if synth.isSpeaking { synth.stopSpeaking(at: .immediate) }
        let u = AVSpeechUtterance(string: trimmed)
        u.voice = AVSpeechSynthesisVoice(language: language)
        u.rate = rate
        try? AVAudioSession.sharedInstance().setCategory(.playback)
        try? AVAudioSession.sharedInstance().setActive(true)
        synth.speak(u)
    }

    func stop() { synth.stopSpeaking(at: .immediate) }
}

extension SpeechService: AVSpeechSynthesizerDelegate {
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        DispatchQueue.main.async { self.isSpeaking = true }
    }
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        DispatchQueue.main.async { self.isSpeaking = false }
    }
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        DispatchQueue.main.async { self.isSpeaking = false }
    }
}
