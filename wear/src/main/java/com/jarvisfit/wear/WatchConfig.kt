package com.jarvisfit.wear

import android.content.Context
import android.content.SharedPreferences

/** Indirizzo del server e token. Arrivano dal telefono (Data Layer): sull'orologio non si scrive nulla. */
object WatchConfig {
    private var prefs: SharedPreferences? = null

    fun init(ctx: Context) {
        if (prefs == null) prefs = ctx.applicationContext.getSharedPreferences("kestra_watch", Context.MODE_PRIVATE)
    }

    var url: String
        get() = prefs?.getString("url", "") ?: ""
        set(v) { prefs?.edit()?.putString("url", v.trim().trimEnd('/'))?.apply() }

    var token: String
        get() = prefs?.getString("token", "") ?: ""
        set(v) { prefs?.edit()?.putString("token", v.trim())?.apply() }

    val ready: Boolean get() = url.isNotBlank() && token.isNotBlank()

    fun save(newUrl: String?, newToken: String?) {
        if (newUrl.isNullOrBlank() || newToken.isNullOrBlank()) return
        url = newUrl
        token = newToken
    }
}
