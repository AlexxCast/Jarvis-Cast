# JarvisFit per iOS (iPhone)

Progetto nativo in **Swift 5.9 & SwiftUI** per iPhone (iOS 16+).

## Caratteristiche Implementate
- **Grafica Dark Neon & Glassmorphism**: Tema nero con sfumature verde neon (`0x22E573`) coerente con la versione Android.
- **Home con Barra a Tendina Persistente**:
  - Riepilogo compatto in cima sempre visibile anche quando la chat scorre (`Kcal / Target`, rimaste/oltre, passi).
  - Espansione animata al tocco con macro (Proteine, Carboidrati, Grassi), calorie bruciate e target adattivo settimanale.
- **Indicatore Typing / Thinking**: Animazione pulsante *"Jarvis sta elaborando..."* durante le richieste AI.
- **AI Multimodale Google Gemini**:
  - Chiamate dirette con `URLSession` su `gemini-3.8-flash`.
  - Timeout automatico e fallback ultra-rapido a `gemini-3.5-flash-lite`.
- **Dispensa Intelligente (Pantry)**:
  - Scatto foto o selezione dalla libreria con `PhotosUI`.
  - Riconoscimento ingredienti automatico e consigli ricette su misura per i tuoi macro.
- **Voce e Riconoscimento Vocale iOS**:
  - Voce maschile profonda italiana stile Iron Man Jarvis con `AVSpeechSynthesizer`.
  - Riconoscimento vocale naturale in tempo reale tramite `SFSpeechRecognizer` e `AVAudioEngine`.
- **Target Adattivo Settimanale & Mensile**:
  - Compensazione automatica degli sgarri distribuita sui giorni rimanenti della settimana.

## Come Aprire ed Eseguire su iPhone (tramite Xcode su Mac)
1. Copia la cartella `apple/` su un Mac con **Xcode 15+**.
2. Apri Xcode e seleziona **File > Open**, quindi scegli la cartella `apple` (oppure crea un nuovo progetto iOS App e trascina all'interno la cartella `JarvisFit`).
3. Collega il tuo iPhone al Mac con il cavetto USB.
4. Nelle impostazioni di Signing in Xcode:
   - Seleziona il tuo **Personal Team** (il tuo Apple ID gratuito).
5. Premi **Run (Cmd + R)**: l'app si installerà direttamente sul tuo iPhone.
