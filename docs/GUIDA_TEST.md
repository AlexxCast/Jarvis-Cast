# Guida ai Test di Verifica — JARVIS (v2.17 / v21)

Questa checklist ti guida passo-passo per verificare sul **telefono Android** e sul **PC Windows** che tutte le funzioni di Jarvis lavorino come previsto.

## Preliminari
- [ ] Scarica e installa sul telefono l'ultimo **APK v2.17** compilato su GitHub Actions (`main`).
- [ ] Apri l'app almeno una volta per far aggiornare l'interfaccia web alla versione **`jarvis-shell-v21`**.

---

## 1. Ascolto Continuo in Background e Anti-Blocco (Watchdog)
- [ ] **Attivazione ascolto:** Vai in **Altro → Impostazioni** e verifica che *"Ascolto continuo di Jarvis (anche a schermo spento)"* sia attivo.
- [ ] **Chiamata vocale base:** Di' **"Jarvis"** (o **"Ehi Jarvis, che ore sono?"**) → senti il *beep* e Jarvis risponde ad alta voce senza ascoltare la propria voce (niente eco).
- [ ] **Ascolto mentre c'è musica attiva:** Fai partire un brano musicale sul telefono, poi di' **"Jarvis"** → Jarvis continua a sentirti anche con la musica in riproduzione.
- [ ] **Convivenza con altre app (MicGuard):** Registra un vocale su WhatsApp o apri Gemini, poi chiudilo → entro ~2 secondi Jarvis torna da solo *"In ascolto di Jarvis"* senza restare bloccato in pausa.
- [ ] **Tenuta nel tempo (Watchdog 10s):** Lascia il telefono in stand-by per 10–15 minuti senza spegnere e riaccendere l'app, poi di' **"Jarvis"** → risponde subito senza bisogno di riavviare l'app.

---

## 2. Parola d'Ordine `"niente più fili"` e Azioni sul Telefono
- [ ] **Verifica impostazione:** In **Altro → Impostazioni**, controlla che la spunta *"Richiedi la parola d'ordine ("niente più fili") per le attività sul telefono"* sia attiva.
- [ ] **Richiesta della parola d'ordine:** Chiedi un'azione sul telefono (es. **"Jarvis apri Joytify"**) → Jarvis chiede solo **"Parola d'ordine?"**.
- [ ] **Sblocco con `"niente più fili"`:** Rispondi **"niente più fili"** → Jarvis autorizza ed esegue subito l'azione.
- [ ] **Parola d'ordine già inclusa nella frase:** Di' direttamente **"Jarvis apri WhatsApp niente più fili"** → Jarvis riconosce la parola d'ordine nella frase e procede subito senza chiedertela.
- [ ] **Finestra di fiducia (15 minuti):** Entro 15 minuti dalla prima autorizzazione, chiedi un'altra azione sul telefono (es. **"Jarvis cerca Vasco Rossi su Joytify"**) → Jarvis esegue subito senza richiedere la parola d'ordine.
- [ ] **Niente conferme intermedie:** Chiedi **"Jarvis scrivi a [Nome] su WhatsApp che arrivo"** → Jarvis apre WhatsApp, scrive e completa l'azione fino in fondo senza fermarsi a chiedere *"Vuoi che invii?"*.

---

## 3. Automazioni Sul Telefono (Prima Volta vs Seconda Volta Senza Modelli)
- [ ] **Ricerca musicale su Joytify (Prefisso Automatico + IA):**
  - Di' **"Jarvis cerca una musica rilassante"** (oppure **"Jarvis cerca Mannarino su Joytify"**).
  - [ ] Passo 0: apre **Joytify** da solo in automatico.
  - [ ] Passo 1: tocca la **lente di ricerca** da solo in automatico.
  - [ ] Passo 2+: scrive il brano/artista e avvia il risultato migliore.
- [ ] **Ripetizione automatica (Zero Modelli Esterni):**
  - Ripeti un'attività già eseguita (es. **"Jarvis cerca rock su Joytify"** dopo aver già fatto una ricerca su Joytify).
  - [ ] Nella chat compare **`local-gatekeeper`** (nessuna chiamata a modelli LLM) e i tocchi sullo schermo partono istantaneamente.
- [ ] **Nodo nel ramo `AUTOMAZIONI`:**
  - Tocca il ramo **AUTOMAZIONI** sulla sfera 3D.
  - [ ] Il nodo è color **verde smeraldo** quando Jarvis è calmo e diventa **viola acceso** mentre pensa/esegue.
  - [ ] Esiste il nodo contenitore dell'app (es. **`Joytify`**, **`WhatsApp`**, **`Instagram`**) e sotto di esso sono annidate le singole azioni pulite (es. **`Cerca Mannarino`**), senza doppioni prolissi.

---

## 4. Grafo della Mente (3D, 2D in Background, Nomi e Annidamento)
- [ ] **Pulizia automatica dei doppioni esistenti:**
  - Apri la schermata principale **Jarvis** e tocca i rami **COMUNICAZIONI**, **VIAGGIO**, **DIETA**, **AUTOMAZIONI**:
  - [ ] In **COMUNICAZIONI**: non ci sono più `comunicazione`, `generale`, `ascolto`, e non ci sono più insieme `lettura whatsapp` + `lettura messaggi WhatsApp`; resta **`WhatsApp`** con sotto **`lettura messaggi`** e **`invio messaggio`**.
  - [ ] In **VIAGGIO**: sotto **`Klagenfurt`** c'è **`ristoranti tipici`** (senza ripetere "Klagenfurt" nel figlio) e la frase lunga del ricordo non compare come nodo separato.
  - [ ] In **DIETA**: i pasti sono ordinati sotto i contenitori **`Colazione`**, **`Pranzo`**, **`Cena`**, **`Spuntino`** (massimo ~5 nodi principali).
- [ ] **Generazione automatica di nuovi nodi (senza dire "aggiungi"):**
  - Parla di un argomento nuovo (es. **"Jarvis, oggi al lavoro ho iniziato il progetto Apollo"** oppure **"Jarvis ricordati che la mia auto ha le gomme invernali nuove"**).
  - [ ] Senza che tu dica *"aggiungi al grafo"*, il ramo corrispondente (`lavoro` o `auto`) si illumina e compare il nuovo nodo conciso.
- [ ] **Comando vocale di riduzione del grafo:**
  - Di' **"Jarvis il grafo della dieta è troppo grande, riducilo a 3 nodi"** → l'agente locale `GraphAgent` compatta subito il ramo.
- [ ] **Rimosso affollamento nella sfera 3D:**
  - Apri la chat (icona fumetto in basso): la sfera si rimpicciolisce in alto e i nodi si ridimensionano proporzionalmente restando leggibili.
- [ ] **Overlay 2D sopra le altre app:**
  - Vai sulla schermata Home del telefono e chiama **"Jarvis"**:
  - [ ] Compare la pillola compatta in alto con il grafo 2D radiale ad archi orbitali (stile disegno a mano: anello centrale vuoto, raggi dritti e archi curvi terminanti in un singolo cerchietto).

---

## 5. Jarvis Core (IA Proprietaria Interna) e App Desktop per PC
- [ ] **Avvio su PC Windows:**
  - Sul PC apri la cartella `g:\Jarvis-Cast\desktop` e fai doppio clic su **`Avvia_Jarvis_PC.bat`**.
  - [ ] Si apre la finestra nera/verde **JARVIS CORE • DESKTOP**.
  - [ ] Inserisci l'URL del server e il `JARVIS_TOKEN`, poi clicca **Salva e Connetti** → la scritta in alto diventa **`● CONNESSO A JARVIS CLOUD`**.
- [ ] **Verifica nella scheda Dispositivi:**
  - Sul telefono (o sul PC) vai in **Altro → Dispositivi**:
  - [ ] Compare il tuo **PC Desktop** con stato **`● Online`**, percentuale RAM e finestra attiva.
- [ ] **Comandi dal Telefono verso il PC (gestiti da `jarvis-core` senza LLM):**
  - Dal telefono di' a voce o scrivi:
  - [ ] **"Jarvis apri Chrome sul PC"** → risponde `jarvis-core` istantaneamente e sul PC si apre Chrome.
  - [ ] **"Jarvis apri VS Code sul computer"** → sul PC si apre Visual Studio Code.
  - [ ] **"Jarvis cerca musica rock su YouTube sul PC"** → sul PC si apre YouTube con la ricerca.
  - [ ] **"Jarvis metti in pausa sul PC"** / **"Jarvis alza il volume sul PC"** → il PC esegue il controllo multimediale.
  - [ ] **"Jarvis qual è lo stato del PC?"** → Jarvis ti legge quanta RAM sta usando il PC e quale finestra è aperta.
- [ ] **Apertura Sfera 3D su Desktop:**
  - Nella finestra di Jarvis Desktop sul PC clicca **"Apri Sfera 3D / Web App"** → si apre la finestra dedicata con la sfera 3D di Jarvis anche sul computer.

---

## 6. Problemi Complessi e Progetti Multi-Step nel Tempo
- [ ] **Avvio da frase complessa:**
  - Chiedi: **"Jarvis avvia un progetto per preparare un piano completo di studio e allenamento diviso in più fasi"** (oppure avvialo da **Attività → Compiti in background**).
  - [ ] In **Attività → Compiti in background** compare il progetto con i singoli passi (`✓` completati man mano in background) e Jarvis ti manda una notifica quando il lavoro completo è pronto.
