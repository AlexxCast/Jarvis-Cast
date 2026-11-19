package com.jarvisfit.app.voice

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.util.Log
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.KeywordSpotter
import com.k2fsa.sherpa.onnx.KeywordSpotterConfig
import com.k2fsa.sherpa.onnx.OnlineModelConfig
import com.k2fsa.sherpa.onnx.OnlineStream
import com.k2fsa.sherpa.onnx.OnlineTransducerModelConfig

/**
 * Riconoscimento "forte" della parola Kestra, tutto sul telefono e senza internet.
 *
 * Il riconoscimento vocale di Android cerca parole italiane e scrive "Kestra" come "questa", "kesta"...
 * Qui invece un piccolo modello (sherpa-onnx, keyword spotting) ascolta il microfono e cerca SOLO la
 * sequenza di suoni di "Kestra": niente vocabolario, niente trascrizione. Quando la sente avvisa il servizio,
 * che passa al riconoscimento normale per capire la richiesta.
 *
 * Modello e librerie vengono scaricati durante la build (scripts/fetch_kws.sh). Se mancano (o il telefono non è
 * arm64) [ready] è falso e il servizio usa il metodo di prima.
 */
object KestraKws {
    private const val TAG = "KestraKws"
    private const val SR = 16000
    private const val DIR = "kws"

    @Volatile var running = false; private set
    /** Ultima volta che il ciclo di ascolto ha letto audio (per il controllo anti-blocco del servizio). */
    @Volatile var lastAliveMs = 0L; private set

    private var spotter: KeywordSpotter? = null
    private var spotterKey = ""
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
            Build.SUPPORTED_ABIS.contains("arm64-v8a") &&
                ctx.assets.list(DIR).orEmpty().toSet().containsAll(listOf("encoder.onnx", "decoder.onnx", "joiner.onnx", "tokens.txt", "keywords.txt"))
        }.getOrDefault(false) && runCatching { System.loadLibrary("sherpa-onnx-jni"); true }.getOrElse {
            Log.w(TAG, "libreria non disponibile", it); false
        }
        available = ok
        return ok
    }

    /**
     * Sensibilità 0..1 dell'app → soglia di attivazione (più bassa = più facile) e spinta della parola.
     * Il modello è inglese e "Kestra" detto da un italiano non è mai perfetto: soglie più basse delle predefinite
     * (0.25 / 1.0). Bassa ≈ 0.22, Media ≈ 0.19, Alta ≈ 0.14.
     */
    internal fun tuning(sensitivity: Float): Pair<Float, Float> {
        val s = sensitivity.coerceIn(0f, 1f)
        return (0.25f - 0.13f * s) to (1.5f + 1.5f * s)
    }

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

    private fun spotterFor(ctx: Context, sensitivity: Float): KeywordSpotter {
        val (threshold, score) = tuning(sensitivity)
        val key = "%.2f/%.2f".format(threshold, score)
        spotter?.let { if (spotterKey == key) return it; runCatching { it.release() } }
        val config = KeywordSpotterConfig(
            featConfig = FeatureConfig(sampleRate = SR, featureDim = 80),
            modelConfig = OnlineModelConfig(
                transducer = OnlineTransducerModelConfig(
                    encoder = "$DIR/encoder.onnx",
                    decoder = "$DIR/decoder.onnx",
                    joiner = "$DIR/joiner.onnx",
                ),
                tokens = "$DIR/tokens.txt",
                modelType = "zipformer2",
                numThreads = 1,
            ),
            keywordsFile = "$DIR/keywords.txt",
            keywordsThreshold = threshold,
            keywordsScore = score,
        )
        return KeywordSpotter(ctx.assets, config).also { spotter = it; spotterKey = key }
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
        val kws = try { spotterFor(ctx.applicationContext, sensitivity) } catch (t: Throwable) {
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
        thread = Thread({ loop(my, kws, record, onWake, onError, onSilent) }, "kestra-kws").also { it.start() }
        return true
    }

    @Synchronized
    fun stop() {
        running = false
        gen++
        thread = null // il ciclo vede running=false, chiude il microfono ed esce entro 100 ms
    }

    private fun loop(my: Int, kws: KeywordSpotter, record: AudioRecord, onWake: () -> Unit, onError: (Throwable) -> Unit, onSilent: () -> Unit) {
        var stream: OnlineStream? = null
        try {
            val st = kws.createStream()
            stream = st
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
                if (g > 1.01f) for (i in 0 until n) samples[i] = kotlin.math.tanh(samples[i] * g) // limitatore morbido
                st.acceptWaveform(if (n == buf.size) samples else samples.copyOf(n), SR)
                while (kws.isReady(st)) kws.decode(st)
                if (kws.getResult(st).keyword.isNotBlank()) {
                    kws.reset(st)
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
            runCatching { stream?.release() }
        }
    }
}
