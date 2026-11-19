package com.jarvisfit.app.voice

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.float
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import kotlin.math.exp

/**
 * Il "cervello" del riconoscimento di Kestra, senza Android: serve anche ai test.
 *
 * Due pezzi già addestrati (openWakeWord, Apache 2.0) trasformano l'audio in suoni: [mel] fa lo spettro
 * (32 bande ogni 10 ms) e [embed] riassume 76 righe di spettro (~0,8 s) in 96 numeri. Ogni 80 ms arriva un
 * riassunto nuovo; gli ultimi [Classifier.win] (16 ≈ 1,3 s) vanno al [Classifier], la piccola rete addestrata
 * sulla parola "Kestra" (scripts/kestra_ww/train.py), che dà un punteggio 0..1.
 *
 * Stessa logica di streaming di scripts/kestra_ww/evaluate.py: ogni 1280 campioni nuovi lo spettro si calcola
 * sugli ultimi 1760 (480 di contesto), così le righe nuove sono 8 e combaciano con quelle calcolate sul file intero.
 */
class KestraDetector(
    private val classifier: Classifier,
    /** Audio in scala int16 (−32768..32767) → righe di spettro da 32 bande. */
    private val mel: (FloatArray) -> Array<FloatArray>,
    /** 76 righe di spettro → 96 numeri. */
    private val embed: (Array<FloatArray>) -> FloatArray,
) {
    private val raw = FloatArray(MEL_IN)
    private val chunk = FloatArray(STEP)
    private var pending = 0
    private var filled = 0
    // Come openWakeWord: lo spettro parte "pieno di uni" finché non arriva audio vero.
    private val melRows = ArrayDeque<FloatArray>().apply { repeat(MEL_WIN) { addLast(FloatArray(MEL_BANDS) { 1f }) } }
    private val embs = ArrayDeque<FloatArray>()

    fun reset() {
        raw.fill(0f); pending = 0; filled = 0
        melRows.clear(); repeat(MEL_WIN) { melRows.addLast(FloatArray(MEL_BANDS) { 1f }) }
        embs.clear()
    }

    /**
     * Aggiunge audio (scala int16). Ritorna il punteggio più alto calcolato in questo pezzo, oppure -1 se non
     * c'era ancora abbastanza audio per un punteggio.
     */
    fun push(samples: FloatArray, n: Int = samples.size): Float {
        var best = -1f
        var i = 0
        while (i < n) {
            val take = minOf(STEP - pending, n - i)
            System.arraycopy(samples, i, chunk, pending, take)
            pending += take; i += take
            if (pending == STEP) {
                pending = 0
                // Finestra degli ultimi 1760 campioni: si scorre di 1280 e si aggiungono quelli nuovi in fondo.
                System.arraycopy(raw, STEP, raw, 0, MEL_IN - STEP)
                System.arraycopy(chunk, 0, raw, MEL_IN - STEP, STEP)
                filled = minOf(MEL_IN, filled + STEP)
                if (filled >= MEL_IN) {
                    val s = step()
                    if (s > best) best = s
                }
            }
        }
        return best
    }

    private fun step(): Float {
        for (row in mel(raw.copyOf())) {
            melRows.addLast(row)
            if (melRows.size > MEL_WIN) melRows.removeFirst()
        }
        embs.addLast(embed(melRows.toTypedArray()))
        if (embs.size > classifier.win) embs.removeFirst()
        return if (embs.size == classifier.win) classifier.score(embs) else -1f
    }

    /** La piccola rete (2 strati nascosti, ReLU, sigmoide) letta da assets/kestra/kestra_ww.json. */
    class Classifier(
        val win: Int, val dim: Int, val hidden: Int,
        private val mean: FloatArray, private val std: FloatArray,
        private val w1: FloatArray, private val b1: FloatArray,
        private val w2: FloatArray, private val b2: FloatArray,
        private val w3: FloatArray, private val b3: Float,
    ) {
        init {
            val inp = win * dim
            require(mean.size == inp && std.size == inp && w1.size == hidden * inp && b1.size == hidden &&
                w2.size == hidden * hidden && b2.size == hidden && w3.size == hidden) { "modello Kestra non valido" }
        }

        fun score(frames: List<FloatArray>): Float {
            val inp = win * dim
            val z = FloatArray(inp)
            var k = 0
            for (f in frames) for (v in f) { z[k] = (v - mean[k]) / std[k]; k++ }
            val h1 = FloatArray(hidden)
            for (j in 0 until hidden) {
                var s = b1[j]; val o = j * inp
                for (i in 0 until inp) s += w1[o + i] * z[i]
                h1[j] = if (s > 0f) s else 0f
            }
            var out = b3
            for (j in 0 until hidden) {
                var s = b2[j]; val o = j * hidden
                for (i in 0 until hidden) s += w2[o + i] * h1[i]
                if (s > 0f) out += w3[j] * s
            }
            return (1.0 / (1.0 + exp(-out.toDouble()))).toFloat()
        }

        companion object {
            fun parse(text: String): Classifier {
                val o = Json.parseToJsonElement(text) as JsonObject
                fun arr(key: String) = o.getValue(key).jsonArray.let { a -> FloatArray(a.size) { a[it].jsonPrimitive.float } }
                return Classifier(
                    win = o.getValue("win").jsonPrimitive.int, dim = o.getValue("dim").jsonPrimitive.int,
                    hidden = o.getValue("hidden").jsonPrimitive.int,
                    mean = arr("mean"), std = arr("std"),
                    w1 = arr("w1"), b1 = arr("b1"), w2 = arr("w2"), b2 = arr("b2"), w3 = arr("w3"), b3 = arr("b3")[0],
                )
            }
        }
    }

    companion object {
        const val STEP = 1280 // 80 ms
        const val MEL_IN = 1760 // 1280 nuovi + 480 di contesto
        const val MEL_WIN = 76
        const val MEL_BANDS = 32
    }
}
