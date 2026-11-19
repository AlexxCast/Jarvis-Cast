"""Prove dell'ascolto dal PC (python -m unittest test_ascolto, serve numpy). Il riconoscimento vocale è finto."""
import threading
import time
import unittest

import numpy as np

import kestra_ascolto as ka


class Chiamata(unittest.TestCase):
    def test_chiama_kestra(self):
        self.assertEqual(ka.wake_command("Kestra, che ore sono?"), "che ore sono")
        self.assertEqual(ka.wake_command("Ehi Kestra accendi la luce"), "accendi la luce")
        self.assertEqual(ka.wake_command("Kestra"), "")
        self.assertEqual(ka.wake_command("che ore sono Kestra"), "che ore sono")
        self.assertEqual(ka.wake_command("kesta metti la musica"), "metti la musica")
        self.assertEqual(ka.wake_command("che stra apri chrome"), "apri chrome")
        self.assertEqual(ka.wake_command("ehi questa"), "")
        self.assertEqual(ka.wake_command("Questa."), "")

    def test_non_chiama_kestra(self):
        for t in ["questa sera vado al cinema", "allora questa la prendo", "gira a destra", "ehi destra",
                  "un extra di patatine", "la testa mi fa male", "che sta facendo", "", "🙂",
                  "ieri ho visto il film dove c'è Kestra", "secondo me dovremmo chiedere a Kestra cosa cucinare"]:
            self.assertIsNone(ka.wake_command(t), t)

    def test_chiusura(self):
        self.assertTrue(ka.is_cancel("grazie Kestra"))
        self.assertTrue(ka.is_cancel("ok basta così"))
        self.assertFalse(ka.is_cancel("grazie, quante calorie mi restano?"))


def tone(seconds, amp):
    n = int(seconds * ka.SR)
    t = np.arange(n) / ka.SR
    return (np.sin(2 * np.pi * 220 * t) * amp).astype(np.int16)


def noise(seconds, amp=60):
    return (np.random.default_rng(1).normal(0, amp, int(seconds * ka.SR))).astype(np.int16)


def frames(sig):
    for i in range(0, len(sig) - ka.FRAME + 1, ka.FRAME):
        yield sig[i:i + ka.FRAME]


class Voce(unittest.TestCase):
    def test_taglia_una_frase(self):
        seg = ka.Segmenter()
        sig = np.concatenate([noise(2), tone(1.5, 3000), noise(1.5)])
        out = [a for a in (seg.push(f) for f in frames(sig)) if a is not None]
        self.assertEqual(len(out), 1)
        self.assertTrue(1.4 < len(out[0]) / ka.SR < 2.6)

    def test_ignora_rumore_e_colpi(self):
        seg = ka.Segmenter()
        sig = np.concatenate([noise(3), tone(0.15, 6000), noise(2)])
        self.assertFalse(any(seg.push(f) is not None for f in frames(sig)))

    def test_si_adatta_al_rumore_della_stanza(self):
        seg = ka.Segmenter()
        sig = np.concatenate([noise(4, amp=250), tone(1.2, 4000), noise(1.5, amp=250)])
        out = [a for a in (seg.push(f) for f in frames(sig)) if a is not None]
        self.assertEqual(len(out), 1)


class Ascolto(unittest.TestCase):
    def run_listener(self, heard, replies):
        sent, spoken, logs = [], [], []
        texts = iter(heard)
        replies = iter(replies)

        def send(text, followup):
            sent.append((text, followup))
            return next(replies)

        lst = ka.Listener(send=send, speak=spoken.append, log=logs.append,
                          transcriber=lambda audio: next(texts, ""), stream_factory=lambda cb: None)
        lst._beep = lambda: None
        for _ in heard:
            lst.handle(np.zeros(16000, dtype=np.float32))
        return sent, spoken

    def test_nome_poi_comando_senza_ripeterlo(self):
        sent, spoken = self.run_listener(["Kestra", "che tempo fa domani"], [{"reply": "Sole, Capo.", "expectReply": False}])
        self.assertEqual(sent, [("che tempo fa domani", False)])
        self.assertEqual(spoken, ["Sole, Capo."])

    def test_replica_senza_nome_dopo_una_domanda(self):
        sent, _ = self.run_listener(
            ["Kestra ricordami di chiamare Luca", "alle otto", "e poi un'altra cosa"],
            [{"reply": "A che ora?", "expectReply": True}, {"reply": "Fatto.", "expectReply": False}],
        )
        self.assertEqual(sent, [("ricordami di chiamare luca", False), ("alle otto", True)])

    def test_la_tv_non_attiva_kestra(self):
        sent, _ = self.run_listener(["questa sera in prima serata", "gira a destra"], [])
        self.assertEqual(sent, [])

    def test_errore_del_server_non_ferma_l_ascolto(self):
        def boom(text, followup):
            raise RuntimeError("503")
        lst = ka.Listener(send=boom, speak=lambda t: None, log=lambda m: None, transcriber=lambda a: "Kestra che ore sono",
                          stream_factory=lambda cb: None)
        lst.handle(np.zeros(100, dtype=np.float32))  # non solleva

    def test_flusso_completo_dal_microfono(self):
        sent = []
        sig = np.concatenate([noise(1.5), tone(1.2, 4000), noise(1.5)])

        class FakeStream:
            def __init__(self, cb):
                self.cb = cb

            def __enter__(self):
                threading.Thread(target=lambda: [self.cb(f) for f in frames(sig)], daemon=True).start()
                return self

            def __exit__(self, *a):
                return False

        lst = ka.Listener(send=lambda t, f: sent.append(t) or {"reply": ""}, speak=lambda t: None, log=lambda m: None,
                          transcriber=lambda a: "Kestra apri chrome", stream_factory=FakeStream)
        lst.start()
        for _ in range(40):
            if sent:
                break
            time.sleep(0.05)
        lst.stop()
        self.assertEqual(sent, ["apri chrome"])


if __name__ == "__main__":
    unittest.main()
