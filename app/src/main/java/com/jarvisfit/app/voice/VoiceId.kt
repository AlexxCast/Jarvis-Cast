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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.resume

/**
 * Autorizzazione tramite password per le azioni sul telefono (aprire app, usare app, telefonare).
 * Viene richiesta SOLO quando il telefono è a schermo spento o bloccato.
 * A schermo acceso e sbloccato Jarvis esegue subito senza chiedere nulla.
 */
object VoiceId {
    const val PHRASE = "Password vocale"
    /** Dopo un'autorizzazione riuscita non richiede la password per 10 minuti. */
    private const val TRUST_MS = 10 * 60_000L

    @Volatile private var trustedUntil = 0L
    @Volatile var enrolling = false
        private set

    /** True se l'utente ha impostato una password sul telefono. */
    val enrolled: Boolean get() = Settings.phonePassword.isNotBlank()

    fun isTrusted(): Boolean = System.currentTimeMillis() <= trustedUntil

    fun trustNow() {
        trustedUntil = System.currentTimeMillis() + TRUST_MS
    }

    /** Rileva se in questo istante lo schermo del telefono è spento oppure bloccato dal keyguard. */
    fun isScreenOffOrLocked(ctx: Context): Boolean {
        val pm = ctx.getSystemService(Context.POWER_SERVICE) as? PowerManager
        val km = ctx.getSystemService(KeyguardManager::class.java)
        return (pm?.isInteractive == false) || (km?.isKeyguardLocked == true) || (km?.isDeviceLocked == true)
    }

    /**
     * Serve chiedere la password adesso?
     * Solo se il telefono era a schermo spento o bloccato ([wasScreenOff] o [isScreenOffOrLocked]),
     * l'utente ha attivato il blocco e impostato una password, e non è già stato autorizzato di recente.
     */
    fun needed(ctx: Context? = null, wasScreenOff: Boolean = false): Boolean {
        val screenOffOrLocked = wasScreenOff || (ctx != null && isScreenOffOrLocked(ctx))
        if (!screenOffOrLocked) return false
        return Settings.voiceLock && enrolled && !isTrusted()
    }

    fun forget() {
        Settings.phonePassword = ""
        Settings.voiceModel = ""
        Settings.voiceLock = false
        trustedUntil = 0L
    }

    private val NUMBER_WORDS = mapOf(
        "zero" to "0", "uno" to "1", "una" to "1", "un" to "1",
        "due" to "2", "tre" to "3", "quattro" to "4", "cinque" to "5",
        "sei" to "6", "sette" to "7", "otto" to "8", "nove" to "9", "dieci" to "10"
    )

    /** Normalizza testo o numeri dettati a voce (es. "uno due tre quattro" -> "1234") per il confronto con la password. */
    fun normalizeForPassword(raw: String): String {
        val tokens = raw.lowercase()
            .replace(Regex("[^a-z0-9àèéìòù\\s]"), " ")
            .trim()
            .split(Regex("\\s+"))
            .filter { it.isNotBlank() }
        return tokens.joinToString("") { NUMBER_WORDS[it] ?: it }
    }

    /** Verifica se la frase pronunciata contiene o coincide con la password impostata. */
    fun matchesPassword(heard: String, expected: String = Settings.phonePassword): Boolean {
        val exp = normalizeForPassword(expected)
        if (exp.isEmpty()) return true
        val normHeard = normalizeForPassword(heard)
        if (normHeard.isEmpty()) return false
        return normHeard == exp || normHeard.contains(exp)
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

    /** Compatibilità con eventuale chiamata legacy da interfaccia. */
    suspend fun enroll(ctx: Context, progress: (String) -> Unit): String? {
        progress("Imposta la password direttamente dal campo di testo nelle Impostazioni.")
        return null
    }

    /**
     * Se il telefono era a schermo spento o bloccato, chiede la password prima di eseguire azioni sul telefono.
     * Se l'utente ha già pronunciato la password nel comando iniziale, autorizza subito senza chiedere.
     */
    suspend fun gate(ctx: Context, wasScreenOff: Boolean = false, initialCommand: String = ""): Boolean {
        if (!needed(ctx, wasScreenOff)) return true
        if (initialCommand.isNotBlank() && matchesPassword(initialCommand)) {
            trustNow()
            return true
        }
        Speaker.init(ctx)
        repeat(2) { attempt ->
            say(if (attempt == 0) "Telefono spento o bloccato: dica la password per autorizzare." else "Password non riconosciuta, ripeta la password.")
            delay(250)
            val spoken = listenOnce(ctx).orEmpty()
            if (spoken.isNotBlank() && matchesPassword(spoken)) {
                trustNow()
                return true
            }
        }
        say("Password non corretta, non procedo.")
        return false
    }
}
