package com.jarvisfit.app.voice

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.util.Log
import ai.onnxruntime.OrtEnvironment

/**
 * Riconoscimento "forte" della parola Kestra, tutto sul telefono e senza internet.
 *
 * Il riconoscimento vocale di Android cerca parole italiane e scrive "Kestra" come "questa", "kesta"...
 * Qui invece un modello addestrato apposta sulla parola "Kestra" (anche sulla voce di Alessio) ascolta il
 * microfono e dà un punteggio ogni 80 ms ([KestraDetector]): niente vocabolario, niente trascrizione.
 * Quando lo sente avvisa il servizio, che passa al riconoscimento normale per capire la richiesta.
 *
 * Il primo tentativo (sherpa-onnx, modello inglese) non riconosceva mai il "Kestra" detto in italiano: vedi
 * docs/DECISIONI.md. Modelli in assets/kestra/ (onnxruntime). Se mancano [ready] è falso e il servizio usa il
 * metodo di Android.
 */
object KestraKws {
    private const val TAG = "KestraKws"
    private const val SR = 16000
    private const val DIR = "kestra"

    @Volatile var running = false; private set
    /** Ultima volta che il ciclo di ascolto ha letto audio (per il controllo anti-blocco del servizio). */
    @Volatile var lastAliveMs = 0L; private set

    private var models: KestraOnnx? = null
    private var thread: Thread? = null
    /** Ogni accensione ha il suo numero: un ciclo vecchio che non ha ancora chiuso il microfono si ferma da solo. */
    @Volatile private var gen = 0
    private var available: Boolean? = null
    private var failedAtMs = 0L

    // Diagnosi (Impostazioni › Telefono): cosa sta succedendo davvero al riconoscimento forte.
    /** Volume medio del microfono negli ultimi secondi, 0..1 (0 = muto). */
    @Volatile var level = 0f; private set
    /** Guadagno digitale applicato per sentire anche da lontano. */
    @Volatile var gain = 1f; private set
    @Volatile var detections = 0; private set
    @Volatile var lastWakeAtMs = 0L; private set
    @Volatile var lastError = ""; private set
    /** Ultimo punteggio del modello (0..1) e il più alto dall'avvio dell'app: aiutano a tarare la sensibilità. */
    @Volatile var lastScore = 0f; private set
    @Volatile var peakScore = 0f; private set
    /** Android dà al servizio un microfono muto (succede se l'ascolto è ripartito mentre l'app era chiusa). */
    @Volatile var silencedUntilMs = 0L; private set

    /** Vero se il microfono arriva muto: per 10 minuti si usa il riconoscimento di Android (o finché si apre l'app). */
    fun silenced() = System.currentTimeMillis() < silencedUntilMs

    /** L'app è in primo piano: Android ridà il microfono vero al servizio, si può riprovare subito. */
    fun clearSilence() { silencedUntilMs = 0L }

    /** Vero se modello e librerie ci sono e l'ultimo errore è lontano (dopo un errore si riprova tra un minuto). */
    fun ready(ctx: Context): Boolean {
        if (System.currentTimeMillis() - failedAtMs < 60_000L) return false
        if (silenced()) return false
        available?.let { return it }
        val ok = runCatching {
            ctx.assets.list(DIR).orEmpty().toSet().containsAll(FILES)
        }.getOrDefault(false) && runCatching { OrtEnvironment.getEnvironment(); true }.getOrElse {
            Log.w(TAG, "onnxruntime non disponibile", it); false
        }
        available = ok
        return ok
    }

    /**
     * Sensibilità 0..1 dell'app → punteggio minimo (0..1) del modello per dire "ho sentito Kestra".
     * Valori tarati sulle registrazioni di Alessio con scripts/kestra_ww/evaluate.py.
     */
    internal fun threshold(sensitivity: Float): Float = (T_LOW - (T_LOW - T_HIGH) * sensitivity.coerceIn(0f, 1f))

    /**
     * Controllo automatico del volume: il telefono sul comodino sente la voce dalla scrivania molto bassa.
     * Porta il parlato verso un livello costante (al massimo ×[MAX_GAIN]), si abbassa subito sui suoni forti e
     * risale piano; il limitatore morbido evita la saturazione. [peakRms] (pezzo più forte degli ultimi 2 s) è 0..1.
     */
    internal fun nextGain(current: Float, peakRms: Float): Float {
        if (peakRms <= 1e-4f) return current
        val want = (TARGET_RMS / peakRms).coerceIn(1f, MAX_GAIN)
        return if (want < current) want else current + (want - current) * 0.05f
    }

    /** Vero se l'audio è "muto digitale": Android passa zeri esatti quando nega il microfono al servizio
     *  (un microfono vero, anche in una stanza silenziosa, ha sempre un filo di fruscio). */
    internal fun isDigitalSilence(buf: ShortArray, n: Int): Boolean {
        if (n <= 0) return false
        for (i in 0 until n) if (buf[i].toInt() != 0) return false
        return true
    }

    private const val TARGET_RMS = 0.08f
    private const val MAX_GAIN = 5f
    private const val SILENT_CHUNKS = 60 // 6 secondi di zeri esatti
    private const val T_LOW = 0.95f // sensibilità 0 (Bassa 0,2 → 0,89)
    private const val T_HIGH = 0.65f // sensibilità 1 (Media 0,5 → 0,8; Alta 0,88 → 0,69)
    private val FILES = listOf("melspectrogram.onnx", "embedding_model.onnx", "kestra_ww.json")


    private fun modelsFor(ctx: Context): KestraOnnx {
        models?.let { return it }
        fun bytes(name: String) = ctx.assets.open("$DIR/$name").use { it.readBytes() }
        return KestraOnnx(bytes("melspectrogram.onnx"), bytes("embedding_model.onnx"), String(bytes("kestra_ww.json")))
            .also { models = it }
    }

    /**
     * Accende l'ascolto. [onWake] e [onError] arrivano dal thread di ascolto: chi li riceve li riporta sul main.
     * Ritorna false se non è partito (in quel caso il servizio usa il riconoscimento normale).
     */
    @SuppressLint("MissingPermission")
    @Synchronized
    fun start(ctx: Context, sensitivity: Float, onWake: () -> Unit, onError: (Throwable) -> Unit, onSilent: () -> Unit = {}): Boolean {
        if (running) return true
        if (!ready(ctx)) return false
        val m = try { modelsFor(ctx.applicationContext) } catch (t: Throwable) {
            Log.w(TAG, "modello non caricato", t); lastError = "modello: ${t.message}"; failedAtMs = System.currentTimeMillis(); available = null; return false
        }
        val minBuf = AudioRecord.getMinBufferSize(SR, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val record = try {
            AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, SR, AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT, maxOf(minBuf, SR / 5 * 2))
        } catch (t: Throwable) {
            lastError = "microfono: ${t.message}"; failedAtMs = System.currentTimeMillis(); return false
        }
        if (record.state != AudioRecord.STATE_INITIALIZED) {
            runCatching { record.release() }
            lastError = "microfono non disponibile"
            failedAtMs = System.currentTimeMillis()
            return false
        }
        running = true
        lastAliveMs = System.currentTimeMillis()
        val my = ++gen
        val thr = threshold(sensitivity)
        thread = Thread({ loop(my, m.detector(), thr, record, onWake, onError, onSilent) }, "kestra-kws").also { it.start() }
        return true
    }

    @Synchronized
    fun stop() {
        running = false
        gen++
        thread = null // il ciclo vede running=false, chiude il microfono ed esce entro 100 ms
    }

    private fun loop(my: Int, det: KestraDetector, thr: Float, record: AudioRecord, onWake: () -> Unit, onError: (Throwable) -> Unit, onSilent: () -> Unit) {
        try {
            record.startRecording()
            val buf = ShortArray(SR / 10) // 100 ms
            val samples = FloatArray(buf.size)
            var lastWake = 0L
            var silentChunks = 0
            var chunks = 0
            // Volume dei pezzi più forti degli ultimi ~2 secondi: guida il guadagno automatico.
            val recent = FloatArray(20)
            var g = gain.coerceIn(1f, MAX_GAIN)
            var lvl = 0f
            val started = System.currentTimeMillis()
            while (running && gen == my) {
                val n = record.read(buf, 0, buf.size)
                if (n < 0) throw IllegalStateException("lettura microfono: $n")
                if (n == 0) continue
                lastAliveMs = System.currentTimeMillis()
                chunks++
                // Microfono negato dal sistema: arrivano solo zeri. Meglio passare al riconoscimento di Android.
                silentChunks = if (isDigitalSilence(buf, n)) silentChunks + 1 else 0
                val clientSilenced = Build.VERSION.SDK_INT >= 29 && chunks % 10 == 0 &&
                    runCatching { record.activeRecordingConfiguration?.isClientSilenced == true }.getOrDefault(false)
                if ((silentChunks >= SILENT_CHUNKS || clientSilenced) && gen == my) {
                    silencedUntilMs = System.currentTimeMillis() + 10 * 60_000L
                    lastError = "Android ha dato al servizio un microfono muto: apri l'app per riattivarlo"
                    running = false
                    level = 0f
                    onSilent()
                    break
                }
                var sum = 0.0
                for (i in 0 until n) { val v = buf[i] / 32768f; samples[i] = v; sum += v * v }
                val rms = kotlin.math.sqrt(sum / n).toFloat()
                recent[chunks % recent.size] = rms
                lvl += (rms - lvl) * 0.1f
                level = lvl
                g = nextGain(g, recent.maxOrNull() ?: 0f)
                gain = g
                // Il modello lavora in scala int16; il limitatore morbido evita la saturazione col guadagno alto.
                if (g > 1.01f) for (i in 0 until n) samples[i] = kotlin.math.tanh(samples[i] * g) * 32767f
                else for (i in 0 until n) samples[i] *= 32767f
                val score = det.push(samples, n)
                if (score < 0f) continue
                lastScore = score
                if (score > peakScore) peakScore = score
                // Il primo secondo dopo l'accensione riempie solo la memoria del modello.
                if (score >= thr && System.currentTimeMillis() - started > 1000L) {
                    val now = System.currentTimeMillis()
                    if (now - lastWake > 1500L && running && gen == my) {
                        lastWake = now
                        detections++
                        lastWakeAtMs = now
                        running = false
                        onWake()
                    }
                }
            }
        } catch (t: Throwable) {
            Log.w(TAG, "ascolto interrotto", t)
            if (gen == my) {
                lastError = "ascolto interrotto: ${t.message}"
                failedAtMs = System.currentTimeMillis()
                running = false
                onError(t)
            }
        } finally {
            runCatching { record.stop() }
            runCatching { record.release() }
        }
    }
}
