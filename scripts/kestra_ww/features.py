"""Estrattore di suoni condiviso (stesso di openWakeWord, Apache 2.0): melspettrogramma + "speech embedding" di Google.
Ogni 80 ms di audio produce un vettore di 96 numeri; il modello di Kestra guarda gli ultimi 16 (circa 1,3 s)."""
import numpy as np
import onnxruntime as ort

WIN = 16          # vettori guardati dal classificatore
CLIP = 32000      # 2 s di audio per esempio di addestramento (bastano per 16 vettori)


class Features:
    def __init__(self, mel_path, emb_path):
        o = ort.SessionOptions(); o.inter_op_num_threads = 1; o.intra_op_num_threads = 2
        self.mel = ort.InferenceSession(mel_path, o, providers=["CPUExecutionProvider"])
        self.emb = ort.InferenceSession(emb_path, o, providers=["CPUExecutionProvider"])

    def melspec(self, pcm16):
        x = pcm16.astype(np.float32)[None, :]
        spec = np.squeeze(self.mel.run(None, {self.mel.get_inputs()[0].name: x})[0])
        return spec / 10 + 2  # stessa trasformazione di openWakeWord

    def embed(self, pcm16):
        """[n, 96] per un pezzo di audio int16 a 16 kHz."""
        spec = self.melspec(pcm16)
        wins = [spec[i:i + 76] for i in range(0, spec.shape[0] - 75, 8)]
        if not wins:
            return np.zeros((0, 96), np.float32)
        out = self.emb.run(None, {self.emb.get_inputs()[0].name: np.array(wins, np.float32)[..., None]})[0]
        return out.reshape(len(wins), 96)

    def clip_features(self, pcm16):
        """Gli ultimi 16 vettori di una clip di 2 s (la parola deve finire verso la fine della clip)."""
        e = self.embed(pcm16)
        return e[-WIN:] if len(e) >= WIN else None
