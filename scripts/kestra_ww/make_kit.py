"""Prepara il "kit" per addestrare il riconoscimento di Kestra (gira in CI: lì si scaricano voci e modelli).

1. Scarica l'estrattore di suoni (openWakeWord) e voci Piper in italiano e lingue vicine (più una inglese con 900 voci).
2. Sintetizza migliaia di "Kestra" (voci, velocità, intonazioni diverse) e migliaia di frasi che NON lo sono,
   comprese le parole che gli somigliano (questa, finestra, maestra, destra, extra...).
3. Rende ogni esempio realistico: rumore, voce lontana (volume basso + guadagno automatico come nell'app).
4. Salva i vettori di suoni (non l'audio) in kit.npz, più l'estrattore, da pubblicare come release del repository.
Uso: python make_kit.py <cartella>
"""
import json, os, random, sys, time, urllib.request, wave, io
import numpy as np
from features import Features, CLIP

OUT = sys.argv[1]; os.makedirs(f"{OUT}/voices", exist_ok=True)
random.seed(7); rng = np.random.default_rng(7)
SR = 16000


def get(url, path):
    if not os.path.exists(path):
        for k in range(4):
            try:
                urllib.request.urlretrieve(url, path); break
            except Exception as e:
                print("riprovo", url, e); time.sleep(5 * (k + 1))
    return path


OWW = "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1"
get(f"{OWW}/melspectrogram.onnx", f"{OUT}/melspectrogram.onnx")
get(f"{OWW}/embedding_model.onnx", f"{OUT}/embedding_model.onnx")
FE = Features(f"{OUT}/melspectrogram.onnx", f"{OUT}/embedding_model.onnx")

HF = "https://huggingface.co/rhasspy/piper-voices/resolve/main"
cat = json.load(open(get(f"{HF}/voices.json", f"{OUT}/voices.json")))
want_lang = ("it", "es", "pt", "ro", "ca")
picked = [k for k, v in cat.items() if v["language"]["family"] in want_lang and v["quality"] in ("medium", "low", "x_low")]
# tutte le italiane, poi una per lingua a turno (spagnolo, portoghese, catalano, rumeno...), più l'inglese a 900 voci
it = sorted(k for k in picked if cat[k]["language"]["family"] == "it")
rest = sorted((k for k in picked if cat[k]["language"]["family"] != "it"), key=lambda k: (cat[k]["language"]["code"], k))
by = {}
for k in rest: by.setdefault(cat[k]["language"]["family"], []).append(k)
mix = [k for grp in zip(*[v + [None] * 20 for v in by.values()]) for k in grp if k]
picked = (it + mix)[:16] + ["en_US-libritts_r-medium"]
print("voci:", picked, flush=True)

from piper import PiperVoice  # noqa: E402
try:
    from piper import SynthesisConfig
except ImportError:
    SynthesisConfig = None


def load(key):
    files = cat[key]["files"]
    onnx = [f for f in files if f.endswith(".onnx")][0]
    p = get(f"{HF}/{onnx}", f"{OUT}/voices/{key}.onnx"); get(f"{HF}/{onnx}.json", p + ".json")
    return PiperVoice.load(p), cat[key].get("num_speakers", 1)


def say(voice, text, spk, ls, ns, nw):
    if SynthesisConfig is not None:
        cfg = SynthesisConfig(speaker_id=spk, length_scale=ls, noise_scale=ns, noise_w_scale=nw)
        a = np.concatenate([c.audio_int16_array for c in voice.synthesize(text, syn_config=cfg)])
        sr = voice.config.sample_rate
    else:
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            voice.synthesize(text, w, speaker_id=spk, length_scale=ls, noise_scale=ns, noise_w=nw)
        buf.seek(0)
        with wave.open(buf) as w:
            sr = w.getframerate(); a = np.frombuffer(w.readframes(w.getnframes()), np.int16)
    x = a.astype(np.float32) / 32768
    if sr != SR:
        x = np.interp(np.linspace(0, len(x) - 1, int(len(x) * SR / sr)), np.arange(len(x)), x).astype(np.float32)
    # taglia il silenzio intorno
    idx = np.where(np.abs(x) > 0.02)[0]
    return x[max(0, idx[0] - 800):idx[-1] + 800] if len(idx) else x


POS_TXT = {"it": ["Kestra", "Kestra!", "Kestra?", "Ehi Kestra", "Ciao Kestra", "Kestra.", "Ehi, Kestra!", "Senti Kestra"],
           "es": ["Kestra", "Kestra!", "Oye Kestra"], "pt": ["Kestra", "Kestra!"], "ro": ["Kestra"], "ca": ["Kestra"],
           "en": ["Kestra", "Kestra!", "Hey Kestra", "Kess-tra"]}
CONF = ["questa", "questa sera", "finestra", "maestra", "orchestra", "destra", "sinistra", "extra", "palestra", "ginestra",
        "minestra", "canestra", "celeste", "testa", "festa", "pasta", "costa", "casta", "cresta", "kesta", "che stai",
        "che strada", "che strano", "questo", "chiesta", "richiesta", "inchiesta", "sequestra", "registra", "mostra", "nostra",
        "vostra", "estrazione", "Kevin", "Chiara", "Celestina", "Estra", "Kesto", "castra", "Kestrel", "Castro", "Ester"]
SENT = ["questa sera vado al cinema con gli amici", "gira a destra al prossimo incrocio", "apri la finestra per favore",
        "la maestra ha dato i compiti", "l'orchestra suona benissimo", "vuoi un extra di patatine", "oggi vado in palestra",
        "che ore sono adesso", "metti un po' di musica", "accendi la luce in cucina", "domani piove tutto il giorno",
        "ho mangiato la pasta al pomodoro", "ricordami di chiamare la mamma", "quanto costa questo telefono",
        "la nostra casa è al secondo piano", "mostra le foto delle vacanze", "è stata una bella festa", "mi fa male la testa",
        "la richiesta è stata inviata", "registra un video breve", "che strano tempo oggi", "chiedilo a Chiara",
        "questo film è bellissimo", "il treno parte alle otto", "devo comprare il latte", "che stai facendo stasera",
        "sto lavorando al computer", "il gatto dorme sul divano", "facciamo una passeggiata", "chi ha vinto la partita",
        "buongiorno a tutti", "va bene ci vediamo dopo", "non ho capito bene", "ripeti per favore", "la sinistra e la destra",
        "ho letto un libro interessante", "fra poco inizia il telegiornale", "scrivi un messaggio a Luca",
        "the weather is nice today", "turn left at the next street", "this is an extra large pizza", "what time is it"]


def agc(y):
    """Guadagno automatico come nell'app: porta il pezzo da 100 ms più forte a 0,08 (al massimo x5), limitatore morbido."""
    peak = max(np.sqrt(np.mean(y[i:i + 1600] ** 2)) for i in range(0, len(y) - 1599, 1600))
    return np.tanh(y * min(5.0, max(1.0, 0.08 / (peak + 1e-9))))


def noise(n):
    z = rng.normal(0, 1, n).astype(np.float32)
    if rng.random() < 0.5:  # rumore rosa (più simile a stanza, ventola, TV lontana)
        f = np.fft.rfft(z); f /= np.sqrt(np.arange(1, len(f) + 1)); z = np.fft.irfft(f, n).astype(np.float32)
    return z / (np.sqrt(np.mean(z ** 2)) + 1e-9)


def realistic(x, end_gap, after=None):
    """Mette la voce in 2,08 s di stanza: finisce [end_gap] campioni prima della fine, con rumore su TUTTA la finestra
    (mai silenzio digitale, che il telefono non sente mai), voce vicina o lontana e guadagno automatico.
    [after]: parlato che segue subito (\"Kestra, accendi la luce\"), nei campioni dopo la parola."""
    gain = 10 ** (rng.uniform(-38, 0) / 20)
    sp = x * gain; rms = np.sqrt(np.mean(sp ** 2)) + 1e-9
    out = np.zeros(CLIP, np.float32)
    sp = sp[-(CLIP - end_gap):]
    out[CLIP - end_gap - len(sp):CLIP - end_gap] = sp
    if after is not None and end_gap > 0:
        a = after[: end_gap] * gain
        out[CLIP - end_gap:CLIP - end_gap + len(a)] += a
    out += noise(CLIP) * rms / 10 ** (rng.uniform(5, 40) / 20)
    return agc(out)


def feats(x):
    f = FE.clip_features((np.clip(x, -1, 1) * 32767).astype(np.int16))
    return None if f is None else f.astype(np.float16)


pos, neg, posmeta = [], [], []
t0 = time.time()
for key in picked:
    voice, nspk = load(key)
    fam = cat[key]["language"]["family"]
    spks = list(range(nspk)) if nspk <= 4 else random.sample(range(nspk), 160)
    npos = 700 if fam == "it" else (1400 if nspk > 4 else 220)
    rnd = lambda: (rng.uniform(0.75, 1.35), rng.uniform(0.4, 0.9), rng.uniform(0.5, 1.0))
    # qualche frase di questa voce, per il parlato che segue il nome ("Kestra, che ore sono")
    tails = [say(voice, random.choice(SENT), random.choice(spks), *rnd()) for _ in range(12)]
    for i in range(npos):
        t = random.choice(POS_TXT.get(fam, ["Kestra"]))
        x = say(voice, t, random.choice(spks), *rnd())
        after = random.choice(tails)[800:] if random.random() < 0.4 else None
        f = feats(realistic(x, int(rng.uniform(0, 0.25) * SR), after))
        if f is not None:
            pos.append(f); posmeta.append(key)
        # la stessa parola tagliata a metà ("Kes...") è un NEGATIVO: deve aspettare il nome intero
        if i % 4 == 0:
            cut = x[: int(len(x) * rng.uniform(0.35, 0.6))]
            f = feats(realistic(cut, int(rng.uniform(0, 0.2) * SR)))
            if f is not None: neg.append(f)
        # il nome detto e finito da più di mezzo secondo non deve far scattare di nuovo
        if i % 6 == 0:
            f = feats(realistic(x, int(rng.uniform(0.6, 1.0) * SR)))
            if f is not None: neg.append(f)
    nneg = 1500 if fam == "it" else (1200 if nspk > 4 else 200)
    for i in range(nneg):
        t = random.choice(CONF) if (fam == "it" and random.random() < 0.4) else random.choice(SENT + CONF)
        if random.random() < 0.3: t = t + " " + random.choice(SENT)
        x = say(voice, t, random.choice(spks), *rnd())
        # finestra in un punto qualunque della frase
        if len(x) > CLIP:
            s0 = rng.integers(0, len(x) - CLIP // 2); x = x[s0:s0 + CLIP]
        f = feats(realistic(x, int(rng.uniform(0, 0.6) * SR)))
        if f is not None: neg.append(f)
    print(f"{key}: positivi {len(pos)} negativi {len(neg)} ({time.time() - t0:.0f}s)", flush=True)
    del voice

# solo rumore e silenzio
for i in range(1500):
    x = agc(noise(CLIP) * rng.uniform(0.0005, 0.05))
    f = feats(x)
    if f is not None: neg.append(f)

np.savez_compressed(f"{OUT}/kit.npz", pos=np.array(pos), neg=np.array(neg), posmeta=np.array(posmeta))
print("kit:", np.array(pos).shape, np.array(neg).shape, flush=True)
