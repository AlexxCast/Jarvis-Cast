package com.jarvisfit.app

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import com.jarvisfit.app.data.Settings
import com.jarvisfit.app.data.Store
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

class JarvisApp : Application() {
    companion object {
        const val CH_LISTEN = "listen"
        const val CH_PHOTO = "photo"
        const val CH_POPUP = "popup_info"
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    }

    override fun onCreate() {
        super.onCreate()
        Settings.init(this)
        Store.init(this)
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CH_LISTEN, "Ascolto Jarvis", NotificationManager.IMPORTANCE_LOW)
        )
        nm.createNotificationChannel(
            NotificationChannel(CH_PHOTO, "Richieste foto", NotificationManager.IMPORTANCE_HIGH)
        )
        nm.createNotificationChannel(
            NotificationChannel(CH_POPUP, "Info Scheda & Dati Jarvis", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Notifiche popup su schermo per ricette in corso, dati e dosi"
                enableVibration(true)
            }
        )
    }
}
