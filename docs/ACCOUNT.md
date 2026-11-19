# Collegare posta, agende e documenti a Kestra

Kestra legge direttamente Gmail, Google Calendar (anche il calendario condiviso con la famiglia), Google Drive,
Outlook (personale e delle università di Udine e Klagenfurt), il calendario di Outlook e OneDrive.

- **Leggere** è immediato: "che mail nuove ho?", "cosa ho domani?", "cosa c'è nel calendario di famiglia sabato?",
  "cerca gli appunti di Machine Learning su Drive".
- **Scrivere** chiede sempre conferma: "manda una mail a ...", "metti cena sabato alle 20 nel calendario di
  famiglia". Kestra ripete destinatario, oggetto e testo (o data e calendario) e agisce solo dopo il tuo "sì".
- Al modello arrivano mittente, oggetto, data e un'anteprima; il testo intero solo quando serve. I codici di
  verifica, i numeri di carta e gli IBAN vengono mascherati prima.
- Gli accessi sono salvati cifrati (AES-GCM) nel database di Kestra con il segreto `ACCOUNTS_KEY`.

Tutto è gratuito. Servono una volta sola tre passaggi: una chiave, l'app Google, l'app Microsoft.

L'indirizzo del tuo server qui sotto è `https://jarvis-cast.alexxcast34.workers.dev`. Se cambia, cambia anche
negli indirizzi di ritorno (in Impostazioni › Account sono comunque scritti quelli giusti).

I segreti si aggiungono su Cloudflare: **Workers & Pages › jarvis-cast › Impostazioni › Variabili e segreti ›
Aggiungi**, tipo **Segreto**.

## 1. La chiave che cifra gli accessi

Aggiungi il segreto `ACCOUNTS_KEY`: una frase casuale lunga almeno 16 caratteri (ad esempio generata dal
gestore di password). Non cambiarla più: se cambia, gli account vanno ricollegati.

## 2. Google (Gmail, Calendar, Drive), per tutti i tuoi account Gmail

1. Apri <https://console.cloud.google.com/>, in alto **Seleziona un progetto › Nuovo progetto**, nome `Kestra`.
2. **API e servizi › Libreria**: attiva **Gmail API**, **Google Calendar API** e **Google Drive API**.
3. **Google Auth Platform** (o "Schermata di consenso OAuth"): tipo **Esterno**, nome app `Kestra`, la tua email
   come assistenza e contatto.
   - In **Pubblico** premi **Pubblica app** (stato **In produzione**). Se resta "Test", Google scollega gli
     account ogni 7 giorni.
   - L'app non va verificata: al login Google mostrerà "Google non ha verificato questa app". Premi
     **Avanzate › Vai a Kestra**. È la tua app, nessun altro la usa.
4. **Client › Crea client**: tipo **Applicazione web**, nome `Kestra`.
   In **URI di reindirizzamento autorizzati** metti:
   `https://jarvis-cast.alexxcast34.workers.dev/oauth/google/callback`
5. Copia **ID client** e **Client secret** nei segreti `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET`.
6. In Kestra: **Altro › Impostazioni › Account › Collega Google**. Si apre il browser: scegli l'account, accetta.
   Ripeti per ogni account Gmail.

Il calendario di famiglia compare da solo se è nella lista dei calendari del tuo account Google (lo vedi a
sinistra in Google Calendar). Kestra cerca il calendario per nome: "famiglia" trova "Famiglia Cast".

## 3. Microsoft (Outlook, agenda, OneDrive): personale e università

1. Apri <https://entra.microsoft.com/> › **Applicazioni › Registrazioni app › Nuova registrazione**.
   Se ti dice che serve una directory, crea un account Azure gratuito (<https://azure.microsoft.com/free>):
   chiede una carta solo come verifica d'identità, per le registrazioni di app non si paga nulla.
2. Nome `Kestra`. **Tipi di account supportati**: *Account in qualsiasi directory organizzativa e account
   Microsoft personali*.
   **URI di reindirizzamento**: piattaforma **Web**, `https://jarvis-cast.alexxcast34.workers.dev/oauth/microsoft/callback`.
3. **Certificati e segreti › Nuovo segreto client** (scadenza 24 mesi). Copia subito il **Valore**.
4. **Autorizzazioni API › Aggiungi › Microsoft Graph › Autorizzazioni delegate**: `User.Read`, `Mail.Read`,
   `Mail.Send`, `Calendars.ReadWrite`, `Files.Read`, `offline_access`.
5. Segreti su Cloudflare: `MS_CLIENT_ID` = **ID applicazione (client)** della pagina Panoramica,
   `MS_CLIENT_SECRET` = il valore del punto 3.
6. In Kestra: **Impostazioni › Account › Collega Microsoft**, una volta per ogni account (personale, Udine,
   Klagenfurt).

### Se l'università blocca il collegamento

Con gli account dell'università può comparire "Approvazione necessaria" o "Serve l'approvazione
dell'amministratore": dipende dalle regole del loro IT, non da Kestra. Puoi:

- premere **Richiedi approvazione** (se c'è) e aspettare l'IT;
- per l'agenda: in Outlook sul web **Impostazioni › Calendario › Calendari condivisi › Pubblica un calendario**,
  scegli il calendario, "Può visualizzare tutti i dettagli", **Pubblica**, copia il link **ICS** e incollalo in
  Kestra in **Impostazioni › Account › Aggiungi il calendario con un link**. Kestra lo legge soltanto;
- per la posta: se l'università lo consente, inoltra automaticamente le mail a un tuo Gmail collegato.

## Limiti di questa prima versione

- Documenti: Google Docs, Fogli e Presentazioni si leggono come testo; i file Word e PDF di OneDrive si trovano
  e si aprono dal link, ma Kestra non ne legge ancora il contenuto.
- Calendari .ics: ripetizioni giornaliere e settimanali sì; quelle mensili o annuali mostrano solo la prima data.
- Le mail non vengono mai eliminate né spostate da Kestra.
