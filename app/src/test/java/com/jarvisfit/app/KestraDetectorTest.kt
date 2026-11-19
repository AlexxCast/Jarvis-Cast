package com.jarvisfit.app

import com.jarvisfit.app.voice.KestraDetector
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class KestraDetectorTest {
    /** Rete minuscola (16 vettori da 2 numeri, 2 neuroni) che dà un punteggio alto quando la media del suono è alta. */
    private fun tinyClassifierJson(): String {
        val inp = 16 * 2
        val mean = List(inp) { 0 }; val std = List(inp) { 1 }
        val w1 = List(2 * inp) { if (it < inp) 1.0 / inp else 0.0 }
        return """{"win":16,"dim":2,"hidden":2,"mean":$mean,"std":$std,"w1":$w1,"b1":[0,0],
            "w2":[1,0,0,0],"b2":[0,0],"w3":[10,0],"b3":[-5]}"""
    }

    @Test
    fun `la rete letta dal json calcola il punteggio come in python`() {
        val c = KestraDetector.Classifier.parse(tinyClassifierJson())
        assertEquals(16, c.win)
        // Media 0 → sigmoide(-5) ≈ 0.0067; media 1 → sigmoide(10·1 − 5) ≈ 0.9933.
        assertEquals(0.0067f, c.score(List(16) { floatArrayOf(0f, 0f) }), 0.001f)
        assertEquals(0.9933f, c.score(List(16) { floatArrayOf(1f, 1f) }), 0.001f)
    }

    @Test
    fun `in streaming arriva un punteggio ogni 80 ms dopo 16 vettori`() {
        val c = KestraDetector.Classifier.parse(tinyClassifierJson())
        var melCalls = 0
        var lastLen = 0
        val det = KestraDetector(c,
            mel = { x -> melCalls++; lastLen = x.size; Array(8) { FloatArray(KestraDetector.MEL_BANDS) { x.average().toFloat() } } },
            embed = { rows -> assertEquals(76, rows.size); floatArrayOf(rows.last()[0], rows.last()[0]) })
        // 100 ms alla volta, come il microfono dell'app.
        val chunk = FloatArray(1600) { 1f }
        val scores = mutableListOf<Float>()
        repeat(30) { scores += det.push(chunk) }
        assertEquals(KestraDetector.MEL_IN, lastLen)
        // 30 pezzi da 1600 = 48000 campioni = 37 passi da 1280; il primo non ha ancora 1760 campioni.
        assertEquals(36, melCalls)
        // Il primo punteggio arriva al 16° vettore, poi uno per pezzo (almeno).
        assertTrue(scores.take(10).all { it < 0f })
        assertTrue(scores.last() > 0.99f)
        det.reset()
        assertEquals(-1f, det.push(chunk), 0f)
    }
}
