package com.jarvisfit.app.data

import kotlinx.serialization.Serializable

@Serializable
data class Profile(
    val name: String = "",
    val birthDate: String = "",          // yyyy-MM-dd
    val sex: String = "M",               // "M" o "F"
    val heightCm: Double = 0.0,
    val weightKg: Double = 0.0,
    val targetWeightKg: Double = 0.0,
    val goal: String = "dimagrire",      // dimagrire / mantenere / massa
    val weeklyChangeKg: Double = 0.5,    // ritmo desiderato (kg/settimana)
    val activityLevel: String = "moderato", // sedentario / leggero / moderato / attivo / molto attivo
    val foodLikes: String = "",
    val foodDislikes: String = "",
    val dietNotes: String = "",          // es. vegetariano, orari, budget
    val photoPath: String = "",
    val appearanceNotes: String = "",    // descrizione generata dalla foto profilo
) {
    val isComplete get() = birthDate.isNotBlank() && heightCm > 0 && weightKg > 0
}

@Serializable
data class FoodItem(
    val name: String,
    val grams: Double = 0.0,
    val kcal: Double = 0.0,
    val protein: Double = 0.0,
    val carbs: Double = 0.0,
    val fat: Double = 0.0,
)

@Serializable
data class Meal(
    val id: String,
    val date: String,          // giorno a cui si riferisce il pasto (yyyy-MM-dd)
    val meal: String,          // colazione / pranzo / cena / spuntino
    val description: String = "",
    val items: List<FoodItem> = emptyList(),
    val loggedAt: String = "",  // quando è stato registrato
    val hasPhoto: Boolean = false,
) {
    val kcal get() = items.sumOf { it.kcal }
    val protein get() = items.sumOf { it.protein }
    val carbs get() = items.sumOf { it.carbs }
    val fat get() = items.sumOf { it.fat }
}

@Serializable
data class Activity(
    val id: String,
    val date: String,
    val type: String,          // palestra / corsa / camminata ...
    val description: String = "",
    val durationMin: Double = 0.0,
    val kcalBurned: Double = 0.0,
)

@Serializable
data class WeightEntry(val date: String, val kg: Double)

@Serializable
data class ChatMsg(
    val role: String,          // "user" o "assistant"
    val text: String,
    val at: String,
    val hasImage: Boolean = false,
)

@Serializable
data class PantryItem(
    val id: String,
    val name: String,
    val quantity: String = "",
    val category: String = "generale", // es. proteine, carboidrati, verdure, condimenti, altro
    val addedAt: String = "",
)

@Serializable
data class Recipe(
    val id: String,
    val title: String,
    val ingredients: List<FoodItem> = emptyList(),
    val instructions: String = "",
    val totalKcal: Double = 0.0,
    val totalProtein: Double = 0.0,
    val totalCarbs: Double = 0.0,
    val totalFat: Double = 0.0,
    val createdAt: String = "",
)

@Serializable
data class ActiveRecipeSession(
    val title: String = "",
    val currentStep: String = "",
    val ingredientsNeeded: String = "",
    val notes: String = "",
    val startedAt: String = "",
)

@Serializable
data class Diary(
    val profile: Profile = Profile(),
    val meals: List<Meal> = emptyList(),
    val activities: List<Activity> = emptyList(),
    val weights: List<WeightEntry> = emptyList(),
    val steps: Map<String, Int> = emptyMap(),   // data -> passi
    val chat: List<ChatMsg> = emptyList(),
    val pendingPhotoRequest: String = "",
    val pantry: List<PantryItem> = emptyList(), // alimenti disponibili in dispensa/frigo
    val savedRecipes: List<Recipe> = emptyList(), // ricette preferite salvate
    val activeRecipeSession: ActiveRecipeSession? = null, // nota/sessione della ricetta attualmente in corso di preparazione
)

