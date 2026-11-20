package com.jarvisfit.app.device

/**
 * Logica pura della "modalità Claude" (nessuna dipendenza Android → testabile su JVM).
 *
 * Kestra fa da ponte vocale con l'app ufficiale di Claude, dove la voce non funziona dentro i progetti:
 * legge ad alta voce le risposte nuove e scrive nella chat ciò che Alessio detta.
 * Non conosciamo gli id interni dell'app di Claude (e possono cambiare a ogni aggiornamento), quindi tutto
 * si basa su ciò che si vede: blocchi di testo nella lista della conversazione, in ordine.
 */
object ClaudeChat {
    const val PACKAGE = "com.anthropic.claude"

    /** Un blocco di testo della conversazione, nell'ordine dello schermo. */
    data class Block(val text: String, val clickable: Boolean = false)

    fun norm(s: String): String = s.lowercase()
        .replace(Regex("[*_`#>]"), "")
        .replace(Regex("\\s+"), " ")
        .trim()

    // Etichette dell'interfaccia di Claude (pulsanti, modelli, avvisi): mai da leggere come risposta.
    private val uiLabel = Regex(
        "^(?:copy|copia|retry|riprova|edit|modifica|share|condividi|stop|interrompi|send|invia|" +
            "claude|opus.*|sonnet.*|haiku.*|fable.*|thinking.*|thought for.*|pensando.*|ragionamento.*|" +
            "claude can make mistakes.*|claude può commettere errori.*|reply to claude.*|rispondi a claude.*|" +
            "good response|bad response|risposta buona|risposta non buona|read aloud|leggi ad alta voce|" +
            "\\d{1,2}[:.]\\d{2}(?: ?[ap]m)?|today|oggi|yesterday|ieri|new chat|nuova chat|project.*|progetto.*)$",
        RegexOption.IGNORE_CASE,
    )

    /** Vero se il blocco è testo di un messaggio e non un pulsante o un'etichetta. */
    fun isMessageText(b: Block): Boolean {
        val t = b.text.trim()
        if (t.length < 2) return false
        if (uiLabel.matches(norm(t))) return false
        // Un pulsante con poche parole e senza punteggiatura è quasi sempre un comando dell'interfaccia.
        if (b.clickable) {
            val words = t.split(Regex("\\s+")).size
            if (words <= 3 && !t.contains(Regex("[.!?,;:]"))) return false
        }
        return true
    }

    /** Vero se il testo di un pulsante indica che Claude sta ancora scrivendo (tasto per interrompere). */
    fun isStopButton(label: String): Boolean =
        norm(label).let { it.length <= 30 && Regex("^(?:stop|interrompi|ferma|annulla risposta)\\b").containsMatchIn(it) }

    /** Vero se il testo di un pulsante è il tasto per inviare il messaggio. */
    fun isSendButton(label: String): Boolean =
        norm(label).let { it.length <= 30 && Regex("^(?:send|invia|submit|manda)\\b").containsMatchIn(it) }

    private fun sameText(a: String, b: String): Boolean {
        val x = norm(a); val y = norm(b)
        if (x.isEmpty() || y.isEmpty()) return false
        if (x == y) return true
        // Il messaggio inviato può comparire con una parola corretta o un a capo diverso: basta una forte somiglianza.
        val short = if (x.length <= y.length) x else y
        val long = if (x.length <= y.length) y else x
        return short.length >= 12 && long.startsWith(short.take(maxOf(12, short.length * 4 / 5)))
    }

    /**
     * La risposta di Claude in corso, aggiornata con ciò che si vede adesso, oppure null se non ce n'è.
     *
     * - [seen]: blocchi già letti o già presenti quando è partita la modalità (mai riletti).
     * - [sent]: l'ultimo messaggio di Alessio: la risposta è ciò che viene DOPO di lui.
     * - [current]: i pezzi della risposta già raccolti. Servono quando la risposta è così lunga che il messaggio
     *   di Alessio è uscito dallo schermo (la lista di Claude non tiene più in memoria ciò che non si vede).
     *
     * Senza nessun punto fermo (chat cambiata, schermo scorso molto in alto) non si legge niente:
     * meglio tacere che rileggere una conversazione vecchia.
     */
    fun update(blocks: List<Block>, seen: Set<String>, sent: String?, current: List<String> = emptyList()): List<String>? {
        val msgs = blocks.filter { isMessageText(it) }.map { it.text.trim() }
        fun after(i: Int) = msgs.drop(i + 1).filter { norm(it) !in seen && (sent == null || !sameText(it, sent)) }
        if (!sent.isNullOrBlank()) {
            val i = msgs.indexOfLast { sameText(it, sent) }
            if (i >= 0) return after(i).ifEmpty { null }
        }
        // Il messaggio inviato non si vede più: ci si aggancia all'ultimo pezzo già raccolto (che intanto può essere cresciuto).
        for (k in current.indices.reversed()) {
            val known = norm(current[k])
            if (known.length < 2) continue
            val j = msgs.indexOfLast { norm(it).startsWith(known) }
            if (j >= 0) return current.take(k) + msgs.drop(j).filter { norm(it) !in seen }
        }
        val i = msgs.indexOfLast { norm(it) in seen }
        if (i >= 0) return after(i).ifEmpty { null }
        return null
    }

    /** I testi di messaggio visibili (per segnarli come già visti). */
    fun messages(blocks: List<Block>): List<String> = blocks.filter { isMessageText(it) }.map { it.text.trim() }

    /** Divide la risposta in pezzi per la voce (il motore vocale non legge testi troppo lunghi in un colpo). */
    fun chunks(parts: List<String>, max: Int = 1200): List<String> {
        val out = mutableListOf<String>()
        for (p in parts) {
            var rest = p.trim()
            while (rest.length > max) {
                val cut = rest.lastIndexOfAny(charArrayOf('.', '!', '?', '\n'), max).takeIf { it > max / 3 } ?: rest.lastIndexOf(' ', max).takeIf { it > 0 } ?: max
                out += rest.substring(0, cut + 1).trim()
                rest = rest.substring(cut + 1).trim()
            }
            if (rest.isNotEmpty()) out += rest
        }
        return out
    }

    // ---------------------------------------------------------------- comandi a voce

    private fun cmd(s: String) = s.lowercase().replace(Regex("[^a-z0-9àèéìòóù ]"), " ").replace(Regex("\\s+"), " ").trim()

    private val startRegex = Regex(
        "^(?:(?:ehi |ok |ciao )?(?:kestra|chestra) )?(?:attiva |avvia |apri |accendi |entra in |vai in |passa in |metti )?(?:la )?" +
            "(?:modalit[aà] claude|modalit[aà] cloud|claude mode|cloud mode|ponte (?:con|per) claude|leggimi claude|leggi claude|parla con claude|collegati a claude)" +
            "(?: (?:per favore|grazie|kestra))*$"
    )

    /** "Kestra, modalità Claude": accende il ponte (riconosciuto sul telefono, senza passare dal server). */
    fun isStartPhrase(text: String): Boolean = startRegex.matches(cmd(text))

    private val stopRegex = Regex(
        "^(?:ok |okay |grazie )?(?:basta|stop|esci|exit|quit|fine|ferma|chiudi|end|disattiva|spegni)" +
            "(?: (?:kestra|chestra|claude|cloud|modalit[aà] claude|modalit[aà] cloud|claude mode|cloud mode|the mode|mode|reading|leggere|grazie|thanks|please|now|così|cosi))*$"
    )

    /** "Basta", "stop", "esci dalla modalità Claude": chiude il ponte. Deve essere tutta la frase. */
    fun isStopPhrase(text: String): Boolean {
        val c = cmd(text).replace(Regex("\\b(?:dalla|della|la|from|the)\\b"), " ").replace(Regex("\\s+"), " ").trim()
        return stopRegex.matches(c)
    }

    private val repeatRegex = Regex(
        "^(?:ripeti|ripetilo|ripeti per favore|rileggi|rileggilo|repeat|repeat that|repeat please|repeat it|say it again|say that again|again please|read it again|one more time)$"
    )

    /** "Ripeti" / "repeat": rilegge l'ultima risposta. */
    fun isRepeatPhrase(text: String): Boolean = repeatRegex.matches(cmd(text))
}
