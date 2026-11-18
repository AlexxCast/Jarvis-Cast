package com.jarvisfit.app.device

import android.app.Notification
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import androidx.core.app.NotificationManagerCompat
import com.jarvisfit.app.data.Settings
import com.jarvisfit.app.net.Cloud
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * Kestra legge le notifiche del telefono (se il Capo dà il permesso "Accesso alle notifiche"):
 * le manda al server a piccoli gruppi, che decide se sono urgenti e le usa per rispondere a
 * "chi mi ha scritto?". Le notifiche continue (musica, download) e quelle di Kestra stessa sono escluse.
 */
class KestraNotifications : NotificationListenerService() {

    private val main = Handler(Looper.getMainLooper())
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val pending = mutableListOf<Cloud.PhoneNotification>()
    private val flush = Runnable { send() }

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        val n = sbn ?: return
        if (!Settings.cloudEnabled || n.packageName == packageName || n.isOngoing) return
        val notif = n.notification ?: return
        if (notif.flags and Notification.FLAG_GROUP_SUMMARY != 0) return
        val extras = notif.extras ?: return
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty()
        val text = (extras.getCharSequence(Notification.EXTRA_BIG_TEXT) ?: extras.getCharSequence(Notification.EXTRA_TEXT))?.toString().orEmpty()
        if (title.isBlank() && text.isBlank()) return
        val label = runCatching { packageManager.getApplicationLabel(packageManager.getApplicationInfo(n.packageName, 0)).toString() }.getOrDefault(n.packageName)
        synchronized(pending) {
            if (pending.size < 30) pending.add(Cloud.PhoneNotification(n.packageName, label, title.take(80), text.take(300), n.postTime))
        }
        // Più notifiche ravvicinate partono insieme: una sola richiesta al server.
        main.removeCallbacks(flush)
        main.postDelayed(flush, 4_000)
    }

    private fun send() {
        val batch = synchronized(pending) { pending.toList().also { pending.clear() } }
        if (batch.isEmpty()) return
        scope.launch { Cloud.notify(batch) }
    }

    override fun onDestroy() {
        main.removeCallbacks(flush)
        super.onDestroy()
    }

    companion object {
        fun enabled(ctx: Context): Boolean =
            NotificationManagerCompat.getEnabledListenerPackages(ctx).contains(ctx.packageName)

        fun openSettings(ctx: Context) {
            val intent = Intent(android.provider.Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            runCatching { ctx.startActivity(intent) }
        }

    }
}
