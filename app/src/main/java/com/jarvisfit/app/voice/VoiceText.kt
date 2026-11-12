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

    // ---------------------------------------------------------------- parola di attivazione

    /** Esito dell'analisi di una frase sentita mentre Jarvis è in attesa. */
    sealed class Wake {
        /** "Jarvis" non è stato pronunciato. */
        object None : Wake()
        /** L'utente ha chiamato Jarvis; [command] è la richiesta (vuota se ha detto solo il nome). */
        data class Direct(val command: String) : Wake()
        /** "Jarvis" compare, ma non è chiaro se l'utente si rivolge a lui o ne sta parlando. */
        data class Ambiguous(val text: String, val aboutJarvis: Boolean) : Wake()
    }

    private val wakeToken = Regex("\\b(jarvis|jarvi|giarvis|jervis|gervis|jarvys)\\b")

    /** Parole che possono precedere il nome quando lo si chiama ("ehi Jarvis", "senti Jarvis"). */
    private val callWords = setOf(
        "ehi", "hey", "ei", "hei", "ciao", "ok", "okay", "senti", "ascolta", "scusa", "allora", "oh",
        "buongiorno", "buonasera", "buonanotte", "grazie", "e", "ma", "dai",
    )

    /** Indizi che si sta parlando DI Jarvis (il personaggio dei film, o l'assistente in terza persona). */
    private val aboutCues = Regex(
        "\\b(film|marvel|iron man|ironman|tony stark|stark|avengers|ultron|fumett\\w*|serie|personaggi\\w*|attore|cinema|" +
            "si chiama|chiamat\\w*|chiamano|di jarvis|su jarvis|con jarvis|a jarvis|il jarvis|un jarvis|" +
            "questo jarvis|quel jarvis|tipo jarvis|come jarvis)\\b"
    )

    /** Vero se nella frase (anche parziale) compare la parola di attivazione. */
    fun containsWake(text: String): Boolean = wakeToken.containsMatchIn(normalize(text))

    /**
     * Decide se una frase è una chiamata a Jarvis.
     * - "Jarvis, quante calorie mi restano?" / "Ehi Jarvis" / "che ore sono Jarvis" → [Wake.Direct]
     * - "ieri ho visto il film dove c'è Jarvis" → [Wake.Ambiguous] (deciderà il contesto)
     */
    fun wake(raw: String): Wake {
        val norm = normalize(raw)
        val m = wakeToken.find(norm) ?: return Wake.None
        val before = norm.substring(0, m.range.first).trim()
        val after = norm.substring(m.range.last + 1).trim()
        val beforeWords = before.split(" ").filter { it.isNotBlank() }
        val about = aboutCues.containsMatchIn(norm)

        // Nome all'inizio (eventualmente dopo un saluto): chiamata diretta.
        if (beforeWords.size <= 3 && beforeWords.all { it in callWords }) {
            return if (about && after.isNotBlank()) Wake.Ambiguous(raw.trim(), true) else Wake.Direct(after)
        }
        // Nome alla fine di una frase breve: "che ore sono Jarvis".
        if (after.isBlank() && !about && beforeWords.size <= 12) return Wake.Direct(before)
        // Nome in mezzo al discorso.
        return Wake.Ambiguous(raw.trim(), about)
    }

    /** Rimuove markdown, link ed emoji prima della sintesi vocale. */
    fun cleanForSpeech(raw: String): String = raw
        .replace(Regex("(?i)https?://\\S+"), "")
        .replace(Regex("[*#_`~>|\\[\\]]"), " ")
        .replace(Regex("[\\p{So}\\p{Cn}\\p{Cs}]"), "")
        .replace(Regex("\\s+"), " ")
        .trim()
}
