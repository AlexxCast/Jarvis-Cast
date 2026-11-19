package com.jarvisfit.app

import com.jarvisfit.app.voice.WakeGreetings
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

class WakeGreetingsTest {
    @Test
    fun `tante frasi brevi e nessuna ripetuta nelle ultime dieci chiamate`() {
        assertTrue(WakeGreetings.ALL.size >= 25)
        assertEquals(WakeGreetings.ALL.size, WakeGreetings.ALL.toSet().size)
        assertTrue(WakeGreetings.ALL.all { it.split(' ').size <= 4 })
        val recent = ArrayDeque<Int>()
        val rnd = Random(7)
        val seq = List(300) { WakeGreetings.pick(WakeGreetings.ALL.size, recent, rnd) }
        for (i in seq.indices) {
            val window = seq.subList(maxOf(0, i - WakeGreetings.MEMORY), i)
            assertTrue("ripetuta troppo presto", seq[i] !in window)
        }
        // Con una sola frase non si blocca.
        assertEquals(0, WakeGreetings.pick(1, ArrayDeque(), rnd))
    }
}
