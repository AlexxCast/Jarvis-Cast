import Foundation

enum AppLanguage: String, CaseIterable, Identifiable {
    case italian = "it"
    case english = "en"
    
    var id: String { rawValue }
    
    var title: String {
        switch self {
        case .italian: return "Italiano 🇮🇹"
        case .english: return "English 🇬🇧"
        }
    }
}

enum L10n {
    static var lang: AppLanguage {
        Store.shared.language
    }
    
    // Tabs
    static var tabToday: String { lang == .english ? "Today" : "Oggi" }
    static var tabPantry: String { lang == .english ? "Pantry" : "Dispensa" }
    static var tabRecipeBook: String { lang == .english ? "Recipes" : "Ricettario" }
    static var tabDiary: String { lang == .english ? "Diary" : "Diario" }
    static var tabProfile: String { lang == .english ? "Profile" : "Profilo" }
    
    // Header
    static var remaining: String { lang == .english ? "left" : "rimaste" }
    static var over: String { lang == .english ? "over" : "oltre" }
    static var steps: String { lang == .english ? "steps" : "passi" }
    static var adaptiveTarget: String { lang == .english ? "⚡ Adaptive Target:" : "⚡ Target Adattivo:" }
    static var regularTarget: String { lang == .english ? "⚡ Regular Target aligned with weekly plan" : "⚡ Target regolare in linea col piano settimanale" }
    static var burnedKcal: String { lang == .english ? "burned" : "bruciate" }
    static var weeklyBudget: String { lang == .english ? "Week:" : "Settimana:" }
    static var days: String { lang == .english ? "days" : "gg" }
    
    // Macros
    static var protein: String { lang == .english ? "Protein" : "Proteine" }
    static var carbs: String { lang == .english ? "Carbs" : "Carbo" }
    static var fat: String { lang == .english ? "Fat" : "Grassi" }
    
    // Active Cooking Banner
    static var cookingNow: String { lang == .english ? "🍳 Cooking Now:" : "🍳 In cucina:" }
    static var step: String { lang == .english ? "Step:" : "Passaggio:" }
    static var ingredients: String { lang == .english ? "Ingredients:" : "Ingredienti:" }
    
    // Chat & Input
    static var placeholderInput: String { lang == .english ? "Message Jarvis…" : "Scrivi a Jarvis…" }
    static var photoAttached: String { lang == .english ? "Photo attached" : "Foto selezionata" }
    static var jarvisThinking: String { lang == .english ? "Jarvis is processing…" : "Jarvis sta elaborando..." }
    static var emptyChatTitle: String { lang == .english ? "Speak or text Jarvis:" : "Parla o scrivi a Jarvis:" }
    static var emptyChatExamples: String {
        if lang == .english {
            return "• \"I had chicken and rice for lunch\"\n• \"What can I cook with what's in my pantry?\"\n• \"I cheated yesterday with a pizza\"\n• \"How many calories do I have left today?\""
        } else {
            return "• \"A pranzo ho mangiato pasta e tonno\"\n• \"Cosa posso cucinare con la dispensa?\"\n• \"Ieri sera ho sgarrato con la pizza\"\n• \"Quante calorie posso ancora mangiare oggi?\""
        }
    }
    
    // Pantry
    static var pantryTitle: String { lang == .english ? "Smart Pantry" : "Dispensa Intelligente" }
    static var pantrySubtitle: String {
        lang == .english
        ? "Take or upload photos of your fridge/shelves: Jarvis will automatically detect ingredients and tailor meals to your macros."
        : "Scatta o carica foto di frigo e scaffali: Jarvis riconoscerà automaticamente gli ingredienti e ti proporrà pasti su misura."
    }
    static var scanPantry: String { lang == .english ? "Scan Fridge / Pantry Photo" : "Scansiona Foto Frigo / Dispensa" }
    static var analyzing: String { lang == .english ? "Analyzing with Gemini AI…" : "Analisi con Gemini in corso..." }
    static var availableIngredients: String { lang == .english ? "Available Ingredients" : "Ingredienti Disponibili" }
    static var clearPantry: String { lang == .english ? "Clear all" : "Svuota" }
    static var emptyPantry: String { lang == .english ? "No ingredients logged. Snap a photo or add them manually." : "Nessun ingrediente registrato. Scatta una foto o aggiungili manualmente." }
    static var addIngredient: String { lang == .english ? "Add Ingredient" : "Aggiungi Ingrediente" }
    static var ingredientName: String { lang == .english ? "Name (e.g. Chicken breast)" : "Nome (es. Petto di pollo)" }
    static var ingredientQty: String { lang == .english ? "Qty (e.g. 400g)" : "Qtà (es. 400g)" }
    static var addBtn: String { lang == .english ? "Add" : "Aggiungi" }
    
    // Recipe Book
    static var recipeBookTitle: String { lang == .english ? "Personal Recipe Book" : "Ricettario Personale" }
    static var recipeBookSubtitle: String { lang == .english ? "Your favorite recipes saved with Jarvis" : "Le tue ricette preferite salvate con Jarvis" }
    static var noSavedRecipes: String { lang == .english ? "No saved recipes yet" : "Nessuna ricetta salvata" }
    static var noSavedRecipesDesc: String {
        lang == .english
        ? "When you discuss a recipe with Jarvis and like it, tell him:\n\"Jarvis, save this recipe\"\nand you'll find it cataloged here ready to cook!"
        : "Quando parli di una ricetta con Jarvis e ti piace l'idea, digli:\n\"Jarvis, salva questa ricetta\"\ne la troverai catalogata qui pronta per essere cucinata!"
    }
    static var cookNow: String { lang == .english ? "Cook this recipe now" : "Cucina ora questa ricetta" }
    static var instructions: String { lang == .english ? "Instructions:" : "Preparazione:" }
    
    // Diary
    static var diaryDate: String { lang == .english ? "Select Date" : "Seleziona data" }
    static var dailyTotals: String { lang == .english ? "Daily Totals" : "Totali della Giornata" }
    static var consumed: String { lang == .english ? "Consumed" : "Consumate" }
    static var loggedMeals: String { lang == .english ? "Logged Meals" : "Pasti Registrati" }
    static var noMealsLogged: String { lang == .english ? "No meals logged for this date." : "Nessun pasto registrato per questa data." }
    
    // Profile
    static var configTitle: String { lang == .english ? "Google Gemini AI Config" : "Configurazione Google Gemini AI" }
    static var apiKeyPrompt: String { lang == .english ? "Enter your Google AI Studio API Key:" : "Inserisci la tua API Key di Google AI Studio:" }
    static var voiceReplies: String { lang == .english ? "Voice Replies (Jarvis Voice)" : "Risposte Vocali (Jarvis Iron Man)" }
    static var appLanguageTitle: String { lang == .english ? "App Language" : "Lingua dell'Applicazione" }
    static var profileDataTitle: String { lang == .english ? "Profile & Physical Data" : "Profilo e Dati Fisici" }
    static var yourName: String { lang == .english ? "Your name" : "Il tuo nome" }
    static var age: String { lang == .english ? "Age" : "Età" }
    static var weight: String { lang == .english ? "Weight (kg)" : "Peso (kg)" }
    static var height: String { lang == .english ? "Height (cm)" : "Altezza (cm)" }
    static var goal: String { lang == .english ? "Goal" : "Obiettivo" }
    static var saveProfile: String { lang == .english ? "Save Profile" : "Salva Profilo" }
}
