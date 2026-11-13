package com.jarvisfit.app.device

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.location.LocationManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.jarvisfit.app.JarvisApp
import com.jarvisfit.app.R
import com.jarvisfit.app.net.Cloud
import com.jarvisfit.app.ui.MainActivity
import kotlinx.coroutines.launch

/** Android ci dice che siamo entrati in un luogo salvato (o ne siamo usciti): chiediamo al server cosa ricordare. */
class PlaceReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action != Places.ACTION) return
        val key = intent.data?.schemeSpecificPart ?: return
        val entering = intent.getBooleanExtra(LocationManager.KEY_PROXIMITY_ENTERING, true)
        val app = ctx.applicationContext
        val pending = goAsync()
        JarvisApp.scope.launch {
            try {
                Cloud.placeEvent(key, if (entering) "arrivo" else "uscita").forEachIndexed { i, text ->
                    notifyReminder(app, text, 300 + (key.hashCode() and 0xff) * 4 + i)
                }
            } finally {
                pending.finish()
            }
        }
    }

    private fun notifyReminder(ctx: Context, text: String, id: Int) {
        val open = Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val pi = PendingIntent.getActivity(ctx, 11, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val n = NotificationCompat.Builder(ctx, JarvisApp.CH_POPUP)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Jarvis Assistente • Promemoria")
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .setAutoCancel(true)
            .setContentIntent(pi)
            .build()
        runCatching { NotificationManagerCompat.from(ctx).notify(id, n) }
    }
}

/** Dopo un riavvio (o un aggiornamento dell'app) Android dimentica gli avvisi di prossimità: li rimettiamo. */
class PlaceBootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) Places.register(ctx)
    }
}
