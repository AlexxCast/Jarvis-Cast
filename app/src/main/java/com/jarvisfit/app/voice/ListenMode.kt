package com.jarvisfit.app.voice

import android.content.Intent
import android.os.Build
import android.speech.RecognizerIntent

/**
 * Come ascoltare la prossima richiesta. Di solito in italiano; durante una lezione di inglese il server
 * chiede l'inglese (con l'italiano di riserva per i comandi) e pause più lunghe, perché chi parla una lingua
 * che sta imparando si ferma a pensare e il vocale veniva tagliato dopo 1,4 secondi.
 * Lo aggiorna ogni risposta del server; il nome "Kestra" si ascolta sempre in italiano.
 */
object ListenMode {
    @Volatile var lang: String = "it-IT"; private set
    @Volatile var alt: String = ""; private set
    @Volatile var silenceMs: Long = 0L; private set

    fun update(newLang: String, newAlt: String, newSilenceMs: Long) {
        lang = if (Regex("^[a-z]{2}-[A-Z]{2}$").matches(newLang)) newLang else "it-IT"
        alt = if (Regex("^[a-z]{2}-[A-Z]{2}$").matches(newAlt) && newAlt != lang) newAlt else ""
        silenceMs = newSilenceMs.coerceIn(0L, 8_000L)
    }

    val isForeign: Boolean get() = lang != "it-IT"

    /** Lingua e pause sull'intent del riconoscitore per la richiesta (non per il nome). */
    fun apply(intent: Intent, defaultSilenceMs: Long, defaultPossiblyMs: Long) {
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang)
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, lang)
        val silence = if (silenceMs > 0) silenceMs else defaultSilenceMs
        intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, silence)
        intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, if (silenceMs > 0) silenceMs - 500 else defaultPossiblyMs)
        if (silenceMs > 0) intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS, 4_000L)
        // Android 14+: il riconoscitore può passare all'italiano se il Capo dà un comando ("esci dal progetto").
        if (alt.isNotEmpty() && Build.VERSION.SDK_INT >= 34) {
            intent.putExtra(RecognizerIntent.EXTRA_ENABLE_LANGUAGE_SWITCH, RecognizerIntent.LANGUAGE_SWITCH_BALANCED)
            intent.putStringArrayListExtra(RecognizerIntent.EXTRA_LANGUAGE_SWITCH_ALLOWED_LANGUAGES, arrayListOf(lang, alt))
        }
    }
}
