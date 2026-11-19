"""Scrive keywords.txt per il modello di keyword spotting: "KESTRA" scomposto nei pezzi (BPE) del modello.
Uso: python kws_keywords.py <cartella_modello> <keywords.txt>"""
import os
import sys

model_dir, out = sys.argv[1], sys.argv[2]
tokens = {line.split()[0] for line in open(os.path.join(model_dir, "tokens.txt"), encoding="utf-8") if line.strip()}
# Il nome come lo pronuncia un italiano, scritto per un modello inglese: la grafia principale e una variante.
WORDS = ["KESTRA", "KESTRAH"]

lines = []
bpe = os.path.join(model_dir, "bpe.model")
if os.path.exists(bpe):
    import sentencepiece as spm
    sp = spm.SentencePieceProcessor(model_file=bpe)
    for w in WORDS:
        pieces = sp.encode(w, out_type=str)
        if all(p in tokens for p in pieces):
            lines.append(" ".join(pieces) + f" @{w}")
else:
    # Senza bpe.model: scomposizione golosa con i pezzi del vocabolario (meno precisa ma valida).
    for w in WORDS:
        s, pieces, first = w, [], True
        while s:
            for n in range(len(s), 0, -1):
                cand = ("▁" if first else "") + s[:n]
                if cand in tokens:
                    pieces.append(cand); s = s[n:]; first = False
                    break
            else:
                sys.exit(f"impossibile scomporre {w}")
        lines.append(" ".join(pieces) + f" @{w}")

lines = list(dict.fromkeys(lines))
if not lines:
    sys.exit("nessuna parola chiave valida")
open(out, "w", encoding="utf-8").write("\n".join(lines) + "\n")
