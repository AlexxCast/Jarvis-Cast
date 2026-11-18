package com.jarvisfit.app.voice

import android.content.Context
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

/**
 * Sintesi vocale italiana condivisa tra app e servizio.
 *
 * Garanzie:
 *  - [speak] chiama SEMPRE onDone, anche se il motore TTS non è disponibile o non notifica la fine
 *    (watchdog), così il servizio vocale non resta mai bloccato in stato "sto parlando".
 *  - onDone arriva solo dopo che l'audio è uscito davvero dallo speaker + 500 ms di cooldown
 *    acustico, così il microfono non riascolta la voce di Jarvis.
 */
object Speaker {
    private var tts: TextToSpeech? = null
    @Volatile private var ready = false
    @Volatile private var failed = false
    private val pending = mutableListOf<Pair<String, (() -> Unit)?>>()
    private val callbacks = ConcurrentHashMap<String, () -> Unit>()
    private val mainHandler by lazy { Handler(Looper.getMainLooper()) }

    @Volatile
    private var activelySpeaking = false

    /** Vero se il TTS sta sintetizzando o riproducendo audio (cooldown incluso). */
    fun isSpeaking(): Boolean = activelySpeaking || (tts?.isSpeaking == true)

    fun init(context: Context) {
        if (tts != null) return
        failed = false
        tts = TextToSpeech(context.applicationContext) { status ->
            if (status == TextToSpeech.SUCCESS) {
                val langOk = tts?.setLanguage(Locale.ITALIAN)
                if (langOk == TextToSpeech.LANG_MISSING_DATA || langOk == TextToSpeech.LANG_NOT_SUPPORTED) {
                    tts?.language = Locale.getDefault()
                }
                // Pitch naturale femminile per Kestra
                tts?.setPitch(1.02f)
                tts?.setSpeechRate(1.02f)

                // Voce femminile italiana più naturale disponibile
                runCatching {
                    val femVoice = tts?.let { pickFemaleVoice(it, Locale.ITALIAN) }
                    if (femVoice != null) tts?.voice = femVoice
                }

                tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                    override fun onStart(id: String) { activelySpeaking = true }
                    override fun onDone(id: String) { handleUtteranceFinished(id) }
                    @Deprecated("Deprecated in Java")
                    override fun onError(id: String) { handleUtteranceFinished(id) }
                    override fun onError(id: String?, errorCode: Int) { if (id != null) handleUtteranceFinished(id) }
                    override fun onStop(id: String?, interrupted: Boolean) { if (id != null) handleUtteranceFinished(id) }
                })
                ready = true
            } else {
                failed = true
            }
            // Svuota la coda: parla oppure, se il TTS non è disponibile, completa subito
            val queued = synchronized(pending) { pending.toList().also { pending.clear() } }
            queued.forEach { (t, cb) -> speak(t, cb) }
        }
    }

    /** Pulisce il testo per la sintesi vocale (markdown, link, emoji). */
    fun cleanTextForSpeech(raw: String): String = VoiceText.cleanForSpeech(raw)

    /** Attende la fine reale dell'audio, poi applica 500 ms di cooldown e invoca la callback. */
    private fun handleUtteranceFinished(id: String) {
        if (!callbacks.containsKey(id) && !activelySpeaking) return
        val checkRunnable = object : Runnable {
            var attempts = 0
            override fun run() {
                attempts++
                if (tts?.isSpeaking == true && attempts < 80) {
                    mainHandler.postDelayed(this, 50)
                } else {
                    mainHandler.postDelayed({
                        activelySpeaking = false
                        callbacks.remove(id)?.invoke()
                    }, 500)
                }
            }
        }
        mainHandler.post(checkRunnable)
    }

    private val ENGLISH_HINT = Regex(
        """\b(i'm|you're|we're|they're|it's|didn't|doesn't|don't|wasn't|weren't|won't|i'd|i've|can't|would|could|should|going\s+to|have\s+you|the|was|were|with|from|this|that|there|here|what|where|when|why|how|yesterday|tomorrow|last\s+week|please|sorry|hello|thanks|amazing|wallet|movie|weekend|question|walk)\b""",
        RegexOption.IGNORE_CASE,
    )
    private val ITALIAN_HINT = Regex(
        """\b(che|per|con|non|sono|hai|abbiamo|signore|esercizio|frase|regola|errore|ripeti|lezione|domani|stasera|oggi|bene|bravo|giusto|sbagliato|risposta|prova|adesso|ora|questo|questa|quello|quella|anche|perch[eé]|come|quando|dove|quindi|allora|molto|poco|tutto|tutti|mia|mio|tuo|tua|suo|sua|nel|nella|sul|sulla|dal|dalla|alla|degli|delle|pu[oò]|vuole|devo|fai|fatto)\b""",
        RegexOption.IGNORE_CASE,
    )

    private fun splitLanguageSegments(text: String): List<Pair<String, Locale>> {
        val rawParts = text.split(Regex("""(?<=[.!?;:\n])\s+|(?="[^"]+")|(?<=")\s+"""))
            .map { it.trim() }
            .filter { it.isNotEmpty() }
        val out = mutableListOf<Pair<String, Locale>>()
        for (part in rawParts) {
            val clean = part.replace("\"", "").trim()
            if (clean.isEmpty()) continue
            val enCount = ENGLISH_HINT.findAll(clean).count()
            val itCount = ITALIAN_HINT.findAll(clean).count()
            val locale = if (enCount >= 1 && enCount > itCount) Locale.US else Locale.ITALIAN
            if (out.isNotEmpty() && out.last().second == locale) {
                val prev = out.removeAt(out.lastIndex)
                out += (prev.first + " " + clean) to locale
            } else {
                out += clean to locale
            }
        }
        return if (out.isEmpty()) listOf(text to Locale.ITALIAN) else out
    }

    private fun pickFemaleVoice(engine: TextToSpeech, locale: Locale): android.speech.tts.Voice? {
        val lang = locale.language
        val candidates = runCatching {
            (engine.voices ?: emptySet()).filter { it.locale.language == lang }
        }.getOrDefault(emptyList())
        if (candidates.isEmpty()) return null
        val femaleHints = listOf("female", "#female", "-itc-", "-itb-", "-ita-", "-sfg-", "-tpf-", "elsa", "alice", "federica", "paola", "samantha", "jenny", "aria", "sara", "victoria")
        val maleHints = listOf("male", "#male", "-itd-", "-tpd-", "-iom-", "-iol-", "-rjs-", "cosimo", "luca", "diego", "david", "daniel", "george", "guy", "ryan")
        val naturalHints = listOf("wavenet", "neural", "natural", "studio", "hd", "journey")

        fun score(v: android.speech.tts.Voice): Int {
            val n = v.name.lowercase()
            if (maleHints.any { n.contains(it) } && !n.contains("female")) return -1000
            var s = v.quality
            if (femaleHints.any { n.contains(it) }) s += 300
            if (naturalHints.any { n.contains(it) }) s += 200
            if (!v.isNetworkConnectionRequired) s += 40
            if (v.locale.country.equals(locale.country, ignoreCase = true)) s += 30
            return s
        }
        return candidates.maxByOrNull { score(it) }
    }

    /** Parla e chiama [onDone] quando l'audio è terminato (garantito, anche in caso di errore). */
    fun speak(text: String, onDone: (() -> Unit)? = null) {
        val cleaned = cleanTextForSpeech(text)
        if (cleaned.isBlank() || failed) {
            activelySpeaking = false
            onDone?.invoke()
            return
        }
        val engine = tts
        if (engine == null || !ready) {
            synchronized(pending) { pending += cleaned to onDone }
            return
        }
        val segments = splitLanguageSegments(cleaned)
        val id = "u" + System.nanoTime()
        if (onDone != null) callbacks[id] = onDone
        activelySpeaking = true
        var ok = true
        for ((idx, pair) in segments.withIndex()) {
            val (segText, segLocale) = pair
            val isFirst = idx == 0
            val isLast = idx == segments.lastIndex
            runCatching {
                val femVoice = pickFemaleVoice(engine, segLocale)
                if (femVoice != null) engine.voice = femVoice else engine.language = segLocale
                engine.setPitch(1.02f)
                engine.setSpeechRate(if (segLocale == Locale.US) 0.94f else 1.0f)
            }
            val queueMode = if (isFirst) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD
            val uttId = if (isLast) id else "seg_${idx}_${System.nanoTime()}"
            val result = engine.speak(segText, queueMode, Bundle(), uttId)
            if (result == TextToSpeech.ERROR) {
                ok = false
                break
            }
        }
        if (!ok) {
            activelySpeaking = false
            callbacks.remove(id)?.invoke()
            return
        }
        // Watchdog: se il motore non notifica mai la fine, sblocca comunque il flusso
        val maxMs = (3_000L + cleaned.length * 120L).coerceAtMost(95_000L)
        mainHandler.postDelayed({
            if (callbacks.containsKey(id)) {
                activelySpeaking = false
                callbacks.remove(id)?.invoke()
            }
        }, maxMs)
    }

    /** Interrompe la voce. Le callback in sospeso vengono scartate (il chiamante gestisce il nuovo flusso). */
    fun stop() {
        activelySpeaking = false
        callbacks.clear()
        runCatching { tts?.stop() }
    }
}
