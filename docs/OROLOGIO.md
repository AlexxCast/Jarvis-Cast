# Kestra sull'orologio (Wear OS)

## Che orologio serve
Un orologio **Wear OS 3 o successivo**: Samsung Galaxy Watch 4 o più recente, Google Pixel Watch, Mobvoi TicWatch (i TicWatch Pro hanno il doppio schermo e durano 2-4 giorni), OnePlus Watch 2 e simili. Meglio se ha l'altoparlante, così Kestra risponde a voce. Senza altoparlante la risposta si legge sullo schermo.

Garmin, Amazfit, Huawei e simili durano più giorni ma non possono caricare un'app come questa.

## Installazione (una volta sola)
L'APK è qui: https://github.com/AlexxCast/Jarvis-Cast/releases/download/apk-latest/Kestra-orologio.apk

1. Aggiorna l'app del telefono (`Jarvis.apk`, versione 2.35 o successiva), installandola **sopra** quella vecchia come sempre.
2. Sull'orologio: Impostazioni › Sistema › Info › tocca 7 volte "Numero build" per attivare le Opzioni sviluppatore. Poi in Opzioni sviluppatore attiva "Debug ADB" e "Debug wireless".
3. Installa l'APK sull'orologio, in uno di questi due modi:
   - **dal PC:** in "Debug wireless" tocca "Associa nuovo dispositivo" e sul PC esegui `adb pair IP:PORTA` con il codice mostrato, poi `adb connect IP:PORTA` e `adb install Kestra-orologio.apk`;
   - **dal telefono:** con un'app come "Bugjaeger" o "Wear Installer 2", che fanno gli stessi passaggi senza PC.
4. Apri Kestra sul telefono una volta: indirizzo del server e token passano da soli all'orologio.
5. Apri Kestra sull'orologio e consenti il microfono.

## Uso
- Apri Kestra dall'elenco app o assegnala al tasto dell'orologio (di solito Impostazioni › Gesti o Tasti › doppia pressione › Kestra). Parte subito l'ascolto, con una breve vibrazione.
- Parla. Kestra risponde e resta in ascolto per il seguito. Puoi abbassare il polso.
- Per chiudere: "grazie", "basta", oppure tocca lo schermo. Se non parli più, si chiude da sola.
- "Apri WhatsApp", "chiama la mamma" e simili li fa il telefono, con le stesse regole di sempre (parola d'ordine se attiva).
