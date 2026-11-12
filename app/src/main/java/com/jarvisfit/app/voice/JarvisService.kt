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
}

/**
 * Servizio in primo piano: ascolta sempre la parola "Jarvis" (Porcupine, offline),
 * poi registra la frase con il riconoscimento vocale di Android, la manda al Brain
 * e legge la risposta. Conta anche i passi del giorno.
 */
class JarvisService : LifecycleService(), SensorEventListener {

    companion object {
        const val ACTION_START = "start"
        const val ACTION_STOP = "stop"
        const val ACTION_LISTEN = "listen"     // ascolta subito, senza parola chiave
        private const val NOTIF_ID = 1
        private const val PHOTO_NOTIF_ID = 2

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
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)
        when (intent?.action) {
            ACTION_STOP -> { shutdown(); return START_NOT_STICKY }
            else -> {
                ensureForeground()
                if (intent?.action == ACTION_LISTEN) {
                    if (!busy) onWakeWord(beep = true) else Unit
                } else if (!busy) {
                    startWakeWord()
                }
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        shutdown()
        (getSystemService(SENSOR_SERVICE) as SensorManager).unregisterListener(this)
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
            .setContentTitle("Jarvis Fit")
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

    // ---------------------------------------------------------------- wake word

    private val wakeWordRegex = Regex("\\b(jarvis|jarvi|ehi jarvis|hey jarvis|ciao jarvis)\\b", RegexOption.IGNORE_CASE)
    private val googleRegex = Regex("\\b(ok google|hey google|ehi google|gemini|apri gemini)\\b", RegexOption.IGNORE_CASE)
    private var lastSpokenText: String = ""
    private var lastSpokenTime: Long = 0L

    private fun startWakeWord() {
        if (!Settings.listeningEnabled || busy) return
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
        updateNotification("In ascolto di \"Jarvis\" (di' \"Jarvis\" o \"Hey Google\")")

        main.post {
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

            try {
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
                        if (text.isNotBlank()) {
                            JarvisState.partial.value = text
                            
                            // 1. Rileva "Jarvis" -> attiva JarvisFit
                            val mJarvis = wakeWordRegex.find(text)
                            if (mJarvis != null && !busy) {
                                rec.stopListening()
                                onWakeWordDetected(text.substring(mJarvis.range.last + 1).trim())
                                return
                            }

                            // 2. Rileva "Hey Google" / "Gemini" -> attiva l'Assistente Google / Gemini ufficiale di Android!
                            val mGoogle = googleRegex.find(text)
                            if (mGoogle != null && !busy) {
                                rec.stopListening()
                                onGoogleDetected()
                                return
                            }
                        }
                    }
                    override fun onResults(results: Bundle?) {
                        if (busy || Speaker.isSpeaking()) return
                        val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
                        val mJarvis = wakeWordRegex.find(text)
                        val mGoogle = googleRegex.find(text)
                        if (mJarvis != null) {
                            onWakeWordDetected(text.substring(mJarvis.range.last + 1).trim())
                        } else if (mGoogle != null) {
                            onGoogleDetected()
                        } else {
                            // Non ha detto né Jarvis né Google, continua ad ascoltare
                            restartWakeWordDelayed(250)
                        }
                    }
                    override fun onError(error: Int) {
                        if (busy) return
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
                rec.startListening(intent)
            } catch (e: Exception) {
                restartWakeWordDelayed(1000)
            }
        }
    }

    private fun restartWakeWordDelayed(delayMs: Long) {
        if (!busy && Settings.listeningEnabled) {
            main.postDelayed({
                if (!busy && Settings.listeningEnabled && !Speaker.isSpeaking()) startWakeWord()
                else if (!busy && Settings.listeningEnabled && Speaker.isSpeaking()) restartWakeWordDelayed(delayMs)
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
        runCatching { recognizer?.stopListening() }
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

        // Rilascia e lascia il microfono a Google, riprendendo l'ascolto di Jarvis dopo 10 secondi
        main.postDelayed({
            busy = false
            if (Settings.listeningEnabled) startWakeWord()
        }, 10_000)
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
            screenLock.acquire(4000)
            screenLock.release()
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
        rec.startListening(intent)
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
        main.postDelayed({ if (Settings.listeningEnabled) startWakeWord() }, 300)
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
        runCatching { recognizer?.stopListening() }

        lifecycleScope.launch {
            val reply = Brain.handle(text)
            if (reply.photoRequest != null) notifyPhotoRequest(reply.photoRequest)
            
            // Pop-up notifica a schermo con i soli dati schematici (es. macro, kcal, ricetta e dosi), NON il discorso parlato!
            val popupText = reply.cardInfo ?: run {
                val activeRecipe = Store.diary.activeRecipeSession
                if (activeRecipe != null) {
                    "🍳 ${activeRecipe.title}\n${activeRecipe.currentStep.ifBlank { activeRecipe.ingredientsNeeded }}"
                } else null
            }
            if (!popupText.isNullOrBlank()) {
                notifyInfoPopup(popupText)
            }

            JarvisState.status.value = JarvisState.Status.SPEAKING
            updateNotification(reply.text.take(80))
            lastSpokenText = reply.text
            lastSpokenTime = System.currentTimeMillis()

            val after = {
                main.post {
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

    private fun notifyInfoPopup(infoText: String) {
        val openIntent = Intent(this, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }
        val pi = PendingIntent.getActivity(this, 10, openIntent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val notif = NotificationCompat.Builder(this, JarvisApp.CH_POPUP)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Jarvis Fit • Dati")
            .setContentText(infoText.lines().firstOrNull() ?: infoText)
            .setStyle(NotificationCompat.BigTextStyle().bigText(infoText))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .setAutoCancel(true)
            .setContentIntent(pi)
            .build()
        runCatching { NotificationManagerCompat.from(this).notify(10, notif) }
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
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
}
