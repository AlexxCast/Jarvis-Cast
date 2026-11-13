package com.jarvisfit.app

import com.jarvisfit.app.voice.VoicePrint
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.exp
import kotlin.math.sin
import kotlin.random.Random

class VoicePrintTest {
    /** Voce finta: tono [f0] con armoniche modellate da due "formanti", più un po' di rumore e pause. */
    private fun voice(f0: Double, f1: Double, f2: Double, seed: Int, seconds: Double = 2.0): ShortArray {
        val rnd = Random(seed)
        val n = (VoicePrint.SAMPLE_RATE * seconds).toInt()
        val jitter = 1 + (rnd.nextDouble() - 0.5) * 0.04
        return ShortArray(n) { i ->
            val t = i.toDouble() / VoicePrint.SAMPLE_RATE
            val speaking = (t * 3).toInt() % 4 != 3          // una pausa ogni tanto
            var s = 0.0
            if (speaking) for (h in 1..30) {
                val f = f0 * jitter * h
                if (f > 7000) break
                val gain = exp(-((f - f1) / 250).let { it * it }) + 0.7 * exp(-((f - f2) / 350).let { it * it }) + 0.03
                s += gain * sin(2 * PI * f * t)
            }
            (s * 6000 + (rnd.nextDouble() - 0.5) * 120).toInt().coerceIn(-32000, 32000).toShort()
        }
    }

    @Test fun `la stessa voce viene riconosciuta e una voce diversa viene respinta`() {
        val mine = (1..3).map { VoicePrint.of(voice(115.0, 600.0, 1400.0, it))!!.vector }
        val model = VoicePrint.enroll(mine)!!
        val again = VoicePrint.of(voice(115.0, 600.0, 1400.0, 99))!!.vector
        val other = VoicePrint.of(voice(210.0, 850.0, 2300.0, 7))!!.vector
        val similarPitch = VoicePrint.of(voice(118.0, 900.0, 2500.0, 8))!!.vector
        assertTrue(VoicePrint.matches(model, again))
        assertFalse(VoicePrint.matches(model, other))
        assertFalse(VoicePrint.matches(model, similarPitch))
        assertTrue(VoicePrint.distance(again, model.mean) < VoicePrint.distance(other, model.mean))
    }

    @Test fun `silenzio o registrazione troppo corta non danno un'impronta`() {
        assertNull(VoicePrint.of(ShortArray(VoicePrint.SAMPLE_RATE * 2)))
        assertNull(VoicePrint.of(ShortArray(100)))
        assertNull(VoicePrint.of(voice(120.0, 600.0, 1400.0, 1, seconds = 0.3)))
    }

    @Test fun `il modello si salva e si rilegge uguale`() {
        val model = VoicePrint.enroll((1..3).map { VoicePrint.of(voice(130.0, 700.0, 1500.0, it))!!.vector })!!
        val back = VoicePrint.decode(VoicePrint.encode(model))
        assertNotNull(back)
        assertEquals(model.selfDistance, back!!.selfDistance, 1e-9)
        assertEquals(model.mean.toList(), back.mean.toList())
        assertNull(VoicePrint.decode("1,2,3"))
        // Più severo = soglia più stretta.
        assertTrue(VoicePrint.threshold(model, 0.9f) < VoicePrint.threshold(model, 0.1f))
    }
}
