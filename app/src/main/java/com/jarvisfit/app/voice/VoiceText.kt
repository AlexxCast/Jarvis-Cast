package com.jarvisfit.app.voice

/**
 * Logica testuale pura del canale vocale (nessuna dipendenza Android → testabile su JVM).
 */
object VoiceText {

    private fun normalize(s: String) = s.lowercase()
        .replace(Regex("[^a-z0-9àèéìòóù ]"), " ")
        .replace(Regex("\\s+"), " ")
        .trim()

    /**
     * Vero se [recognized] è con alta probabilità l'eco della frase appena pronunciata da Jarvis.
     * Volutamente conservativo: una risposta breve dell'utente che riprende 1-2 parole di Jarvis
     * ("sì, il pranzo") NON deve essere scartata.
     */
    fun isSelfEcho(recognized: String, lastSpoken: String, msSinceSpoken: Long, windowMs: Long = 15_000L): Boolean {
        if (lastSpoken.isBlank() || msSinceSpoken < 0 || msSinceSpoken > windowMs) return false
        val rec = normalize(recognized)
        val spoken = normalize(lastSpoken)
        val recWords = rec.split(" ").filter { it.length > 2 }
        if (recWords.size < 3) return false

        // Frammento contiguo della frase di Jarvis (≥ 4 parole)
        if (rec.split(" ").size >= 4 && spoken.contains(rec)) return true

        val spokenWords = spoken.split(" ").filter { it.length > 2 }.toSet()
        val ratio = recWords.count { it in spokenWords }.toDouble() / recWords.size
        return ratio >= 0.85
    }

    /**
     * Frasi che chiudono la conversazione. Devono costituire TUTTA la frase: "niente pasta oggi"
     * o "grazie, quante calorie mi restano?" non devono chiudere la sessione.
     */
    private val cancelRegex = Regex(
        "^(?:ok |okay |va bene |perfetto )?(?:basta|grazie(?: mille| tante)?|a posto(?: così)?|stop|annulla|niente|chiudi|" +
            "lascia stare|arrivederci|ciao|ok basta|perfetto grazie|ho finito|finito|va bene così|può bastare|sono a posto)" +
            "(?: (?:così|jarvis|grazie|ciao))*$",
        RegexOption.IGNORE_CASE,
    )

    fun isCancelPhrase(text: String): Boolean = cancelRegex.matches(normalize(text))

    /** Rimuove markdown, link ed emoji prima della sintesi vocale. */
    fun cleanForSpeech(raw: String): String = raw
        .replace(Regex("(?i)https?://\\S+"), "")
        .replace(Regex("[*#_`~>|\\[\\]]"), " ")
        .replace(Regex("[\\p{So}\\p{Cn}\\p{Cs}]"), "")
        .replace(Regex("\\s+"), " ")
        .trim()
}
