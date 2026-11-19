# Riconoscimento della parola "Kestra"

Modello che ascolta solo il nome "Kestra", sul telefono e senza internet (app: `voice/KestraKws.kt`,
`KestraDetector.kt`, `KestraOnnx.kt`). Decisioni e numeri in `docs/DECISIONI.md`.

- `app/src/main/assets/kestra/melspectrogram.onnx` e `embedding_model.onnx`: estrattore di suoni di
  [openWakeWord](https://github.com/dscripka/openWakeWord) v0.5.1 (Apache 2.0; l'embedding è il modello
  "speech embedding" di Google, Apache 2.0). Non si addestrano: restano uguali.
- `app/src/main/assets/kestra/kestra_ww.json`: la piccola rete nostra (numeri, nessun audio).

Rifare il modello:
1. `kestra-kit.yml` e `kestra-neg.yml` (CI) pubblicano nella release `kestra-kit` il kit sintetico e i negativi.
2. Scaricare la release, convertire i vocali in WAV 16 kHz mono (`ffmpeg -i in.m4a -ac 1 -ar 16000 out.wav`).
3. `python train.py <kit> kestra_ww.json --pos <solo "Kestra" ripetuti> --neg <parlato senza Kestra> --neg-npy neg_val_train.npy neg_acav.npy`
4. `python evaluate.py <kit> kestra_ww.json <vocali di prova>`: chiamate e punteggi come nell'app.

Le registrazioni della voce di Alessio NON vanno mai nel repository.
