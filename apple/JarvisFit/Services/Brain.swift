import Foundation

struct BrainReply {
    var text: String
    var expectReply: Bool
    var photoRequest: String?
    var cardInfo: String?
}

enum Brain {
    
    static func handle(userText: String, imageBase64: String? = nil) async -> BrainReply {
        let store = await Store.shared
        await store.addChat(role: "user", text: userText, hasImage: imageBase64 != nil)
        
        let requestBody = await buildRequest(userText: userText, imageBase64: imageBase64)
        
        do {
            let response = try await GeminiClient.send(body: requestBody)
            
            if let toolInput = GeminiClient.extractToolInput(response: response) {
                let photoReq = await applyActions(actions: toolInput["actions"] as? [[String: Any]])
                let replyText = (toolInput["reply"] as? String) ?? "Ai suoi ordini, signore."
                let expect = (toolInput["expect_reply"] as? Bool) ?? false
                let cardInfo = toolInput["card_info"] as? String
                
                let reply = BrainReply(text: replyText, expectReply: expect, photoRequest: photoReq, cardInfo: cardInfo)
                await store.addChat(role: "assistant", text: reply.text)
                return reply
            } else {
                let text = GeminiClient.extractText(response: response)
                let reply = BrainReply(text: text.isEmpty ? "Non ho compreso, signore. Può ripetere?" : text, expectReply: true, photoRequest: nil, cardInfo: nil)
                await store.addChat(role: "assistant", text: reply.text)
                return reply
            }
        } catch {
            let errorMsg = "Problema di connessione: \(error.localizedDescription)"
            await store.addChat(role: "assistant", text: errorMsg)
            return BrainReply(text: errorMsg, expectReply: false, photoRequest: nil, cardInfo: nil)
        }
    }
    
    private static func applyActions(actions: [[String: Any]]?) async -> String? {
        guard let actions = actions else { return nil }
        var photoReq: String? = nil
        let store = await Store.shared
        
        await store.updateDiary { diary in
            let today = Store.todayString()
            
            for action in actions {
                guard let name = action["name"] as? String else { continue }
                
                switch name {
                case "add_meal":
                    let date = (action["date"] as? String) ?? today
                    var day = diary.days[date] ?? DayLog(date: date)
                    
                    var items: [MealItem] = []
                    if let rawItems = action["items"] as? [[String: Any]] {
                        for ri in rawItems {
                            items.append(MealItem(
                                name: (ri["name"] as? String) ?? "",
                                grams: (ri["grams"] as? Double) ?? 0.0,
                                kcal: (ri["kcal"] as? Double) ?? 0.0,
                                protein: (ri["protein"] as? Double) ?? 0.0,
                                carbs: (ri["carbs"] as? Double) ?? 0.0,
                                fat: (ri["fat"] as? Double) ?? 0.0
                            ))
                        }
                    }
                    
                    let meal = Meal(
                        type: (action["type"] as? String) ?? "snack",
                        time: (action["time"] as? String) ?? "",
                        note: (action["note"] as? String) ?? "",
                        items: items
                    )
                    day.meals.append(meal)
                    diary.days[date] = day
                    
                case "add_activity":
                    let date = (action["date"] as? String) ?? today
                    var day = diary.days[date] ?? DayLog(date: date)
                    let act = Activity(
                        type: (action["type"] as? String) ?? "workout",
                        durationMinutes: (action["duration_minutes"] as? Int) ?? 30,
                        burnedKcal: (action["burned_kcal"] as? Double) ?? 0.0,
                        note: (action["note"] as? String) ?? ""
                    )
                    day.activities.append(act)
                    diary.days[date] = day

                case "set_steps":
                    let date = (action["date"] as? String) ?? today
                    var day = diary.days[date] ?? DayLog(date: date)
                    let st = (action["steps"] as? Int) ?? (action["steps"] as? Double).map { Int($0) } ?? 0
                    day.steps = max(0, st)
                    diary.days[date] = day
                    
                case "add_pantry_items":
                    if let rawItems = action["items"] as? [[String: Any]] {
                        for ri in rawItems {
                            let item = PantryItem(
                                name: (ri["name"] as? String) ?? "",
                                quantity: (ri["quantity"] as? String) ?? "",
                                category: (ri["category"] as? String) ?? "altro",
                                addedDate: today
                            )
                            diary.pantry.append(item)
                        }
                    }
                    
                case "remove_pantry_items":
                    if let names = action["names"] as? [String] {
                        let lower = names.map { $0.lowercased() }
                        diary.pantry.removeAll { p in lower.contains(where: { p.name.lowercased().contains($0) }) }
                    }
                    
                case "request_photo":
                    photoReq = action["reason"] as? String
                    
                case "update_recipe_session":
                    let title = (action["title"] as? String) ?? (diary.activeRecipeSession?.title ?? "Ricetta in corso")
                    let currentStep = (action["current_step"] as? String) ?? ""
                    let ingredientsNeeded = (action["ingredients_needed"] as? String) ?? ""
                    let notes = (action["notes"] as? String) ?? ""
                    diary.activeRecipeSession = ActiveRecipeSession(
                        title: title,
                        currentStep: currentStep,
                        ingredientsNeeded: ingredientsNeeded,
                        notes: notes,
                        startedAt: diary.activeRecipeSession?.startedAt ?? Store.todayString()
                    )
                    
                case "clear_recipe_session":
                    diary.activeRecipeSession = nil
                    
                case "save_recipe":
                    var items: [MealItem] = []
                    if let rawItems = action["items"] as? [[String: Any]] {
                        for ri in rawItems {
                            items.append(MealItem(
                                name: (ri["name"] as? String) ?? "",
                                grams: (ri["grams"] as? Double) ?? 0.0,
                                kcal: (ri["kcal"] as? Double) ?? 0.0,
                                protein: (ri["protein"] as? Double) ?? 0.0,
                                carbs: (ri["carbs"] as? Double) ?? 0.0,
                                fat: (ri["fat"] as? Double) ?? 0.0
                            ))
                        }
                    }
                    let title = (action["title"] as? String) ?? (diary.activeRecipeSession?.title ?? "Ricetta salvata")
                    let calcKcal = (action["total_kcal"] as? Double) ?? items.reduce(0) { $0 + $1.kcal }
                    let calcProt = (action["total_protein"] as? Double) ?? items.reduce(0) { $0 + $1.protein }
                    let calcCarbs = (action["total_carbs"] as? Double) ?? items.reduce(0) { $0 + $1.carbs }
                    let calcFat = (action["total_fat"] as? Double) ?? items.reduce(0) { $0 + $1.fat }
                    let recipe = Recipe(
                        id: UUID().uuidString,
                        title: title,
                        ingredients: items,
                        instructions: (action["instructions"] as? String) ?? (diary.activeRecipeSession?.notes ?? ""),
                        totalKcal: calcKcal,
                        totalProtein: calcProt,
                        totalCarbs: calcCarbs,
                        totalFat: calcFat,
                        createdAt: Store.todayString()
                    )
                    diary.savedRecipes.append(recipe)
                    diary.activeRecipeSession = nil
                    
                case "delete_recipe":
                    if let title = action["title"] as? String {
                        diary.savedRecipes.removeAll { $0.title.lowercased() == title.lowercased() }
                    }
                    
                default:
                    break
                }
            }
        }
        
        return photoReq
    }
    
    private static func buildRequest(userText: String, imageBase64: String?) async -> [String: Any] {
        let diary = await Store.shared.diary
        let systemPrompt = generateSystemPrompt(diary: diary)
        
        var parts: [[String: Any]] = []
        if let img = imageBase64 {
            parts.append([
                "inlineData": [
                    "mimeType": "image/jpeg",
                    "data": img
                ]
            ])
        }
        
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "it_IT")
        formatter.dateFormat = "EEEE dd MMMM yyyy HH:mm"
        let nowStr = formatter.string(from: Date())
        
        parts.append(["text": "[\(nowStr)] \(userText)"])
        
        let toolDefinition: [String: Any] = [
            "functionDeclarations": [[
                "name": "jarvis_action",
                "description": "Rispondi all'utente ed esegui modifiche a pasti, attività, dispensa o ricette.",
                "parameters": [
                    "type": "OBJECT",
                    "properties": [
                        "reply": ["type": "STRING", "description": "Risposta vocale/testuale in italiano stile Jarvis Iron Man."],
                        "card_info": ["type": "STRING", "description": "SCHEDA SINTETICA DATI/NOTIFICA: riassunto numerico essenziale per pop-up a schermo (kcal, macro, ricetta e dosi). NON mettere il discorso parlato."],
                        "expect_reply": ["type": "BOOLEAN", "description": "True se continui la conversazione."],
                        "actions": [
                            "type": "ARRAY",
                            "items": ["type": "OBJECT"]
                        ]
                    ],
                    "required": ["reply", "expect_reply"]
                ]
            ]]
        ]
        
        return [
            "systemInstruction": [
                "parts": [["text": systemPrompt]]
            ],
            "contents": [[
                "role": "user",
                "parts": parts
            ]],
            "tools": [toolDefinition],
            "toolConfig": [
                "functionCallingConfig": ["mode": "ANY"]
            ]
        ]
    }
    
    private static func generateSystemPrompt(diary: Diary) -> String {
        let name = diary.profile.name.isEmpty ? "signore" : diary.profile.name
        let adapt = Nutrition.weeklyAdaptive(diary: diary)
        let todayStr = Store.todayString()
        let t = Nutrition.totals(diary: diary, date: todayStr)
        let effectiveTarget = adapt.adaptiveDailyTarget + Int(t.burned * 0.5 + t.stepBonus)
        let remainingToday = effectiveTarget - Int(t.kcal)
        
        let pantryList = diary.pantry.map { "- \($0.name) (\($0.quantity), \($0.category))" }.joined(separator: "\n")
        let recipeList = diary.savedRecipes.map { "- \($0.title) (~\(Int($0.totalKcal)) kcal)" }.joined(separator: "\n")
        
        var activeRecipeText = ""
        if let ar = diary.activeRecipeSession {
            activeRecipeText = "\n🍳 RICETTA IN CORSO DI PREPARAZIONE:\n- \(ar.title): \(ar.currentStep) (Dosi: \(ar.ingredientsNeeded))\nContinua ad assistere l'utente finché non dice che ha finito."
        }
        
        return """
Sei JARVIS, l'assistente personale di \(name) ispirato all'intelligenza artificiale di Iron Man.
Personalità: impeccabile, calmo, brillante, rispettoso e devoto ("Certamente, signore", "Subito", "Ai suoi ordini").
Parli SEMPRE in italiano con tono naturale, sintetico ed elegante (1-3 frasi, numeri arrotondati, niente markdown).

STATO NUTRIZIONALE ADATTIVO:
- Target base teorico: \(adapt.targetDailyBase) kcal
- Target adattivo base da pasti passati: \(adapt.adaptiveDailyTarget) kcal (delta: \(adapt.deltaKcal > 0 ? "+\(adapt.deltaKcal)" : "\(adapt.deltaKcal)"))
- Oggi: \(t.steps) passi (\(Int(t.stepBurned)) kcal bruciate stimate -> +\(Int(t.stepBonus)) kcal al budget al 50%), allenamenti \(Int(t.burned)) kcal
- TARGET CALORICO EFFETTIVO OGGI: \(effectiveTarget) kcal | Rimanenti oggi: \(remainingToday) kcal
- Budget residuo settimana: \(adapt.remainingBudgetWeek) kcal su \(adapt.daysRemaining) giorni

DISPENSA ATTUALE DELL'UTENTE:
\(pantryList.isEmpty ? "La dispensa è attualmente vuota." : pantryList)

RICETTARIO SALVATO DELL'UTENTE:
\(recipeList.isEmpty ? "Nessuna ricetta salvata." : recipeList)
\(activeRecipeText)

COMPITI FIT E CUCINA:
- Quando l'utente mangia: calcola kcal e macro e usa add_meal.
- Target adattivo continuo e passi:
  * Ogni passo brucia ~\(String(format: "%.3f", Nutrition.kcalPerStep(diary: diary))) kcal. Il 50% di queste kcal viene aggiunto automaticamente al budget giornaliero (oggi +\(Int(t.stepBonus)) kcal per \(t.steps) passi).
  * Comunica sempre il target effettivo aggiornato (\(effectiveTarget) kcal) e le calorie rimanenti (\(remainingToday) kcal).
  * Se l'utente comunica i passi a voce (es. "Oggi ho fatto 7000 passi"), usa set_steps per registrarli.
- Se l'utente sgarra o registra pasti passati: spiega come il target settimanale si adatta per bilanciare senza privazioni.
- RICETTE & CUCINA IN CORSO:
  * OBBLIGATORIO: Quando proponi una ricetta o l'utente inizia a cucinare, usa SEMPRE update_recipe_session (title, current_step, ingredients_needed, notes) per mostrare il banner in alto e la notifica con le dosi.
  * Quando l'utente finisce di cucinare o ringrazia, usa clear_recipe_session.
  * Se dice "salva la ricetta" o gli piace, usa save_recipe.
  * ADATTAMENTO DOSI: Se l'utente vuole cucinare una ricetta ma il fabbisogno calorico di oggi è diverso, RICALCOLA E MODIFICA AUTOMATICAMENTE LE DOSI (es. riduci la pasta da 100g a 70g) per rientrare perfettamente nel target!
"""
    }
}

