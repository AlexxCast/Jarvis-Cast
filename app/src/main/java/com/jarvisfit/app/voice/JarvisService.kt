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
import com.jarvisfit.app.device.Places
import com.jarvisfit.app.device.PhoneAgent
import com.jarvisfit.app.device.Overlay
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
    /** Avanzamento della registrazione della voce: "step|messaggio|n" oppure "done|errore|n". */
    val voiceEnroll = MutableStateFlow("")
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
        const val ACTION_ANSWER = "answer"     // ascolta la risposta a una domanda, senza portare Jarvis in primo piano
        private const val NOTIF_ID = 1
        private const val PHOTO_NOTIF_ID = 2
        private const val INBOX_POLL_MS = 90_000L // Timer interno di 1 minuto e mezzo per controllare attività, messaggi e stato

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
        /** Jarvis ha fatto una domanda mentre usava un'altra app: ascolta la risposta restando dov'è. */
        fun listenForAnswer(ctx: Context) {
            if (!Settings.listeningEnabled) return
            runCatching { ctx.startForegroundService(Intent(ctx, JarvisService::class.java).setAction(ACTION_ANSWER)) }
        }
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
    private var lastRecognizerActivityMs = System.currentTimeMillis()
    private var yieldedSinceMs = 0L
    private var busySinceMs = 0L
    private var wakeCycles = 0
    private var wakeHeard = false       // "Jarvis" comparso nei risultati parziali della sessione
    private var lastWakePartial = ""
    private var lastCommandPartial = ""
    private val wakeStopRunnable = Runnable {
        if (sessionActive && wakeHeard) runCatching { recognizer?.stopListening() }
    }
    private val commandStopRunnable = Runnable {
        if (sessionActive) runCatching { recognizer?.stopListening() }
    }

    // Anti-eco: qualunque voce di Kestra (servizio, app aperta, promemoria, agente del telefono) spegne il microfono.
    private var commandSession = false          // la sessione accesa è l'ascolto di un comando (non della parola chiave)
    private var pausedForSpeech: String? = null // "wake" | "command": cosa riaccendere quando la voce finisce
    private var ignoredFollowups = 0            // frasi della conversazione aperta giudicate non rivolte a Kestra
    private val speechListener: (Boolean) -> Unit = { speaking -> main.post { onSpeechState(speaking) } }

    private fun onSpeechState(speaking: Boolean) {
        if (speaking) {
            main.removeCallbacks(wakeStopRunnable)
            main.removeCallbacks(commandStopRunnable)
            if (sessionActive) {
                pausedForSpeech = if (commandSession) "command" else "wake"
                lastCommandPartial = ""
                lastWakePartial = ""
                wakeHeard = false
                stopSession(cancel = true)
            }
            return
        }
        val mode = pausedForSpeech ?: return
        pausedForSpeech = null
        if (yielded || !Settings.listeningEnabled) return
        main.postDelayed({
            if (sessionActive || Speaker.isSpeaking()) return@postDelayed
            if (mode == "command") listenForCommand() else if (!busy) startWakeWord()
        }, 250)
    }

    // ---------------------------------------------------------------- lifecycle

    override fun onCreate() {
        super.onCreate()
        Speaker.init(this)
        Speaker.addListener(speechListener)
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
        ticker.postDelayed(watchdogRunnable, 10_000)
        Places.register(this)
        // La sfera sopra le altre app segue lo stato dell'ascolto.
        lifecycleScope.launch { JarvisState.status.collect { Overlay.onStatus(this@JarvisService, it) } }
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
                } else if (intent?.action == ACTION_ANSWER) {
                    if (!busy && !yielded) { stopSession(cancel = true); onWakeWordDetected("", openApp = false) }
                } else if (!busy && !yielded) {
                    startWakeWord()
                }
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        Speaker.removeListener(speechListener)
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
        ServiceCompat.startForeground(this, NOTIF_ID, buildNotification("In ascolto di \"Kestra\""), type)
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
        if (yielded || VoiceId.enrolling) return
        yielded = true
        yieldedSinceMs = System.currentTimeMillis()
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

    private fun beginSession(rec: SpeechRecognizer, intent: Intent, command: Boolean = false) {
        if (Speaker.isSpeaking()) {
            // La voce è partita nel frattempo: si riaccende quando finisce.
            pausedForSpeech = if (command) "command" else "wake"
            return
        }
        commandSession = command
        sessionActive = true
        lastRecognizerActivityMs = System.currentTimeMillis()
        guard?.sessionStarted()
        rec.startListening(intent)
    }

    private fun stopSession(cancel: Boolean) {
        sessionActive = false
        guard?.sessionStopped()
        if (KestraKws.running) KestraKws.stop()
        runCatching { if (cancel) recognizer?.cancel() else recognizer?.stopListening() }
    }

    /**
     * Ascolto "forte" della parola Kestra (modello offline che cerca solo quel suono). Non prende il fuoco audio,
     * quindi ascolta anche con la musica accesa. Ritorna false se non è disponibile: si usa il riconoscitore di Android.
     */
    private fun startStrongWake(): Boolean {
        if (!Settings.strongWake) return false
        commandSession = false
        sessionActive = true
        lastRecognizerActivityMs = System.currentTimeMillis()
        guard?.sessionStarted()
        val ok = KestraKws.start(this, Settings.sensitivity,
            onWake = { main.post { onStrongWake() } },
            onError = { main.post { if (sessionActive && !busy) { sessionActive = false; guard?.sessionStopped(); restartWakeWordDelayed(800) } } },
        )
        if (!ok) { sessionActive = false; guard?.sessionStopped() }
        return ok
    }

    private fun onStrongWake() {
        if (busy || yielded) return
        sessionActive = false
        guard?.sessionStopped()
        JarvisState.partial.value = "Kestra"
        // Il microfono passa al riconoscimento della richiesta: niente saluto lungo, chi dice
        // "Kestra, che ore sono" tutto d'un fiato non deve aspettare.
        onWakeWordDetected("", quick = true)
    }

    /**
     * Watchdog anti-blocco: su Android lo SpeechRecognizer può talvolta restare appeso in silenzio
     * senza chiamare né onResults né onError, oppure restare in pausa per una sessione fantasma.
     * Ogni 10 secondi controlla che l'ascolto sia vivo e, se fermo da troppo, ricrea il riconoscitore e riparte.
     */
    private val watchdogRunnable = object : Runnable {
        override fun run() {
            try {
                if (Settings.listeningEnabled && !VoiceId.enrolling && !Speaker.isSpeaking()) {
                    val now = System.currentTimeMillis()
                    if (yielded && guard?.inCall() != true && now - yieldedSinceMs > 18_000L) {
                        yielded = false
                        freeChecks = 0
                        startWakeWord()
                    } else if (busy && now - maxOf(busySinceMs, lastConversationActivityTime) > CONVERSATION_TIMEOUT_MS + 10_000L) {
                        busy = false
                        inConversationMode = false
                        runCatching { recognizer?.destroy() }
                        recognizer = null
                        startWakeWord()
                    } else if (!busy && !yielded && now - (if (KestraKws.running) KestraKws.lastAliveMs else lastRecognizerActivityMs) > 15_000L) {
                        KestraKws.stop()
                        sessionActive = false
                        guard?.sessionStopped()
                        runCatching { recognizer?.destroy() }
                        recognizer = null
                        startWakeWord()
                    }
                }
            } catch (_: Exception) {}
            ticker.postDelayed(this, 10_000L)
        }
    }

    // ---------------------------------------------------------------- wake word

    private val googleRegex = Regex("\\b(ok google|hey google|ehi google|gemini|apri gemini)\\b", RegexOption.IGNORE_CASE)
    private var lastSpokenText: String = ""
    private var lastSpokenTime: Long = 0L

    private fun startWakeWord() {
        if (!Settings.listeningEnabled || busy || yielded) return
        if (VoiceId.enrolling) { restartWakeWordDelayed(1500); return } // il microfono serve alla registrazione della voce
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
        updateNotification("In ascolto di \"Kestra\"")

        main.post {
            if (yielded || busy || !Settings.listeningEnabled || sessionActive) return@post
            if (Speaker.isSpeaking()) {
                restartWakeWordDelayed(500)
                return@post
            }
            // Riconoscimento forte della parola: non disturba la musica e non dipende dal vocabolario.
            if (!PhoneAgent.running && KestraKws.ready(this)) {
                if (!micFreeOrYield { startWakeWord() }) return@post
                if (startStrongWake()) return@post
            }
            // Mentre un'app musicale (es. Joytify) riproduce musica o PhoneAgent sta lavorando,
            // non avviare continuamente lo SpeechRecognizer altrimenti Android ruba l'audio focus e mette in pausa la musica!
            val am = getSystemService(AUDIO_SERVICE) as? AudioManager
            if ((am != null && am.isMusicActive) || PhoneAgent.running) {
                restartWakeWordDelayed(3500)
                return@post
            }
            // Se un'altra app sta registrando o c'è una chiamata, non toccare il microfono
            if (!micFreeOrYield { startWakeWord() }) return@post

            try {
                wakeHeard = false
                lastWakePartial = ""
                main.removeCallbacks(wakeStopRunnable)
                if (++wakeCycles >= 15) {
                    wakeCycles = 0
                    runCatching { recognizer?.destroy() }
                    recognizer = null
                }
                val rec = recognizer ?: SpeechRecognizer.createSpeechRecognizer(this).also { recognizer = it }
                rec.setRecognitionListener(object : RecognitionListener {
                    override fun onReadyForSpeech(params: Bundle?) { lastRecognizerActivityMs = System.currentTimeMillis() }
                    override fun onBeginningOfSpeech() { lastRecognizerActivityMs = System.currentTimeMillis() }
                    override fun onRmsChanged(rmsdB: Float) {}
                    override fun onBufferReceived(buffer: ByteArray?) {}
                    override fun onEndOfSpeech() { lastRecognizerActivityMs = System.currentTimeMillis() }
                    override fun onEvent(eventType: Int, params: Bundle?) {}
                    override fun onPartialResults(partialResults: Bundle?) {
                        lastRecognizerActivityMs = System.currentTimeMillis()
                        if (Speaker.isSpeaking() || busy || yielded) return
                        val list = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION).orEmpty()
                        val text = list.firstOrNull { VoiceText.containsWake(it, Settings.sensitivity) } ?: list.firstOrNull().orEmpty()
                        if (text.isBlank()) return
                        JarvisState.partial.value = text
                        // Sentito "Jarvis" (anche a voce bassa tra le alternative parziali): chiude rapido senza dover gridare.
                        if (wakeHeard || VoiceText.containsWake(text, Settings.sensitivity)) {
                            lastWakePartial = text
                            if (!wakeHeard) {
                                wakeHeard = true
                                JarvisState.status.value = JarvisState.Status.LISTENING
                                updateNotification("Ti ascolto…")
                            }
                            main.removeCallbacks(wakeStopRunnable)
                            main.postDelayed(wakeStopRunnable, 650L)
                        }
                    }
                    override fun onResults(results: Bundle?) {
                        lastRecognizerActivityMs = System.currentTimeMillis()
                        main.removeCallbacks(wakeStopRunnable)
                        sessionActive = false
                        guard?.sessionStopped()
                        if (busy || yielded || Speaker.isSpeaking()) return
                        val all = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION).orEmpty()
                        // Il primo risultato può non contenere il nome mentre un'alternativa sì ("Jarvis" detto piano).
                        val text = VoiceText.pickHeard(all, Settings.sensitivity)
                        if (wakeHeard && VoiceText.wake(text, Settings.sensitivity) == VoiceText.Wake.None) {
                            // I parziali avevano sentito "Jarvis" ma la frase finale l'ha perso: vale come chiamata.
                            wakeHeard = false
                            val recovered = text.ifBlank { lastWakePartial }
                            lastWakePartial = ""
                            onWakeWordDetected(VoiceText.commandAfterLostWake(recovered))
                            return
                        }
                        lastWakePartial = ""
                        handleHeard(text)
                    }
                    override fun onError(error: Int) {
                        lastRecognizerActivityMs = System.currentTimeMillis()
                        main.removeCallbacks(wakeStopRunnable)
                        sessionActive = false
                        guard?.sessionStopped()
                        if (busy || yielded) return
                        if (wakeHeard) {
                            // Ha chiamato Jarvis ma la sessione si è chiusa con errore: recupera l'eventuale comando dai parziali.
                            wakeHeard = false
                            val cmd = VoiceText.commandAfterLostWake(lastWakePartial)
                            lastWakePartial = ""
                            onWakeWordDetected(cmd)
                            return
                        }
                        lastWakePartial = ""
                        when (error) {
                            // Silenzio: riparte subito, così il nome detto in quel momento non va perso.
                            SpeechRecognizer.ERROR_NO_MATCH,
                            SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> restartWakeWordDelayed(60)
                            else -> {
                                runCatching { recognizer?.destroy() }
                                recognizer = null
                                restartWakeWordDelayed(800)
                            }
                        }
                    }
                })

                beginSession(rec, wakeIntent())
            } catch (e: Exception) {
                sessionActive = false
                restartWakeWordDelayed(1000)
            }
        }
    }

    /**
     * Ascolto in attesa del nome: più alternative tra cui cercare "Jarvis" e, da Android 13,
     * il riconoscitore spinto a capire proprio quel nome. Senza durata minima forzata così risponde subito.
     */
    private fun wakeIntent() = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putExtra(RecognizerIntent.EXTRA_LANGUAGE, "it-IT")
        putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 5)
        putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS, 5_000L)
        putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 1_800L)
        putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 1_200L)
        if (Build.VERSION.SDK_INT >= 33) {
            putStringArrayListExtra(RecognizerIntent.EXTRA_BIASING_STRINGS, arrayListOf("Kestra", "Ehi Kestra", "Ciao Kestra", "Ok Kestra"))
        }
    }

    /** Decide cosa fare di una frase completa sentita in attesa. */
    private fun handleHeard(text: String) {
        wakeHeard = false
        if (isSelfSpeechEcho(text)) { restartWakeWordDelayed(250); return }
        when (val w = VoiceText.wake(text, Settings.sensitivity)) {
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
        if (!Settings.listeningEnabled) return
        main.postDelayed({
            if (!Settings.listeningEnabled || yielded) return@postDelayed
            if (!busy && !Speaker.isSpeaking() && !VoiceId.enrolling) startWakeWord()
            else if (Speaker.isSpeaking() || VoiceId.enrolling) restartWakeWordDelayed(maxOf(400L, delayMs))
        }, delayMs)
    }

    private fun fail(msg: String) {
        JarvisState.error.value = msg
        JarvisState.status.value = JarvisState.Status.ERROR
        updateNotification(msg)
    }

    private var inConversationMode = false
    /** Il prossimo comando arriva dalla conversazione aperta (senza "Kestra"): va filtrato dal server. */
    private var followupTurn = false
    private var lastConversationActivityTime = 0L
    // Dopo una risposta resta in ascolto senza parola chiave per 45 s (dall'ultima frase rivolta a Kestra).
    // Ciò che sente in questa finestra passa dal filtro "è rivolto a me?" del server: TV e altre persone vengono ignorate.
    private val CONVERSATION_TIMEOUT_MS = 45_000L

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

    /** True se quando l'utente ha chiamato Jarvis lo schermo del telefono era spento o bloccato. */
    private var wakeFromScreenOff = false

    private var lastWakeGreetingIdx = -1
    // Saluti brevi: dopo la chiamata Kestra torna in ascolto quasi subito. Tutti riconosciuti come sua eco.
    private val wakeGreetings = listOf(
        "Eccomi, Capo.",
        "Dimmi, Capo.",
        "Sono qui, Capo.",
        "Comandi, Capo.",
        "Ti ascolto.",
        "Pronta, Capo.",
    )

    private fun nextWakeGreeting(): String {
        var idx = kotlin.random.Random.nextInt(wakeGreetings.size)
        if (idx == lastWakeGreetingIdx) idx = (idx + 1) % wakeGreetings.size
        lastWakeGreetingIdx = idx
        return wakeGreetings[idx]
    }

    private fun onWakeWordDetected(remainingCommand: String, openApp: Boolean = true, quick: Boolean = false) {
        if (busy) return
        if (KestraKws.running) KestraKws.stop()
        // Ferma immediatamente qualsiasi discorso del TTS per non ascoltare se stesso
        Speaker.stop()
        busy = true
        busySinceMs = System.currentTimeMillis()
        inConversationMode = true
        followupTurn = false
        ignoredFollowups = 0
        lastConversationActivityTime = System.currentTimeMillis()

        // 0. Ricorda se il telefono era a schermo spento o bloccato PRIMA di risvegliare lo schermo:
        // così Jarvis chiede la password solo a telefono spento/bloccato, e mai a telefono già acceso e sbloccato.
        wakeFromScreenOff = VoiceId.isScreenOffOrLocked(this)

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
        // Con la finestra sopra le altre app Jarvis non interrompe ciò che si sta facendo: niente app in primo piano.
        val locked = getSystemService(android.app.KeyguardManager::class.java)?.isKeyguardLocked == true
        if (openApp && (!Overlay.enabled(this) || locked)) {
            val openIntent = Intent(this, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            }
            runCatching { startActivity(openIntent) }
        }

        // 3. Se ha già detto il comando (es. "Jarvis cosa mangio?"), elabora subito;
        //    altrimenti saluta a voce ("Eccomi, signore.", "Mi dica.", ecc.) invece del beep e poi ascolta la richiesta.
        if (remainingCommand.isNotBlank()) {
            tone?.startTone(ToneGenerator.TONE_PROP_BEEP, 90)
            main.postDelayed({ process(remainingCommand) }, 250)
        } else if (quick) {
            tone?.startTone(ToneGenerator.TONE_PROP_BEEP, 90)
            main.postDelayed({ listenForCommand() }, 200)
        } else if (Settings.speakReplies) {
            val greet = nextWakeGreeting()
            lastSpokenText = greet
            lastSpokenTime = System.currentTimeMillis()
            JarvisState.status.value = JarvisState.Status.SPEAKING
            Overlay.caption(this, greet)
            Speaker.speak(greet) {
                main.postDelayed({ listenForCommand() }, 150)
            }
        } else {
            tone?.startTone(ToneGenerator.TONE_PROP_BEEP, 120)
            main.postDelayed({ listenForCommand() }, 250)
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
        if (yielded || sessionActive) return
        if (!micFreeOrYield { listenForCommand() }) return
        busy = true
        busySinceMs = System.currentTimeMillis()
        lastCommandPartial = ""
        main.removeCallbacks(commandStopRunnable)
        JarvisState.status.value = JarvisState.Status.LISTENING
        JarvisState.partial.value = ""
        updateNotification(if (inConversationMode) "Conversazione aperta (ti ascolto)…" else "Ti ascolto…")

        val rec = recognizer ?: SpeechRecognizer.createSpeechRecognizer(this).also { recognizer = it }
        rec.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) { lastRecognizerActivityMs = System.currentTimeMillis() }
            override fun onBeginningOfSpeech() { lastRecognizerActivityMs = System.currentTimeMillis() }
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() { lastRecognizerActivityMs = System.currentTimeMillis() }
            override fun onEvent(eventType: Int, params: Bundle?) {}
            override fun onPartialResults(partialResults: Bundle?) {
                lastRecognizerActivityMs = System.currentTimeMillis()
                if (Speaker.isSpeaking()) return
                val text = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
                if (text.isNotBlank() && !isSelfSpeechEcho(text)) {
                    lastCommandPartial = text
                    JarvisState.partial.value = text
                    main.removeCallbacks(commandStopRunnable)
                    main.postDelayed(commandStopRunnable, 1400L)
                }
            }
            override fun onResults(results: Bundle?) {
                lastRecognizerActivityMs = System.currentTimeMillis()
                main.removeCallbacks(commandStopRunnable)
                sessionActive = false
                guard?.sessionStopped()
                if (yielded) return
                if (Speaker.isSpeaking()) {
                    lastCommandPartial = ""
                    handleSilence()
                    return
                }
                val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
                val chosen = if (text.isNotBlank()) text else if (lastCommandPartial.length >= 2 && !isSelfSpeechEcho(lastCommandPartial)) lastCommandPartial else ""
                lastCommandPartial = ""
                if (chosen.isNotBlank()) {
                    if (isSelfSpeechEcho(chosen)) {
                        android.util.Log.w("JarvisService", "Rilevata eco della voce di Jarvis, messaggio scartato: '$chosen'")
                        handleSilence()
                        return
                    }
                    lastConversationActivityTime = System.currentTimeMillis()
                    process(chosen)
                } else {
                    handleSilence()
                }
            }
            override fun onError(error: Int) {
                lastRecognizerActivityMs = System.currentTimeMillis()
                main.removeCallbacks(commandStopRunnable)
                sessionActive = false
                guard?.sessionStopped()
                if (yielded) return
                val recovered = lastCommandPartial
                lastCommandPartial = ""
                if (recovered.length >= 2 && !isSelfSpeechEcho(recovered)) {
                    lastConversationActivityTime = System.currentTimeMillis()
                    process(recovered)
                    return
                }
                when (error) {
                    SpeechRecognizer.ERROR_NO_MATCH,
                    SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> handleSilence()
                    else -> {
                        runCatching { recognizer?.destroy() }
                        recognizer = null
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
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 1_400L)
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 1_100L)
        }
        beginSession(rec, intent, command = true)
    }

    /**
     * Riconosce e scarta automaticamente quando il microfono cattura la fine della frase
     * letta dagli altoparlanti da Jarvis stesso, impedendogli di rispondere al proprio messaggio.
     */
    private fun isSelfSpeechEcho(recognizedText: String): Boolean {
        val low = recognizedText.lowercase().trim()
        if (low == "parola d'ordine" || low.startsWith("parola d'ordine non corretta")) return true
        val now = System.currentTimeMillis()
        // Confronto con le ultime frasi dette, misurando il tempo dalla FINE della voce (prima dall'inizio:
        // con una risposta lunga la finestra anti-eco era già scaduta quando il microfono la riascoltava).
        val spoken = Speaker.recentSpoken()
        if (spoken.any { (t, endMs) -> VoiceText.isSelfEcho(recognizedText, t, now - endMs, windowMs = 20_000L) }) return true
        return VoiceText.isSelfEcho(recognized = recognizedText, lastSpoken = lastSpokenText, msSinceSpoken = now - lastSpokenTime, windowMs = 60_000L)
    }

    private fun handleSilence() {
        if (yielded) return
        if (inConversationMode) {
            val elapsed = System.currentTimeMillis() - lastConversationActivityTime
            if (elapsed > CONVERSATION_TIMEOUT_MS) {
                // Silenzio prolungato: torna discretamente in ascolto della parola chiave senza interrompere l'utente.
                inConversationMode = false
                busy = false
                backToWaiting()
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

    private var awaitingPassphrase = false
    private var pendingDeviceActions: List<Pair<String, String>> = emptyList()
    private var pendingReplyText: String = ""

    private fun backToWaiting() {
        busy = false
        inConversationMode = false
        wakeFromScreenOff = false
        awaitingPassphrase = false
        pendingDeviceActions = emptyList()
        if (yielded) return
        main.postDelayed({ if (Settings.listeningEnabled && !yielded) startWakeWord() }, 300)
    }

    private fun runApprovedDeviceActions(actions: List<Pair<String, String>>): String? {
        var callWho: String? = null
        for ((type, value) in actions) {
            when (type) {
                "call" -> callWho = value
                "visual" -> Overlay.showVisual(this@JarvisService, value)
                "open_app" -> AppLauncher.open(this@JarvisService, value)
                "open_url" -> AppLauncher.openUrl(this@JarvisService, value)
                "phone_task" -> PhoneAgent.start(this@JarvisService, value)
                "save_place" -> when (Places.saveHere(this@JarvisService, value)) {
                    "permesso" -> notifyInfoPopup("Per salvare \"$value\" apri Jarvis e concedi la posizione (Consenti sempre).", 12)
                    "spento" -> notifyInfoPopup("Accendi la posizione del telefono e ripeti.", 12)
                }
            }
        }
        return callWho
    }

    // ---------------------------------------------------------------- brain

    private fun process(text: String) {
        if (VoiceText.isCancelPhrase(text.trim())) {
            inConversationMode = false
            awaitingPassphrase = false
            pendingDeviceActions = emptyList()
            Speaker.speak("Ai suoi ordini, signore. Resto a disposizione.") {
                main.post { backToWaiting() }
            }
            return
        }
        // Se l'utente sta chiaramente parlando con altre persone nella stanza, mette in pausa la conversazione attiva senza disturbare.
        if (inConversationMode && !awaitingPassphrase && VoiceText.isTalkingToOthers(text)) {
            inConversationMode = false
            backToWaiting()
            return
        }

        // Se Jarvis stava aspettando la parola d'ordine ("niente più fili"), la verifica qui usando lo stesso riconoscitore
        // (senza mai aprirne un secondo in conflitto né inviare la parola d'ordine alla chat).
        if (awaitingPassphrase) {
            stopSession(cancel = false)
            if (VoiceId.matchesPassword(text)) {
                awaitingPassphrase = false
                wakeFromScreenOff = false
                VoiceId.trustNow()
                val actions = pendingDeviceActions
                val replySay = pendingReplyText.ifBlank { "Parola d'ordine confermata, procedo signore." }
                pendingDeviceActions = emptyList()
                pendingReplyText = ""
                val callWho = runApprovedDeviceActions(actions)
                JarvisState.status.value = JarvisState.Status.SPEAKING
                Overlay.caption(this@JarvisService, replySay)
                lastSpokenText = replySay
                lastSpokenTime = System.currentTimeMillis()
                Speaker.speak(replySay) {
                    main.post {
                        callWho?.let { com.jarvisfit.app.device.Dialer.call(this@JarvisService, it) }
                        backToWaiting()
                    }
                }
            } else {
                awaitingPassphrase = false
                pendingDeviceActions = emptyList()
                pendingReplyText = ""
                val msg = "Parola d'ordine non corretta, non procedo."
                lastSpokenText = msg
                lastSpokenTime = System.currentTimeMillis()
                Speaker.speak(msg) { main.post { backToWaiting() } }
            }
            return
        }

        JarvisState.status.value = JarvisState.Status.THINKING
        updateNotification("Sto pensando…")
        stopSession(cancel = false)

        // Frase della conversazione aperta senza il nome: il server la ignora se non era rivolta a Kestra.
        val isFollowup = followupTurn && !VoiceText.containsWake(text, Settings.sensitivity)
        followupTurn = false
        lifecycleScope.launch {
            if (VoiceId.matchesPassword(text)) VoiceId.trustNow()
            val cloud = Settings.cloudEnabled
            val reply = if (cloud) Cloud.chat(text, followup = isFollowup) else Brain.handle(text)
            if (reply.ignored) {
                // TV, radio o persone nella stanza: nessuna risposta. Dopo due frasi ignorate di fila chiude la conversazione.
                if (++ignoredFollowups >= 2) { inConversationMode = false; backToWaiting(); return@launch }
                busy = false
                followupTurn = true
                JarvisState.status.value = JarvisState.Status.LISTENING
                main.postDelayed({ if (inConversationMode && !busy) listenForCommand() }, 300)
                return@launch
            }
            ignoredFollowups = 0
            JarvisState.exchanges.value = JarvisState.exchanges.value + 1
            if (cloud) scheduleInbox(20_000) // un promemoria appena creato può scadere a breve
            if (reply.photoRequest != null) notifyPhotoRequest(reply.photoRequest)
            // Usare il telefono, aprire app o telefonare: se serve la parola d'ordine, la chiede con il riconoscitore principale.
            val sensitive = reply.device.any { it.first == "phone_task" || it.first == "call" || it.first == "open_app" }
            if (sensitive && VoiceId.needed(this@JarvisService, wakeFromScreenOff)) {
                awaitingPassphrase = true
                pendingDeviceActions = reply.device
                pendingReplyText = reply.text
                inConversationMode = true
                val prompt = "Parola d'ordine?"
                JarvisState.status.value = JarvisState.Status.SPEAKING
                Overlay.caption(this@JarvisService, prompt)
                updateNotification(prompt)
                lastSpokenText = prompt
                lastSpokenTime = System.currentTimeMillis()
                Speaker.speak(prompt) {
                    main.postDelayed({
                        busy = false
                        lastConversationActivityTime = System.currentTimeMillis()
                        listenForCommand()
                    }, 350)
                }
                return@launch
            }
            if (sensitive) {
                wakeFromScreenOff = false
                // Quando parte un'azione sul telefono (es. musica su Joytify), chiude la conversazione vocale
                // così il microfono non si riapre sopra la musica mettendola in pausa.
                inConversationMode = false
            }
            val callWho = runApprovedDeviceActions(reply.device)
            
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
            Overlay.caption(this@JarvisService, reply.text)
            updateNotification(reply.text.take(80))
            lastSpokenText = reply.text
            lastSpokenTime = System.currentTimeMillis()

            val after = {
                main.post {
                    callWho?.let { who ->
                        // La telefonata vera: se non parte lo dice, invece di lasciare una promessa a vuoto.
                        val said = com.jarvisfit.app.device.Dialer.problem(com.jarvisfit.app.device.Dialer.call(this@JarvisService, who), who)
                        inConversationMode = false
                        if (said != null) { notifyInfoPopup(said, 13); Speaker.speak(said) { main.post { backToWaiting() } } } else backToWaiting()
                        return@post
                    }
                    if (yielded) return@post
                    if (inConversationMode && reply.photoRequest == null) {
                        busy = false
                        followupTurn = true
                        lastConversationActivityTime = System.currentTimeMillis()
                        tone?.startTone(ToneGenerator.TONE_PROP_BEEP, 80)
                        // Conversazione flessibile: resta in ascolto finché l'utente non dice "grazie Jarvis", parla con altri o resta in silenzio.
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
            .setContentTitle("Kestra • Dati")
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
            .setContentTitle("Kestra vuole una foto")
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
                    val inbox = Cloud.consumeInbox()
                    val items = inbox.items
                    // Se un promemoria scade prima del prossimo giro, si torna a chiedere proprio a quell'ora.
                    inbox.nextInMs?.let { if (it < INBOX_POLL_MS) scheduleInbox(it + 2_000) }
                    items.forEachIndexed { i, rawText ->
                        val taskMatch = Regex("\\[PHONE_TASK:([^\\]]+)\\]").find(rawText)
                        val appMatch = Regex("\\[OPEN_APP:([^\\]]+)\\]").find(rawText)
                        val text = rawText.replace(Regex("\\[(?:PHONE_TASK|OPEN_APP):[^\\]]+\\]\\s*"), "").trim()
                        if (text.isNotBlank()) notifyInfoPopup(text, 20 + i)
                        if (appMatch != null) AppLauncher.open(this@JarvisService, appMatch.groupValues[1].trim())
                        if (taskMatch != null) PhoneAgent.start(this@JarvisService, taskMatch.groupValues[1].trim())
                    }
                    val first = items.firstOrNull()?.replace(Regex("\\[(?:PHONE_TASK|OPEN_APP):[^\\]]+\\]\\s*"), "")?.trim()
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

    private fun scheduleInbox(delayMs: Long) {
        ticker.removeCallbacks(inboxPoll)
        ticker.postDelayed(inboxPoll, delayMs.coerceIn(3_000, INBOX_POLL_MS))
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
