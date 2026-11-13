package com.jarvisfit.app.voice

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.ln
import kotlin.math.log10
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * "Impronta" della voce, calcolata sul telefono senza servizi esterni.
 *
 * Da una registrazione ricava il timbro (coefficienti MFCC: media e variabilità) e l'altezza
 * della voce (media e variabilità del tono). Due registrazioni della stessa persona danno vettori
 * vicini; una voce diversa dà un vettore lontano. È una protezione di base, non una serratura:
 * distingue bene voci diverse per timbro e altezza, meno bene voci molto simili.
 */
object VoicePrint {
    const val SAMPLE_RATE = 16_000
    private const val FRAME = 400      // 25 ms
    private const val HOP = 160        // 10 ms
    private const val FFT = 512
    private const val MELS = 26
    private const val CEPS = 12
    /** Dimensione del vettore: media e deviazione dei 12 coefficienti, più tono medio e sua variabilità. */
    const val SIZE = CEPS * 2 + 2
    /** Sotto questa quantità di parlato la registrazione non basta per giudicare. */
    const val MIN_VOICED_FRAMES = 40

    private val window = DoubleArray(FRAME) { 0.54 - 0.46 * cos(2 * PI * it / (FRAME - 1)) }
    private val filters: Array<DoubleArray> by lazy { melFilters() }

    private fun mel(hz: Double) = 2595.0 * log10(1 + hz / 700.0)
    private fun hz(mel: Double) = 700.0 * (10.0.pow(mel / 2595.0) - 1)

    private fun melFilters(): Array<DoubleArray> {
        val lo = mel(100.0); val hi = mel(SAMPLE_RATE / 2.0 - 500)
        val pts = DoubleArray(MELS + 2) { hz(lo + (hi - lo) * it / (MELS + 1)) * FFT / SAMPLE_RATE }
        return Array(MELS) { m ->
            DoubleArray(FFT / 2 + 1) { k ->
                val x = k.toDouble()
                when {
                    x <= pts[m] || x >= pts[m + 2] -> 0.0
                    x <= pts[m + 1] -> (x - pts[m]) / (pts[m + 1] - pts[m])
                    else -> (pts[m + 2] - x) / (pts[m + 2] - pts[m + 1])
                }
            }
        }
    }

    /** FFT in posto (lunghezza potenza di 2). */
    private fun fft(re: DoubleArray, im: DoubleArray) {
        val n = re.size
        var j = 0
        for (i in 1 until n) {
            var bit = n shr 1
            while (j and bit != 0) { j = j xor bit; bit = bit shr 1 }
            j = j xor bit
            if (i < j) { val tr = re[i]; re[i] = re[j]; re[j] = tr; val ti = im[i]; im[i] = im[j]; im[j] = ti }
        }
        var len = 2
        while (len <= n) {
            val ang = -2 * PI / len
            val wr = cos(ang); val wi = sin(ang)
            var i = 0
            while (i < n) {
                var cr = 1.0; var ci = 0.0
                for (k in 0 until len / 2) {
                    val ur = re[i + k]; val ui = im[i + k]
                    val vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci
                    val vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr
                    re[i + k] = ur + vr; im[i + k] = ui + vi
                    re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi
                    val nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr
                }
                i += len
            }
            len = len shl 1
        }
    }

    /** Tono (Hz) di un pezzetto di voce con l'autocorrelazione; 0 se non è un suono con un tono chiaro. */
    private fun pitch(frame: DoubleArray): Double {
        val minLag = SAMPLE_RATE / 400; val maxLag = SAMPLE_RATE / 70
        var e = 0.0
        for (v in frame) e += v * v
        if (e <= 0) return 0.0
        var best = 0.0; var bestLag = 0
        for (lag in minLag..maxLag) {
            var s = 0.0
            for (i in 0 until frame.size - lag) s += frame[i] * frame[i + lag]
            if (s > best) { best = s; bestLag = lag }
        }
        return if (bestLag > 0 && best / e > 0.35) SAMPLE_RATE.toDouble() / bestLag else 0.0
    }

    data class Print(val vector: DoubleArray, val voicedFrames: Int)

    /** Calcola l'impronta di una registrazione a 16 kHz mono. Ritorna null se c'è troppo poco parlato. */
    fun of(pcm: ShortArray): Print? {
        if (pcm.size < FRAME * 4) return null
        // Pre-enfasi: dà peso alle frequenze alte, dove sta molto del timbro.
        val x = DoubleArray(pcm.size)
        x[0] = pcm[0].toDouble()
        for (i in 1 until pcm.size) x[i] = pcm[i] - 0.97 * pcm[i - 1]
        val count = (pcm.size - FRAME) / HOP + 1
        val energy = DoubleArray(count)
        for (f in 0 until count) { var e = 0.0; for (i in 0 until FRAME) { val v = pcm[f * HOP + i].toDouble(); e += v * v }; energy[f] = e / FRAME }
        // Parlato = pezzi nettamente più forti del rumore di fondo (il 10% più silenzioso).
        val floor = energy.sorted()[count / 10].coerceAtLeast(1.0)
        val peak = energy.maxOrNull() ?: 0.0
        val threshold = maxOf(floor * 6, peak * 0.02, 2_500.0)

        val sum = DoubleArray(CEPS); val sq = DoubleArray(CEPS)
        val pitches = ArrayList<Double>()
        var voiced = 0
        val re = DoubleArray(FFT); val im = DoubleArray(FFT)
        val raw = DoubleArray(FRAME)
        for (f in 0 until count) {
            if (energy[f] < threshold) continue
            java.util.Arrays.fill(re, 0.0); java.util.Arrays.fill(im, 0.0)
            for (i in 0 until FRAME) { re[i] = x[f * HOP + i] * window[i]; raw[i] = pcm[f * HOP + i].toDouble() }
            fft(re, im)
            val logMel = DoubleArray(MELS) { m ->
                var s = 0.0
                val w = filters[m]
                for (k in 0..FFT / 2) if (w[k] != 0.0) s += w[k] * (re[k] * re[k] + im[k] * im[k])
                ln(s + 1e-3)
            }
            for (c in 0 until CEPS) {
                var s = 0.0
                for (m in 0 until MELS) s += logMel[m] * cos(PI * (c + 1) * (m + 0.5) / MELS)
                sum[c] += s; sq[c] += s * s
            }
            val p = pitch(raw)
            if (p > 0) pitches += p
            voiced++
        }
        if (voiced < MIN_VOICED_FRAMES) return null
        val v = DoubleArray(SIZE)
        for (c in 0 until CEPS) {
            val mean = sum[c] / voiced
            v[c] = mean
            v[CEPS + c] = sqrt((sq[c] / voiced - mean * mean).coerceAtLeast(0.0))
        }
        if (pitches.size >= 8) {
            val logs = pitches.map { ln(it) }
            val mean = logs.average()
            v[CEPS * 2] = mean
            v[CEPS * 2 + 1] = sqrt(logs.sumOf { (it - mean) * (it - mean) } / logs.size)
        }
        return Print(v, voiced)
    }

    /** Modello dell'utente: media delle impronte registrate e quanto variano tra loro. */
    data class Model(val mean: DoubleArray, val spread: DoubleArray, val selfDistance: Double)

    // Quanto pesa ogni parte: le medie del timbro e il tono contano più della variabilità.
    private fun weight(i: Int) = when {
        i < CEPS -> 1.0
        i < CEPS * 2 -> 0.4
        i == CEPS * 2 -> 2.5
        else -> 0.3
    }
    // Scala tipica di ogni grandezza, così timbro e tono sono confrontabili.
    private fun scale(i: Int) = when {
        i < CEPS -> 4.0
        i < CEPS * 2 -> 2.0
        i == CEPS * 2 -> 0.12   // circa il 12% di differenza di tono
        else -> 0.15
    }

    fun distance(a: DoubleArray, b: DoubleArray): Double {
        var s = 0.0; var w = 0.0
        for (i in 0 until SIZE) {
            // Tono non misurato in una delle due: quella parte non entra nel confronto.
            if (i >= CEPS * 2 && (a[CEPS * 2] == 0.0 || b[CEPS * 2] == 0.0)) continue
            val d = (a[i] - b[i]) / scale(i)
            s += weight(i) * d * d; w += weight(i)
        }
        return sqrt(s / w)
    }

    /** Costruisce il modello da almeno 2 registrazioni dell'utente. */
    fun enroll(prints: List<DoubleArray>): Model? {
        if (prints.size < 2) return null
        val mean = DoubleArray(SIZE) { i -> prints.map { it[i] }.average() }
        val spread = DoubleArray(SIZE) { i -> sqrt(prints.sumOf { (it[i] - mean[i]) * (it[i] - mean[i]) } / prints.size) }
        val self = prints.map { distance(it, mean) }.average()
        return Model(mean, spread, self)
    }

    /**
     * La voce corrisponde? [strictness] da 0 (permissivo) a 1 (severo).
     * La soglia parte da quanto le registrazioni dell'utente differiscono tra loro.
     */
    fun threshold(model: Model, strictness: Float): Double {
        val base = maxOf(model.selfDistance * 2.2, 0.45)
        return base * (1.35 - 0.6 * strictness.coerceIn(0f, 1f))
    }

    fun matches(model: Model, sample: DoubleArray, strictness: Float = 0.5f): Boolean =
        distance(sample, model.mean) <= threshold(model, strictness)

    fun encode(m: Model): String = (m.mean.toList() + m.spread.toList() + m.selfDistance).joinToString(",")
    fun decode(s: String): Model? = runCatching {
        val v = s.split(',').map { it.toDouble() }
        if (v.size != SIZE * 2 + 1 || v.any { it.isNaN() || abs(it) > 1e6 }) return null
        Model(v.subList(0, SIZE).toDoubleArray(), v.subList(SIZE, SIZE * 2).toDoubleArray(), v[SIZE * 2])
    }.getOrNull()
}
