import Foundation
import Speech
import AVFoundation

enum SpeechState: Equatable {
    case off
    case waiting
    case listening(String)
    case thinking
    case speaking
    case error(String)
}

@MainActor
class SpeechManager: NSObject, ObservableObject, SFSpeechRecognizerDelegate {
    static let shared = SpeechManager()
    
    @Published var state: SpeechState = .off
    @Published var partialText: String = ""
    
    private let speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: "it-IT"))
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private let audioEngine = AVAudioEngine()
    private var silenceTimer: Timer?
    
    override private init() {
        super.init()
        speechRecognizer?.delegate = self
    }
    
    func requestPermission() async -> Bool {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { auth in
                AVAudioSession.sharedInstance().requestRecordPermission { micGranted in
                    continuation.resume(returning: auth == .authorized && micGranted)
                }
            }
        }
    }
    
    func startListening(onResult: @escaping (String) -> Void) {
        stopListening()
        
        let localeId = (Store.shared.language == .english) ? "en-US" : "it-IT"
        let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeId))
        
        guard let recognizer = recognizer, recognizer.isAvailable else {
            state = .error("Riconoscimento vocale non disponibile.")
            return
        }
        
        let audioSession = AVAudioSession.sharedInstance()
        do {
            try audioSession.setCategory(.playAndRecord, mode: .measurement, options: [.duckOthers, .defaultToSpeaker])
            try audioSession.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            state = .error("Impossibile avviare il microfono.")
            return
        }
        
        recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
        guard let request = recognitionRequest else { return }
        request.shouldReportPartialResults = true
        
        let inputNode = audioEngine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { (buffer, _) in
            request.append(buffer)
        }
        
        audioEngine.prepare()
        do {
            try audioEngine.start()
            state = .listening("")
            partialText = ""
        } catch {
            state = .error("Errore avvio audio engine.")
            return
        }
        
        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] (result, error) in
            guard let self = self else { return }
            
            if let result = result {
                let text = result.bestTranscription.formattedString
                Task { @MainActor in
                    self.partialText = text
                    self.state = .listening(text)
                }
                
                // Reset timer silenzio (1.8 secondi di silenzio inviano il messaggio)
                self.silenceTimer?.invalidate()
                self.silenceTimer = Timer.scheduledTimer(withTimeInterval: 1.8, repeats: false) { [weak self] _ in
                    guard let self = self else { return }
                    Task { @MainActor in
                        let finalText = self.partialText
                        self.stopListening()
                        if !finalText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            onResult(finalText)
                        }
                    }
                }
            }
            
            if error != nil {
                Task { @MainActor in
                    self.stopListening()
                }
            }
        }
    }
    
    func stopListening() {
        silenceTimer?.invalidate()
        silenceTimer = nil
        
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        
        recognitionRequest?.endAudio()
        recognitionRequest = nil
        
        recognitionTask?.cancel()
        recognitionTask = nil
        
        if case .listening = state {
            state = .waiting
        }
    }
}
