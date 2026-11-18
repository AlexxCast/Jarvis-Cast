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
| `flows.js` | compiti sul telefono imparati e ripetuti senza modello, gatekeeper locale della chat |
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

### Sincronizzazione automatica (`scripts/git_sync.py`)

- `python scripts/git_sync.py -m "messaggio"` fa tutto: fetch, controlli, commit, merge di `origin/main` nel branch, push e apertura della PR (con `gh`, altrimenti stampa il link).
- **Su `main` fa solo pull fast-forward**, mai commit né push. Con modifiche su `main` si ferma; `--branch nome` le sposta su un branch nuovo.
- **Prima del commit controlla le regole:** niente file o testi con credenziali, versione di `web/sw.js` aumentata se cambia `web/`, `versionCode`/`versionName` se cambia `app/`, `npm test` verde (se `npm` non c'è, i test li fa la CI).
- Le novità di `main` entrano con un **merge, mai rebase**: così il push non va mai forzato. Un conflitto annulla l'unione senza perdere nulla.
- `--watch 10` ripete ogni 10 minuti; `--auto-commit` salva da solo le modifiche; `--pull-only` solo aggiornamento.
- È in Python perché gira uguale su Windows (PC di Alessio) e Linux (assistenti).

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
  - se un provider rifiuta il parametro, c'è un secondo tentativo senza.
- **Timeout e fallback:** 14 secondi per il livello veloce, 30 per `smart`, 35 per `vision`. Se i modelli `smart` sono esauriti, il router ripiega automaticamente su `fast` invece di fallire.
- **Continuità del discorso:** `buildMessages` dà priorità al riassunto e agli ultimi 6 messaggi (3 scambi), i moduli attivi restano caldi per 5 turni e il modello interpreta eventuali storpiature vocali nel contesto degli ultimi scambi.
- **Formato della risposta del modello:** JSON con `reply, expect_reply, card, topics, mood, actions`. Se `reply` termina con `?`, `expectReply` è forzato a `true` per mantenere il microfono aperto.

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
- **Grafo 2D in ascolto in background (`web/net2d.js`, `web/overlay.js`, `web/overlay.html`):**
  - Barra compatta (`56x56px` per il grafo, pillola snella fino a `260px` che si chiude a cerchio quando non c'è testo).
  - Modalità `sketch: true`: anello centrale cavo prominente da cui partono raggi dritti di lunghezza sfalsata verso fino a 6 rami principali; da ciascun ramo partono solo 1-2 ampi archi orbitali concentrici o tratti angolati che terminano in un singolo cerchietto cavo (niente file di cerchietti sovrapposti).
- **Sfera 3D, pulizia del ramo Dieta e nodi autonomi (`web/orb.js`, `server/src/memory.js`, `server/src/api.js`):**
  - Il ramo `dieta` mostra solo l'ultimo pasto per fascia (`colazione`, `pranzo`, `cena`, `spuntino`, entro `graphLimits.dieta` predefinito a 5 nodi) e `tidyTopics` scarta automaticamente etichette generiche/meta (`pranzo`, `cena`, `spuntino`, `calorie`, `gestione nodi`, `modulo dieta`); l'azione `clean_graph` e `GraphAgent.detectCleanCommand` riducono davvero i nodi quando l'utente chiede di snellire o sistemare un ramo.
  - Ridimensionamento dinamico dei nodi: i nodi sui gusci più interni (`shellScale`), i rami affollati (`leafCrowd`), i grafi molto densi (`densityScale`) e la sfera rimpicciolita quando si apre la chat (`viewScale` / `compact`) riducono proporzionalmente il raggio di rami e foglie per non affollare il centro.
  - Quando Jarvis impara un percorso autonomo (`phoneFlows`) che non richiede modelli LLM esterni, compare automaticamente il ramo/nodo nel grafo con flag `auto: true` (`kind: 'flow'`), colorato di **verde smeraldo acceso** (`[0, 255, 155]`) quando Jarvis è calmo e **viola vivido** (`[190, 65, 255]`) quando è agitato o sotto sforzo (`tensione` / `thinking`), con doppio anello per staccarsi visivamente dagli altri nodi.
- **Sistema multi-agente locale (`server/src/agents.js`):**
  - Quattro micro-agenti specializzati deterministici a costo zero che affiancano i modelli LLM: `GraphAgent` (ordinamento gusci, creazione/accensione nodi, pulizia duplicati), `MemoryAgent` (classificazione per ramo e cattura immediata dei "ricordati che..."), `FlowAgent` (ciclo di vita e potatura dei flow autonomi che falliscono), `UiAgent` (apertura sezioni e comandi diretti dell'app).
- **Grafiche:** l'azione `show` supporta i tipi `bars, line, pie, list, text, svg, image` (`web/visual.js`).

### Voce

- **Parola chiave:** "Jarvis", "Ehi Jarvis", "Ciao Jarvis".
  - Deve capire il contesto: non deve attivarsi quando si parla dei film Marvel.
  - Si riconoscono anche le storpiature.
  - La sensibilità si sceglie in Impostazioni: Bassa, Media o Alta.
  - Dopo una domanda di Jarvis ascolta la risposta senza bisogno della parola chiave.
  - **Reattività e recupero:** nessun blocco minimo di 15s sul `wakeIntent`; appena la frase si ferma (1,1s su wake, 1,4s su comando) chiude l'ascolto e risponde, recuperando i risultati parziali anche se `SpeechRecognizer` termina con timeout/errore.
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
- **Il server aggiunge l'azione sul telefono solo quando la richiesta riguarda davvero un'app/funzione del telefono (`phone.isPhoneTarget`):**
  - mai su richieste interne a Jarvis (grafo, dieta, memoria, agenda, meteo) né su semplici formule di cortesia ("subito", "faccio");
  - se la risposta promette esplicitamente un'azione su un'app (`apro`, `mando`, `invio`, `avvio`, `riproduco`) senza metterla, aggiunge un `phone_task`;
  - se l'utente voleva fare qualcosa dentro un'app, un semplice `open_app` diventa un `phone_task`.
- **Una conferma in sospeso** ("sì, invialo") resta valida 15 minuti.
- **Telefonate:** l'azione `call {name}` cerca nei contatti (permessi READ_CONTACTS e CALL_PHONE).
- **Flow appresi, prefisso automatico musicale e gatekeeper locale (`server/src/flows.js`):**
  - Il ramo `Automazioni` (`auto: true`, verde quando è calmo, viola quando è attivo/agitato) è sempre visibile nel grafo, partendo dal flow musicale predefinito (`Joytify: apri e cerca musica`) e arricchendosi con i flow appresi (`phoneFlows`).
  - Per le ricerche musicali ("cerca una musica...", anche vaghe o con il nome dell'app storpiato come "joy-faly"), i primi passi meccanici (aprire `Joytify` e toccare la lente `Cerca` leggendo gli elementi dello schermo) partono sempre in automatico a costo zero; arrivato al campo di ricerca o davanti all'elenco dei risultati sulla pagina, subentra il modello IA veloce (`fast`) che legge i testi sullo schermo, corregge eventuali storpiature/richieste vaghe e seleziona il risultato migliore.
  - Quando un compito sul telefono termina con successo (`done`), la sequenza di mosse viene salvata in memoria procedurale (`phoneFlows`). Il testo preso dall'obiettivo diventa un parametro (`cerca {q} su Joytify`), così la volta dopo cambia solo quello.
  - Un classificatore leggero (filtri booleani + punteggio logistico) decide se ripetere il flow leggendo gli elementi dello schermo (`screen.items`) **senza chiamare modelli esterni**. Tutte le parole fisse del flow devono essere nella richiesta; parole in più solo se il flow ha un parametro. Un flow parte solo dal primo passo.
  - **Torna sempre al modello:** scelte creative ("musica che mi piace"), testi composti (il corpo di un messaggio), schermi imprevisti (il flow perde fiducia), compiti di lettura (l'ultima parola è del modello) e **qualunque pulsante irreversibile o campo sensibile** (invia, paga, elimina, chiama, password...): il controllo e le conferme restano quelli del modello.
  - Un compito ripreso a metà non diventa un flow, per non rovinare quello buono. I flow si vedono e si cancellano con `GET/DELETE /api/flows`.
  - In chat, il gatekeeper risponde da solo solo a richieste semplici e certe (aprire un'app installata, chiamare un contatto, un flow già appreso); domande, dieta, memoria, agenda, più richieste insieme vanno al modello.

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

### Autorizzazione con password a telefono spento/bloccato (15/11/2026)

- **Sostituito il riconoscimento biometrico della voce con una password vocale/PIN:** in Impostazioni l'utente imposta una password o PIN (`Settings.phonePassword`).
- **Richiesta solo a telefono spento o bloccato:** quando lo schermo è già acceso e sbloccato (`!wakeFromScreenOff && !VoiceId.isScreenOffOrLocked`), Jarvis esegue subito le azioni sul telefono (`phone_task`, `call`, `open_app`) senza chiedere autorizzazione. Solo se il comando è partito a schermo spento o telefono bloccato Jarvis chiede di pronunciare la password prima di procedere (oppure l'accetta direttamente se inclusa nella frase iniziale).

### Generazione automatica di automazioni e nodi nel grafo della mente (15/11/2026)

- **Automazioni registrate subito (`flows.registerAutoGoal`):** appena parte un `phone_task` (dalla chat, dal gatekeeper o al passo 0 di `phone.step`), oppure quando una sequenza si ferma su `ask` dopo almeno 2 passi, il nodo autonomo (`f:<id>`) viene inserito e acceso in automatico nel ramo `Automazioni` del grafo e nella sezione `Altro → Mente`, senza che l'utente debba dire "aggiungi".
- **Generazione automatica dei nodi (`GraphAgent.inferFallbackTopics`):** se il modello risponde senza compilare `"topics"`, `GraphAgent` estrae comunque in locale app e argomenti (intrattenimento, lavoro, studio, tecnologia, salute, viaggi) e aggiorna subito la sfera 3D/2D e la vista `Mente`.

### Watchdog ascolto continuo, parola d'ordine "niente più fili", Jarvis Core e App Desktop PC (16/11/2026)

- **Ascolto continuo anti-blocco (`JarvisService.kt` + `MicGuard.kt`):** aggiunto un watchdog ogni 10 secondi che ricrea lo `SpeechRecognizer` se Android lo lascia appeso senza callback, rimosso il blocco su `isMusicActive` (così Jarvis ascolta anche mentre c'è musica) e aggiunta una finestra di grazia di 1,8s in `MicGuard` alla chiusura della propria sessione per evitare auto-pause fantasma.
- **Parola d'ordine unica `"niente più fili"` senza conferme intermedie (`VoiceId.kt`, `Settings.kt`, `phone.js`):** la parola d'ordine predefinita è `"niente più fili"`. Una volta autorizzato, Jarvis esegue le attività sul telefono fino in fondo senza fermarsi a chiedere conferme intermedie.
- **Attività già fatte 100% automatiche (`flows.js`):** i flow vengono salvati già dopo 2 passi validi dall'inizio (anche senza aspettare un passo separato `done`) e `CHAT_THRESHOLD` è allineato a `PHONE_THRESHOLD` (0.65), così alla seconda richiesta non viene chiamato nessun modello esterno.
- **Nomi, annidamento e gestione logistica dei nodi (`memory.js`, `api.js`, `context.js`, `orb.js`):** mantenuto invariato il layout estetico di `web/orb.js` (con supporto a più livelli di sotto-nodi); introdotta la gestione logistica dei rami (`CANONICAL_AREAS`, che consolida sinonimi come `alimentazione -> dieta`, `musica/film -> intrattenimento` con `parent` automatico), pulizia concettuale dei titoli (`cleanNodeTitle` e `formatAutoNode` senza frasi discorsive né suffissi tecnici) e annidamento gerarchico automatico (`Automazioni -> App/Dispositivo -> Azione`, `Dieta -> Fascia pasto -> Alimenti`, `Modulo -> Argomento contenitore -> Sotto-argomento / Ricordo`).

- **Deduplicazione semantica e pulizia gerarchica dei nodi (`memory.js`):** `sameTopic` confronta le radici concettuali (`topicStems`) ignorando parole pleonastiche come `"messaggi"` o `"app"` (così `"lettura whatsapp"` e `"lettura messaggi WhatsApp"` si fondono in un solo nodo invece di coesistere o annidarsi tra loro); `isNoiseTopic` elimina nodi generici (`generale`, `ascolto`, `traduzione`) e nodi che ripetono il nome del ramo (`comunicazione` dentro `comunicazioni`); `stripParentWord` rimuove dall'etichetta del nodo figlio la ripetizione del nodo padre (`"ristoranti tipici Klagenfurt"` sotto `"Klagenfurt"` diventa `"ristoranti tipici"`), e `formatAutoNode` unifica le varianti prolisse delle automazioni (`"Apri Joytify, cerca Mannarino e avvia..."` + `"Apri Joytify, cerca Mannarino"` → `"Cerca Mannarino"` sotto `"Joytify"`).

- **Amministratore autonomo a zero crediti (`selfInterrogate` in `jarvis_core.js`), Task Antigravity con Schermo PC Live, Notizie/Diagnostica in Sovraimpressione e Sfondo Nero puro (`#000000`):**
  - `selfInterrogate` gira in automatico su timer e heartbeat senza consumare token LLM: isola per 24h i modelli EOL/410, riattiva i modelli usciti da picchi 503/timeout, avvisa se la RAM del PC supera il 90% e ottimizza il grafo ogni 10 minuti.
  - Chiedendo *"fai partire un task a Antigravity sul progetto X"*, il PC apre Antigravity sulla cartella del progetto, copia il prompt, cattura uno screenshot dello schermo del PC (`POST /api/devices/screen`) e lo mostra in sovraimpressione sul telefono.
  - Diagnostiche e notizie generano sempre una scheda grafica in sovraimpressione (`visual` / `Overlay.showVisual`).
  - Lo sfondo di web app, overlay, WebView Android e app Desktop è ora nero puro (`#000000`) con soli dettagli verdi (`#39ff14`).

### Sensibilità ascolto alta, conversazione continua flessibile, password su flag opzionale, timer interno 90s, 31 modelli e Multi-Agente Progetti/GUI (17/11/2026)

- **Ascolto reattivo senza gridare e conversazione continua (`JarvisService.kt`, `VoiceText.kt`, `Settings.kt`):** sensibilità predefinita a `0.88`, controllo di tutte le alternative parziali per cogliere `"Jarvis"` anche a voce bassa, e conversazione che resta aperta dopo ogni risposta finché l'utente non dice *"grazie Jarvis"* / *"basta"*, non parla chiaramente con altri nella stanza (`isTalkingToOthers`) o non resta in silenzio per 90s.
- **Password disattivata di default (`Settings.voiceLock = false`):** la parola d'ordine `"niente più fili"` non viene chiesta a meno che l'utente non attivi esplicitamente il flag in `Altro → Impostazioni`.
- **Task sul dispositivo migliorati (`JarvisAccessibility.kt`):** esclusi i contenitori vuoti dallo snapshot (che prima saturavano i 120 elementi) e aggiunto l'invio automatico `ACTION_IME_ENTER` dopo la scrittura nei campi di ricerca.
- **Timer interno di 90 secondi e attività temporizzate (`jarvis_core.js`, `index.js`, `JarvisService.kt`, `app.js`):** ogni 1,5 minuti Jarvis controlla compiti in sospeso, stato dispositivi e scadenze, ed esegue azioni temporizzate (*"tra X minuti apri/fai partire..."*).
- **Catalogo espanso a 31 modelli (`models.js`) e Sviluppatore Multi-Agente Multi-File/GUI (`jobs.js` + `jarvis_desktop.py`):** fino a 10 passi multi-agente con estrazione automatica di file (`=== FILE: ... ===`) scritti ed eseguiti direttamente sul PC in `G:\Progetti_Jarvis\<progetto>`.

---

## 5. Stato attuale (17/11/2026)

- **Pubblicato:** tutto fino alla versione 2.21 (`jarvis-shell-v25`).
- **APK:** l'ultimo è il 2.21 (`versionCode = 23`).
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

## Puntatore di Contesto Attivo (`focusContext`, v2.22)
- Per mantenere coerenza tra turni senza appesantire il prompt con lunga cronologia, ogni sessione mantiene un puntatore gerarchico leggero (`focus:<sessionId>`, es. `dispositivo(pc(chrome · profilo: Persona 1 · apri))`, `dieta(...)`, `progetti(...)`).
- `jarvis_core.js` eredita automaticamente il dispositivo attivo (es. se siamo sul PC, `"apri youtube"` / `"chiudilo"` vanno sul PC senza ripeterlo) e permette il cambio immediato sullo stesso oggetto (`"ora fai la stessa cosa sul telefono"` → `dispositivo(telefono(youtube · apri))`).
- `brain.js` inietta una sola riga `CONTESTO ATTIVO (grafo): ...` nei prompt dei modelli LLM e aggiorna il puntatore a ogni azione eseguita.

## Automatismi Modulari a Step Verificati (`modularSkills`, v2.23)
- Le nuove azioni su PC/telefono/servizi generano una bozza in `pendingSkill:<sessionId>` e chiedono conferma all'utente (*"Ha funzionato?"*); solo dopo conferma esplicita vengono salvate in `modularSkills` con ogni singolo step separato e parametrizzato (`{account}`, `{media}` opzionale).
- Alla riesecuzione (`findMatchingSkill` + `planSkillExecution`), Jarvis si ferma ai blocchi richiesti (es. sulla home di Prime se non è indicato un film), delega al modello solo gli eventuali step finali dinamici e fa autocontrollo quando cambia un solo dato (es. un altro account) senza chiedere nuova conferma.

## Documento Automatico `fix latenti` (`maybeLogLatentIssue`, v2.24)
- Quando l'utente segnala che qualcosa non funziona o insiste per più turni sullo stesso argomento (`ISSUE_HINT_RE` o ripetizione sul `focus.target`), `jarvis_core.js` raggruppa automaticamente gli scambi di messaggi e gli eventuali errori tecnici recenti sotto un titolo descrittivo in `fixLatenti`.
- Il documento è sempre consultabile in formato Markdown (o JSON con `?format=json`) su `GET /api/fix-latenti`.

## Gestione Account Salvati e Conferma Vocale (`pcAccounts`, v2.25)
- `desktop/jarvis_desktop.py` invia nell'heartbeat i profili Chrome reali letti da `Local State`, uniti agli account salvati dall'utente (`pcAccounts` in `flows.js`).
- Quando l'utente nomina un account non esatto o nuovo, Jarvis lo ripete chiedendo conferma (`resolvePendingAccount`); quando ci sono ≥ 2 account e non viene specificato nella richiesta di apertura browser/servizio, Jarvis chiede ogni volta quale utilizzare.

## Modulo Interno di Auto-Diagnostica e Apprendimento (`self_heal.js`, v2.26)
- `server/src/self_heal.js` esegue periodicamente in `selfInterrogate` (e su richiesta vocale *"auto-diagnosi"* / *"sistema i problemi"*, oppure via `POST /api/self-heal`) la pulizia automatica di flussi errati, consolidamento degli automatismi doppi, rimozione di comandi PC scaduti e apprendimento di `learnedAliases` dalle correzioni dell'utente e da `fixLatenti`.
- Su richiesta esplicita `POST /api/self-heal` può anche invocare `diagnoseWithModel` per estrarre nuovi alias e un riepilogo dalle voci aperte in `fixLatenti`.

## Workspace Adattivo di Progetto (`workspace.js`, v2.27)
- Entrando in un progetto (`POST /api/workspace/enter`, pulsante `🎯 Apri Workspace` o caricando un file/PDF con `🎯 Attiva come Workspace Progetto`), Jarvis genera un `workspaceSpec` su misura (`kind`, `systemContext`, `widgets` con timer, checklist spuntabile, tabelle/regole, barre progresso e pulsanti rapidi).
- Finchè il workspace è attivo, `brain.js` sostituisce il contesto generale con `systemContext` (es. regole DSA, livello, formato risposta, temi preferiti) e isola la chat nella sessione `proj:<id>`. All'uscita (`✕ Esci` o `"esci dal progetto"`) ripristina l'assetto standard.

## HUD Celle Curve a Scatti & Navigazione Continua (`orb.js`, `jarvis_desktop.py`, `navMode`, v2.28)
- `web/orb.js` e `desktop/jarvis_desktop.py` condividono l'estetica HUD a nucleo centrale `JARVIS` con celle curve concentriche, caselle dei nodi figli incastonate e rotazione a scatti cadenzati (`steppedAngle`).
- Quando si controlla a distanza PC o Telefono, `navMode:<sessionId>` mantiene `expectReply: true` (ricezione continua in tempo reale per scorrere, cliccare, cercare nella pagina con `find_on_page`) finché non parte un video (`play_youtube`) o l'utente dice `"a posto così"`.

## Identità e Tema Ufficiale: Kestra (v2.27 / v42)
- L'assistente e l'app si chiamano **Kestra** (pacchetto Android `com.jarvisfit.app` e firma invariati per preservare gli aggiornamenti sopra le vecchie installazioni; `app_name = "Kestra"`, wake word `kestra` + varianti fonetiche in `VoiceText.kt`).
- Personalità (`context.js`): ladra/assassina scanzonata contestualizzata come IA brillante, agile e precisa, sempre leale e rispettosa verso l'utente (chiamato **"Capo"**).
- Palette ufficiale **Viola (`#a855f7`) + Verde (`#39ff14`)** su sfondo nero `#05020a`, con il **simbolo ufficiale di Kestra** (diamante + lame incrociate viola e 3 trattini verdi) come logo app (`web/logo.png`, `ic_launcher.xml`), al centro del globo 3D (`web/orb.js`), dentro il cerchio dell'overlay pop-up a celle curve (`web/overlay.js`) e nell'HUD PC (`desktop/jarvis_desktop.py`).

## Revisione affidabilità dai messaggi reali (v2.31, 18/11/2026)
Diagnosi fatta leggendo i 1.589 messaggi salvati. Decisioni:
- **Eco**: `Speaker` avvisa i listener quando Kestra inizia e finisce di parlare, da QUALSIASI fonte (risposte della web app via `WebShell.speak`, `PhoneAgent`, promemoria dell'inbox). `JarvisService` chiude il riconoscimento mentre parla e lo riapre 250 ms dopo la fine (+650 ms di coda). Il confronto con l'eco usa le ultime 4 frasi dette e una finestra misurata dalla FINE della frase, non dall'inizio.
- **Parola di attivazione**: solo omofoni veri di "Kestra". Vietato rimettere parole italiane comuni (destra, finestra, questo, "estra"): facevano partire Kestra con la TV accesa. "chiedi a Kestra", "la serie di Kestra" → ambiguo, decide il contesto.
- **Conversazione aperta**: le frasi dette senza nome dopo una risposta arrivano al server con `followup: true`. `followupVerdict` decide in locale (sì/comando → risponde); per il resto una chiamata da 5 token al modello veloce (SI/NO). Se NO: niente risposta, niente cronologia, la frase finisce in kv `ignoredHeard`. Dopo 2 frasi ignorate di fila Kestra torna in attesa della parola. In caso di errore risponde (fail open).
- **Automatismi**: mai più "Ha funzionato?". La bozza si salva da sola se il messaggio successivo non è una lamentela (`implicitSkillFeedback`); una lamentela la scarta.
- **Flow del telefono**: niente salvataggio a ogni passo. Un compito interrotto diventa un flow *provvisorio*, che rifà i passi da solo ma lascia al modello il "fatto" finale.
- **Promesse a vuoto**: se la risposta promette "dopo/in background/ti avviso" e non c'è un compito vero, parte un `start_job` reale; se è una funzione nuova dell'app finisce in kv `improvementRequests` e Kestra lo dice. Foto e file si analizzano subito.
- **PC/YouTube**: si cerca solo il titolo/artista (`extractMediaQuery`); frasi che parlano di Prime, Netflix, Chrome, telefono, account ecc. non finiscono su YouTube.
- **Stile**: `tidyReply` toglie "Certamente, Capo." in testa e trasforma "signore" in "Capo".
- **Progetti**: il contesto di progetto non può contenere passphrase/parola d'ordine (`cleanProjectContext`), e un'intestazione "Verifica passphrase … [OK]" viene tolta dalle risposte.
- **Pasti**: `update_meal`/`delete_meal` con id sbagliato ritrovano il pasto dello stesso giorno per tipo o alimenti (`findMeal`); senza indizi non si tocca niente.
- **Token del PC**: `jarvis_desktop.py` usa `config.local.json` (ignorato da git) e legge `config.json` solo la prima volta per migrare. `jarvis_bg.log` non è più nel repository. Il token stava nel repository: va ruotato.

## Progetti come i progetti di Claude, contesto e memoria intelligenti (fase 2, 18/11/2026)
- **Progetti veri** (`server/src/projects.js`, tabelle `projects`, `project_files`, `project_chats`, colonna `jobs.project`). Ogni progetto ha:
  - istruzioni proprie;
  - file di conoscenza, salvati come testo (i PDF vengono estratti una volta sola);
  - più chat (sessione `p:<progetto>:<chat>`), ognuna con un titolo preso dalla prima domanda;
  - una memoria sua (modulo `p:<id>`, esclusa dal richiamo generale);
  - compiti legati, che ricevono istruzioni, file e memoria del progetto.
- **Dentro un progetto Kestra resta Kestra**: `CORE_PROMPT` (formato JSON e azioni) sempre presente, più l'intestazione del progetto. Prima il prompt del workspace sostituiva tutto e si perdevano formato e azioni.
- **File per pertinenza**: se tutti i file stanno in circa 7.000 token entrano interi, altrimenti solo i pezzi più vicini alla domanda (radici delle parole). Le altre chat del progetto entrano come riassunto.
- **Progetto attivo** in kv `activeProject`. App, voce e `/api/history` usano la chat del progetto attivo. A voce: "apri il progetto X", "crea un progetto chiamato X", "nuova chat", "esci dal progetto".
- **I vecchi workspace** (`workspaceSpecs`, sessione `proj:<id>`) diventano progetti in automatico (`migrateWorkspaces`) senza perdere la conversazione. "Attiva come progetto" con un file ora crea un progetto con il materiale tra i file.
- **Richiamo dei ricordi**: confronto per radice ("allenamento" ↔ "allenamenti"). Uso frequente e recenza contano solo se il ricordo è già pertinente.
- **Consolidamento giornaliero** (`memory.consolidate` in `selfInterrogate`): nello stesso modulo, ricordi quasi uguali (Jaccard ≥ 0,8) diventano uno, il più recente. Ricordi diversi non vengono mai cancellati.
- **Resoconto del contesto**: `buildMessages` registra le sezioni entrate con i token, i ricordi, i file e cosa è rimasto fuori. Lo salva in kv `contextReport` e la vista Mente lo mostra come "Ultima risposta: cosa ho usato".
- **Interfaccia**: nuova scheda **Progetti**. In chat, la barra del progetto ha "+ Chat", "Apri" ed "Esci".

## Autonomia: iniziativa, notifiche, correzioni e grafica (fase 3, app v2.32, 18/11/2026)
- **Motore di iniziativa** (`server/src/initiative.js`). Gira nel battito del Durable Object (allarme ogni 15 minuti, sempre attivo) e non usa modelli. Controlla:
  - errori uguali ripetuti (almeno 3 in 2 ore);
  - modelli tutti in pausa;
  - compiti falliti, con "riprova il compito";
  - scadenze scritte nei ricordi (3 giorni prima e il giorno prima);
  - diario vuoto la sera (solo se la dieta è in uso);
  - peso non registrato da più di 8 giorni.
- **Regole degli avvisi**:
  - ogni avviso ha una chiave con un intervallo minimo;
  - tetto giornaliero di 3 avvisi (livello "bassa") o 8 (livello "normale");
  - ore di silenzio, 23-7 di default: gli avvisi si accodano e arrivano riuniti al mattino;
  - si regola tutto in Impostazioni › Iniziativa.
- **Notifiche del telefono**: `device/KestraNotifications.kt` (NotificationListenerService) manda gruppi di notifiche a `POST /api/notify`.
  - Il server non salva mai codici di verifica e password, e scarta le pubblicità.
  - Un messaggio urgente (urgente, chiamami, aiuto…) avvisa subito, anche di notte. Una chiamata persa offre di richiamare.
  - "Chi mi ha scritto?" mette nel contesto le ultime notifiche.
  - Serve il permesso Android "Accesso alle notifiche", attivabile da Impostazioni › Iniziativa.
- **Correzioni** (`server/src/lessons.js`, kv `lessons`):
  - il modello ha l'azione `learn {rule}`;
  - se il Capo corregge ("no, intendevo…") e il modello non scrive una regola, si salva lo scambio;
  - un "no" detto per rispondere a una domanda di Kestra non conta come correzione;
  - le regole pertinenti entrano nel contesto;
  - in Mente si vedono e si possono cancellare.
- **Grafica**:
  - bordi viola più leggeri e testo secondario neutro;
  - pulsanti elimina discreti;
  - composer su due righe (campo e invio sopra, strumenti sotto);
  - meno emoji nelle etichette;
  - tutti i testi usano "Kestra" e il "tu" (prima c'erano "Jarvis" e il "Lei").
