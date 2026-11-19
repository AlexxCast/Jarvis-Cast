package com.jarvisfit.wear

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager

class WatchApp : Application() {
    companion object {
        const val CH_TALK = "talk"
    }

    override fun onCreate() {
        super.onCreate()
        WatchConfig.init(this)
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CH_TALK, "Conversazione con Kestra", NotificationManager.IMPORTANCE_LOW)
        )
    }
}
