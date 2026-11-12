import Foundation
import AVFoundation

class Speaker: NSObject, AVSpeechSynthesizerDelegate {
    static let shared = Speaker()
    
    private let synthesizer = AVSpeechSynthesizer()
    private var onDone: (() -> Void)?
    
    override private init() {
        super.init()
        synthesizer.delegate = self
    }
    
    func speak(_ text: String, completion: (() -> Void)? = nil) {
        stop()
        self.onDone = completion
        
        let utterance = AVSpeechUtterance(string: text)
        let langCode = (Store.shared.language == .english) ? "en-GB" : "it-IT"
        utterance.voice = AVSpeechSynthesisVoice(language: langCode)
        utterance.rate = 0.50 // Velocità calibrata e naturale
        utterance.pitchMultiplier = 0.85 // Tono maschile più profondo tipo Jarvis di Iron Man
        
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio, options: .duckOthers)
        try? AVAudioSession.sharedInstance().setActive(true)
        
        synthesizer.speak(utterance)
    }
    
    func stop() {
        if synthesizer.isSpeaking {
            synthesizer.stopSpeaking(at: .immediate)
        }
        onDone = nil
    }
    
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        onDone?()
        onDone = nil
    }
}
