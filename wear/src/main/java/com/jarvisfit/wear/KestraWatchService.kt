package com.jarvisfit.wear

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelChildren
import kotlinx.coroutines.launch
import java.util.Locale

/**
 * La conversazione dell'orologio. Parte quando apri Kestra (tocco o tasto), ascolta, manda la frase
 * al server, dice la risposta e resta in ascolto per il seguito. Se abbassi il polso continua lo stesso;
 * quando non parli più si chiude da sola, così la batteria non se ne va.
 */
class KestraWatchService : Service() {

    companion object {
        const val ACTION_TALK = "talk"
        const val ACTION_TEXT = "text"
        const val ACTION_STOP = "stop"
        const val EXTRA_TEXT = "text"
        private const val MAX_TURNS = 8

        fun talk(ctx: Context) = ctx.startForegroundService(Intent(ctx, KestraWatchService::class.java).setAction(ACTION_TALK))
        fun text(ctx: Context, text: String) =
            ctx.startForegroundService(Intent(ctx, KestraWatchService::class.java).setAction(ACTION_TEXT).putExtra(EXTRA_TEXT, text))
        fun stop(ctx: Context) = ctx.startService(Intent(ctx, KestraWatchService::class.java).setAction(ACTION_STOP))

        fun canRecognize(ctx: Context) = SpeechRecognizer.isRecognitionAvailable(ctx)
    }

    private val main = Handler(Looper.getMainLooper())
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var recognizer: SpeechRecognizer? = null
    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private var wake: PowerManager.WakeLock? = null
    private var turns = 0
    private var busy = false
    /** Azioni sul telefono in attesa della parola d'ordine. */
    private var pendingPhone: List<Pair<String, String>>? = null
    private var pendingSay = ""

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        WatchConfig.init(this)
        tts = TextToSpeech(this) { status ->
            ttsReady = status == TextToSpeech.SUCCESS
            if (ttsReady) tts?.language = Locale.ITALIAN
        }
        wake = getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "kestra:watch")
            .apply { setReferenceCounted(false) }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) { finish(); return START_NOT_STICKY }
        startForeground(1, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        wake?.acquire(3 * 60_000L)
        when (intent?.action) {
            ACTION_TEXT -> intent.getStringExtra(EXTRA_TEXT)?.takeIf { it.isNotBlank() }?.let { turns = 0; handle(it, followup = false) } ?: finish()
            else -> { scope.coroutineContext.cancelChildren(); tts?.stop(); turns = 0; pendingPhone = null; listen(followup = false) }
        }
        return START_NOT_STICKY
    }

    private fun notification(): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, WatchActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 1, Intent(this, KestraWatchService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this, WatchApp.CH_TALK)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Kestra")
            .setContentText("In conversazione")
            .setContentIntent(open)
            .addAction(Notification.Action.Builder(null, "Chiudi", stop).build())
            .setOngoing(true)
            .build()
    }

    // ------------------------------------------------------------------ ascolto

    private fun listen(followup: Boolean) {
        if (!WatchConfig.ready) { say("Apri Kestra sul telefono: indirizzo e token arrivano da soli.") { finish() }; return }
        if (!canRecognize(this)) {
            // Niente riconoscimento in background su questo orologio: si parla toccando la schermata.
            WatchState.phase.value = WatchState.Phase.IDLE
            finish()
            return
        }
        if (turns++ >= MAX_TURNS) { finish(); return }
        busy = false
        WatchState.phase.value = WatchState.Phase.LISTENING
        WatchState.heard.value = ""
        buzz(30)
        recognizer?.destroy()
        val r = SpeechRecognizer.createSpeechRecognizer(this)
        recognizer = r
        r.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) {}
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) { WatchState.level.value = ((rmsdB + 2f) / 12f).coerceIn(0f, 1f) }
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() { WatchState.level.value = 0f }
            override fun onEvent(eventType: Int, params: Bundle?) {}
            override fun onPartialResults(partial: Bundle?) {
                partial?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.let { WatchState.heard.value = it }
            }
            override fun onResults(results: Bundle?) {
                val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
                if (text.isBlank()) onSilence(followup) else handle(text, followup)
            }
            override fun onError(error: Int) {
                if (busy) return
                when (error) {
                    SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> onSilence(followup)
                    SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> say("Mi serve il permesso del microfono: apri Kestra sull'orologio.") { finish() }
                    SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> say("Non ho rete per capire la voce.") { finish() }
                    else -> if (followup) finish() else say("Non ho capito, tocca e riprova.") { finish() }
                }
            }
        })
        r.startListening(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, "it-IT")
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, packageName)
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 1500L)
        })
    }

    /** Nessuna frase: alla prima domanda lo dice, nel seguito della conversazione chiude in silenzio. */
    private fun onSilence(followup: Boolean) {
        if (busy) return
        busy = true
        if (followup) finish() else say("Non ti ho sentito.") { finish() }
    }

    // ------------------------------------------------------------------ cervello

    private fun handle(text: String, followup: Boolean) {
        busy = true
        recognizer?.cancel()
        WatchState.heard.value = text
        if (Protocol.isGoodbye(text)) { pendingPhone = null; say("A dopo.") { finish() }; return }

        val waiting = pendingPhone
        if (waiting != null) {
            // Era la risposta a "Parola d'ordine?": la controlla il telefono, come quando parli a lui.
            pendingPhone = null
            WatchState.phase.value = WatchState.Phase.THINKING
            scope.launch {
                val r = PhoneLink.runOnPhone(this@KestraWatchService, waiting, password = text)
                when (r.status) {
                    "ok" -> say(r.say.ifBlank { pendingSay.ifBlank { "Fatto sul telefono." } }) { listen(true) }
                    "wrong" -> say("Parola d'ordine non corretta, non procedo.") { listen(true) }
                    else -> say("Non raggiungo il telefono, quindi non l'ho fatto.") { listen(true) }
                }
            }
            return
        }

        WatchState.phase.value = WatchState.Phase.THINKING
        scope.launch {
            val reply = WatchCloud.chat(text, followup)
            if (reply.ignored) { finish(); return@launch }
            if (reply.phone.isEmpty()) {
                say(reply.text) { listen(true) }
                return@launch
            }
            // Il server ha chiesto un'azione sul telefono: la fa il telefono, l'orologio dice com'è andata.
            val r = PhoneLink.runOnPhone(this@KestraWatchService, reply.phone, password = null)
            when (r.status) {
                "ok" -> say(listOf(reply.text, r.say).filter { it.isNotBlank() }.joinToString(" ").ifBlank { "Fatto sul telefono." }) { listen(true) }
                "password" -> {
                    pendingPhone = reply.phone
                    pendingSay = reply.text
                    say("Parola d'ordine?") { listen(true) }
                }
                else -> say("Non raggiungo il telefono, quindi non l'ho fatto.") { listen(true) }
            }
        }
    }

    // ------------------------------------------------------------------ voce

    private fun hasSpeaker(): Boolean {
        if (!packageManager.hasSystemFeature(PackageManager.FEATURE_AUDIO_OUTPUT)) return false
        val am = getSystemService(AudioManager::class.java)
        return am.getDevices(AudioManager.GET_DEVICES_OUTPUTS).any {
            it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER || it.type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP
        }
    }

    /** Dice la frase; senza altoparlante la mostra soltanto e vibra. */
    private fun say(text: String, after: () -> Unit) {
        WatchState.reply.value = text
        WatchState.level.value = 0f
        if (text.isBlank()) { main.post(after); return }
        WatchState.phase.value = WatchState.Phase.SPEAKING
        val engine = tts
        if (!ttsReady || engine == null || !hasSpeaker()) {
            buzz(120)
            // Tempo per leggere: circa 60 ms a carattere, tra 2 e 8 secondi.
            main.postDelayed(after, (text.length * 60L).coerceIn(2000L, 8000L))
            return
        }
        val id = "k" + System.nanoTime()
        engine.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) {}
            override fun onDone(utteranceId: String?) { if (utteranceId == id) main.post(after) }
            @Deprecated("Deprecated in Java")
            override fun onError(utteranceId: String?) { if (utteranceId == id) main.post(after) }
        })
        engine.speak(text, TextToSpeech.QUEUE_FLUSH, null, id)
    }

    private fun buzz(ms: Long) {
        runCatching { getSystemService(Vibrator::class.java)?.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE)) }
    }

    private fun finish() {
        recognizer?.destroy()
        recognizer = null
        WatchState.phase.value = WatchState.Phase.IDLE
        WatchState.level.value = 0f
        runCatching { wake?.release() }
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        recognizer?.destroy()
        tts?.shutdown()
        scope.cancel()
        runCatching { wake?.release() }
        super.onDestroy()
    }
}
