import Foundation

@MainActor
class Store: ObservableObject {
    static let shared = Store()
    
    @Published var diary: Diary = Diary()
    @Published var apiKey: String = ""
    @Published var selectedModel: String = "gemini-3.8-flash"
    @Published var speakReplies: Bool = true
    @Published var language: AppLanguage = .italian
    
    private let diaryKey = "JarvisFit_Diary_JSON"
    private let apiKeyKey = "JarvisFit_ApiKey"
    private let modelKey = "JarvisFit_Model"
    private let speakKey = "JarvisFit_Speak"
    private let langKey = "JarvisFit_Language"
    
    private init() {
        load()
    }
    
    static func todayString() -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: Date())
    }
    
    func load() {
        if let key = UserDefaults.standard.string(forKey: apiKeyKey) {
            apiKey = key
        }
        if let m = UserDefaults.standard.string(forKey: modelKey), !m.isEmpty {
            selectedModel = m
        }
        speakReplies = UserDefaults.standard.bool(forKey: speakKey)
        if let lStr = UserDefaults.standard.string(forKey: langKey), let l = AppLanguage(rawValue: lStr) {
            language = l
        }
        
        if let data = UserDefaults.standard.data(forKey: diaryKey),
           let decoded = try? JSONDecoder().decode(Diary.self, from: data) {
            diary = decoded
        }
    }
    
    func save() {
        UserDefaults.standard.set(apiKey, forKey: apiKeyKey)
        UserDefaults.standard.set(selectedModel, forKey: modelKey)
        UserDefaults.standard.set(speakReplies, forKey: speakKey)
        UserDefaults.standard.set(language.rawValue, forKey: langKey)
        if let encoded = try? JSONEncoder().encode(diary) {
            UserDefaults.standard.set(encoded, forKey: diaryKey)
        }
    }
    
    func addChat(role: String, text: String, hasImage: Bool = false) {
        let msg = ChatMessage(role: role, text: text, hasImage: hasImage)
        diary.chat.append(msg)
        if diary.chat.count > 100 {
            diary.chat.removeFirst(diary.chat.count - 100)
        }
        save()
    }
    
    func updateDiary(_ block: (inout Diary) -> Void) {
        block(&diary)
        save()
    }
}
