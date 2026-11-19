"""Prova il modello come farebbe l'app: audio in pezzi da 80 ms, estrattore in streaming, 16 vettori, soglia."""
import json, sys, wave
import numpy as np
from features import Features


class Stream:
    """Stessa logica di streaming dell'app (KestraWake.kt): 1280 campioni nuovi + 480 di contesto per il mel."""
    def __init__(self, fe):
        self.fe = fe; self.raw = np.zeros(0, np.int16); self.mel = np.ones((76, 32), np.float32); self.emb = []

    def push(self, chunk):
        self.raw = np.concatenate([self.raw, chunk])[-16000:]
        if len(self.raw) < 1760: return None
        m = self.fe.melspec(self.raw[-1760:])
        self.mel = np.vstack([self.mel, m])[-120:]
        x = self.mel[-76:].astype(np.float32)[None, :, :, None]
        e = self.fe.emb.run(None, {self.fe.emb.get_inputs()[0].name: x})[0].reshape(96)
        self.emb = (self.emb + [e])[-16:]
        return np.array(self.emb) if len(self.emb) == 16 else None


def model(path):
    M = json.load(open(path)); H = M["hidden"]
    W1 = np.array(M["w1"], np.float32).reshape(H, -1).T; W2 = np.array(M["w2"], np.float32).reshape(H, H).T
    W3 = np.array(M["w3"], np.float32).reshape(1, H).T
    mu, sd = np.array(M["mean"], np.float32), np.array(M["std"], np.float32)
    b1, b2, b3 = (np.array(M[k], np.float32) for k in ("b1", "b2", "b3"))

    def score(f):
        z = (f.reshape(-1) - mu) / sd
        h = np.maximum(0, z @ W1 + b1); h = np.maximum(0, h @ W2 + b2)
        return float(1 / (1 + np.exp(-(h @ W3 + b3)[0])))
    return score


def run(fe, score, x, thr=0.5, gain=1.0):
    st = Stream(fe); hits = []; last = -9; scores = []
    x = np.clip(x * gain, -1, 1)
    for i in range(0, len(x) - 1280, 1280):
        f = st.push((x[i:i + 1280] * 32767).astype(np.int16))
        if f is None: continue
        s = score(f); scores.append(s); t = (i + 1280) / 16000
        if s > thr and t - last > 1.5:
            hits.append(round(t, 2)); last = t
    return hits, scores


if __name__ == "__main__":
    kit, mpath = sys.argv[1], sys.argv[2]
    fe = Features(f"{kit}/melspectrogram.onnx", f"{kit}/embedding_model.onnx"); score = model(mpath)
    for p in sys.argv[3:]:
        with wave.open(p) as w: x = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768
        for thr in (0.5, 0.7, 0.9):
            for g in (1.0, 0.1):
                h, s = run(fe, score, x, thr, g)
                print(f"{p.split('/')[-1]} soglia {thr} volume x{g}: {len(h)} chiamate a {h}  (max {max(s):.2f})")


def false_alarms_per_hour(score, windows, thr, stride_s=0.32):
    """Falsi allarmi all'ora su finestre di vettori già pronte (es. neg_val_test.npy, passo 4 vettori = 0,32 s)."""
    last = -9; n = 0
    for i, f in enumerate(windows):
        t = i * stride_s
        if score(f.astype(np.float32)) > thr and t - last > 1.5: n += 1; last = t
    return n / (len(windows) * stride_s / 3600)
