# Istruzioni per Gemini e Antigravity (copia di AGENTS.md)

Prima di toccare il codice leggi **[docs/DECISIONI.md](docs/DECISIONI.md)**: contiene decisioni, ragionamenti, architettura e flusso di lavoro di Jarvis.

Regole che non si discutono:

1. **Dati dell'utente:** non perdere mai il diario di dieta e sport né il resto dei dati. Niente migrazioni distruttive.
2. **App Android:** pacchetto `com.jarvisfit.app` e firma invariati. L'APK si installa sempre sopra il vecchio.
3. **Branch e PR:** si lavora su un branch, poi PR. Unire su `main` pubblica tutto da solo (Cloudflare per server e web, GitHub Actions per l'APK).
4. **Test:** `npm test` deve passare. Non disattivare test. Aggiungi un test quando cambi la logica del server.
5. **Versioni:** se cambi `web/`, aumenta la cache in `web/sw.js`. Se cambi `app/`, aumenta `versionCode` e `versionName` in `app/build.gradle.kts`.
6. **Credenziali:** mai chiavi, token o keystore nel repo. Le chiavi stanno nei Secrets del Worker Cloudflare.
7. **Comportamento di Jarvis:** non togliere il controllo di onestà sulle azioni (`server/src/brain.js`) né le conferme prima di azioni irreversibili sul telefono.
8. **Lingua:** testi per l'utente, commenti e commit in italiano.
9. **Aggiorna il documento:** quando prendi una decisione nuova, aggiungila a `docs/DECISIONI.md`.
