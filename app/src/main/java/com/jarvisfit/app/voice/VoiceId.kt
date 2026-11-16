package com.jarvisfit.app.voice

import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.PowerManager
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import com.jarvisfit.app.data.Settings
import java.text.Normalizer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.resume

/**
 * Autorizzazione tramite parola d'ordine ("niente più fili") per le azioni sul telefono.
 * Niente più conferme intermedie: una volta detta la parola d'ordine, Jarvis esegue l'attività fino in fondo.
 */
object VoiceId {
    const val PHRASE = "niente più fili"
    /** Dopo un'autorizzazione riuscita non richiede la parola d'ordine per 15 minuti. */
    private const val TRUST_MS = 15 * 60_000L

    @Volatile private var trustedUntil = 0L
    @Volatile var enrolling = false
        private set

    /** True se c'è una parola d'ordine attiva (predefinita: "niente più fili"). */
    val enrolled: Boolean get() = Settings.phonePassword.isNotBlank()

    fun isTrusted(): Boolean = System.currentTimeMillis() <= trustedUntil

    fun trustNow() {
        trustedUntil = System.currentTimeMillis() + TRUST_MS
    }

    /** Rileva se lo schermo del telefono è spento oppure bloccato dal keyguard. */
    fun isScreenOffOrLocked(ctx: Context): Boolean {
        val pm = ctx.getSystemService(Context.POWER_SERVICE) as? PowerManager
        val km = ctx.getSystemService(KeyguardManager::class.java)
        return (pm?.isInteractive == false) || (km?.isKeyguardLocked == true) || (km?.isDeviceLocked == true)
    }

    /**
     * Serve chiedere la parola d'ordine adesso?
     * Se il blocco è attivo e non siamo già autorizzati negli ultimi 15 minuti.
     */
    fun needed(ctx: Context? = null, wasScreenOff: Boolean = false): Boolean {
        return Settings.voiceLock && enrolled && !isTrusted()
    }

    fun forget() {
        Settings.phonePassword = PHRASE
        Settings.voiceModel = ""
        Settings.voiceLock = false
        trustedUntil = 0L
    }

    private val NUMBER_WORDS = mapOf(
        "zero" to "0", "uno" to "1", "una" to "1", "un" to "1",
        "due" to "2", "tre" to "3", "quattro" to "4", "cinque" to "5",
        "sei" to "6", "sette" to "7", "otto" to "8", "nove" to "9", "dieci" to "10"
    )

    /** Normalizza testo, accenti ("più" -> "piu") e numeri dettati a voce per il confronto con la parola d'ordine. */
    fun normalizeForPassword(raw: String): String {
        val noAccents = Normalizer.normalize(raw.lowercase(), Normalizer.Form.NFD)
            .replace(Regex("\\p{InCombiningDiacriticalMarks}+"), "")
        val tokens = noAccents
            .replace(Regex("[^a-z0-9\\s]"), " ")
            .trim()
            .split(Regex("\\s+"))
            .filter { it.isNotBlank() }
        return tokens.joinToString("") { NUMBER_WORDS[it] ?: it }
    }

    /** Verifica se la frase pronunciata contiene o coincide con la parola d'ordine (es. "niente più fili"). */
    fun matchesPassword(heard: String, expected: String = Settings.phonePassword): Boolean {
        val exp = normalizeForPassword(expected)
        if (exp.isEmpty()) return true
        val normHeard = normalizeForPassword(heard)
        if (normHeard.isEmpty()) return false
        if (normHeard == exp || normHeard.contains(exp)) return true
        // Tolleranza per piccole imprecisioni del microfono su "niente più fili" (es. "niente piu fili", "niente fili")
        if (exp == "nientepiufili" && (normHeard.contains("nientepiufil") || normHeard.contains("nientefili") || normHeard.contains("piufili"))) {
            return true
        }
        return false
    }

    private suspend fun say(text: String) = suspendCancellableCoroutine<Unit> { c ->
        Speaker.speak(text) { if (c.isActive) c.resume(Unit) }
    }

    /** Ascolta una singola risposta vocale tramite SpeechRecognizer sul main thread. */
    private suspend fun listenOnce(ctx: Context): String? = withContext(Dispatchers.Main) {
        if (!SpeechRecognizer.isRecognitionAvailable(ctx)) return@withContext null
        withTimeoutOrNull(7500L) {
            suspendCancellableCoroutine { cont ->
                val rec = SpeechRecognizer.createSpeechRecognizer(ctx)
                var lastPartial = ""
                var finished = false
                fun finish(res: String?) {
                    if (finished) return
                    finished = true
                    runCatching { rec.destroy() }
                    if (cont.isActive) cont.resume(res)
                }
                rec.setRecognitionListener(object : RecognitionListener {
                    override fun onReadyForSpeech(params: Bundle?) {}
                    override fun onBeginningOfSpeech() {}
                    override fun onRmsChanged(rmsdB: Float) {}
                    override fun onBufferReceived(buffer: ByteArray?) {}
                    override fun onEndOfSpeech() {}
                    override fun onEvent(eventType: Int, params: Bundle?) {}
                    override fun onPartialResults(partialResults: Bundle?) {
                        val t = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
                        if (t.isNotBlank()) lastPartial = t
                    }
                    override fun onResults(results: Bundle?) {
                        val t = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
                        finish(t.ifBlank { lastPartial })
                    }
                    override fun onError(error: Int) {
                        finish(lastPartial.ifBlank { null })
                    }
                })
                val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE, "it-IT")
                    putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                }
                cont.invokeOnCancellation { runCatching { rec.destroy() } }
                runCatching { rec.startListening(intent) }.onFailure { finish(null) }
            }
        }
    }

    suspend fun enroll(ctx: Context, progress: (String) -> Unit): String? {
        progress("Parola d'ordine attiva: \"${Settings.phonePassword}\".")
        return null
    }

    /**
     * Chiede solo la parola d'ordine ("niente più fili") prima di eseguire attività sul telefono.
     * Se l'utente l'ha già pronunciata nel comando iniziale, procede subito senza chiedere nulla.
     */
    suspend fun gate(ctx: Context, wasScreenOff: Boolean = false, initialCommand: String = ""): Boolean {
        if (initialCommand.isNotBlank() && matchesPassword(initialCommand)) {
            trustNow()
            return true
        }
        if (!needed(ctx, wasScreenOff)) return true
        enrolling = true
        try {
            Speaker.init(ctx)
            repeat(2) { attempt ->
                say(if (attempt == 0) "Parola d'ordine?" else "Non ho capito. Ripeta la parola d'ordine.")
                delay(250)
                val spoken = listenOnce(ctx).orEmpty()
                if (spoken.isNotBlank() && matchesPassword(spoken)) {
                    trustNow()
                    return true
                }
            }
            say("Parola d'ordine non corretta, non procedo.")
            return false
        } finally {
            enrolling = false
        }
    }
}
