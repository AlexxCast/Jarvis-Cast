"""Scarica esempi NEGATIVI già pronti da openWakeWord (Apache 2.0 / CC): vettori di suoni dello stesso estrattore,
calcolati su ore di parlato, musica e rumore di ogni tipo. Senza di loro il modello impara "voce di Alessio = Kestra".

- validation_set_features.npy (~11 ore, vettori continui ogni 80 ms) → finestre da 16, metà per addestrare e metà per
  misurare i falsi allarmi su audio mai visto.
- un pezzo di openwakeword_features_ACAV100M_2000_hrs_16bit.npy (finestre [N,16,96] in float16): solo i primi ~1,5 GB
  con una richiesta parziale, poi un campione a caso.
Uso: python fetch_negatives.py <cartella>
"""
import os, sys, urllib.request, ast
import numpy as np

OUT = sys.argv[1]; os.makedirs(OUT, exist_ok=True)
HF = "https://huggingface.co/datasets/davidscripka/openwakeword_features/resolve/main"
rng = np.random.default_rng(3)

val = f"{OUT}/validation_set_features.npy"
if not os.path.exists(val): urllib.request.urlretrieve(f"{HF}/validation_set_features.npy", val)
v = np.load(val, mmap_mode="r"); print("validation", v.shape, v.dtype, flush=True)
if v.ndim == 2:
    starts = np.arange(0, v.shape[0] - 16, 4)
    win = np.stack([np.asarray(v[s:s + 16]) for s in starts]).astype(np.float16)
else:
    win = np.asarray(v).astype(np.float16)
half = len(win) // 2
np.save(f"{OUT}/neg_val_train.npy", win[:half]); np.save(f"{OUT}/neg_val_test.npy", win[half:])
print("validation finestre", win.shape, flush=True)

# ACAV100M: intestazione .npy + i primi byte del file, finestre intere.
LIMIT = 1_500_000_000
req = urllib.request.Request(f"{HF}/openwakeword_features_ACAV100M_2000_hrs_16bit.npy", headers={"Range": f"bytes=0-{LIMIT}"})
part = f"{OUT}/acav_part.bin"
with urllib.request.urlopen(req) as r, open(part, "wb") as f:
    while True:
        b = r.read(1 << 22)
        if not b: break
        f.write(b)
raw = open(part, "rb").read(4096)
hlen = int.from_bytes(raw[8:10], "little") if raw[6] == 1 else int.from_bytes(raw[8:12], "little")
off = (10 if raw[6] == 1 else 12) + hlen
hdr = ast.literal_eval(raw[off - hlen:off].decode("latin1"))
print("ACAV intestazione", hdr, flush=True)
shape = hdr["shape"]; per = int(np.prod(shape[1:])); dt = np.dtype(hdr["descr"])
n = (os.path.getsize(part) - off) // (per * dt.itemsize)
a = np.memmap(part, dtype=dt, mode="r", offset=off, shape=(n, *shape[1:]))
pick = np.sort(rng.choice(n, size=min(n, 120_000), replace=False))
np.save(f"{OUT}/neg_acav.npy", np.asarray(a[pick]).astype(np.float16))
print("ACAV finestre", n, "prese", len(pick), flush=True)
os.remove(part)
