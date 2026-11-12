# Jarvis Fit

Assistente vocale Android per alimentazione e allenamento. Dici **"Jarvis"**, parli, e lui registra i pasti, ti propone cosa cucinare, calcola i passi che ti servono e ricorda tutto lo storico.

## Cosa fa
- **Sempre in ascolto** della parola "Jarvis" (anche a schermo spento) tramite un servizio in primo piano con Porcupine, offline e a basso consumo. Funziona anche "Ehi Jarvis".
- Dopo la parola chiave senti un *bip*: dici la frase in italiano. Jarvis risponde a voce e, se ti fa una domanda, resta in ascolto senza bisogno di ripetere "Jarvis". Per chiudere basta dire "niente" o "annulla".
- **Profilo**: data di nascita, sesso, altezza, peso, obiettivo, ritmo, gusti e cibi da evitare, foto. Calcola il metabolismo basale (Mifflin-St Jeor), il mantenimento e un target con limiti di sicurezza.
- **Pasti a voce**: stima grammi, kcal e macro. Se la quantità è vaga ti **chiede una foto** con una notifica; tocchi "Scatta foto" e lui ricalcola.
- **Date naturali**: capisce "la cena di stasera", "il pranzo di ieri", "lunedì", e corregge un pasto già registrato invece di duplicarlo.
- **Attività e passi**: registra palestra e corsa. Il contapassi del telefono è integrato ed adatta dinamicamente le calorie giornaliere in tempo reale (ogni passo aggiunge calorie al budget), oltre a dirti quanti passi mancano per l'obiettivo.
- **Memoria**: tutto lo storico resta salvato sul telefono. A ogni richiesta Jarvis vede il dettaglio degli ultimi 31 giorni e le medie dei periodi precedenti.
- **Schermate**: "Oggi" mostra calorie, macro, passi e la chat (anche scritta); "Storico" mostra i giorni espandibili, con la possibilità di eliminare voci; "Profilo" contiene dati e impostazioni.

## Setup (10 minuti)
1. **Chiave Claude**: crea una API key su https://console.anthropic.com. L'uso è a consumo: ogni domanda invia il diario del mese, circa 5-10k token.
2. **Chiave Picovoice**: crea un account gratuito su https://console.picovoice.ai e copia la *AccessKey*. Il piano gratuito è per uso personale.
3. Apri la cartella `JarvisFit` con **Android Studio** (Ladybug o più recente). Lascia fare il Gradle sync, collega il telefono con il debug USB attivo e premi ▶ Run.
4. Nell'app, sotto **Profilo**, compila i dati e incolla le due chiavi, poi premi **Salva**.
5. In **Oggi** attiva l'interruttore accanto a "Jarvis" e concedi i permessi: microfono, notifiche, attività fisica, e "ignora ottimizzazione batteria".

## Da sapere
- **Batteria e marche**: Xiaomi, Samsung, Huawei e OnePlus chiudono le app in background. In *Impostazioni → App → Jarvis Fit → Batteria* imposta "Nessuna restrizione" o "Senza limiti", e su Xiaomi attiva anche l'avvio automatico.
- **Dopo un riavvio** apri l'app una volta. Da Android 14 non è più permesso riaccendere il microfono in automatico all'avvio del telefono.
- Il riconoscimento della frase usa il motore vocale di Google, quindi serve l'app Google aggiornata con la lingua italiana.
- Le chiavi e il diario (`diary.json`) restano solo nella memoria privata dell'app. Le frasi e le foto dei pasti vengono inviate all'API di Claude per l'elaborazione.
- Le stime di kcal e grammature sono indicative. Il target non scende mai sotto il metabolismo basale né sotto 1500/1200 kcal.

## Struttura
```
voice/JarvisService.kt   wake word "Jarvis" + speech-to-text + contapassi + notifiche
voice/Speaker.kt         sintesi vocale italiana
ai/Brain.kt              prompt, contesto del mese, azioni (add/update_meal, foto, peso…)
ai/ClaudeClient.kt       chiamate HTTP alla Messages API
data/                    modelli, salvataggio JSON, calcoli nutrizionali, immagini
ui/                      schermate Compose (Oggi, Storico, Profilo)
```
Puoi cambiare il modello dal Profilo (default `claude-sonnet-5-5`).
