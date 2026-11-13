# Installare Jarvis Cloud

Tre passi: pubblicare il server (gratis, su Cloudflare), aggiornare l'app sul telefono **una sola volta**, collegarli.
Da lì in poi ogni modifica che arriva sul ramo `main` di questo repository viene pubblicata da sola e il telefono la riceve alla successiva apertura: niente più APK.

## 1. Pubblicare il server (10 minuti)

1. Crea un account gratuito su <https://dash.cloudflare.com/sign-up>.
2. Nel pannello: **Workers & Pages → Create → Import a repository**, collega GitHub e scegli `Jarvis-Cast`.
   Lascia il nome progetto `jarvis-cast` (deve coincidere con `name` in `wrangler.toml`) e il comando di deploy proposto (`npx wrangler deploy`), poi **Deploy**.
3. Apri il Worker appena creato → **Settings → Variables and Secrets** e aggiungi questi valori come **Secret**:

   | Nome | Cosa metterci | Dove si prende |
   |---|---|---|
   | `JARVIS_TOKEN` | una password lunga scelta da te (è la chiave di casa) | la inventi tu |
   | `GEMINI_API_KEY` | chiave gratuita Gemini (consigliata, legge anche le foto) | <https://aistudio.google.com/apikey> |
   | `GROQ_API_KEY` | facoltativa, gratuita | <https://console.groq.com/keys> |
   | `CEREBRAS_API_KEY` | facoltativa, gratuita | <https://cloud.cerebras.ai> |
   | `NVIDIA_API_KEY` | facoltativa, gratuita | <https://build.nvidia.com> |
   | `OPENROUTER_API_KEY` | facoltativa, gratuita (DeepSeek, Llama e altri) | <https://openrouter.ai/keys> |
   | `MISTRAL_API_KEY` | facoltativa, gratuita | <https://console.mistral.ai> |
   | `GITHUB_MODELS_TOKEN` | facoltativa, gratuita (token con permesso "Models") | <https://github.com/settings/personal-access-tokens> |
   | `DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY` | facoltative, **a pagamento** (usate solo se i gratuiti sono esauriti) | <https://platform.deepseek.com>, <https://console.anthropic.com> |

   Basta `JARVIS_TOKEN` più una chiave per partire. Più chiavi gratuite aggiungi, più margine ha Jarvis prima di restare senza crediti.
4. Apri l'indirizzo del Worker (tipo `https://jarvis-cast.tuonome.workers.dev`), inserisci il token: sei dentro.

Gli abbonamenti Gemini Pro e Claude Pro valgono per le rispettive app di chat e **non** danno crediti API: per Jarvis servono le chiavi qui sopra.

## 2. Aggiornare l'app sul telefono (una volta sola)

L'app nuova deve essere **installata sopra quella vecchia**, così i dati restano. Per riuscirci va compilata dallo stesso PC di prima (stessa chiave di firma).

1. Sul PC, nella cartella del progetto: `git pull`, poi `gradlew.bat assembleDebug`.
2. Installa `app\build\outputs\apk\debug\app-debug.apk` sul telefono **senza disinstallare** la versione precedente.
   Se Android segnala un conflitto di firma, fermati: non disinstallare, altrimenti i dati sul telefono andrebbero persi.
3. Apri l'app: compare la finestra **Collega Jarvis Cloud**. Inserisci l'indirizzo del Worker e il token.
   Se la chiudi, la ritrovi in **Profilo → Collega Jarvis Cloud**.

Al primo collegamento l'app copia sul server pasti, attività, pesate, passi, dispensa, ricette e profilo. Sul telefono non viene cancellato nulla: con **Impostazioni → Torna all'app classica** rivedi tutto com'era.

## 3. Uso quotidiano

- **Voce**: in *Altro → Impostazioni* attiva l'ascolto continuo. Di' "Jarvis…", "Ehi Jarvis…" o "…, Jarvis". Se nomini Jarvis in mezzo a un discorso (per esempio parlando dei film), un modello veloce controlla se ti stai rivolgendo a lui.
- **Microfono condiviso**: quando un'altra app registra (Gemini, un vocale, una chiamata) Jarvis si mette in pausa e riprende da solo. Si può disattivare dalle stesse impostazioni se desse problemi sul tuo telefono.
- **Memoria**: "Jarvis, ricordati che…". I ricordi sono divisi in moduli e si vedono in *Altro → Memoria*.
- **Promemoria e compiti lunghi**: sezione *Attività*, oppure a voce.
- **Modelli**: *Altro → Modelli* mostra quali provider sono attivi, quanto sono carichi e ogni cambio automatico. Se un provider rinomina un modello, lo correggi lì senza aggiornare nulla.
- **Backup**: *Altro → Impostazioni → Scarica un backup*.

## Sviluppo

```
npm install        # solo la prima volta
npm test           # test del server
echo JARVIS_TOKEN=prova > .dev.vars && npm run dev   # server locale su http://localhost:8787
```
