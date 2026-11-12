import SwiftUI
import PhotosUI

struct TodayView: View {
    @ObservedObject var store = Store.shared
    @ObservedObject var speech = SpeechManager.shared
    
    @State private var isDashboardExpanded: Bool = false
    @State private var inputText: String = ""
    @State private var selectedPhotoItem: PhotosPickerItem? = nil
    @State private var selectedImageData: Data? = nil
    @State private var isProcessing: Bool = false
    
    var body: some View {
        ZStack {
            Color.jarvisDarkBg.ignoresSafeArea()
            
            VStack(spacing: 0) {
                // MARK: - Barra a tendina Persistente
                collapsibleHeader
                    .padding(.horizontal, 14)
                    .padding(.top, 8)
                    .padding(.bottom, 6)
                
                // MARK: - Banner Sessione Ricetta Attiva
                if let session = store.diary.activeRecipeSession {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text("🍳 In cucina:")
                                .font(.system(size: 14, weight: .bold))
                                .foregroundColor(.jarvisNeonGreen)
                            Text(session.title)
                                .font(.system(size: 14, weight: .bold))
                                .foregroundColor(.white)
                            Spacer()
                            Button("✕") {
                                store.updateDiary { $0.activeRecipeSession = nil }
                            }
                            .foregroundColor(.gray)
                        }
                        if !session.currentStep.isEmpty {
                            Text("Passaggio: \(session.currentStep)")
                                .font(.system(size: 12))
                                .foregroundColor(.jarvisNeonGreen.opacity(0.9))
                        }
                        if !session.ingredientsNeeded.isEmpty {
                            Text("Ingredienti: \(session.ingredientsNeeded)")
                                .font(.system(size: 11))
                                .foregroundColor(.gray)
                        }
                    }
                    .padding(12)
                    .neonCard()
                    .padding(.horizontal, 14)
                    .padding(.bottom, 4)
                }
                
                // MARK: - Chat LazyVStack & ScrollView
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 12) {
                            if store.diary.chat.isEmpty {
                                emptyPlaceholder
                            }
                            
                            ForEach(store.diary.chat) { msg in
                                ChatBubbleView(msg: msg)
                                    .id(msg.id)
                            }
                            
                            // Indicatore Jarvis Thinking / Typing
                            if isProcessing {
                                ThinkingBubbleView()
                                    .id("thinking_bubble")
                            }
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                    }
                    .onChange(of: store.diary.chat.count) { _ in
                        withAnimation {
                            if let last = store.diary.chat.last {
                                proxy.scrollTo(last.id, anchor: .bottom)
                            }
                        }
                    }
                    .onChange(of: isProcessing) { proc in
                        if proc {
                            withAnimation { proxy.scrollTo("thinking_bubble", anchor: .bottom) }
                        }
                    }
                }
                
                // MARK: - Barra di Input
                inputBar
            }
        }
    }
    
    // MARK: - Tendina Calorie & Statistiche
    private var collapsibleHeader: some View {
        let today = Store.todayString()
        let t = Nutrition.totals(diary: store.diary, date: today)
        let adapt = Nutrition.weeklyAdaptive(diary: store.diary)
        let target = adapt.adaptiveDailyTarget + Int(t.burned * 0.5 + t.stepBonus)
        let remaining = target - Int(t.kcal)
        
        return VStack(spacing: 0) {
            // Riga sempre visibile
            Button(action: {
                withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
                    isDashboardExpanded.toggle()
                }
            }) {
                HStack(spacing: 8) {
                    Circle()
                        .fill(speechStatusColor)
                        .frame(width: 10, height: 10)
                    
                    Text("\(Int(t.kcal)) / \(target) kcal")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundColor(.jarvisNeonGreen)
                    
                    Text(remaining >= 0 ? "(\(remaining) rimaste)" : "(\(-remaining) oltre)")
                        .font(.system(size: 12))
                        .foregroundColor(remaining >= 0 ? .jarvisCyan : .jarvisRed)
                    
                    Spacer()
                    
                    Text("👣 \(t.steps)")
                        .font(.system(size: 12))
                        .foregroundColor(.gray)
                    
                    Image(systemName: isDashboardExpanded ? "chevron.up" : "chevron.down")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundColor(.jarvisNeonGreen)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
            }
            .buttonStyle(PlainButtonStyle())
            
            // Contenuto espanso
            if isDashboardExpanded {
                VStack(alignment: .leading, spacing: 10) {
                    Divider().background(Color.gray.opacity(0.3))
                    
                    // Barra progresso kcal
                    ProgressView(value: min(1.0, max(0.0, t.kcal / Double(target))))
                        .tint(.jarvisNeonGreen)
                    
                    Text(adapt.deltaKcal != 0
                         ? "⚡ Target Adattivo: \(adapt.deltaKcal > 0 ? "+\(adapt.deltaKcal)" : "\(adapt.deltaKcal)") kcal da pasti precedenti"
                         : "⚡ Target regolare in linea col piano settimanale")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(.jarvisNeonGreen)
                    
                    if Int(t.stepBonus + t.burned * 0.5) > 0 {
                        Text("🔥 +\(Int(t.stepBonus + t.burned * 0.5)) kcal da passi (+\(Int(t.stepBonus))) e allenamenti")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundColor(.jarvisCyan)
                    }
                    
                    HStack(spacing: 12) {
                        MacroView(label: "Proteine", value: t.protein, target: Nutrition.proteinTarget(diary: store.diary))
                        MacroView(label: "Carbo", value: t.carbs, target: nil)
                        MacroView(label: "Grassi", value: t.fat, target: nil)
                    }
                    
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("👣 \(t.steps) passi (+\(Int(t.stepBonus)) kcal)   ·   🏋️ \(Int(t.burned)) kcal bruciate")
                                .font(.system(size: 12))
                                .foregroundColor(.gray)
                            Text("📅 Settimana: \(adapt.remainingBudgetWeek) kcal su \(adapt.daysRemaining) gg")
                                .font(.system(size: 11))
                                .foregroundColor(.gray)
                        }
                        Spacer()
                    }
                }
                .padding(.horizontal, 14)
                .padding(.bottom, 12)
            }
        }
        .neonCard()
    }
    
    // MARK: - Barra Input & Azioni
    private var inputBar: some View {
        VStack(spacing: 6) {
            if let imgData = selectedImageData, let uiImg = UIImage(data: imgData) {
                HStack {
                    Image(uiImage: uiImg)
                        .resizable()
                        .scaledToFill()
                        .frame(width: 44, height: 44)
                        .cornerRadius(8)
                        .clipped()
                    Text("Foto selezionata")
                        .font(.system(size: 13))
                        .foregroundColor(.white)
                    Spacer()
                    Button("✕") { selectedImageData = nil }
                        .foregroundColor(.gray)
                }
                .padding(.horizontal, 16)
            }
            
            HStack(spacing: 8) {
                PhotosPicker(selection: $selectedPhotoItem, matching: .images) {
                    Image(systemName: "camera.fill")
                        .font(.system(size: 18))
                        .foregroundColor(.jarvisNeonGreen)
                        .frame(width: 38, height: 38)
                        .background(Color.jarvisCardBg)
                        .clipShape(Circle())
                }
                .onChange(of: selectedPhotoItem) { item in
                    Task {
                        if let data = try? await item?.loadTransferable(type: Data.self) {
                            selectedImageData = data
                        }
                    }
                }
                
                TextField("Scrivi a Jarvis…", text: $inputText)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Color.jarvisCardBg)
                    .cornerRadius(20)
                    .foregroundColor(.white)
                
                if inputText.isEmpty && selectedImageData == nil {
                    Button(action: toggleMic) {
                        Image(systemName: isMicListening ? "mic.fill" : "mic")
                            .font(.system(size: 18))
                            .foregroundColor(isMicListening ? .white : .jarvisDarkBg)
                            .frame(width: 38, height: 38)
                            .background(isMicListening ? Color.jarvisRed : Color.jarvisNeonGreen)
                            .clipShape(Circle())
                    }
                } else {
                    Button(action: sendCurrentMessage) {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 18, weight: .bold))
                            .foregroundColor(.jarvisDarkBg)
                            .frame(width: 38, height: 38)
                            .background(Color.jarvisNeonGreen)
                            .clipShape(Circle())
                    }
                    .disabled(isProcessing)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
        .background(Color.jarvisDarkBg)
    }
    
    private var isMicListening: Bool {
        if case .listening = speech.state { return true }
        return false
    }
    
    private var speechStatusColor: Color {
        switch speech.state {
        case .off: return .gray
        case .waiting: return .jarvisNeonGreen
        case .listening: return .jarvisCyan
        case .thinking, .speaking: return .jarvisAmber
        case .error: return .jarvisRed
        }
    }
    
    private func toggleMic() {
        if isMicListening {
            speech.stopListening()
        } else {
            Task {
                let granted = await speech.requestPermission()
                if granted {
                    speech.startListening { voiceText in
                        send(text: voiceText, photoData: nil, speakReply: true)
                    }
                }
            }
        }
    }
    
    private func sendCurrentMessage() {
        let t = inputText
        let d = selectedImageData
        inputText = ""
        selectedImageData = nil
        send(text: t, photoData: d, speakReply: false)
    }
    
    private func send(text: String, photoData: Data?, speakReply: Bool) {
        guard !text.isEmpty || photoData != nil else { return }
        isProcessing = true
        
        Task {
            let b64 = photoData?.base64EncodedString()
            let reply = await Brain.handle(userText: text.isEmpty ? "Ecco la foto" : text, imageBase64: b64)
            isProcessing = false
            
            if speakReply && store.speakReplies {
                Speaker.shared.speak(reply.text)
            }
        }
    }
    
    private var emptyPlaceholder: some View {
        VStack(spacing: 8) {
            Image(systemName: "sparkles")
                .font(.system(size: 32))
                .foregroundColor(.jarvisNeonGreen)
            Text("Parla o scrivi a Jarvis:")
                .font(.system(size: 15, weight: .semibold))
                .foregroundColor(.white)
            Text("• \"A pranzo ho mangiato pasta e tonno\"\n• \"Cosa posso cucinare con la dispensa?\"\n• \"Ieri sera ho sgarrato con la pizza\"\n• \"Quante calorie posso ancora mangiare oggi?\"")
                .font(.system(size: 13))
                .foregroundColor(.gray)
                .multilineTextAlignment(.leading)
        }
        .padding(.vertical, 30)
    }
}

// MARK: - Subviews
struct MacroView: View {
    let label: String
    let value: Double
    let target: Double?
    
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.system(size: 11))
                .foregroundColor(.gray)
            Text(target != nil ? "\(Int(value)) / \(Int(target!)) g" : "\(Int(value)) g")
                .font(.system(size: 13, weight: .semibold))
                .foregroundColor(.white)
            if let t = target, t > 0 {
                ProgressView(value: min(1.0, value / t))
                    .tint(.jarvisCyan)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct ChatBubbleView: View {
    let msg: ChatMessage
    var isUser: Bool { msg.role == "user" }
    
    var body: some View {
        HStack {
            if isUser { Spacer(minLength: 40) }
            
            Text(msg.text)
                .font(.system(size: 15))
                .foregroundColor(.white)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(isUser ? Color.jarvisNeonGreen.opacity(0.2) : Color.jarvisCardBg)
                .cornerRadius(16)
                .overlay(
                    RoundedRectangle(cornerRadius: 16)
                        .stroke(isUser ? Color.jarvisNeonGreen.opacity(0.4) : Color.clear, lineWidth: 1)
                )
            
            if !isUser { Spacer(minLength: 40) }
        }
    }
}

struct ThinkingBubbleView: View {
    @State private var pulsing = false
    
    var body: some View {
        HStack {
            HStack(spacing: 8) {
                Circle()
                    .fill(Color.jarvisNeonGreen)
                    .frame(width: 8, height: 8)
                    .scaleEffect(pulsing ? 1.3 : 0.8)
                    .opacity(pulsing ? 1.0 : 0.4)
                
                Text("Jarvis sta elaborando...")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundColor(.jarvisNeonGreen)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(Color.jarvisCardBg)
            .cornerRadius(16)
            .overlay(
                RoundedRectangle(cornerRadius: 16)
                    .stroke(Color.jarvisNeonGreen.opacity(0.3), lineWidth: 1)
            )
            .onAppear {
                withAnimation(Animation.easeInOut(duration: 0.7).repeatForever(autoreverses: true)) {
                    pulsing = true
                }
            }
            
            Spacer(minLength: 40)
        }
    }
}
