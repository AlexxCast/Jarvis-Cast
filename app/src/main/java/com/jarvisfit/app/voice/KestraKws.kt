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

    /** Vero se modello e librerie ci sono e l'ultimo errore è lontano (dopo un errore si riprova tra un minuto). */
    fun ready(ctx: Context): Boolean {
        if (System.currentTimeMillis() - failedAtMs < 60_000L) return false
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

    /** Sensibilità 0..1 dell'app → soglia di attivazione (più bassa = più facile) e spinta della parola. */
    internal fun tuning(sensitivity: Float): Pair<Float, Float> {
        val s = sensitivity.coerceIn(0f, 1f)
        return (0.33f - 0.15f * s) to (1.0f + 1.0f * s)
    }

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
    fun start(ctx: Context, sensitivity: Float, onWake: () -> Unit, onError: (Throwable) -> Unit): Boolean {
        if (running) return true
        if (!ready(ctx)) return false
        val kws = try { spotterFor(ctx.applicationContext, sensitivity) } catch (t: Throwable) {
            Log.w(TAG, "modello non caricato", t); failedAtMs = System.currentTimeMillis(); available = null; return false
        }
        val minBuf = AudioRecord.getMinBufferSize(SR, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val record = try {
            AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, SR, AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT, maxOf(minBuf, SR / 5 * 2))
        } catch (t: Throwable) {
            failedAtMs = System.currentTimeMillis(); return false
        }
        if (record.state != AudioRecord.STATE_INITIALIZED) {
            runCatching { record.release() }
            failedAtMs = System.currentTimeMillis()
            return false
        }
        running = true
        lastAliveMs = System.currentTimeMillis()
        val my = ++gen
        thread = Thread({ loop(my, kws, record, onWake, onError) }, "kestra-kws").also { it.start() }
        return true
    }

    @Synchronized
    fun stop() {
        running = false
        gen++
        thread = null // il ciclo vede running=false, chiude il microfono ed esce entro 100 ms
    }

    private fun loop(my: Int, kws: KeywordSpotter, record: AudioRecord, onWake: () -> Unit, onError: (Throwable) -> Unit) {
        var stream: OnlineStream? = null
        try {
            val st = kws.createStream()
            stream = st
            record.startRecording()
            val buf = ShortArray(SR / 10) // 100 ms
            val samples = FloatArray(buf.size)
            var lastWake = 0L
            while (running && gen == my) {
                val n = record.read(buf, 0, buf.size)
                if (n < 0) throw IllegalStateException("lettura microfono: $n")
                if (n == 0) continue
                lastAliveMs = System.currentTimeMillis()
                for (i in 0 until n) samples[i] = buf[i] / 32768f
                st.acceptWaveform(if (n == buf.size) samples else samples.copyOf(n), SR)
                while (kws.isReady(st)) kws.decode(st)
                if (kws.getResult(st).keyword.isNotBlank()) {
                    kws.reset(st)
                    val now = System.currentTimeMillis()
                    if (now - lastWake > 1500L && running && gen == my) {
                        lastWake = now
                        running = false
                        onWake()
                    }
                }
            }
        } catch (t: Throwable) {
            Log.w(TAG, "ascolto interrotto", t)
            if (gen == my) {
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
