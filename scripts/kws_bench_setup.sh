#!/usr/bin/env bash
# Prepara il banco di prova di "Kestra": due modelli di keyword spotting, voci italiane, parole chiave.
set -eux
W="$1"; mkdir -p "$W/voices"; cd "$W"
R=https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models
# 1) modello attuale dell'app: inglese, pezzi di parola (BPE)
curl -fsSL -o en.tar.bz2 "$R/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2" && tar xjf en.tar.bz2
# 2) modello a fonemi (inglese ARPAbet + cinese): "Kestra" si scrive coi suoni, non con lo spelling inglese
curl -fsSL -o zhen.tar.bz2 "$R/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20.tar.bz2" && tar xjf zhen.tar.bz2 || echo "modello zh-en non trovato"
ls -la */ | head -80
EN=sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01
ZE=sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20
printf '▁K EST RA @KESTRA\n▁K EST RA H @KESTRAH\n' > kw-en.txt
if [ -d "$ZE" ]; then
  head -40 "$ZE/tokens.txt" || true; grep -n "^K \|^EH\|^AA\|^AH\|^S \|^T \|^R " "$ZE/tokens.txt" | head || true
  find "$ZE" -name "en.phone" -exec sh -c 'head -5 "$1"; grep -i "^extra \|^kestrel \|^castro " "$1"' _ {} \; || true
fi
python3 - "$ZE" <<'PY'
import os, sys, json
ze = sys.argv[1]
models = [["en-bpe (attuale)", "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01", "kw-en.txt"]]
if os.path.isdir(ze):
    toks = {l.split()[0] for l in open(f"{ze}/tokens.txt", encoding="utf-8") if l.strip()}
    # "Kestra" all'italiana in fonemi ARPAbet, con e senza accento numerico (dipende dal vocabolario del modello).
    cands = [["K", "EH1", "S", "T", "R", "AA0"], ["K", "EH1", "S", "T", "R", "AH0"], ["K", "EH1", "S", "T", "R", "AA1"],
             ["K", "EH", "S", "T", "R", "AA"], ["K", "EH", "S", "T", "R", "AH"]]
    ok = [c for c in cands if all(p in toks for p in c)]
    print("candidati validi:", ok)
    if ok:
        open("kw-ph.txt", "w").write("".join(" ".join(c) + f" @KESTRA{i}\n" for i, c in enumerate(ok)))
        models.append(["fonemi zh-en", ze, "kw-ph.txt"])
json.dump(models, open("models.json", "w"))
print(open("models.json").read())
PY
# Voci italiane naturali (Piper)
H=https://huggingface.co/rhasspy/piper-voices/resolve/main/it/it_IT
for v in paola/medium/it_IT-paola-medium riccardo/x_low/it_IT-riccardo-x_low; do
  n=$(basename $v)
  curl -fsSL -o "voices/$n.onnx" "$H/$v.onnx" && curl -fsSL -o "voices/$n.onnx.json" "$H/$v.onnx.json" || rm -f "voices/$n.onnx"
done
ls -la voices
