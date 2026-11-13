package com.jarvisfit.app.voice

import android.app.Notification
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.lifecycleScope

import com.jarvisfit.app.JarvisApp
import com.jarvisfit.app.R
import com.jarvisfit.app.ai.Brain
import com.jarvisfit.app.data.Settings
import com.jarvisfit.app.data.Store
import com.jarvisfit.app.device.AppLauncher
import com.jarvisfit.app.net.Cloud
import com.jarvisfit.app.ui.MainActivity
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/** Stato condiviso con la UI. */
object JarvisState {
    enum class Status { OFF, WAITING, LISTENING, THINKING, SPEAKING, ERROR }
    val status = MutableStateFlow(Status.OFF)
    val partial = MutableStateFlow("")
    val error = MutableStateFlow("")
    val running: StateFlow<Status> get() = status
    /** Aumenta a ogni scambio vocale concluso: la web app lo usa per aggiornare lo schermo. */
    val exchanges = MutableStateFlow(0)
}

/**
 * Servizio in primo piano: ascolta la parola "Jarvis" con il riconoscimento vocale di Android,
 * manda la richiesta al cervello (server Jarvis, oppure Gemini diretto in modalità classica)
 * e legge la risposta. Conta anche i passi del giorno.
 *
 * Il microfono non è mai tenuto in ostaggio: [MicGuard] avvisa quando un'altra app inizia a
 * registrare (Gemini, vocali, chiamate) e il servizio si mette in pausa finché non ha finito.
 */
class JarvisService : LifecycleService(), SensorEventListener {

    companion object {
        const val ACTION_START = "start"
        const val ACTION_STOP = "stop"
        const val ACTION_LISTEN = "listen"     // ascolta subito, senza parola chiave
        private const val NOTIF_ID = 1
        private const val PHOTO_NOTIF_ID = 2
        private const val INBOX_POLL_MS = 5 * 60_000L

        fun start(ctx: Context) {
            Settings.listeningEnabled = true
            ctx.startForegroundService(Intent(ctx, JarvisService::class.java).setAction(ACTION_START))
        }
        fun stop(ctx: Context) {
            Settings.listeningEnabled = false
            ctx.startService(Intent(ctx, JarvisService::class.java).setAction(ACTION_STOP))
        }
        fun listenNow(ctx: Context) =
            ctx.startForegroundService(Intent(ctx, JarvisService::class.java).setAction(ACTION_LISTEN))
    }

    private val main = Handler(Looper.getMainLooper())
    private var recognizer: SpeechRecognizer? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var tone: ToneGenerator? = null
    private var foreground = false
    private var busy = false

    // Convivenza con le altre app che usano il microfono
    private val ticker = Handler(Looper.getMainLooper())
    private var guard: MicGuard? = null
    private var sessionActive = false   // il nostro riconoscitore è acceso
    private var yielded = false         // in pausa perché il microfono serve a un'altra app
    private var freeChecks = 0
    private var wakeHeard = false       // "Jarvis" comparso nei risultati parziali della sessione

    // ---------------------------------------------------------------- lifecycle

    override fun onCreate() {
        super.onCreate()
        Speaker.init(this)
        tone = runCatching { ToneGenerator(AudioManager.STREAM_MUSIC, 70) }.getOrNull()
        (getSystemService(SENSOR_SERVICE) as SensorManager).let { sm ->
            sm.getDefaultSensor(Sensor.TYPE_STEP_COUNTER)?.let {
                sm.registerListener(this, it, SensorManager.SENSOR_DELAY_NORMAL, 60_000_000)
            }
        }
        wakeLock = (getSystemService(POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "JarvisFit::listen").apply { setReferenceCounted(false) }
        guard = MicGuard(this, main) { onRecordingChanged() }.also { it.start() }
        ticker.postDelayed(inboxPoll, 20_000)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)
        when (intent?.action) {
            ACTION_STOP -> { shutdown(); return START_NOT_STICKY }
            else -> {
                ensureForeground()
                if (intent?.action == ACTION_LISTEN) {
                    // Richiesta esplicita dell'utente: esce dall'eventuale pausa e ascolta subito.
                    if (yielded) { yielded = false; main.removeCallbacks(resumeCheck) }
                    if (!busy) onWakeWord(beep = true) else Unit
                } else if (!busy && !yielded) {
                    startWakeWord()
                }
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        shutdown()
        (getSystemService(SENSOR_SERVICE) as SensorManager).unregisterListener(this)
        guard?.stop()
        ticker.removeCallbacksAndMessages(null)
        tone?.release()
        super.onDestroy()
    }

    private fun ensureForeground() {
        if (foreground) return
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R)
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0
        ServiceCompat.startForeground(this, NOTIF_ID, buildNotification("In ascolto di \"Jarvis\""), type)
        foreground = true
        wakeLock?.acquire()
    }

    private fun shutdown() {
        main.removeCallbacksAndMessages(null)
        runCatching { recognizer?.destroy() }
        recognizer = null
        sessionActive = false
        yielded = false
        busy = false
        Speaker.stop()
        if (wakeLock?.isHeld == true) wakeLock?.release()
        JarvisState.status.value = JarvisState.Status.OFF
        if (foreground) {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
            foreground = false
        }
        stopSelf()
    }

    private fun buildNotification(text: String): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val stop = PendingIntent.getService(this, 1, Intent(this, JarvisService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val talk = PendingIntent.getService(this, 2, Intent(this, JarvisService::class.java).setAction(ACTION_LISTEN),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        return NotificationCompat.Builder(this, JarvisApp.CH_LISTEN)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Jarvis Assistente")
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(0, "Parla ora", talk)
            .addAction(0, "Disattiva", stop)
            .build()
    }

    private fun updateNotification(text: String) {
        if (!foreground) return
        runCatching { NotificationManagerCompat.from(this).notify(NOTIF_ID, buildNotification(text)) }
    }

    // ---------------------------------------------------------------- microfono condiviso

    private fun guardEnabled() = Settings.micGuard && guard != null

    /** Android segnala che qualcuno ha iniziato o smesso di registrare. */
    private fun onRecordingChanged() {
        if (!guardEnabled() || yielded) return
        if (sessionActive && guard?.busyElsewhere(true) == true) yieldMic()
    }

    /** Rilascia subito il microfono e resta in pausa finché l'altra app non ha finito. */
    private fun yieldMic() {
        if (yielded) return
        yielded = true
        freeChecks = 0
        main.removeCallbacksAndMessages(null)
        stopSession(cancel = true)
        Speaker.stop()
        busy = false
        inConversationMode = false
        wakeHeard = false
        JarvisState.status.value = JarvisState.Status.WAITING
        JarvisState.partial.value = ""
        updateNotification("In pausa: il microfono è in uso da un'altra app")
        main.postDelayed(resumeCheck, 1500)
    }

    private val resumeCheck = object : Runnable {
        override fun run() {
            if (!yielded) return
            if (!Settings.listeningEnabled) { yielded = false; return }
            val g = guard
            if (g != null && g.busyElsewhere(false)) {
                freeChecks = 0
                main.postDelayed(this, 1500)
            } else if (++freeChecks < 2) {
                // Deve risultare libero per due controlli di fila, così non si riparte tra una frase e l'altra.
                main.postDelayed(this, 1200)
            } else {
                yielded = false
                freeChecks = 0
                startWakeWord()
            }
        }
    }

    /**
     * Prima di accendere il riconoscitore: se il microfono è occupato si va in pausa.
     * Ritorna true se si può procedere subito; altrimenti [retry] verrà richiamato (o si entra in pausa).
     */
    private fun micFreeOrYield(retry: () -> Unit): Boolean {
        val g = guard
        if (!guardEnabled() || g == null || !g.busyElsewhere(false)) return true
        // Può essere la coda della nostra sessione appena chiusa: ricontrolla tra un attimo.
        main.postDelayed({
            if (yielded) return@postDelayed
            if (g.busyElsewhere(false)) yieldMic() else retry()
        }, 450)
        return false
    }

    private fun beginSession(rec: SpeechRecognizer, intent: Intent) {
        sessionActive = true
        guard?.sessionStarted()
        rec.startListening(intent)
    }

    private fun stopSession(cancel: Boolean) {
        sessionActive = false
        runCatching { if (cancel) recognizer?.cancel() else recognizer?.stopListening() }
    }

    // ---------------------------------------------------------------- wake word

    private val googleRegex = Regex("\\b(ok google|hey google|ehi google|gemini|apri gemini)\\b", RegexOption.IGNORE_CASE)
    private var lastSpokenText: String = ""
    private var lastSpokenTime: Long = 0L

    private fun startWakeWord() {
        if (!Settings.listeningEnabled || busy || yielded) return
        if (Speaker.isSpeaking()) {
            restartWakeWordDelayed(500)
            return
        }
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            fail("Riconoscimento vocale non disponibile sul telefono.")
            return
        }

        busy = false
        JarvisState.status.value = JarvisState.Status.WAITING
        JarvisState.error.value = ""
        updateNotification("In ascolto di \"Jarvis\"")

        main.post {
            if (yielded || busy || !Settings.listeningEnabled) return@post
            if (Speaker.isSpeaking()) {
                restartWakeWordDelayed(500)
                return@post
            }
            // Se l'utente sta ascoltando musica o guardando video, non prendere l'audio focus
            val am = getSystemService(AUDIO_SERVICE) as? AudioManager
            if (am != null && am.isMusicActive) {
                restartWakeWordDelayed(3000)
                return@post
            }
            // Se un'altra app sta registrando o c'è una chiamata, non toccare il microfono
            if (!micFreeOrYield { startWakeWord() }) return@post

            try {
                wakeHeard = false
                val rec = recognizer ?: SpeechRecognizer.createSpeechRecognizer(this).also { recognizer = it }
                rec.setRecognitionListener(object : RecognitionListener {
                    override fun onReadyForSpeech(params: Bundle?) {}
                    override fun onBeginningOfSpeech() {}
                    override fun onRmsChanged(rmsdB: Float) {}
                    override fun onBufferReceived(buffer: ByteArray?) {}
                    override fun onEndOfSpeech() {}
                    override fun onEvent(eventType: Int, params: Bundle?) {}
                    override fun onPartialResults(partialResults: Bundle?) {
                        if (Speaker.isSpeaking() || busy || yielded) return
                        val text = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
                        if (text.isBlank()) return
                        JarvisState.partial.value = text
                        // Sentito "Jarvis": segnala che sta ascoltando, ma aspetta la frase COMPLETA
                        // (prima il comando veniva tagliato a metà sul risultato parziale).
                        if (!wakeHeard && VoiceText.containsWake(text)) {
                            wakeHeard = true
                            JarvisState.status.value = JarvisState.Status.LISTENING
                            updateNotification("Ti ascolto…")
                        }
                    }
                    override fun onResults(results: Bundle?) {
                        sessionActive = false
                        if (busy || yielded || Speaker.isSpeaking()) return
                        val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
                        handleHeard(text)
                    }
                    override fun onError(error: Int) {
                        sessionActive = false
                        if (busy || yielded) return
                        if (wakeHeard) {
                            // Ha chiamato Jarvis ma la frase non è arrivata intera: chiedi di ripetere il comando.
                            wakeHeard = false
                            onWakeWordDetected("")
                            return
                        }
                        when (error) {
                            SpeechRecognizer.ERROR_NO_MATCH,
                            SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> restartWakeWordDelayed(300)
                            else -> {
                                runCatching { recognizer?.destroy() }
                                recognizer = null
                                restartWakeWordDelayed(800)
                            }
                        }
                    }
                })

                val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE, "it-IT")
                    putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                }
                beginSession(rec, intent)
            } catch (e: Exception) {
                sessionActive = false
                restartWakeWordDelayed(1000)
            }
        }
    }

    /** Decide cosa fare di una frase completa sentita in attesa. */
    private fun handleHeard(text: String) {
        wakeHeard = false
        when (val w = VoiceText.wake(text)) {
            is VoiceText.Wake.Direct -> onWakeWordDetected(w.command)
            is VoiceText.Wake.Ambiguous -> {
                if (!Settings.cloudEnabled) {
                    // Modalità classica: senza un modello che giudichi il contesto, ignora solo i casi evidenti.
                    if (w.aboutJarvis) backToWaiting() else onWakeWordDetected(w.text)
                    return
                }
                // "Jarvis" in mezzo a un discorso: chiedi al server se l'utente si rivolge davvero a lui.
                busy = true
                JarvisState.status.value = JarvisState.Status.THINKING
                lifecycleScope.launch {
                    val yes = Cloud.addressed(w.text) ?: !w.aboutJarvis
                    busy = false
                    if (yielded) return@launch
                    if (yes) onWakeWordDetected(w.text) else backToWaiting()
                }
            }
            VoiceText.Wake.None -> {
                if (googleRegex.containsMatchIn(text)) onGoogleDetected() else restartWakeWordDelayed(250)
            }
        }
    }

    private fun restartWakeWordDelayed(delayMs: Long) {
        if (!busy && !yielded && Settings.listeningEnabled) {
            main.postDelayed({
                if (!busy && !yielded && Settings.listeningEnabled && !Speaker.isSpeaking()) startWakeWord()
                else if (!busy && !yielded && Settings.listeningEnabled && Speaker.isSpeaking()) restartWakeWordDelayed(delayMs)
            }, delayMs)
        }
    }

    private fun fail(msg: String) {
        JarvisState.error.value = msg
        JarvisState.status.value = JarvisState.Status.ERROR
        updateNotification(msg)
    }

    private var inConversationMode = false
    private var lastConversationActivityTime = 0L
    private val CONVERSATION_TIMEOUT_MS = 90_000L // 1 minuto e mezzo

    private fun onGoogleDetected() {
        if (busy) return
        busy = true
        // Ferma il nostro ascolto e rilascia immediatamente il microfono per Google / Gemini
        stopSession(cancel = true)
        JarvisState.status.value = JarvisState.Status.WAITING
        updateNotification("Avvio Assistente Google / Gemini…")

        // Invia l'Intent di sistema ufficiale per invocare Google Assistant / Gemini
        runCatching {
            val assistantIntent = Intent(Intent.ACTION_VOICE_COMMAND).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            startActivity(assistantIntent)
        }.onFailure {
            runCatching {
                val voiceSearchIntent = Intent(RecognizerIntent.ACTION_WEB_SEARCH).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                startActivity(voiceSearchIntent)
            }
        }

        // Lascia il microfono all'assistente: si riparte solo quando ha finito di ascoltare
        // (almeno 6 secondi, poi finché il microfono non risulta libero).
        main.postDelayed({
            busy = false
            if (!Settings.listeningEnabled) return@postDelayed
            if (guardEnabled()) {
                yielded = true
                freeChecks = 0
                updateNotification("In pausa: il microfono è in uso da un'altra app")
                main.post(resumeCheck)
            } else {
                startWakeWord()
            }
        }, 6_000)
    }

    private fun onWakeWordDetected(remainingCommand: String) {
        if (busy) return
        // Ferma immediatamente qualsiasi discorso del TTS per non ascoltare se stesso
        Speaker.stop()
        busy = true
        inConversationMode = true
        lastConversationActivityTime = System.currentTimeMillis()

        // 1. Risveglia lo schermo del telefono se spento
        runCatching {
            val pm = getSystemService(POWER_SERVICE) as PowerManager
            @Suppress("DEPRECATION")
            val screenLock = pm.newWakeLock(
                PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP,
                "JarvisFit::wakeScreen"
            )
            // Si rilascia da solo allo scadere: rilasciarlo subito non lasciava il tempo di accendere lo schermo.
            screenLock.acquire(4000)
        }

        // 2. Apri l'app sul telefono
        val openIntent = Intent(this, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }
        startActivity(openIntent)

        // 3. Suono di conferma (beep)
        tone?.startTone(ToneGenerator.TONE_PROP_BEEP, 150)

        // 4. Se ha già detto il comando (es. "Jarvis cosa mangio?"), elabora subito; altrimenti ascolta la richiesta
        if (remainingCommand.isNotBlank()) {
            main.postDelayed({ process(remainingCommand) }, 300)
        } else {
            main.postDelayed({ listenForCommand() }, 300)
        }
    }

    fun onWakeWord(beep: Boolean) {
        onWakeWordDetected("")
    }

    // ---------------------------------------------------------------- speech to text

    private fun listenForCommand() {
        if (Speaker.isSpeaking()) {
            // Se Jarvis sta ancora parlando, aspetta che finisca completamente prima di aprire il microfono!
            main.postDelayed({ listenForCommand() }, 250)
            return
        }

        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            fail("Riconoscimento vocale non disponibile: installa/aggiorna l'app Google.")
            busy = false
            return
        }
        if (yielded) return
        if (!micFreeOrYield { listenForCommand() }) return
        busy = true
        JarvisState.status.value = JarvisState.Status.LISTENING
        JarvisState.partial.value = ""
        updateNotification(if (inConversationMode) "Conversazione aperta (ti ascolto)…" else "Ti ascolto…")

        val rec = recognizer ?: SpeechRecognizer.createSpeechRecognizer(this).also { recognizer = it }
        rec.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) {}
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onEvent(eventType: Int, params: Bundle?) {}
            override fun onPartialResults(partialResults: Bundle?) {
                if (Speaker.isSpeaking()) return
                val text = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
                if (text.isNotBlank() && !isSelfSpeechEcho(text)) {
                    JarvisState.partial.value = text
                }
            }
            override fun onResults(results: Bundle?) {
                sessionActive = false
                if (yielded) return
                if (Speaker.isSpeaking()) {
                    handleSilence()
                    return
                }
                val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
                if (text.isNotBlank()) {
                    if (isSelfSpeechEcho(text)) {
                        android.util.Log.w("JarvisService", "Rilevata eco della voce di Jarvis, messaggio scartato: '$text'")
                        handleSilence()
                        return
                    }
                    lastConversationActivityTime = System.currentTimeMillis()
                    process(text)
                } else {
                    handleSilence()
                }
            }
            override fun onError(error: Int) {
                sessionActive = false
                if (yielded) return
                when (error) {
                    SpeechRecognizer.ERROR_NO_MATCH,
                    SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> handleSilence()
                    else -> {
                        JarvisState.error.value = "Errore riconoscimento ($error)"
                        handleSilence()
                    }
                }
            }
        })

        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, "it-IT")
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 2500L)
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 2500L)
        }
        beginSession(rec, intent)
    }

    /**
     * Riconosce e scarta automaticamente quando il microfono cattura la fine della frase
     * letta dagli altoparlanti da Jarvis stesso, impedendogli di rispondere al proprio messaggio.
     */
    private fun isSelfSpeechEcho(recognizedText: String): Boolean {
        return VoiceText.isSelfEcho(
            recognized = recognizedText,
            lastSpoken = lastSpokenText,
            msSinceSpoken = System.currentTimeMillis() - lastSpokenTime
        )
    }

    private fun handleSilence() {
        if (yielded) return
        if (inConversationMode) {
            val elapsed = System.currentTimeMillis() - lastConversationActivityTime
            if (elapsed > CONVERSATION_TIMEOUT_MS) {
                // Timeout di 1 minuto e mezzo superato: chiudi la conversazione
                inConversationMode = false
                busy = false
                Speaker.speak("Nessuna risposta da oltre un minuto e mezzo. Torno in stand-by, signore.") {
                    main.post { backToWaiting() }
                }
            } else {
                // Ancora dentro i 90 secondi: continua ad ascoltare l'utente
                busy = false
                main.postDelayed({
                    if (inConversationMode && Settings.listeningEnabled && !busy) {
                        listenForCommand()
                    }
                }, 400)
            }
        } else {
            backToWaiting()
        }
    }

    private fun backToWaiting() {
        busy = false
        inConversationMode = false
        if (yielded) return
        main.postDelayed({ if (Settings.listeningEnabled && !yielded) startWakeWord() }, 300)
    }

    // ---------------------------------------------------------------- brain

    private fun process(text: String) {
        if (VoiceText.isCancelPhrase(text.trim())) {
            inConversationMode = false
            Speaker.speak("Ai suoi ordini, signore. Resto a disposizione.") {
                main.post { backToWaiting() }
            }
            return
        }

        JarvisState.status.value = JarvisState.Status.THINKING
        updateNotification("Sto pensando…")
        stopSession(cancel = false)

        lifecycleScope.launch {
            val cloud = Settings.cloudEnabled
            val reply = if (cloud) Cloud.chat(text) else Brain.handle(text)
            JarvisState.exchanges.value = JarvisState.exchanges.value + 1
            if (reply.photoRequest != null) notifyPhotoRequest(reply.photoRequest)
            // "Apri Spotify": a schermo spento o con Jarvis in secondo piano Android può rifiutare l'avvio.
            for ((type, value) in reply.device) {
                when (type) {
                    "open_app" -> AppLauncher.open(this@JarvisService, value)
                    "open_url" -> AppLauncher.openUrl(this@JarvisService, value)
                }
            }
            
            // Pop-up notifica a schermo con i soli dati schematici (es. macro, kcal, ricetta e dosi), NON il discorso parlato!
            val popupText = reply.cardInfo ?: run {
                val activeRecipe = if (cloud) null else Store.diary.activeRecipeSession
                if (activeRecipe != null) {
                    "🍳 ${activeRecipe.title}\n${activeRecipe.currentStep.ifBlank { activeRecipe.ingredientsNeeded }}"
                } else null
            }
            if (!popupText.isNullOrBlank()) {
                notifyInfoPopup(popupText)
            }

            if (yielded) {
                // Nel frattempo un'altra app ha preso il microfono: niente voce sopra il suo audio,
                // la risposta resta leggibile nella notifica.
                if (popupText.isNullOrBlank()) notifyInfoPopup(reply.text)
                return@launch
            }

            JarvisState.status.value = JarvisState.Status.SPEAKING
            updateNotification(reply.text.take(80))
            lastSpokenText = reply.text
            lastSpokenTime = System.currentTimeMillis()

            val after = {
                main.post {
                    if (yielded) return@post
                    if (inConversationMode && reply.expectReply && reply.photoRequest == null) {
                        busy = false
                        lastConversationActivityTime = System.currentTimeMillis()
                        tone?.startTone(ToneGenerator.TONE_PROP_BEEP, 100)
                        // Continua la conversazione ascoltando senza dover ridire "Jarvis"
                        listenForCommand()
                    } else {
                        inConversationMode = false
                        backToWaiting()
                    }
                }
                Unit
            }
            if (Settings.speakReplies) Speaker.speak(reply.text, after) else after()
        }
    }

    private fun notifyInfoPopup(infoText: String, notificationId: Int = 10) {
        val openIntent = Intent(this, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }
        val pi = PendingIntent.getActivity(this, 10, openIntent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val notif = NotificationCompat.Builder(this, JarvisApp.CH_POPUP)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Jarvis Assistente • Dati")
            .setContentText(infoText.lines().firstOrNull() ?: infoText)
            .setStyle(NotificationCompat.BigTextStyle().bigText(infoText))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .setAutoCancel(true)
            .setContentIntent(pi)
            .build()
        runCatching { NotificationManagerCompat.from(this).notify(notificationId, notif) }
    }

    private fun notifyPhotoRequest(reason: String) {
        val i = Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(MainActivity.EXTRA_TAKE_PHOTO, true)
        val pi = PendingIntent.getActivity(this, 3, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val n = NotificationCompat.Builder(this, JarvisApp.CH_PHOTO)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Jarvis vuole una foto")
            .setContentText(reason)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(pi)
            .addAction(0, "Scatta foto", pi)
            .build()
        runCatching { NotificationManagerCompat.from(this).notify(PHOTO_NOTIF_ID, n) }
    }

    // ---------------------------------------------------------------- avvisi dal server

    /** Ogni pochi minuti chiede al server promemoria scaduti e compiti completati. */
    private val inboxPoll = object : Runnable {
        override fun run() {
            if (Settings.cloudEnabled) {
                lifecycleScope.launch {
                    val items = Cloud.consumeInbox()
                    items.forEachIndexed { i, text ->
                        notifyInfoPopup(text, 20 + i)
                    }
                    val first = items.firstOrNull()
                    val micFree = guard?.busyElsewhere(sessionActive) != true
                    if (first != null && Settings.speakReplies && !busy && !yielded && micFree) {
                        lastSpokenText = first
                        lastSpokenTime = System.currentTimeMillis()
                        Speaker.speak(first)
                    }
                }
            }
            ticker.postDelayed(this, INBOX_POLL_MS)
        }
    }

    // ---------------------------------------------------------------- contapassi

    private var lastSavedSteps = -1
    private var lastSaveTime = 0L

    override fun onSensorChanged(event: SensorEvent) {
        val raw = event.values[0]
        val today = Store.today()
        val stored = Store.diary.steps[today] ?: 0
        when {
            Settings.stepBaseDate != today || Settings.stepBaseValue < 0 -> {
                // nuovo giorno: i passi dall'ultima lettura in poi contano per oggi
                val last = Settings.stepLastRaw
                Settings.stepBaseValue = if (last in 0f..raw) last else raw
                Settings.stepBaseDate = today
            }
            raw < Settings.stepLastRaw -> Settings.stepBaseValue = raw - stored   // telefono riavviato
        }
        Settings.stepLastRaw = raw
        val steps = (raw - Settings.stepBaseValue).toInt().coerceAtLeast(0)
        val now = System.currentTimeMillis()
        if (steps != lastSavedSteps && (steps - lastSavedSteps >= 50 || now - lastSaveTime > 120_000)) {
            Store.setSteps(today, steps)
            lastSavedSteps = steps
            lastSaveTime = now
            if (Settings.cloudEnabled) lifecycleScope.launch { Cloud.sendSteps(today, steps) }
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
}
