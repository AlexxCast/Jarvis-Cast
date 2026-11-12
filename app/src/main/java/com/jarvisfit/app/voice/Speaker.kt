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
                // Pitch leggermente più profondo e cadenza calibrata in stile Jarvis
                tts?.setPitch(0.88f)
                tts?.setSpeechRate(1.02f)

                // Voce maschile italiana, se installata
                runCatching {
                    val italianVoices = (tts?.voices ?: emptySet()).filter { it.locale.language == "it" && !it.isNetworkConnectionRequired }
                    val maleVoice = italianVoices.firstOrNull { v ->
                        val n = v.name.lowercase()
                        (n.contains("male") || n.contains("-itd-") || n.contains("-ita-")) && !n.contains("female")
                    } ?: italianVoices.firstOrNull { !it.name.lowercase().contains("female") }
                    if (maleVoice != null) tts?.voice = maleVoice
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
        val id = "u" + System.nanoTime()
        if (onDone != null) callbacks[id] = onDone
        activelySpeaking = true
        val result = engine.speak(cleaned, TextToSpeech.QUEUE_FLUSH, Bundle(), id)
        if (result == TextToSpeech.ERROR) {
            activelySpeaking = false
            callbacks.remove(id)?.invoke()
            return
        }
        // Watchdog: se il motore non notifica mai la fine, sblocca comunque il flusso
        val maxMs = (3_000L + cleaned.length * 110L).coerceAtMost(90_000L)
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
