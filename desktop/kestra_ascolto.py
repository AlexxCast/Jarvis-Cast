"""
Ascolto di "Kestra" dal microfono del PC.

Il telefono sul comodino non sente il Capo alla scrivania: qui ascolta il PC, con un microfono vicino.
- Riconoscimento offline sul PC (faster-whisper), con il nome "Kestra" suggerito al modello: è la cosa
  più vicina ad "aggiungere la parola al vocabolario", che il riconoscimento di Android non permette.
- Il modello lavora solo quando qualcuno parla (rilevatore di voce a energia), non di continuo.
- Si attiva solo se la frase chiama Kestra (stesse regole del telefono: il nome all'inizio, o alla fine
  di una frase breve; le storpiature solo in posizione di chiamata, mai "questa sera..." o "a destra").
- Dopo una risposta che aspetta una replica, ascolta qualche secondo senza bisogno del nome.

Dipendenze (una volta sola): Installa_Ascolto.bat, cioè  pip install faster-whisper sounddevice numpy
"""

import queue
import re
import threading
import time

SR = 16000
FRAME = 480  # 30 ms
PROMPT = "Kestra. Ehi Kestra, che ore sono? Kestra, metti la musica."
FOLLOW_S = 8.0

# ------------------------------------------------------------------ riconoscere la chiamata

STRICT = re.compile(
    r"\b(kestra|chestra|questra|cestra|khestra|keistra|kesra|kestre|kestro|kestrah|chestre|chestro|kestrà|kesztra|"
    r"chiestra|kiestra|kestar|chestar|kestera|kesstra)\b"
)
CALL_WORDS = {
    "ehi", "hey", "ei", "hei", "ciao", "ok", "okay", "senti", "ascolta", "scusa", "scusami", "allora", "oh", "dimmi",
    "per", "favore", "cortesia", "ora", "adesso", "dico", "sentimi", "buongiorno", "buonasera", "buonanotte", "grazie",
    "e", "ma", "dai",
}
GREETINGS = {"ehi", "hey", "ei", "hei", "ehy", "ciao"}
COMMON_NEAR = {"questa", "cesta"}
NEVER_NEAR = {"destra", "extra", "estra", "sestra", "castra", "vestra", "testra"}
NEAR_EXTRA = {"kester", "kestar", "kestrel", "kestral", "kestera", "kesterà"}
ABOUT = re.compile(r"\b(film|marvel|serie|personagg\w*|attore|attrice|cinema|videogioc\w*|gioco|fumett\w*|si chiama|chiamat\w*|chiamano)\b")
ABOUT_BEFORE = {"di", "su", "con", "a", "il", "la", "un", "una", "questo", "questa", "quel", "quella", "tipo", "come", "della", "sulla", "alla", "dalla"}


def normalize(s: str) -> str:
    s = (s or "").lower()
    s = re.sub(r"[^a-z0-9àèéìòóù ]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def phonetic(w: str) -> str:
    w = w.replace("ch", "k").replace("qu", "k").replace("kh", "k").replace("x", "ks").replace("c", "k").replace("h", "")
    w = w.replace("à", "a").replace("è", "e").replace("é", "e")
    return re.sub(r"(.)\1+", r"\1", w)


def distance(a: str, b: str) -> int:
    d = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        prev, d[0] = d[0], i
        for j in range(1, len(b) + 1):
            cur = d[j]
            d[j] = min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] != b[j - 1]))
            prev = cur
    return d[len(b)]


def _near(t: str) -> bool:
    if len(t) < 4:
        return False
    k = phonetic(t)
    return distance(k, "kestra") <= 1 or t in NEAR_EXTRA or k in NEAR_EXTRA


def _near_call(tokens):
    """Il nome storpiato detto per chiamare: all'inizio, dopo al massimo parole di richiamo."""
    for i in range(min(4, len(tokens))):
        if any(w not in CALL_WORDS for w in tokens[:i]):
            break
        t = tokens[i]
        greeted = i > 0 and tokens[i - 1] in GREETINGS
        if i + 1 < len(tokens) and phonetic(t + tokens[i + 1]) == "kestra":
            return i, i + 1
        if t in NEVER_NEAR:
            continue
        if t in COMMON_NEAR:
            if greeted or len(tokens) == 1:
                return i, i
            continue
        if _near(t):
            return i, i
    return None


def wake_command(text: str):
    """None se la frase non chiama Kestra; altrimenti il comando che segue il nome ("" se c'è solo il nome)."""
    norm = normalize(text)
    if not norm:
        return None
    m = STRICT.search(norm)
    if not m:
        tokens = norm.split()
        r = _near_call(tokens)
        if r is None:
            return None
        after = " ".join(tokens[r[1] + 1:])
        return None if (ABOUT.search(norm) and after) else after
    before = norm[:m.start()].split()
    after = norm[m.end():].strip()
    about = bool(ABOUT.search(norm)) or (len(before) > 1 and before[-1] in ABOUT_BEFORE)
    if len(before) <= 3 and all(w in CALL_WORDS for w in before):
        return None if (about and after) else after
    if about:
        return None
    if not after and len(before) <= 12:
        return " ".join(before)
    return " ".join(before + after.split()).strip()


def is_cancel(text: str) -> bool:
    return bool(re.fullmatch(
        r"(ok |okay |va bene |perfetto )?(basta( così)?|grazie( mille| kestra)?|a posto( così)?|stop|annulla|lascia stare|ho finito|niente)( kestra| grazie| capo)*",
        normalize(text),
    ))


# ------------------------------------------------------------------ rilevatore di voce

class Segmenter:
    """Taglia il flusso del microfono in frasi: soglia di energia che segue il rumore di fondo della stanza."""

    def __init__(self, start_frames=4, end_frames=25, max_s=15.0, preroll=10):
        self.noise = 120.0
        self.start_frames, self.end_frames = start_frames, end_frames
        self.max_frames = int(max_s * SR / FRAME)
        self.preroll = preroll
        self.reset()

    def reset(self):
        self.recent = []      # ultimi frame prima della voce
        self.loud = []        # 1/0 degli ultimi frame
        self.buf = None
        self.quiet = 0
        self.voiced = 0

    def push(self, frame):
        """frame: array int16 di FRAME campioni. Ritorna l'audio di una frase finita (float32) o None."""
        import numpy as np
        rms = float(np.sqrt(np.mean(frame.astype(np.float32) ** 2))) if len(frame) else 0.0
        thr = max(150.0, self.noise * 2.6)
        loud = rms > thr
        if self.buf is None:
            self.noise = self.noise * 0.97 + min(rms, self.noise * 3) * 0.03 if not loud else self.noise
            self.recent = (self.recent + [frame])[-self.preroll:]
            self.loud = (self.loud + [1 if loud else 0])[-6:]
            if sum(self.loud) >= self.start_frames:
                self.buf = list(self.recent)
                self.quiet = 0
                self.voiced = sum(self.loud)
            return None
        self.buf.append(frame)
        if rms > thr * 0.8:
            self.quiet = 0
            self.voiced += 1
        else:
            self.quiet += 1
        if self.quiet >= self.end_frames or len(self.buf) >= self.max_frames:
            audio = np.concatenate(self.buf).astype(np.float32) / 32768.0
            voiced = self.voiced
            self.reset()
            if voiced < 10:  # meno di 0,3 s di voce: un colpo, una porta
                return None
            return audio
        return None


# ------------------------------------------------------------------ ascolto

def missing_dependencies() -> str:
    missing = []
    for mod in ("numpy", "sounddevice", "faster_whisper"):
        try:
            __import__(mod)
        except Exception:
            missing.append(mod.replace("_", "-"))
    return " ".join(missing)


class WhisperTranscriber:
    def __init__(self, size="small"):
        from faster_whisper import WhisperModel
        self.model = WhisperModel(size, device="cpu", compute_type="int8")

    def __call__(self, audio) -> str:
        segs, _ = self.model.transcribe(
            audio, language="it", initial_prompt=PROMPT, beam_size=1, vad_filter=False,
            condition_on_previous_text=False, without_timestamps=True,
        )
        out = []
        for s in segs:
            # Rumore scambiato per voce: Whisper a volte "inventa" il testo del suggerimento.
            if s.no_speech_prob > 0.6 or s.avg_logprob < -1.1:
                continue
            out.append(s.text)
        text = " ".join(out).strip()
        return "" if normalize(text) in (normalize(PROMPT), "kestra ehi kestra") else text


class Listener:
    """Thread che ascolta il microfono e parla con Kestra. send(text, followup) → risposta del server."""

    def __init__(self, send, speak, log, model_size="small", device=None, transcriber=None, stream_factory=None):
        self.send, self.speak, self.log = send, speak, log
        self.model_size, self.device = model_size, device
        self.transcriber = transcriber
        self.stream_factory = stream_factory
        self.frames = queue.Queue(maxsize=2000)
        self.stop_event = threading.Event()
        self.thread = None
        self.follow_until = 0.0
        self.awaiting = False
        self.speaking = False

    def start(self):
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()

    def stop(self):
        self.stop_event.set()

    @property
    def alive(self):
        return bool(self.thread and self.thread.is_alive())

    def _open_stream(self):
        if self.stream_factory:
            return self.stream_factory(self._on_audio)
        import sounddevice as sd
        return sd.InputStream(samplerate=SR, channels=1, dtype="int16", blocksize=FRAME, device=self.device,
                              callback=lambda data, n, t, status: self._on_audio(data[:, 0].copy()))

    def _on_audio(self, frame):
        if self.speaking:
            return  # non ascoltare la propria voce
        try:
            self.frames.put_nowait(frame)
        except queue.Full:
            pass

    def run(self):
        if self.transcriber is None:
            self.log(f"Ascolto: carico il modello vocale '{self.model_size}' (la prima volta lo scarica, qualche minuto)...")
            try:
                self.transcriber = WhisperTranscriber(self.model_size)
            except Exception as e:
                self.log(f"Ascolto non avviato: {e}")
                return
        seg = Segmenter()
        while not self.stop_event.is_set():
            try:
                stream = self._open_stream()
            except Exception as e:
                self.log(f"Microfono non disponibile ({e}). Riprovo tra 30 secondi.")
                self.stop_event.wait(30)
                continue
            self.log('Ascolto attivo: chiama "Kestra" dal PC.')
            try:
                with stream:
                    while not self.stop_event.is_set():
                        try:
                            frame = self.frames.get(timeout=0.5)
                        except queue.Empty:
                            continue
                        audio = seg.push(frame)
                        if audio is not None:
                            self.handle(audio)
                            seg.reset()
            except Exception as e:
                self.log(f"Ascolto interrotto ({e}). Riparto tra 5 secondi.")
                self.stop_event.wait(5)

    def _drain(self):
        while True:
            try:
                self.frames.get_nowait()
            except queue.Empty:
                return

    def handle(self, audio):
        try:
            text = self.transcriber(audio)
        except Exception as e:
            self.log(f"Trascrizione non riuscita: {e}")
            return
        if not text:
            return
        in_follow = time.time() < self.follow_until
        cmd = wake_command(text)
        if cmd is None and not in_follow:
            return
        followup = cmd is None and in_follow and not self.awaiting
        if cmd is None:
            cmd = normalize(text)
        if not cmd:
            # Solo il nome: un bip e poi ascolta la richiesta senza bisogno di ripeterlo.
            self.log(f"Sentito: {text}")
            self._beep()
            self.awaiting = True
            self.follow_until = time.time() + FOLLOW_S
            return
        self.awaiting = False
        self.follow_until = 0.0
        if followup and is_cancel(cmd):
            return
        self.log(f"Tu (voce): {cmd}")
        try:
            out = self.send(cmd, followup) or {}
        except Exception as e:
            self.log(f"Kestra non risponde: {e}")
            return
        if out.get("ignored"):
            return
        reply = out.get("reply", "")
        if reply:
            self.log(f"Kestra: {reply}")
            self.speaking = True
            try:
                self.speak(reply)
            finally:
                self._drain()
                self.speaking = False
        if out.get("expectReply"):
            self.follow_until = time.time() + FOLLOW_S

    def _beep(self):
        try:
            import winsound
            winsound.Beep(880, 120)
        except Exception:
            pass
