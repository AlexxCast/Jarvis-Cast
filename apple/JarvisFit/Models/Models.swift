import Foundation

// MARK: - Modelli Dati

struct Profile: Codable {
    var name: String = ""
    var age: Int = 25
    var heightCm: Double = 175.0
    var weightKg: Double = 75.0
    var sex: String = "M" // "M" o "F"
    var goal: String = "maintain" // "lose", "maintain", "gain"
    var activityLevel: String = "moderate" // "sedentary", "light", "moderate", "active", "very_active"
    var targetKcalManual: Double = 0.0
    var proteinGramsManual: Double = 0.0
}

struct MealItem: Codable, Identifiable {
    var id: String = UUID().uuidString
    var name: String = ""
    var grams: Double = 0.0
    var kcal: Double = 0.0
    var protein: Double = 0.0
    var carbs: Double = 0.0
    var fat: Double = 0.0
}

struct Meal: Codable, Identifiable {
    var id: String = UUID().uuidString
    var type: String = "snack" // breakfast, lunch, dinner, snack
    var time: String = ""
    var note: String = ""
    var items: [MealItem] = []
    
    var totalKcal: Double { items.reduce(0) { $0 + $1.kcal } }
    var totalProtein: Double { items.reduce(0) { $0 + $1.protein } }
    var totalCarbs: Double { items.reduce(0) { $0 + $1.carbs } }
    var totalFat: Double { items.reduce(0) { $0 + $1.fat } }
}

struct Activity: Codable, Identifiable {
    var id: String = UUID().uuidString
    var type: String = "workout"
    var durationMinutes: Int = 30
    var burnedKcal: Double = 0.0
    var note: String = ""
}

struct DayLog: Codable {
    var date: String // yyyy-MM-dd
    var meals: [Meal] = []
    var activities: [Activity] = []
    var steps: Int = 0
}

struct PantryItem: Codable, Identifiable {
    var id: String = UUID().uuidString
    var name: String = ""
    var quantity: String = ""
    var category: String = "" // "proteine", "carboidrati", "verdura", "frutta", "condimenti", "altro"
    var addedDate: String = ""
}

struct ChatMessage: Codable, Identifiable {
    var id: String = UUID().uuidString
    var role: String // "user" o "assistant"
    var text: String
    var hasImage: Bool = false
    var timestamp: Date = Date()
}

struct Recipe: Codable, Identifiable {
    var id: String = UUID().uuidString
    var title: String = ""
    var ingredients: [MealItem] = []
    var instructions: String = ""
    var totalKcal: Double = 0.0
    var totalProtein: Double = 0.0
    var totalCarbs: Double = 0.0
    var totalFat: Double = 0.0
    var createdAt: String = ""
}

struct ActiveRecipeSession: Codable {
    var title: String = ""
    var currentStep: String = ""
    var ingredientsNeeded: String = ""
    var notes: String = ""
    var startedAt: String = ""
}

struct Diary: Codable {
    var profile: Profile = Profile()
    var days: [String: DayLog] = [:]
    var chat: [ChatMessage] = []
    var pantry: [PantryItem] = []
    var pendingPhotoRequest: String = ""
    var savedRecipes: [Recipe] = []
    var activeRecipeSession: ActiveRecipeSession? = nil
}

