"""Estrattore di suoni condiviso (stesso di openWakeWord, Apache 2.0): melspettrogramma + "speech embedding" di Google.
Ogni 80 ms di audio produce un vettore di 96 numeri; il modello di Kestra guarda gli ultimi 16 (circa 1,3 s)."""
import numpy as np
import onnxruntime as ort

WIN = 16          # vettori guardati dal classificatore
STEP = 1280       # l'app lavora a pezzi da 80 ms
MEL_IN = 1760     # per ogni pezzo lo spettro si calcola sugli ultimi 1760 campioni (480 di contesto)
# 26 pezzi: il primo non basta per lo spettro, poi 9,5 pezzi riempiono le 76 righe, poi i 16 vettori.
CLIP = 26 * STEP  # 2,08 s di audio per esempio di addestramento


class Features:
    def __init__(self, mel_path, emb_path):
        o = ort.SessionOptions(); o.inter_op_num_threads = 1; o.intra_op_num_threads = 2
        self.mel = ort.InferenceSession(mel_path, o, providers=["CPUExecutionProvider"])
        self.emb = ort.InferenceSession(emb_path, o, providers=["CPUExecutionProvider"])

    def melspec(self, pcm16):
        x = pcm16.astype(np.float32)[None, :]
        spec = np.squeeze(self.mel.run(None, {self.mel.get_inputs()[0].name: x})[0])
        return spec / 10 + 2  # stessa trasformazione di openWakeWord

    def clip_features(self, pcm16):
        """Gli ultimi 16 vettori di una clip, calcolati ESATTAMENTE come nell'app (KestraDetector.kt) partendo da
        zero: spettro sugli ultimi 1760 campioni a ogni pezzo da 1280, righe iniziali a 1, embedding delle ultime 76.
        Calcolarli sul file intero darebbe numeri un po' diversi da quelli che il telefono vede davvero."""
        x = np.asarray(pcm16, np.float32)
        n = len(x) // STEP
        ends = [k * STEP for k in range(1, n + 1) if k * STEP >= MEL_IN]
        if not ends: return None
        batch = np.stack([x[e - MEL_IN:e] for e in ends])
        spec = self.mel.run(None, {self.mel.get_inputs()[0].name: batch})[0][:, 0] / 10 + 2  # [steps, 8, 32]
        rows = np.concatenate([np.ones((76, 32), np.float32), spec.reshape(-1, 32)])
        per = spec.shape[1]
        if len(ends) < WIN: return None
        wins = np.stack([rows[76 + per * (k + 1) - 76:76 + per * (k + 1)] for k in range(len(ends) - WIN, len(ends))])
        out = self.emb.run(None, {self.emb.get_inputs()[0].name: wins.astype(np.float32)[..., None]})[0]
        return out.reshape(WIN, 96)
