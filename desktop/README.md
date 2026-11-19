# Jarvis Desktop (App e System Manager per PC Windows)

Questa cartella contiene l'applicazione **Jarvis Desktop** per collegare il tuo PC Windows allo stesso cervello di Jarvis che usi sullo smartphone.

## Come avviarla sul PC

1. Fai doppio clic su **`Avvia_Jarvis_PC.bat`** (oppure esegui `python jarvis_desktop.py`).
2. Al primo avvio incolla l'**Indirizzo Server** (es. `jarvis.tuonome.workers.dev`) e il **Token (`JARVIS_TOKEN`)** e premi **Salva e Connetti**.
3. Premi **Apri Sfera 3D / Web App** per aprire l'interfaccia completa di Jarvis in una finestra dedicata sul desktop.

## Cosa può fare Jarvis sul PC (anche comandato dal telefono!)

Finché `Jarvis Desktop` è aperto sul computer, il PC compare **Online** nella scheda **Altro → Dispositivi** e puoi dire a Jarvis (dal telefono o dal PC):

- *"Jarvis apri Chrome sul PC"* / *"apri VS Code sul computer"* / *"apri Esplora File sul PC"*
- *"Jarvis cerca musica rock su YouTube sul PC"*
- *"Jarvis metti in pausa sul PC"* / *"alza il volume sul PC"* / *"blocca il PC"*
- *"Jarvis qual è lo stato del PC?"* (ti legge l'uso della RAM e la finestra attiva sul computer)

## Parlare con Kestra dal PC (microfono)

Utile quando il telefono è lontano (per esempio sul comodino) e tu sei alla scrivania.

1. Una volta sola: doppio clic su **`Installa_Ascolto.bat`** (installa `faster-whisper`, `sounddevice`, `numpy`).
2. Apri Kestra Desktop e attiva **Ascolta "Kestra" dal microfono del PC**. La prima volta scarica il modello vocale (circa 500 MB).
3. Di' *"Kestra, che ore sono?"* oppure solo *"Kestra"*, aspetta il bip e poi la richiesta. Risponde dalle casse del PC.

- Il riconoscimento è offline sul PC e conosce già il nome "Kestra"; lavora solo quando qualcuno parla.
- Si attiva solo se il nome è detto per chiamarla (all'inizio, o alla fine di una frase breve), non a ogni parola simile.
- Se ti fa una domanda, puoi rispondere per qualche secondo senza ripetere il nome.
- Va bene il microfono della webcam; da 2-3 metri è meglio un microfono USB da conferenza.
- Opzioni in `config.local.json`: `"listen_model"` (`"small"` predefinito, `"base"` per PC lenti, `"medium"` per PC potenti) e `"listen_device"` (numero del microfono, se non è quello predefinito).
- I messaggi dell'ascolto finiscono in `jarvis_bg.log`.
