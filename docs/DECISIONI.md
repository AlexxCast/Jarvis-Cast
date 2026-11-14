# Jarvis: decisioni, flussi di lavoro e ragionamenti

Questo documento raccoglie tutto quello che è stato deciso costruendo Jarvis (novembre 2026), il perché delle scelte e come si lavora sul progetto. Serve a chi riprende il lavoro (una persona o un assistente come Antigravity o Claude) per non rifare domande già risolte e non rompere scelte fatte apposta.

Aggiornalo quando prendi una decisione nuova.

---

## 1. Cos'è Jarvis e cosa vuole Alessio

Jarvis è un assistente personale "a 360 gradi": dieta e sport, agenda, promemoria, memoria della vita quotidiana, controllo del telefono e, più avanti, di tutti i dispositivi (PC Windows, un dispositivo da stanza, un robot).

Richieste di fondo, mai da tradire:

- **I dati non si perdono.** Il diario di dieta e sport (pasti dal 10/10/2026, pesi, attività, chat) viene dalla vecchia app JarvisFit e va conservato sempre. Un backup è in `/mnt/project-files/jarvis/backup/` (cartella del progetto Claude, non nel repo).
- **Un solo APK, poi aggiornamenti dal web.** L'APK esiste solo per quello che un sito non può fare: permessi, microfono a schermo spento, notifiche, controllo del telefono. Tutto il resto (interfaccia, cervello) si aggiorna da solo da git. Un nuovo APK si fa solo quando cambia la parte nativa.
- **L'APK si installa sempre SOPRA quello vecchio, mai disinstallare.** Stesso pacchetto `com.jarvisfit.app`, stessa chiave di firma (certificato v2 SHA-256 `CBE33F52DF0FCE8EF19F5A16A1475D8E4854D23AE0A01047F5AFEA624C2F0E07`). Se la firma cambia, Android rifiuta l'aggiornamento e l'unica via sarebbe disinstallare, perdendo i dati.
- **Interazione dal vivo, senza attese.** I modelli lenti che ragionano si usano solo per compiti che lo richiedono.
- **Modelli gratuiti, con cambio prima che finiscano i crediti.** Il cambio avviene senza perdere la sessione.
- **Memoria persistente e modulare**, usata solo quando serve.
- **Onestà sulle azioni.** Jarvis non deve mai dire "fatto" se non l'ha fatto davvero. Questo è stato un problema reale e molto sentito.
- **La lingua è l'italiano.** Le risposte di Jarvis sono in italiano e brevi.
- **Abbonamenti:** Gemini Pro e Claude. Sono abbonamenti da consumatore e non includono crediti API: per le API si usano i livelli gratuiti dei provider.
- **Luogo:** Alessio vive a Klagenfurt (Austria), fuso orario Europa/Roma.

---

## 2. Architettura

```
web/      interfaccia (HTML/CSS/JS senza build): sfera, chat, oggi, cucina, mente, impostazioni, finestra sopra le app
server/   Cloudflare Worker "jarvis-cast" + Durable Object con SQLite: API, cervello, router dei modelli, memoria, diario, promemoria
app/      app Android (Kotlin): guscio WebView + servizio vocale + controllo del telefono
apple/    vecchia versione iOS, non collegata al cloud
scripts/  strumenti (es. apk_cert.py per controllare la firma)
docs/     guide
```

### Perché così

- **Cloudflare Worker con Durable Object e SQLite.** È gratuito, sempre acceso, tiene le chiavi API lontane dal telefono e ha un database vero per persona.
  - Il token `JARVIS_TOKEN` protegge le API.
  - Le chiavi dei provider sono Secrets del Worker, mai nel codice.
- **Web app senza build** (moduli ES nativi). Così ogni modifica su `main` è subito online e Jarvis stesso può modificarla (vedi "Jarvis programmatore").
- **Android come guscio.**
  - Una WebView carica la web app e un ponte `JarvisNative` dà accesso alle funzioni del telefono.
  - Se non è configurato un server, l'app funziona ancora in "modalità classica" (la vecchia JarvisFit).

### File chiave del server (`server/src/`)

| File | Cosa fa |
|---|---|
| `index.js` | ingresso, controllo del token, file statici |
| `api.js` | tutte le rotte `/api/...` |
| `brain.js` | gestione di un messaggio: contesto, modello, azioni, controllo di onestà |
| `context.js` | costruisce il prompt a moduli (`buildMessages`), regole, recupero di JSON troncato |
| `router.js` + `models.js` | scelta del modello, limiti, cambio di provider |
| `memory.js` | moduli, argomenti, grafo della sfera, livelli |
| `phone.js` | agente che usa il telefono, conferme in sospeso, elenco app |
| `web.js` | ricerca internet (Gemini con Google Search, fallback Wikipedia) e lettura pagine |
| `weather.js` | meteo vero con Open-Meteo |
| `diet.js`, `nutrition.js` | diario alimentare e sportivo |
| `agenda.js`, `jobs.js`, `places.js` | promemoria, compiti in background, luoghi |
| `coder.js` | Jarvis programmatore (modifica solo `web/` tramite PR) |
| `mood.js`, `ui.js` | umore e riquadri personalizzati |

### File chiave Android (`app/src/main/java/com/jarvisfit/app/`)

| File | Cosa fa |
|---|---|
| `voice/JarvisService.kt` | servizio sempre attivo: parola chiave, ascolto, risposta, voce |
| `voice/VoiceText.kt` | riconosce "Jarvis" e le storpiature comuni (giarvis, garvis, jarbis...) |
| `voice/MicGuard.kt` | libera il microfono quando un'altra app registra |
| `voice/VoiceId.kt`, `VoicePrint.kt` | riconoscimento della voce del proprietario, tutto sul telefono |
| `device/JarvisAccessibility.kt`, `PhoneAgent.kt` | controllo del telefono: legge lo schermo, tocca, scrive |
| `device/Dialer.kt` | telefonate ai contatti |
| `device/Overlay.kt` | finestra sopra le altre app (rete 2D, frasi, grafiche) |
| `device/Places.kt`, `PlaceReceiver.kt` | promemoria per luogo ("quando arrivo a casa") |
| `net/Cloud.kt` | chiamate al server |
| `ui/WebShell.kt` | WebView e ponte `JarvisNative` |

---

## 3. Flusso di lavoro (come si cambia qualcosa)

1. **Si lavora su un branch, mai direttamente su `main`.**
2. **Prima di unire, i test devono passare: `npm test`.** Ci sono oltre 60 test in `server/test/`. Se cambi logica, aggiungi un test. Non si disattiva mai un test per far passare la CI.
3. **Si apre una Pull Request.** La CI su GitHub esegue due controlli:
   - "Server e web (test)";
   - "App Android (test e build)", che è l'unico posto dove si compila l'app Android.
4. **Si unisce (squash) quando la CI è verde.** Alessio approva le unioni dicendo "unisci" o "fai l'APK".
5. **Unire su `main` pubblica tutto da solo:**
   - **Cloudflare (Workers Builds)** pubblica server e web app.
     - Il controllo "Workers Builds" sui branch di anteprima fallisce sempre: è normale e va ignorato.
     - Quello su `main` deve essere verde.
     - Se Cloudflare smette di costruire da solo, la soluzione è scollegare e ricollegare il repo Git in Cloudflare › Impostazioni › Build.
   - **GitHub Actions "Build APK"** compila l'APK firmato con la chiave del PC di Alessio (secret `DEBUG_KEYSTORE_B64`). Lo pubblica nella release `apk-latest` solo se la firma coincide con l'app installata.
     - Link fisso: https://github.com/AlexxCast/Jarvis-Cast/releases/download/apk-latest/Jarvis.apk
6. **Se cambia la parte Android:**
   - aumenta `versionCode` e `versionName` in `app/build.gradle.kts`;
   - verifica la firma con `python3 -I scripts/apk_cert.py Jarvis.apk`.
7. **Se cambia la web app**, aumenta la versione della cache in `web/sw.js` (es. `jarvis-shell-v13` → `v14`). Così il telefono prende subito i file nuovi.
8. **Mai nel repo:** keystore, chiavi API, token. Il file `local.properties`, le build e gli APK sono esclusi.

### Secrets del Worker (Cloudflare)

- **Accesso:** `JARVIS_TOKEN`.
- **Modelli:** `GEMINI_API_KEY`, `GROQ_API_KEY`, `NVIDIA_API_KEY`, `OPENROUTER_API_KEY`, `GITHUB_MODELS_TOKEN`.
- **Modelli opzionali:** `CEREBRAS_API_KEY`, `MISTRAL_API_KEY`, `DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY`.
- **Jarvis programmatore:** `GITHUB_TOKEN` (fine-grained, Contents e Pull requests in lettura e scrittura) e `GITHUB_REPO`.
- **Fuso orario:** `TZ_NAME`.

---

## 4. Decisioni per area, con il ragionamento

### Modelli e contesto

- **Router a livelli.** Ogni richiesta va su uno di tre livelli: veloce, ragionamento, immagini.
  - Il router conta richieste e token per provider e **cambia modello all'80% del limite**, prima dell'errore.
  - Se un provider cade, la stessa richiesta riparte su un altro.
- **Le sessioni non si perdono** perché conversazione, riassunto e memoria vivono nel database, non nel modello. Cambiare modello a metà discorso è invisibile.
- **Contesto modulare.** Ogni richiesta riceve:
  - il nucleo e il riepilogo della giornata;
  - solo i moduli che servono (la dieta solo se si parla di cibo);
  - il riassunto e gli ultimi messaggi.

  Tutto viene dimensionato sulla finestra del modello.
- **Modelli che "pensano"** (Gemini Flash non-lite, gpt-oss):
  - ricevono +1500 token e `reasoning_effort: low`, altrimenti restituivano risposte vuote;
  - se il provider rifiuta il parametro, c'è un secondo tentativo senza.
- **Timeout:** 22 secondi per il livello veloce, 45 per gli altri.
- **Formato della risposta del modello:** JSON con `reply, expect_reply, card, topics, mood, actions`.

### Onestà sulle azioni (problema reale, risolto in PR #22)

Jarvis diceva "ho aggiornato il piano" o "chiamo Marcolino" senza farlo.

- Ogni azione dichiarata viene verificata. Un pasto conta solo se il diario è cambiato davvero.
- Se la risposta dice di aver fatto qualcosa e nessuna azione è andata a buon fine, Jarvis fa **un** secondo tentativo con il modello.
- Se anche il secondo tentativo fallisce, Jarvis risponde onestamente "non sono riuscito a...". Se solo una parte riesce, lo dice.
- **Non togliere questo controllo.**

### Sfera e interfaccia

- **Idea di Alessio:** una rete neurale verde a forma di sfera, stile circuito stampato e cervello, con impulsi. Reagisce quando Jarvis ascolta, pensa, parla e guarda.
- **Versione attuale (v3):**
  - Niente rete finta al centro. Al centro c'è un solo nodo Jarvis.
  - Ogni area è un nodo sulla superficie della sfera, con i sotto-argomenti vicini collegati da piste stile PCB curve.
  - La sfera cresce nodo per nodo.
- **Livelli senza limite.** I rami stanno su gusci, e il livello dipende da tre fattori:
  - 40% dimensione delle informazioni;
  - 30% frequenza d'uso;
  - 30% quanto è personale.

  I rami interni sono i più personali, leggeri e usati. Ci sono fino a 32 foglie per ramo e la telecamera si adatta.
- **L'umore colora la rete e gli impulsi**, con un'onda dal centro. **Non colora lo sfondo:** è una richiesta esplicita di Alessio.
- **Dieta e Sport sono rami separati.** Sport ha un nodo per ogni tipo di attività.
- **Argomenti:**
  - i duplicati si uniscono da soli e i sotto-argomenti si annidano (`topics.parent`);
  - i nomi di app storpiati vengono riportati all'app installata.

  Esempio: Alessio usa davvero un'app chiamata **Joytify**, non Spotify.
- **La chat è nascosta** finché non si apre. Toccando un ramo si fa zoom.
- **Impostazioni › Mente** mostra come Jarvis archivia contesti e progetti.
- **Finestra sopra le altre app (ad app chiusa):**
  - mostra la vera rete di Jarvis appiattita in 2D (`web/net2d.js`, `web/overlay.js`), la frase che sta dicendo e le grafiche;
  - non intercetta mai i tocchi;
  - il token passa nel frammento `#t=` dell'indirizzo, che non viene mai inviato in rete.
- **Grafiche:** l'azione `show` supporta i tipi `bars, line, pie, list, text, svg, image` (`web/visual.js`).

### Voce

- **Parola chiave:** "Jarvis", "Ehi Jarvis", "Ciao Jarvis".
  - Deve capire il contesto: non deve attivarsi quando si parla dei film Marvel.
  - Si riconoscono anche le storpiature.
  - La sensibilità si sceglie in Impostazioni: Bassa, Media o Alta.
  - Dopo una domanda di Jarvis ascolta la risposta senza bisogno della parola chiave.
- **MicGuard:** Jarvis libera il microfono quando un'altra app registra (Gemini, messaggi vocali). Era il bug principale della vecchia app.
- **Limite noto, lasciato così:** Jarvis non ascolta mentre c'è musica.
- **Riconoscimento della voce del proprietario:**
  - Funziona solo sul telefono (MFCC e intonazione).
  - Registrazione della voce: 3 volte la frase "Jarvis, sono io, procedi pure".
  - Protegge l'uso del telefono e le telefonate. La fiducia dura 10 minuti.
  - È stato provato solo con segnali sintetici, quindi le soglie potrebbero aver bisogno di regolazione.

### Controllo del telefono

- **AccessibilityService "Jarvis: usa il telefono"** con un agente che fa una mossa alla volta (`/api/phone/step`).
  - Chiede prima di fare azioni irreversibili.
  - **Non scrive mai password.**
  - Non agisce con il telefono bloccato.
- **Se Android blocca l'Accessibilità** come "Impostazione con restrizioni" (APK installato a mano): Info app › ⋮ › Consenti impostazioni con restrizioni.
- **Il telefono invia l'elenco delle app installate**, così Jarvis apre l'app giusta anche se il nome viene capito male.
- **Il server aggiunge l'azione sul telefono quando serve:**
  - se la risposta promette un'azione senza farla, aggiunge un `phone_task`;
  - se l'utente voleva fare qualcosa dentro un'app, un semplice `open_app` diventa un `phone_task`.
- **Una conferma in sospeso** ("sì, invialo") resta valida 15 minuti.
- **Telefonate:** l'azione `call {name}` cerca nei contatti (permessi READ_CONTACTS e CALL_PHONE).

### Internet, meteo, luoghi

- **Internet:** ricerca con Google Search tramite la chiave Gemini già presente, con Wikipedia come riserva. Lettura delle pagine solo in https.
- **Meteo:** vero, da Open-Meteo. La città si sceglie così:
  - quella detta nella frase;
  - altrimenti l'ultima chiesta;
  - altrimenti il luogo "casa".
- **Promemoria per luogo:** Android usa avvisi di prossimità.

### Jarvis programmatore

- Su richiesta, Jarvis modifica **solo `web/`** tramite PR su GitHub.
- Alessio vuole **sempre un'anteprima visiva vera** (`/preview/<id>/`) prima di approvare, mai solo testo.

---

## 5. Stato attuale (14/11/2026)

- **Pubblicato:** tutto fino alla PR #25.
- **APK:** l'ultimo è il 2.13.
- **Mai verificato da noi sul telefono vero:**
  - l'Accessibilità sbloccata;
  - l'affidabilità della parola chiave;
  - le soglie della voce;
  - la finestra sopra le app.

## 6. Prossimi passi (roadmap)

1. **Compagno per Windows:** Jarvis che usa il PC come usa il telefono.
2. **"Cantiere" di programmazione:** progetti come quelli di Claude, con compiti.
3. **Dispositivo da stanza**, poi indossabile. È stato suggerito un XIAO ESP32S3 Sense con microfono, telecamera e amplificatore I2S. Alessio ha un kit con ESP8266, che va bene solo per sensori e LED.
4. **Più avanti:** controllo di un robot e versione iOS collegata al cloud.
5. **Da regolare con l'uso reale:** soglie del riconoscimento vocale e sensibilità della parola chiave.

---

## 7. Regole per chi lavora sul codice (umano o AI)

- **Italiano** nei testi per l'utente, nei commenti e nei messaggi di commit.
- **Non rompere la compatibilità dei dati:**
  - niente migrazioni distruttive del database;
  - il backup (`/api/export`, "Scarica un backup" in Impostazioni) deve includere tutto: diario, luoghi, argomenti, riquadri.
- **Non cambiare** il pacchetto Android né la firma.
- **Non togliere** il controllo di onestà sulle azioni né le conferme prima di azioni irreversibili sul telefono.
- **Mai credenziali nel repo.**
- **Branch e PR**, test verdi, poi unione.
- **Se due assistenti lavorano insieme** (es. Antigravity e Claude), ognuno usa il suo branch e si parte sempre da `main` aggiornato.
