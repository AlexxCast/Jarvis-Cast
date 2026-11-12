import SwiftUI

struct ProfileView: View {
    @ObservedObject var store = Store.shared
    
    @State private var name: String = ""
    @State private var apiKey: String = ""
    @State private var age: String = ""
    @State private var weight: String = ""
    @State private var height: String = ""
    @State private var goal: String = "maintain"
    @State private var targetManual: String = ""
    @State private var speakReplies: Bool = true
    
    let goals = [
        ("lose", "Dimagrimento (-400 kcal)"),
        ("maintain", "Mantenimento"),
        ("gain", "Massa Muscolare (+350 kcal)")
    ]
    
    var body: some View {
        ZStack {
            Color.jarvisDarkBg.ignoresSafeArea()
            
            ScrollView {
                VStack(spacing: 16) {
                    // API Key Card
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Configurazione Google Gemini AI")
                            .font(.system(size: 16, weight: .bold))
                            .foregroundColor(.white)
                        Text("Inserisci la tua API Key di Google AI Studio:")
                            .font(.system(size: 12))
                            .foregroundColor(.gray)
                        
                        SecureField("Chiave API (AIzaSy...)", text: $apiKey)
                            .textFieldStyle(PlainTextFieldStyle())
                            .padding(10)
                            .background(Color.jarvisDarkBg)
                            .cornerRadius(8)
                            .foregroundColor(.white)
                        
                        Toggle(L10n.voiceReplies, isOn: $speakReplies)
                            .tint(.jarvisNeonGreen)
                            .font(.system(size: 13))
                            .foregroundColor(.white)
                    }
                    .padding(16)
                    .neonCard()
                    
                    // Language Card
                    VStack(alignment: .leading, spacing: 8) {
                        Text(L10n.appLanguageTitle)
                            .font(.system(size: 16, weight: .bold))
                            .foregroundColor(.white)
                        
                        Picker(L10n.appLanguageTitle, selection: $store.language) {
                            ForEach(AppLanguage.allCases) { l in
                                Text(l.title).tag(l)
                            }
                        }
                        .pickerStyle(SegmentedPickerStyle())
                        .colorScheme(.dark)
                        .onChange(of: store.language) { _ in
                            store.save()
                        }
                    }
                    .padding(16)
                    .neonCard()
                    
                    // Dati Fisici Card
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Profilo e Dati Fisici")
                            .font(.system(size: 16, weight: .bold))
                            .foregroundColor(.white)
                        
                        TextField("Il tuo nome", text: $name)
                            .textFieldStyle(PlainTextFieldStyle())
                            .padding(10)
                            .background(Color.jarvisDarkBg)
                            .cornerRadius(8)
                            .foregroundColor(.white)
                        
                        HStack {
                            VStack(alignment: .leading) {
                                Text("Età").font(.system(size: 11)).foregroundColor(.gray)
                                TextField("25", text: $age)
                                    .keyboardType(.numberPad)
                                    .padding(10)
                                    .background(Color.jarvisDarkBg)
                                    .cornerRadius(8)
                                    .foregroundColor(.white)
                            }
                            VStack(alignment: .leading) {
                                Text("Peso (kg)").font(.system(size: 11)).foregroundColor(.gray)
                                TextField("75", text: $weight)
                                    .keyboardType(.decimalPad)
                                    .padding(10)
                                    .background(Color.jarvisDarkBg)
                                    .cornerRadius(8)
                                    .foregroundColor(.white)
                            }
                            VStack(alignment: .leading) {
                                Text("Altezza (cm)").font(.system(size: 11)).foregroundColor(.gray)
                                TextField("175", text: $height)
                                    .keyboardType(.numberPad)
                                    .padding(10)
                                    .background(Color.jarvisDarkBg)
                                    .cornerRadius(8)
                                    .foregroundColor(.white)
                            }
                        }
                        
                        Text("Obiettivo").font(.system(size: 11)).foregroundColor(.gray)
                        Picker("Obiettivo", selection: $goal) {
                            ForEach(goals, id: \.0) { g in
                                Text(g.1).tag(g.0)
                            }
                        }
                        .pickerStyle(SegmentedPickerStyle())
                        .colorScheme(.dark)
                    }
                    .padding(16)
                    .neonCard()
                    
                    // Salva
                    Button(action: save) {
                        Text("Salva Profilo")
                            .font(.system(size: 15, weight: .bold))
                            .foregroundColor(.jarvisDarkBg)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                            .background(Color.jarvisNeonGreen)
                            .cornerRadius(12)
                    }
                }
                .padding(14)
            }
        }
        .onAppear(perform: load)
    }
    
    private func load() {
        apiKey = store.apiKey
        speakReplies = store.speakReplies
        let p = store.diary.profile
        name = p.name
        age = "\(p.age)"
        weight = "\(p.weightKg)"
        height = "\(p.heightCm)"
        goal = p.goal
        targetManual = p.targetKcalManual > 0 ? "\(Int(p.targetKcalManual))" : ""
    }
    
    private func save() {
        store.apiKey = apiKey
        store.speakReplies = speakReplies
        store.updateDiary { d in
            d.profile.name = name
            d.profile.age = Int(age) ?? 25
            d.profile.weightKg = Double(weight) ?? 75.0
            d.profile.heightCm = Double(height) ?? 175.0
            d.profile.goal = goal
            d.profile.targetKcalManual = Double(targetManual) ?? 0.0
        }
    }
}
