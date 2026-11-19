package com.jarvisfit.app

import com.jarvisfit.app.voice.KestraKws
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class KestraKwsTest {
    @Test
    fun `piu sensibilita vuol dire soglia piu bassa`() {
        val low = KestraKws.threshold(0.2f)
        val mid = KestraKws.threshold(0.5f)
        val high = KestraKws.threshold(0.88f)
        assertTrue(low > mid && mid > high)
        // Sempre un punteggio vero (0..1) e mai così basso da scattare con ogni parola simile.
        assertTrue(KestraKws.threshold(0f) < 1f && KestraKws.threshold(1f) >= 0.3f)
        assertEquals(KestraKws.threshold(1f), KestraKws.threshold(5f), 0f)
        // Anche ad Alta (0,88, quella predefinita) non sotto 0,75: a 0,69 scattava con orchestra, finestra e la TV.
        assertTrue(KestraKws.threshold(0.88f) >= 0.75f)
    }

    @Test
    fun `un picco isolato non basta, servono punteggi alti di fila`() {
        var run = 0
        for (s in floatArrayOf(0.95f, 0.2f, 0.96f, 0.1f)) run = KestraKws.streak(run, s, 0.8f)
        assertEquals(0, run)
        run = 0
        for (s in floatArrayOf(0.3f, 0.9f, 0.97f)) run = KestraKws.streak(run, s, 0.8f)
        assertTrue(run >= KestraKws.CONSECUTIVE)
    }

    @Test
    fun `il volume automatico alza la voce lontana e si abbassa subito su quella forte`() {
        // Voce lontana: sale piano fino al massimo (5x).
        var g = 1f
        repeat(200) { g = KestraKws.nextGain(g, 0.005f) }
        assertEquals(5f, g, 0.01f)
        // Voce forte vicina: scende subito, non satura.
        g = KestraKws.nextGain(g, 0.4f)
        assertEquals(1f, g, 0.001f)
        // Voce media: guadagno moderato.
        var m = 1f
        repeat(200) { m = KestraKws.nextGain(m, 0.04f) }
        assertEquals(2f, m, 0.05f)
        // Niente segnale: il guadagno resta com'è.
        assertEquals(3f, KestraKws.nextGain(3f, 0f), 0f)
    }

    @Test
    fun `solo gli zeri esatti contano come microfono negato`() {
        assertTrue(KestraKws.isDigitalSilence(ShortArray(1600), 1600))
        val hiss = ShortArray(1600) { if (it % 7 == 0) 1 else 0 }
        assertFalse(KestraKws.isDigitalSilence(hiss, 1600))
        assertFalse(KestraKws.isDigitalSilence(ShortArray(0), 0))
    }
}
