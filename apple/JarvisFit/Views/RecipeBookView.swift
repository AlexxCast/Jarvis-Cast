import SwiftUI

struct RecipeBookView: View {
    @ObservedObject var store = Store.shared
    var onStartCooking: () -> Void
    
    var body: some View {
        ZStack {
            Color.jarvisDarkBg.ignoresSafeArea()
            
            VStack(alignment: .leading, spacing: 14) {
                // Header
                HStack {
                    Image(systemName: "book.fill")
                        .font(.system(size: 24))
                        .foregroundColor(.jarvisNeonGreen)
                    VStack(alignment: .leading) {
                        Text("Ricettario Personale")
                            .font(.system(size: 20, weight: .bold))
                            .foregroundColor(.white)
                        Text("Le tue ricette preferite salvate con Jarvis")
                            .font(.system(size: 13))
                            .foregroundColor(.gray)
                    }
                    Spacer()
                }
                .padding(.horizontal, 16)
                .padding(.top, 14)
                
                if store.diary.savedRecipes.isEmpty {
                    Spacer()
                    VStack(spacing: 10) {
                        Text("📖")
                            .font(.system(size: 48))
                        Text("Nessuna ricetta salvata")
                            .font(.system(size: 17, weight: .bold))
                            .foregroundColor(.white)
                        Text("Quando parli di una ricetta con Jarvis e ti piace l'idea, digli:\n\"Jarvis, salva questa ricetta\"\ne la troverai catalogata qui pronta per essere cucinata!")
                            .font(.system(size: 13))
                            .foregroundColor(.gray)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 24)
                    }
                    .frame(maxWidth: .infinity)
                    Spacer()
                } else {
                    ScrollView {
                        LazyVStack(spacing: 12) {
                            ForEach(store.diary.savedRecipes) { recipe in
                                RecipeRowView(recipe: recipe, onStartCooking: {
                                    store.updateDiary { d in
                                        d.activeRecipeSession = ActiveRecipeSession(
                                            title: recipe.title,
                                            currentStep: "Inizio preparazione",
                                            ingredientsNeeded: recipe.ingredients.map { "\($0.name) \(Int($0.grams))g" }.joined(separator: ", "),
                                            notes: recipe.instructions,
                                            startedAt: Store.todayString()
                                        )
                                    }
                                    onStartCooking()
                                })
                            }
                        }
                        .padding(.horizontal, 14)
                        .padding(.bottom, 20)
                    }
                }
            }
        }
    }
}

struct RecipeRowView: View {
    let recipe: Recipe
    var onStartCooking: () -> Void
    @ObservedObject var store = Store.shared
    
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(recipe.title)
                        .font(.system(size: 17, weight: .bold))
                        .foregroundColor(.white)
                    Text("\(Int(recipe.totalKcal)) kcal • P: \(Int(recipe.totalProtein))g C: \(Int(recipe.totalCarbs))g G: \(Int(recipe.totalFat))g")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(.jarvisNeonGreen)
                }
                Spacer()
                Button(action: {
                    store.updateDiary { d in
                        d.savedRecipes.removeAll { $0.id == recipe.id }
                    }
                }) {
                    Image(systemName: "trash")
                        .font(.system(size: 15))
                        .foregroundColor(.jarvisRed)
                }
            }
            
            Divider().background(Color.gray.opacity(0.3))
            
            Text("Ingredienti:")
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(.gray)
            ForEach(recipe.ingredients) { item in
                Text("• \(item.name): \(Int(item.grams))g (\(Int(item.kcal)) kcal)")
                    .font(.system(size: 12))
                    .foregroundColor(.white.opacity(0.9))
            }
            
            if !recipe.instructions.isEmpty {
                Text("Preparazione:")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(.gray)
                    .padding(.top, 4)
                Text(recipe.instructions)
                    .font(.system(size: 12))
                    .foregroundColor(.white)
            }
            
            Button(action: onStartCooking) {
                HStack {
                    Image(systemName: "play.fill")
                    Text("Cucina ora questa ricetta")
                }
                .font(.system(size: 13, weight: .semibold))
                .foregroundColor(.jarvisDarkBg)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
                .background(Color.jarvisNeonGreen)
                .cornerRadius(10)
            }
            .padding(.top, 6)
        }
        .padding(14)
        .neonCard()
    }
}
