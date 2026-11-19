"""Addestra il classificatore di "Kestra" sui vettori di suoni del kit (sintetici) più le registrazioni reali.

Le registrazioni della voce di Alessio si passano da fuori (mai nel repository). Il risultato è un piccolo
modello (rete con due strati) salvato in kestra_ww.json, che l'app legge e calcola da sola.
Uso: python train.py <kit_dir> <out.json> [--pos file.wav ...] [--neg file.wav ...] [--test file.wav ...]
"""
import argparse, json, wave
import numpy as np
from features import Features, CLIP, WIN

ap = argparse.ArgumentParser()
ap.add_argument("kit"); ap.add_argument("out")
ap.add_argument("--pos", nargs="*", default=[]); ap.add_argument("--neg", nargs="*", default=[])
ap.add_argument("--hidden", type=int, default=64); ap.add_argument("--epochs", type=int, default=40)
ap.add_argument("--real-weight", type=float, default=4.0, help="peso degli esempi reali rispetto ai sintetici")
ap.add_argument("--neg-npy", nargs="*", default=[], help="negativi già in vettori [N,16,96] (fetch_negatives.py)")
ap.add_argument("--neg-npy-weight", type=float, default=1.0)
ap.add_argument("--mine", type=int, default=2, help="giri di caccia ai falsi allarmi sulle registrazioni senza Kestra")
ap.add_argument("--bg", nargs="*", default=[], help="audio di sottofondo (es. TV accesa) da mescolare sotto gli esempi")
ap.add_argument("--bg-prob", type=float, default=0.35, help="quota di esempi con il sottofondo")
ap.add_argument("--noise-prob", type=float, default=0.3, help="quota di esempi con rumore costante forte (ventola, cappa)")
ap.add_argument("--seed", type=int, default=1)
args = ap.parse_args()
rng = np.random.default_rng(args.seed)
FE = Features(f"{args.kit}/melspectrogram.onnx", f"{args.kit}/embedding_model.onnx")


def read(path):
    with wave.open(path) as w:
        assert w.getframerate() == 16000 and w.getnchannels() == 1, path
        return np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768


def segments(x, min_len=0.25, max_gap=0.18):
    """Pezzi di voce separati da pause (per dividere i "Kestra" ripetuti)."""
    hop = 160; e = np.array([np.sqrt(np.mean(x[i:i + 400] ** 2)) for i in range(0, len(x) - 400, hop)])
    floor = np.percentile(e, 20); thr = max(floor * 4, np.percentile(e, 95) * 0.12)
    on = e > thr; segs = []; start = None; last = None
    for i, v in enumerate(on):
        if v:
            if start is None: start = i
            last = i
        elif start is not None and (i - last) * hop / 16000 > max_gap:
            if (last - start) * hop / 16000 >= min_len: segs.append((start * hop, last * hop + 400))
            start = None
    if start is not None and (last - start) * hop / 16000 >= min_len: segs.append((start * hop, last * hop + 400))
    return segs


BG = []


def colored_noise(n):
    """Rumore costante: bianco, rosa o marrone (ventola, cappa, phon, doccia)."""
    w = rng.normal(0, 1, n).astype(np.float32); kind = rng.integers(0, 3)
    if kind == 0: return w
    X = np.fft.rfft(w); f = np.maximum(np.fft.rfftfreq(n, 1 / 16000), 20)
    return np.fft.irfft(X / (np.sqrt(f) if kind == 1 else f), n).astype(np.float32)


def augment(x):
    """Stessa stanza ma più lontana o più rumorosa, poi il guadagno automatico dell'app (pezzo più forte → 0,08, max x5).
    Con --bg una parte degli esempi ha sotto la TV vera (0-15 dB), con --noise-prob un rumore costante forte (3-20 dB):
    nei crash test del 19/11 con la TV sotto la voce il nome passava 5 volte su 15, e il rumore costante faceva scattare."""
    gain = 10 ** (rng.uniform(-30, 3) / 20); y = x * gain
    py = np.sqrt(np.mean(y ** 2)) + 1e-9
    n = rng.normal(0, 1, len(y)).astype(np.float32); n /= np.sqrt(np.mean(n ** 2)) + 1e-9
    y = y + n * py / 10 ** (rng.uniform(8, 45) / 20)
    if BG and rng.random() < args.bg_prob:
        b = BG[rng.integers(len(BG))]; a = rng.integers(0, max(1, len(b) - len(y)))
        seg = np.resize(b[a:a + len(y)], len(y)); seg /= np.sqrt(np.mean(seg ** 2)) + 1e-9
        y = y + seg * py / 10 ** (rng.uniform(0, 15) / 20)
    if rng.random() < args.noise_prob:
        c = colored_noise(len(y)); c /= np.sqrt(np.mean(c ** 2)) + 1e-9
        y = y + c * py / 10 ** (rng.uniform(3, 20) / 20)
    if rng.random() < 0.08: y = np.clip(y * rng.uniform(3, 8), -1, 1)  # voce troppo vicina: saturazione
    peak = max(np.sqrt(np.mean(y[i:i + 1600] ** 2)) for i in range(0, len(y) - 1599, 1600))
    return np.tanh(y * min(5.0, max(1.0, 0.08 / (peak + 1e-9))))


def f16(x):
    return FE.clip_features((np.clip(x, -1, 1) * 32767).astype(np.int16))


BG = [read(p) for p in args.bg]
kit = np.load(f"{args.kit}/kit.npz")
P = kit["pos"].astype(np.float32); N = kit["neg"].astype(np.float32)
print("kit", P.shape, N.shape)
EXT = [np.load(p).astype(np.float32) for p in args.neg_npy]
EXT = np.concatenate(EXT) if EXT else np.zeros((0, WIN, 96), np.float32)
print("negativi esterni", EXT.shape)
RP, RN = [], []
STEP = 1280


def windows_ending(x, ends):
    """Finestre di 2 s VERE (con l'audio che c'era prima) che finiscono nei punti [ends]."""
    out = []
    for e in ends:
        e = int(e)
        if e > len(x): continue
        w = x[max(0, e - CLIP):e]
        if len(w) < CLIP: w = np.concatenate([np.zeros(CLIP - len(w), np.float32) + x[:1600].mean(), w])
        out.append(w)
    return out


for p in args.pos:
    x = read(p); segs = segments(x)
    for s, e in segs:
        # Il modello deve scattare quando la parola è appena finita (0-0,25 s dopo), con la stanza vera prima.
        for _ in range(40):
            f = f16(augment(windows_ending(x, [e + rng.uniform(0, 0.25) * 16000])[0]))
            if f is not None: RP.append(f)
    # Il resto della registrazione (pause, rumore della stanza, metà parola) è un esempio negativo.
    for end in range(CLIP // 2, len(x), STEP):
        if any(e - 0.15 * 16000 < end < e + 0.7 * 16000 for _, e in segs): continue
        for _ in range(2):
            f = f16(augment(windows_ending(x, [end])[0]))
            if f is not None: RN.append(f)
negs = [read(p) for p in args.neg]
for x in negs:
    for end in range(CLIP // 2, len(x), 1600):
        for _ in range(3):
            f = f16(augment(windows_ending(x, [end])[0]))
            if f is not None: RN.append(f)
print("reali: positivi", len(RP), "negativi", len(RN))
nreal_p, nreal_n = len(RP), len(RN)
X = np.concatenate([P] + ([np.array(RP)] if RP else []) + [N] + ([np.array(RN)] if RN else []) + [EXT]).reshape(-1, WIN * 96)
y = np.concatenate([np.ones(len(P) + nreal_p), np.zeros(len(N) + nreal_n + len(EXT))]).astype(np.float32)
# Gli esempi veri contano di più: sono la voce e la stanza in cui il modello lavorerà.
sw = np.concatenate([np.ones(len(P)), np.full(nreal_p, args.real_weight), np.ones(len(N)), np.full(nreal_n, args.real_weight),
                     np.full(len(EXT), args.neg_npy_weight)]).astype(np.float32)
idx = rng.permutation(len(X)); X, y, sw = X[idx], y[idx], sw[idx]
nv = len(X) // 10; Xv, yv, Xt, yt, swt = X[:nv], y[:nv], X[nv:], y[nv:], sw[nv:]
mu = Xt.mean(0); sd = Xt.std(0) + 1e-3


def init(i, o): return (rng.normal(0, np.sqrt(2 / i), (i, o)).astype(np.float32), np.zeros(o, np.float32))


H = args.hidden
W1, b1 = init(WIN * 96, H); W2, b2 = init(H, H); W3, b3 = init(H, 1)
params = [W1, b1, W2, b2, W3, b3]; m = [np.zeros_like(p) for p in params]; v = [np.zeros_like(p) for p in params]


def forward(Xb, drop=0.0):
    z = (Xb - mu) / sd
    h1 = np.maximum(0, z @ W1 + b1)
    if drop: h1 *= (rng.random(h1.shape) > drop) / (1 - drop)
    h2 = np.maximum(0, h1 @ W2 + b2)
    if drop: h2 *= (rng.random(h2.shape) > drop) / (1 - drop)
    o = (h2 @ W3 + b3)[:, 0]
    return z, h1, h2, 1 / (1 + np.exp(-o))


def train(Xt, yt, swt, epochs):
    global t
    wpos = swt.sum() / (2 * (swt * yt).sum()); wneg = swt.sum() / (2 * (swt * (1 - yt)).sum())
    for ep in range(epochs):
        order = rng.permutation(len(Xt))
        for k in range(0, len(order), 256):
            b = order[k:k + 256]; Xb, yb = Xt[b], yt[b]
            z, h1, h2, p = forward(Xb, drop=0.2)
            # negativi pesati di più: un falso allarme dà più fastidio di una chiamata ripetuta
            w = np.where(yb > 0, wpos, wneg * 1.5) * swt[b]
            d = (p - yb) * w / len(b)
            gW3 = h2.T @ d[:, None]; gb3 = d.sum(keepdims=True)
            dh2 = d[:, None] @ W3.T * (h2 > 0); gW2 = h1.T @ dh2; gb2 = dh2.sum(0)
            dh1 = dh2 @ W2.T * (h1 > 0); gW1 = z.T @ dh1; gb1 = dh1.sum(0)
            grads = [gW1 + 1e-4 * W1, gb1, gW2 + 1e-4 * W2, gb2, gW3, gb3]
            t += 1
            for i, (pp, g) in enumerate(zip(params, grads)):
                m[i] = 0.9 * m[i] + 0.1 * g; v[i] = 0.999 * v[i] + 0.001 * g * g
                pp -= lr * (m[i] / (1 - 0.9 ** t)) / (np.sqrt(v[i] / (1 - 0.999 ** t)) + 1e-8)
        if (ep + 1) % 10 == 0 or ep == epochs - 1:
            pv = forward(Xv)[3]
            tp = ((pv > 0.5) & (yv > 0)).sum() / max(1, yv.sum()); fp = ((pv > 0.5) & (yv == 0)).sum() / max(1, (yv == 0).sum())
            print(f"epoca {ep + 1}: riconosciuti {tp:.3f}  falsi {fp:.4f}", flush=True)


lr, t = 1e-3, 0
train(Xt, yt, swt, args.epochs)
# Caccia ai falsi allarmi: i pezzi delle registrazioni senza "Kestra" che il modello confonde diventano
# esempi negativi in più (con molte varianti) e si riaddestra.
for r in range(args.mine):
    hard = []
    for x in negs:
        for end in range(CLIP // 2, len(x), 640):
            f = f16(windows_ending(x, [end])[0])
            if f is not None and forward(f.reshape(1, -1))[3][0] > 0.2:
                for _ in range(8):
                    g = f16(augment(windows_ending(x, [end + rng.integers(-320, 320)])[0]))
                    if g is not None: hard.append(g)
    print(f"caccia {r + 1}: {len(hard)} esempi difficili", flush=True)
    if not hard: break
    H_ = np.array(hard).reshape(-1, WIN * 96)
    Xt = np.concatenate([Xt, H_]); yt = np.concatenate([yt, np.zeros(len(H_), np.float32)])
    swt = np.concatenate([swt, np.full(len(H_), args.real_weight, np.float32)])
    train(Xt, yt, swt, max(10, args.epochs // 3))

json.dump({"win": WIN, "dim": 96, "mean": mu.tolist(), "std": sd.tolist(),
           "w1": W1.T.flatten().tolist(), "b1": b1.tolist(), "w2": W2.T.flatten().tolist(), "b2": b2.tolist(),
           "w3": W3.T.flatten().tolist(), "b3": b3.tolist(), "hidden": H}, open(args.out, "w"))
print("salvato", args.out)
