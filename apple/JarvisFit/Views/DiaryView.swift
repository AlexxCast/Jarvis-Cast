import SwiftUI

struct DiaryView: View {
    @ObservedObject var store = Store.shared
    @State private var selectedDate: Date = Date()
    
    private var dateKey: String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: selectedDate)
    }
    
    var body: some View {
        ZStack {
            Color.jarvisDarkBg.ignoresSafeArea()
            
            ScrollView {
                VStack(spacing: 14) {
                    // Date selector
                    DatePicker("Seleziona data", selection: $selectedDate, displayedComponents: .date)
                        .datePickerStyle(.compact)
                        .colorScheme(.dark)
                        .tint(.jarvisNeonGreen)
                        .padding(14)
                        .neonCard()
                    
                    let dayLog = store.diary.days[dateKey]
                    let totals = Nutrition.totals(diary: store.diary, date: dateKey)
                    
                    // Riepilogo del giorno selezionato
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Totali della Giornata")
                            .font(.system(size: 16, weight: .bold))
                            .foregroundColor(.white)
                        
                        HStack {
                            VStack(alignment: .leading) {
                                Text("\(Int(totals.kcal)) kcal")
                                    .font(.system(size: 24, weight: .bold))
                                    .foregroundColor(.jarvisNeonGreen)
                                Text("Consumate")
                                    .font(.system(size: 12))
                                    .foregroundColor(.gray)
                            }
                            Spacer()
                            VStack(alignment: .trailing) {
                                Text("\(Int(totals.burned)) kcal")
                                    .font(.system(size: 20, weight: .bold))
                                    .foregroundColor(.jarvisCyan)
                                Text("Bruciate")
                                    .font(.system(size: 12))
                                    .foregroundColor(.gray)
                            }
                        }
                        
                        Divider().background(Color.gray.opacity(0.3))
                        
                        HStack {
                            Text("Prot: \(Int(totals.protein))g")
                            Spacer()
                            Text("Carb: \(Int(totals.carbs))g")
                            Spacer()
                            Text("Gras: \(Int(totals.fat))g")
                        }
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(.white)
                    }
                    .padding(16)
                    .neonCard()
                    
                    // Pasti
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Pasti Registrati")
                            .font(.system(size: 16, weight: .bold))
                            .foregroundColor(.white)
                        
                        if let meals = dayLog?.meals, !meals.isEmpty {
                            ForEach(meals) { meal in
                                VStack(alignment: .leading, spacing: 4) {
                                    HStack {
                                        Text(meal.type.capitalized)
                                            .font(.system(size: 14, weight: .semibold))
                                            .foregroundColor(.jarvisNeonGreen)
                                        Spacer()
                                        Text("\(Int(meal.totalKcal)) kcal")
                                            .font(.system(size: 14, weight: .bold))
                                            .foregroundColor(.white)
                                    }
                                    ForEach(meal.items) { item in
                                        Text("• \(item.name) (\(Int(item.grams))g) - \(Int(item.kcal)) kcal")
                                            .font(.system(size: 12))
                                            .foregroundColor(.gray)
                                    }
                                }
                                .padding(.vertical, 4)
                                Divider().background(Color.gray.opacity(0.2))
                            }
                        } else {
                            Text("Nessun pasto registrato per questa data.")
                                .font(.system(size: 13))
                                .foregroundColor(.gray)
                                .padding(.vertical, 8)
                        }
                    }
                    .padding(16)
                    .neonCard()
                }
                .padding(14)
            }
        }
    }
}
