"""Banco di prova del riconoscimento di "Kestra" (gira in CI, dove si scaricano modelli e voci).

Sintetizza frasi con e senza "Kestra" con voci italiane (Piper, più naturali, ed espeak-ng), le rende più
difficili (voce lontana = volume basso, rumore di fondo) e misura per ogni modello e soglia quante chiamate
riconosce e quanti falsi allarmi dà. Uso: python kws_bench.py <cartella_lavoro>
"""
import glob, json, os, subprocess, sys, wave
import numpy as np
import sherpa_onnx

W = sys.argv[1]
SR = 16000
POS = ["Kestra", "Kestra, che ore sono?", "Ehi Kestra", "Ciao Kestra, accendi la luce", "Kestra, che tempo fa domani?",
       "Kestra metti la musica", "Senti Kestra, ricordami di chiamare Luca"]
NEG = ["questa sera vado al cinema", "gira a destra", "un extra di patatine", "che sta facendo", "la finestra è aperta",
       "orchestra sinfonica", "la maestra è brava", "la casta dei politici", "quanto costa", "questa strada è lunga",
       "che strano", "registra il video", "mostra le foto", "la nostra casa", "fa caldo stanotte", "la sinistra",
       "una cesta di frutta", "ho preso la pasta", "è una festa", "il testo è lungo", "la palestra apre alle sette",
       "la ginestra è fiorita", "chiedilo a lui", "che ore sono", "accendi la luce", "domani piove"]


def read_wav(path):
    with wave.open(path) as f:
        sr, n = f.getframerate(), f.getnframes()
        a = np.frombuffer(f.readframes(n), dtype=np.int16).astype(np.float32) / 32768
    if sr != SR:
        a = np.interp(np.linspace(0, len(a) - 1, int(len(a) * SR / sr)), np.arange(len(a)), a).astype(np.float32)
    return a


def synth():
    """[(voce, testo, audio)] con tutte le voci disponibili."""
    out = []
    os.makedirs(f"{W}/wav", exist_ok=True)
    for model in sorted(glob.glob(f"{W}/voices/*.onnx")):
        name = os.path.basename(model)[:-5]
        for ls in (0.9, 1.0, 1.15):
            for i, t in enumerate(POS + NEG):
                p = f"{W}/wav/{name}-{ls}-{i}.wav"
                subprocess.run(["piper", "--model", model, "--output_file", p, "--length_scale", str(ls)], input=t.encode(),
                               check=True, capture_output=True)
                out.append((f"{name}@{ls}", t, read_wav(p)))
    for v in ("it", "it+m3", "it+f2"):
        for i, t in enumerate(POS + NEG):
            p = f"{W}/wav/espeak-{v}-{i}.wav"
            subprocess.run(["espeak-ng", "-v", v, "-s", "150", "-w", p, t], check=True)
            out.append((f"espeak-{v}", t, read_wav(p)))
    return out


rng = np.random.default_rng(0)


def detect(sp, audio, gain, noise):
    sig = np.concatenate([np.zeros(SR, np.float32), audio * gain, np.zeros(SR, np.float32)])
    sig = sig + rng.normal(0, noise, len(sig)).astype(np.float32)
    # Stesso guadagno automatico dell'app (fino a x5) per la voce lontana.
    rms = np.sqrt(np.mean((audio * gain) ** 2) + 1e-12)
    g = min(5.0, max(1.0, 0.08 / rms))
    sig = np.tanh(sig * g)
    st = sp.create_stream()
    found = []
    for i in range(0, len(sig), 1600):
        st.accept_waveform(SR, sig[i:i + 1600])
        while sp.is_ready(st):
            sp.decode_stream(st)
        r = sp.get_result(st)
        if r:
            found.append(r)
            sp.reset_stream(st)
    return found


def bench(label, d, kwfile, data):
    enc = sorted(glob.glob(f"{d}/encoder*int8*.onnx") or glob.glob(f"{d}/encoder*.onnx"))[0]
    dec = sorted([x for x in glob.glob(f"{d}/decoder*.onnx") if "int8" not in x] or glob.glob(f"{d}/decoder*.onnx"))[0]
    joi = sorted(glob.glob(f"{d}/joiner*int8*.onnx") or glob.glob(f"{d}/joiner*.onnx"))[0]
    rows = []
    for th, sc in [(0.25, 1.0), (0.2, 1.5), (0.15, 2.0), (0.12, 2.5), (0.1, 3.0), (0.08, 3.5)]:
        sp = sherpa_onnx.KeywordSpotter(tokens=f"{d}/tokens.txt", encoder=enc, decoder=dec, joiner=joi, keywords_file=kwfile,
                                        num_threads=2, keywords_score=sc, keywords_threshold=th, feature_dim=80, sample_rate=SR)
        res = {}
        for cond, gain, noise in [("vicino", 1.0, 0.002), ("lontano", 0.06, 0.002), ("lontano+rumore", 0.06, 0.008)]:
            tp = fn = fp = tn = 0
            for v, t, a in data:
                hit = bool(detect(sp, a, gain, noise))
                if t in POS:
                    tp += hit; fn += not hit
                else:
                    fp += hit; tn += not hit
            res[cond] = f"{tp}/{tp + fn} chiamate, {fp}/{fp + tn} falsi"
        rows.append((th, sc, res))
        print(f"{label:28s} soglia={th:<5} spinta={sc:<4} " + " | ".join(f"{k}: {v}" for k, v in res.items()), flush=True)
    return rows


if __name__ == "__main__":
    data = synth()
    print(f"{len(data)} frasi sintetizzate", flush=True)
    results = {}
    for label, d, kw in json.load(open(f"{W}/models.json")):
        results[label] = bench(label, os.path.join(W, d), os.path.join(W, kw), data)
    json.dump(results, open(f"{W}/risultati.json", "w"), indent=1)
