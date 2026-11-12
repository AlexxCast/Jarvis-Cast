import SwiftUI
import PhotosUI

struct PantryView: View {
    @ObservedObject var store = Store.shared
    @State private var selectedPhotoItem: PhotosPickerItem? = nil
    @State private var manualName: String = ""
    @State private var manualQty: String = ""
    @State private var manualCategory: String = "proteine"
    @State private var isAnalyzing: Bool = false
    
    let categories = ["proteine", "carboidrati", "verdura", "frutta", "condimenti", "altro"]
    
    var body: some View {
        ZStack {
            Color.jarvisDarkBg.ignoresSafeArea()
            
            ScrollView {
                VStack(spacing: 16) {
                    // Header card
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Image(systemName: "refrigerator.fill")
                                .font(.system(size: 24))
                                .foregroundColor(.jarvisNeonGreen)
                            Text("Dispensa Intelligente")
                                .font(.system(size: 20, weight: .bold))
                                .foregroundColor(.white)
                            Spacer()
                        }
                        Text("Scatta o carica foto di frigo e scaffali: Jarvis riconoscerà automaticamente gli ingredienti e ti proporrà pasti su misura.")
                            .font(.system(size: 13))
                            .foregroundColor(.gray)
                        
                        PhotosPicker(selection: $selectedPhotoItem, matching: .images) {
                            HStack {
                                Image(systemName: "camera.viewfinder")
                                Text(isAnalyzing ? "Analisi con Gemini in corso..." : "Scansiona Foto Frigo / Dispensa")
                            }
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundColor(.jarvisDarkBg)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                            .background(Color.jarvisNeonGreen)
                            .cornerRadius(12)
                        }
                        .disabled(isAnalyzing)
                        .onChange(of: selectedPhotoItem) { item in
                            guard let item = item else { return }
                            Task {
                                if let data = try? await item.loadTransferable(type: Data.self) {
                                    analyzePantryPhoto(data: data)
                                }
                            }
                        }
                    }
                    .padding(16)
                    .neonCard()
                    
                    // Lista ingredienti
                    VStack(alignment: .leading, spacing: 12) {
                        HStack {
                            Text("Ingredienti Disponibili (\(store.diary.pantry.count))")
                                .font(.system(size: 16, weight: .bold))
                                .foregroundColor(.white)
                            Spacer()
                            if !store.diary.pantry.isEmpty {
                                Button("Svuota") {
                                    store.updateDiary { $0.pantry.removeAll() }
                                }
                                .font(.system(size: 12))
                                .foregroundColor(.jarvisRed)
                            }
                        }
                        
                        if store.diary.pantry.isEmpty {
                            Text("Nessun ingrediente registrato. Scatta una foto o aggiungili manualmente.")
                                .font(.system(size: 13))
                                .foregroundColor(.gray)
                                .padding(.vertical, 10)
                        } else {
                            ForEach(store.diary.pantry) { item in
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(item.name)
                                            .font(.system(size: 15, weight: .medium))
                                            .foregroundColor(.white)
                                        Text("\(item.quantity) • \(item.category)")
                                            .font(.system(size: 12))
                                            .foregroundColor(.gray)
                                    }
                                    Spacer()
                                    Button(action: {
                                        store.updateDiary { d in
                                            d.pantry.removeAll { $0.id == item.id }
                                        }
                                    }) {
                                        Image(systemName: "trash")
                                            .font(.system(size: 14))
                                            .foregroundColor(.gray)
                                    }
                                }
                                .padding(.vertical, 6)
                                Divider().background(Color.gray.opacity(0.2))
                            }
                        }
                    }
                    .padding(16)
                    .neonCard()
                    
                    // Aggiunta manuale rapida
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Aggiungi Ingrediente")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundColor(.white)
                        
                        HStack {
                            TextField("Nome (es. Petto di pollo)", text: $manualName)
                                .textFieldStyle(PlainTextFieldStyle())
                                .padding(10)
                                .background(Color.jarvisDarkBg)
                                .cornerRadius(8)
                                .foregroundColor(.white)
                            
                            TextField("Qtà (es. 400g)", text: $manualQty)
                                .textFieldStyle(PlainTextFieldStyle())
                                .padding(10)
                                .frame(width: 90)
                                .background(Color.jarvisDarkBg)
                                .cornerRadius(8)
                                .foregroundColor(.white)
                        }
                        
                        Button("Aggiungi") {
                            guard !manualName.trimmingCharacters(in: .whitespaces).isEmpty else { return }
                            let itm = PantryItem(
                                name: manualName,
                                quantity: manualQty.isEmpty ? "presente" : manualQty,
                                category: manualCategory,
                                addedDate: Store.todayString()
                            )
                            store.updateDiary { $0.pantry.append(itm) }
                            manualName = ""
                            manualQty = ""
                        }
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundColor(.jarvisNeonGreen)
                    }
                    .padding(16)
                    .neonCard()
                }
                .padding(14)
            }
        }
    }
    
    private func analyzePantryPhoto(data: Data) {
        isAnalyzing = true
        Task {
            let b64 = data.base64EncodedString()
            _ = await Brain.handle(
                userText: "Analizza questa foto della mia dispensa/frigo: elenca tutti gli ingredienti riconosciuti e aggiungili alla dispensa con add_pantry_items.",
                imageBase64: b64
            )
            isAnalyzing = false
        }
    }
}
