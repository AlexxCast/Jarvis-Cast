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
    private val selfSignatureRegex = Regex(
        "^(?:certamente capo|agli ordini capo|subito capo|colpo riuscito|ci penso io capo|certamente signore|subito signore|ricevuto signore|ottimo lavoro signore|ho avviato la riproduzione|" +
            "capo ho riscontrato|signore ho riscontrato|parola d ordine|apro joytify|riprendo subito|fatto capo|fatto signore|eseguo subito|" +
            "eccomi capo|eccomi signore|dimmi capo|sono qui capo|a tua disposizione|comandi capo|ti ascolto|" +
            "dica pure signore|pronta capo|sempre operativa|ai tuoi ordini|tutto orecchi)\\b"
    )

    fun isSelfEcho(recognized: String, lastSpoken: String, msSinceSpoken: Long, windowMs: Long = 15_000L): Boolean {
        val rec = normalize(recognized)
        if (selfSignatureRegex.containsMatchIn(rec)) return true
        if (lastSpoken.isBlank() || msSinceSpoken < 0 || msSinceSpoken > windowMs) return false
        val spoken = normalize(lastSpoken)
        val recWords = rec.split(" ").filter { it.length > 2 }
        if (recWords.size < 3) return false

        // Frammento contiguo della frase di Jarvis (≥ 4 parole)
        if (rec.split(" ").size >= 4 && spoken.contains(rec)) return true

        val spokenWords = spoken.split(" ").filter { it.length > 2 }.toSet()
        val ratio = recWords.count { it in spokenWords }.toDouble() / recWords.size
        return ratio >= 0.65
    }

    /**
     * Frasi che chiudono la conversazione. Devono costituire TUTTA la frase: "niente pasta oggi"
     * o "grazie, quante calorie mi restano?" non devono chiudere la sessione.
     */
    private val cancelRegex = Regex(
        "^(?:ok |okay |va bene |perfetto |tutto )?(?:basta(?: così)?|grazie(?: mille| tante| jarvis| giarvis)?|a posto(?: così)?|stop|annulla|chiudi|" +
            "lascia stare|arrivederci|ciao(?: jarvis| giarvis)?|ok basta|perfetto grazie|ho finito|finito|va bene così|può bastare|sono a posto|tutto chiaro)" +
            "(?: (?:così|jarvis|giarvis|grazie|ciao|signore))*$",
        RegexOption.IGNORE_CASE,
    )

    fun isCancelPhrase(text: String): Boolean = cancelRegex.matches(normalize(text))

    private val talkingToOthersRegex = Regex(
        "\\b(?:ragazzi|amore|mamma|papà|papa|tesoro|scusa un attimo|aspetta un secondo|stavo dicendo a|parlavo con|" +
            "passami|vieni qui|venite|senti un po|dimmi pure caro|dimmi cara)\\b",
        RegexOption.IGNORE_CASE,
    )

    /** Vero se l'utente ha chiaramente iniziato a parlare con altre persone nella stanza (senza nominare Jarvis). */
    fun isTalkingToOthers(text: String): Boolean {
        val norm = normalize(text)
        if (containsWake(norm, 0.85f)) return false
        return talkingToOthersRegex.containsMatchIn(norm)
    }

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

    /**
     * Il riconoscimento italiano scrive "Jarvis" in molti modi: detto a voce normale esce spesso
     * "giarvis", "jarvi", "garvis"... Tutte queste valgono già con la sensibilità media; il contesto
     * (nome all'inizio, alla fine o giudicato dal server) evita le false chiamate.
     */
    private val wakeToken = Regex("\\b(kestra|chestra|questra|cestra|khestra|keistra|kesra|kestre|kestro|estra|jarvis|jarvi|giarvis|jervis|gervis|jarvys|jarviss|jarbis|giarvi|garvis|charvis|jarvas|giarviz|jarviz|jarves|giarves|giarbis|jervi|giervis|harvis|giorvis|jarvees|ciarvis|sarvis|garbis|darvis|carvis|zarvis|iarvis|arvis|giardi|giarri|ciardi)\\b")
    /** Sensibilità alta: accetta anche come il riconoscimento vocale storpia spesso il nome detto a voce bassa o da lontano. */
    private val wakeTokenLoose = Regex("\\b(kestra|chestra|questra|cestra|khestra|keistra|kesra|kestre|kestro|estra|castra|destra|finestra|jarvis|jarvi|giarvis|jervis|gervis|jarvys|jarviss|jarbis|giarvi|garvis|charvis|jarvas|giarviz|jarviz|jarves|giarves|giarbis|jervi|giervis|harvis|giorvis|jarvees|travis|davis|chavis|service|servis|ciarvis|sarvis|harvey|garbis|darvis|carvis|zarvis|iarvis|arvis|giardi|giarri|ciardi|giar|jarv|giarv|sciarvis|cervi|servi|chavez)\\b")

    /** Parole che possono precedere il nome quando lo si chiama ("ehi Jarvis", "senti Jarvis"). */
    private val callWords = setOf(
        "ehi", "hey", "ei", "hei", "ciao", "ok", "okay", "senti", "ascolta", "scusa", "scusami",
        "allora", "oh", "dimmi", "per", "favore", "cortesia", "ora", "adesso", "dico", "sentimi",
        "buongiorno", "buonasera", "buonanotte", "grazie", "e", "ma", "dai",
    )

    /** Indizi che si sta parlando DI Jarvis (il personaggio dei film, o l'assistente in terza persona). */
    private val aboutCues = Regex(
        "\\b(film|marvel|iron man|ironman|tony stark|stark|avengers|ultron|fumett\\w*|serie|personaggi\\w*|attore|cinema|" +
            "si chiama|chiamat\\w*|chiamano|di jarvis|su jarvis|con jarvis|a jarvis|il jarvis|un jarvis|" +
            "questo jarvis|quel jarvis|tipo jarvis|come jarvis)\\b"
    )

    /** Vero se nella frase (anche parziale) compare la parola di attivazione. */
    fun containsWake(text: String, sensitivity: Float = 0.5f): Boolean =
        (if (sensitivity > 0.7f) wakeTokenLoose else wakeToken).containsMatchIn(normalize(text))

    /**
     * La frase finale ha perso il nome che i risultati parziali avevano sentito ("Jarvis accendi" →
     * "accendi"): è comunque una chiamata, con quello che resta come comando.
     */
    fun commandAfterLostWake(finalText: String): String = normalize(finalText).let { t ->
        val m = wakeTokenLoose.find(t)
        if (m != null) t.substring(m.range.last + 1).trim() else t
    }

    /**
     * Decide se una frase è una chiamata a Jarvis.
     * - "Jarvis, quante calorie mi restano?" / "Ehi Jarvis" / "che ore sono Jarvis" → [Wake.Direct]
     * - "ieri ho visto il film dove c'è Jarvis" → [Wake.Ambiguous] (deciderà il contesto)
     */
    fun wake(raw: String, sensitivity: Float = 0.5f): Wake {
        val norm = normalize(raw)
        val m = (if (sensitivity > 0.7f) wakeTokenLoose else wakeToken).find(norm) ?: return Wake.None
        val before = norm.substring(0, m.range.first).trim()
        val after = norm.substring(m.range.last + 1).trim()
        val beforeWords = before.split(" ").filter { it.isNotBlank() }
        val about = aboutCues.containsMatchIn(norm)

        // Nome all'inizio (eventualmente dopo un saluto): chiamata diretta.
        if (beforeWords.size <= 3 && beforeWords.all { it in callWords }) {
            return if (about && after.isNotBlank()) Wake.Ambiguous(raw.trim(), true) else Wake.Direct(after)
        }
        // Sensibilità bassa: risponde solo se il nome è all'inizio.
        if (sensitivity < 0.35f) return Wake.None
        // Nome alla fine di una frase breve: "che ore sono Jarvis".
        if (after.isBlank() && !about && beforeWords.size <= 12) return Wake.Direct(before)
        // Sensibilità alta: il nome in mezzo alla frase basta, se non si parla dei film.
        if (sensitivity > 0.7f && !about) return Wake.Direct("$before $after".trim())
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
