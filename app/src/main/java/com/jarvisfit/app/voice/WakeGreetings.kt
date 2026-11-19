package com.jarvisfit.app.voice

import kotlin.random.Random

/** Cosa dice Kestra quando la si chiama: brevi, al posto del bip, e mai le stesse di fila. */
object WakeGreetings {
    val ALL = listOf(
        "Ciao Capo.", "Sì Capo?", "Dimmi, Capo.", "Eccomi.", "Sono qui.", "Dimmi pure.", "Ti ascolto.",
        "Comandi, Capo.", "Sì?", "Pronta.", "Eccomi, Capo.", "Dimmi tutto.", "Sì, Capo.", "Agli ordini.",
        "Ciao, dimmi.", "Sono tutta orecchi.", "Ci sono.", "Presente.", "Che ti serve?", "Dica, Capo.",
        "Eccomi qua.", "Sì, ti sento.", "Pronta, Capo.", "Vai, ti ascolto.", "Dimmi, ci sono.",
        "Ciao! Dimmi.", "Sì, sono qui.", "In ascolto.", "Eccomi, dimmi.", "Certo, Capo?",
    )

    /** Quante delle ultime frasi non si ripetono. */
    const val MEMORY = 10

    /** Sceglie un indice a caso tra [size] evitando gli ultimi [MEMORY] usati (in [recent], aggiornato qui). */
    fun pick(size: Int, recent: ArrayDeque<Int>, rnd: Random): Int {
        require(size > 0)
        val keep = minOf(MEMORY, size - 1)
        val free = (0 until size).filter { it !in recent.takeLast(keep) }
        val idx = free[rnd.nextInt(free.size)]
        recent.addLast(idx)
        while (recent.size > MEMORY) recent.removeFirst()
        return idx
    }
}
