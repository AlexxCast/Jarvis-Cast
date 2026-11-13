package com.jarvisfit.app.device

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Settings
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.jarvisfit.app.JarvisApp
import com.jarvisfit.app.R
import com.jarvisfit.app.net.Cloud
import com.jarvisfit.app.voice.Speaker
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Esegue un obiettivo sul telefono ("scrivi a Marco che arrivo"): legge lo schermo, chiede al server
 * la prossima mossa, la esegue, e ripete. Si ferma quando il server dice "fatto" o "chiedi".
 */
object PhoneAgent {
    private const val NOTIF_ID = 4242
    const val ACTION_STOP = "com.jarvisfit.app.PHONE_STOP"
    private var job: Job? = null

    val running get() = job?.isActive == true

    fun openSettings(ctx: Context) {
        runCatching { ctx.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    }

    /** "ok" se è partito, "spento" se manca il permesso di accessibilità. */
    fun start(ctx: Context, goal: String): String {
        val app = ctx.applicationContext
        // Con il telefono bloccato Jarvis non agisce: chi parla deve essere chi l'ha sbloccato.
        val km = app.getSystemService(android.app.KeyguardManager::class.java)
        if (km?.isDeviceLocked == true) {
            tell(app, "Sblocca il telefono e ripeti: con il telefono bloccato non uso le app.")
            return "bloccato"
        }
        if (JarvisAccessibility.instance == null) {
            tell(app, "Non posso farlo: devo essere attivato in Impostazioni, Accessibilità, Jarvis usa il telefono.")
            return "spento"
        }
        job?.cancel()
        job = JarvisApp.scope.launch { loop(app, goal) }
        return "ok"
    }

    /** Dice e mostra perché non può procedere: mai una promessa a vuoto. */
    private fun tell(ctx: Context, text: String) {
        notify(ctx, text, ongoing = false)
        Speaker.init(ctx)
        Speaker.speak(text)
    }

    fun stop(ctx: Context) {
        job?.cancel()
        job = null
        NotificationManagerCompat.from(ctx).cancel(NOTIF_ID)
    }

    private suspend fun loop(ctx: Context, goal: String) {
        Speaker.init(ctx)
        val history = mutableListOf<String>()
        var finalSay = ""
        var asked = false
        var pause = 600L
        try {
            for (step in 0 until 25) {
                delay(pause) // lascia caricare lo schermo
                val svc = JarvisAccessibility.instance ?: run { finalSay = "Il permesso di accessibilità è stato spento."; return }
                var screen = svc.snapshot()
                // Schermo ancora vuoto (app che si sta aprendo): aspettiamo un attimo e rileggiamo.
                repeat(3) { if (screen.items.size < 2) { delay(800); screen = svc.snapshot() } }
                val move = Cloud.phoneStep(goal, step, history, screen)
                val doing = move.say.ifBlank { move.kind }
                notify(ctx, "Passo ${step + 1}: $doing", ongoing = true)
                val err: String? = when (move.kind) {
                    "tap" -> svc.tap(move.n ?: -1)
                    "type" -> svc.type(move.n ?: -1, move.text)
                    "scroll" -> svc.scroll(move.n, move.dir != "su")
                    "back" -> { svc.back(); null }
                    "home" -> { svc.home(); null }
                    "open_app" -> if (AppLauncher.open(ctx, move.text)) null else "app \"${move.text}\" non trovata"
                    "wait" -> null
                    else -> { asked = move.kind == "ask"; finalSay = move.say.ifBlank { if (move.kind == "done") "Fatto." else "Mi sono fermato: mi dica come proseguire." }; return } // done / ask
                }
                pause = when (move.kind) { "open_app" -> 2500L; "type" -> 700L; else -> 1300L }
                val target = move.n?.let { n -> screen.items.firstOrNull { it.n == n }?.text?.take(40) }.orEmpty()
                history += listOfNotNull(move.kind, move.n?.toString(), target.ifBlank { null }, move.text.ifBlank { null }?.let { "\"$it\"" }).joinToString(" ") +
                    (err?.let { " → ERRORE: $it" } ?: "")
            }
            finalSay = "Ci sto mettendo troppi passaggi, mi fermo qui."
        } finally {
            if (finalSay.isNotBlank()) {
                notify(ctx, finalSay, ongoing = false)
                // Dopo una domanda ascolta subito la risposta, senza dover ridire "Jarvis".
                if (asked) Speaker.speak(finalSay) { com.jarvisfit.app.voice.JarvisService.listenForAnswer(ctx) }
                else Speaker.speak(finalSay)
            } else NotificationManagerCompat.from(ctx).cancel(NOTIF_ID)
        }
    }

    private fun notify(ctx: Context, text: String, ongoing: Boolean) {
        val b = NotificationCompat.Builder(ctx, JarvisApp.CH_POPUP)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(if (ongoing) "Jarvis sta usando il telefono" else "Jarvis Assistente")
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setOnlyAlertOnce(true)
            .setOngoing(ongoing)
            .setAutoCancel(!ongoing)
        if (ongoing) {
            val stop = PendingIntent.getBroadcast(ctx, 42, Intent(ctx, PhoneStopReceiver::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE)
            b.addAction(0, "Ferma", stop).setPriority(NotificationCompat.PRIORITY_LOW)
        } else b.setPriority(NotificationCompat.PRIORITY_HIGH)
        runCatching { NotificationManagerCompat.from(ctx).notify(NOTIF_ID, b.build()) }
    }
}

class PhoneStopReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action == PhoneAgent.ACTION_STOP) PhoneAgent.stop(ctx)
    }
}
