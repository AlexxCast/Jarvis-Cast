package com.jarvisfit.app.voice

import android.content.Context
import android.media.AudioManager
import android.media.AudioRecordingConfiguration
import android.os.Handler
import android.os.SystemClock

/**
 * Sorveglia chi sta usando il microfono.
 *
 * Android avvisa ogni volta che un'app inizia o smette di registrare: quando un'altra app
 * (Gemini, un vocale su WhatsApp, una chiamata) prende il microfono, Jarvis deve smettere
 * subito di ascoltare e riprendere solo quando l'altra app ha finito.
 */
class MicGuard(context: Context, private val handler: Handler, private val onChange: () -> Unit) {

    private val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private var registered = false

    /** Quante registrazioni appartengono alla nostra sessione di riconoscimento (di norma 1). */
    private var ownConfigs = 1
    private var sessionStartedAt = 0L

    private val callback = object : AudioManager.AudioRecordingCallback() {
        override fun onRecordingConfigChanged(configs: MutableList<AudioRecordingConfiguration>?) {
            learnOwnConfigs()
            onChange()
        }
    }

    fun start() {
        if (registered) return
        registered = runCatching { am.registerAudioRecordingCallback(callback, handler) }.isSuccess
    }

    fun stop() {
        if (!registered) return
        runCatching { am.unregisterAudioRecordingCallback(callback) }
        registered = false
    }

    /** Da chiamare quando Jarvis accende il proprio riconoscimento vocale. */
    fun sessionStarted() {
        sessionStartedAt = SystemClock.elapsedRealtime()
        ownConfigs = 1
    }

    /** Nei primi istanti della sessione impara quante registrazioni apre il riconoscitore su questo telefono. */
    private fun learnOwnConfigs() {
        if (sessionStartedAt == 0L) return
        if (SystemClock.elapsedRealtime() - sessionStartedAt <= LEARN_WINDOW_MS) {
            ownConfigs = maxOf(ownConfigs, activeRecordings())
        }
    }

    /** Registrazioni attive in questo momento, esclusa la parola chiave di sistema ("Hey Google"). */
    fun activeRecordings(): Int = runCatching {
        am.activeRecordingConfigurations.count { it.clientAudioSource != AUDIO_SOURCE_HOTWORD }
    }.getOrDefault(0)

    /** Vero durante chiamate, videochiamate e squilli. */
    fun inCall(): Boolean = when (am.mode) {
        AudioManager.MODE_IN_CALL, AudioManager.MODE_IN_COMMUNICATION, AudioManager.MODE_RINGTONE -> true
        else -> false
    }

    /**
     * Vero se il microfono serve a qualcun altro.
     * [ownSessionActive]: Jarvis sta ascoltando in questo momento (le sue registrazioni non contano).
     */
    fun busyElsewhere(ownSessionActive: Boolean): Boolean {
        if (inCall()) return true
        val allowed = if (ownSessionActive) ownConfigs else 0
        return activeRecordings() > allowed
    }

    companion object {
        /** MediaRecorder.AudioSource.HOTWORD (costante di sistema non pubblica). */
        private const val AUDIO_SOURCE_HOTWORD = 1999
        private const val LEARN_WINDOW_MS = 1200L
    }
}
