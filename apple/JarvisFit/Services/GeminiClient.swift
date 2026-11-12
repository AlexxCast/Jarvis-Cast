import Foundation

enum GeminiError: LocalizedError {
    case missingKey
    case invalidResponse(String)
    case networkTimeout
    
    var errorDescription: String? {
        switch self {
        case .missingKey: return "Manca la API key: inseriscila nel Profilo."
        case .invalidResponse(let msg): return "Errore API: \(msg)"
        case .networkTimeout: return "Timeout di rete: Google ha impiegato troppo tempo a rispondere. Riprovo..."
        }
    }
}

enum GeminiClient {
    
    private static let fallbackModels = [
        "gemini-3.8-flash",
        "gemini-flash-latest",
        "gemini-2.5-flash-lite",
        "gemini-3-pro-preview",
        "gemini-2.5-pro"
    ]

    private static func sanitizeModel(_ raw: String) -> String {
        var m = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "models/", with: "")
        if m.isEmpty || m.contains("claude") || m.contains("2.0-flash") || m.contains("1.5-flash") {
            m = "gemini-3.8-flash"
        }
        return m
    }
    
    static func send(body: [String: Any]) async throws -> [String: Any] {
        let key = await Store.shared.apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { throw GeminiError.missingKey }
        
        let initialModel = sanitizeModel(await Store.shared.selectedModel)
        var candidateModels = [initialModel]
        for m in fallbackModels {
            if !candidateModels.contains(m) {
                candidateModels.append(m)
            }
        }
        
        var lastError: Error?
        
        for model in candidateModels {
            for attempt in 1...2 {
                do {
                    return try await executePost(model: model, key: key, body: body, timeout: 35.0)
                } catch let err as GeminiError {
                    lastError = err
                    if case .invalidResponse(let msg) = err, (msg.contains("503") || msg.contains("429")) {
                        if attempt == 1 {
                            try? await Task.sleep(nanoseconds: 1_500_000_000)
                            continue
                        } else {
                            break
                        }
                    } else if case .invalidResponse(let msg) = err, msg.contains("404") {
                        break
                    } else if case .networkTimeout = err {
                        if attempt == 1 {
                            try? await Task.sleep(nanoseconds: 1_000_000_000)
                            continue
                        } else {
                            break
                        }
                    } else {
                        throw err
                    }
                } catch {
                    lastError = error
                    if attempt == 1 {
                        try? await Task.sleep(nanoseconds: 1_000_000_000)
                        continue
                    } else {
                        break
                    }
                }
            }
        }
        
        throw lastError ?? GeminiError.invalidResponse("I server di Google sono temporaneamente sovraccarichi su tutti i cluster (503).")
    }
    
    private static func executePost(model: String, key: String, body: [String: Any], timeout: TimeInterval) async throws -> [String: Any] {
        guard let url = URL(string: "https://generativelanguage.googleapis.com/v1beta/models/\(model):generateContent?key=\(key)") else {
            throw GeminiError.invalidResponse("URL non valido")
        }
        
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = timeout
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await URLSession.shared.data(for: req)
        } catch {
            let nsErr = error as NSError
            if nsErr.code == NSURLErrorTimedOut {
                throw GeminiError.networkTimeout
            }
            throw error
        }
        
        guard let http = response as? HTTPURLResponse else {
            throw GeminiError.invalidResponse("Risposta non HTTP")
        }
        
        guard (200...299).contains(http.statusCode) else {
            let text = String(data: data, encoding: .utf8) ?? ""
            throw GeminiError.invalidResponse("Codice \(http.statusCode): \(text.prefix(200))")
        }
        
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
        return json
    }
    
    static func extractToolInput(response: [String: Any]) -> [String: Any]? {
        guard let candidates = response["candidates"] as? [[String: Any]],
              let first = candidates.first,
              let content = first["content"] as? [String: Any],
              let parts = content["parts"] as? [[String: Any]] else {
            return nil
        }
        for part in parts {
            if let functionCall = part["functionCall"] as? [String: Any],
               let args = functionCall["args"] as? [String: Any] {
                return args
            }
        }
        return nil
    }
    
    static func extractText(response: [String: Any]) -> String {
        guard let candidates = response["candidates"] as? [[String: Any]],
              let first = candidates.first,
              let content = first["content"] as? [String: Any],
              let parts = content["parts"] as? [[String: Any]] else {
            return ""
        }
        let texts = parts.compactMap { $0["text"] as? String }
        return texts.joined(separator: "\n")
    }
}
