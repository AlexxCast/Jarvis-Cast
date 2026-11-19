#!/usr/bin/env bash
# Scarica il riconoscimento della parola "Kestra" per l'app Android (sherpa-onnx, Apache 2.0):
#   - modello di keyword spotting (zipformer gigaspeech 3.3M) → app/src/main/assets/kws/
#   - librerie native arm64 della STESSA versione dei file Kotlin in app/src/main/java/com/k2fsa/sherpa/onnx
#   - keywords.txt con "KESTRA" scomposto nei pezzi del modello
# Se qualcosa non va l'app si compila lo stesso e usa il riconoscimento di Android (avviso nel log della build).
set -u
VER="2.0.1"
MODEL="sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ASSETS="$ROOT/app/src/main/assets/kws"
LIBS="$ROOT/app/src/main/jniLibs/arm64-v8a"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() {
  echo "::warning::Riconoscimento forte di Kestra NON incluso nell'APK: $1"
  rm -rf "$ASSETS" "$LIBS"
  exit 0
}

mkdir -p "$ASSETS" "$LIBS"
AUTH=()
[ -n "${GITHUB_TOKEN:-}" ] && AUTH=(-H "Authorization: Bearer $GITHUB_TOKEN")

echo "== Modello $MODEL"
curl -fsSL --retry 3 -o "$TMP/model.tar.bz2" "https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/$MODEL.tar.bz2" || fail "download del modello"
tar xjf "$TMP/model.tar.bz2" -C "$TMP" || fail "estrazione del modello"
D="$TMP/$MODEL"
ls -la "$D"
pick() { # $1 = encoder|decoder|joiner, $2 = int8|fp32
  if [ "$2" = int8 ]; then ls "$D"/$1-*int8*.onnx 2>/dev/null | head -1; else ls "$D"/$1-*.onnx 2>/dev/null | grep -v int8 | head -1; fi
}
ENC="$(pick encoder int8)"; [ -z "$ENC" ] && ENC="$(pick encoder fp32)"
JOI="$(pick joiner int8)";  [ -z "$JOI" ] && JOI="$(pick joiner fp32)"
DEC="$(pick decoder fp32)"; [ -z "$DEC" ] && DEC="$(pick decoder int8)"
[ -n "$ENC" ] && [ -n "$DEC" ] && [ -n "$JOI" ] && [ -f "$D/tokens.txt" ] || fail "file del modello mancanti"
cp "$ENC" "$ASSETS/encoder.onnx"; cp "$DEC" "$ASSETS/decoder.onnx"; cp "$JOI" "$ASSETS/joiner.onnx"; cp "$D/tokens.txt" "$ASSETS/tokens.txt"
echo "encoder=$(basename "$ENC") decoder=$(basename "$DEC") joiner=$(basename "$JOI")"

echo "== Parole chiave"
python3 -m pip install -q sentencepiece >/dev/null 2>&1 || pip install -q sentencepiece >/dev/null 2>&1 || true
python3 "$ROOT/scripts/kws_keywords.py" "$D" "$ASSETS/keywords.txt" || fail "keywords.txt"
cat "$ASSETS/keywords.txt"

echo "== Librerie native sherpa-onnx v$VER"
curl -fsSL --retry 3 "${AUTH[@]}" -o "$TMP/release.json" "https://api.github.com/repos/k2-fsa/sherpa-onnx/releases/tags/v$VER" || fail "elenco della release v$VER"
python3 - "$TMP/release.json" > "$TMP/assets.txt" <<'PY'
import json, re, sys
rel = json.load(open(sys.argv[1]))
names = [(a["name"], a["browser_download_url"]) for a in rel.get("assets", [])]
for n, _ in names:
    print("  asset:", n, file=sys.stderr)
bad = re.compile(r"(rknn|qnn|ascend|static|apk|tts|asr|kws|vad|java|jni-only|harmony|ohos)", re.I)
cands = [(n, u) for n, u in names if re.search(r"android", n, re.I) and re.search(r"\.(tar\.bz2|tar\.gz|zip|aar)$", n) and not bad.search(n)]
cands.sort(key=lambda x: (not x[0].endswith(".tar.bz2"), len(x[0])))
if cands:
    print(cands[0][0]); print(cands[0][1])
PY
[ -s "$TMP/assets.txt" ] || fail "nessun pacchetto Android nella release v$VER"
NAME="$(sed -n 1p "$TMP/assets.txt")"; URL="$(sed -n 2p "$TMP/assets.txt")"
echo "pacchetto: $NAME"
curl -fsSL --retry 3 -o "$TMP/$NAME" "$URL" || fail "download delle librerie"
mkdir -p "$TMP/libs"
case "$NAME" in
  *.tar.bz2) tar xjf "$TMP/$NAME" -C "$TMP/libs" ;;
  *.tar.gz) tar xzf "$TMP/$NAME" -C "$TMP/libs" ;;
  *.zip|*.aar) (cd "$TMP/libs" && unzip -q "$TMP/$NAME") ;;
esac || fail "estrazione delle librerie"
JNI="$(find "$TMP/libs" -path '*arm64-v8a*' -name 'libsherpa-onnx-jni.so' | head -1)"
[ -n "$JNI" ] || { find "$TMP/libs" -name '*.so' | head -20; fail "libsherpa-onnx-jni.so arm64 non trovata"; }
cp "$(dirname "$JNI")"/*.so "$LIBS/"
ls -la "$LIBS"
echo "Riconoscimento forte di Kestra incluso."
