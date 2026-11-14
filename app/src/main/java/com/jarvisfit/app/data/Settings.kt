package com.jarvisfit.app.data

import android.content.Context
import android.content.SharedPreferences

/** Chiavi API e preferenze tecniche (salvate solo sul telefono). */
object Settings {
    private lateinit var prefs: SharedPreferences

    fun init(context: Context) {
        prefs = context.getSharedPreferences("settings", Context.MODE_PRIVATE)
    }

    var geminiKey: String
        get() = prefs.getString("gemini_key", null) ?: prefs.getString("anthropic_key", "") ?: ""
        set(v) = prefs.edit().putString("gemini_key", v.trim()).putString("anthropic_key", v.trim()).apply()

    var anthropicKey: String
        get() = geminiKey
        set(v) { geminiKey = v }

    var picovoiceKey: String
        get() = prefs.getString("picovoice_key", "") ?: ""
        set(v) = prefs.edit().putString("picovoice_key", v.trim()).apply()

    var model: String
        get() = prefs.getString("model", "gemini-3.8-flash") ?: "gemini-3.8-flash"
        set(v) = prefs.edit().putString("model", v.trim()).apply()

    var sensitivity: Float
        get() = prefs.getFloat("sensitivity", 0.65f)
        set(v) = prefs.edit().putFloat("sensitivity", v).apply()

    var speakReplies: Boolean
        get() = prefs.getBoolean("speak", true)
        set(v) = prefs.edit().putBoolean("speak", v).apply()

    var listeningEnabled: Boolean
        get() = prefs.getBoolean("listening", false)
        set(v) = prefs.edit().putBoolean("listening", v).apply()

    // Jarvis Cloud: indirizzo del server e token di accesso. Se mancano, l'app lavora in modalità classica.
    var serverUrl: String
        get() = prefs.getString("server_url", "") ?: ""
        set(v) = prefs.edit().putString("server_url", v.trim().trimEnd('/')).apply()

    var serverToken: String
        get() = prefs.getString("server_token", "") ?: ""
        set(v) = prefs.edit().putString("server_token", v.trim()).apply()

    val cloudEnabled: Boolean
        get() = serverUrl.isNotBlank() && serverToken.isNotBlank()

    var cloudPromptSeen: Boolean
        get() = prefs.getBoolean("cloud_prompt_seen", false)
        set(v) = prefs.edit().putBoolean("cloud_prompt_seen", v).apply()

    /** Se attivo, Jarvis lascia il microfono quando un'altra app registra (Gemini, vocali, chiamate). */
    var micGuard: Boolean
        get() = prefs.getBoolean("mic_guard", true)
        set(v) = prefs.edit().putBoolean("mic_guard", v).apply()

    // Riconoscimento della voce: impronta registrata (solo numeri, resta sul telefono) e blocco attivo.
    var voiceModel: String
        get() = prefs.getString("voice_model", "") ?: ""
        set(v) = prefs.edit().putString("voice_model", v).apply()
    var voiceLock: Boolean
        get() = prefs.getBoolean("voice_lock", false)
        set(v) = prefs.edit().putBoolean("voice_lock", v).apply()
    /** Da 0 (permissivo) a 1 (severo). */
    var voiceStrictness: Float
        get() = prefs.getFloat("voice_strictness", 0.5f)
        set(v) = prefs.edit().putFloat("voice_strictness", v.coerceIn(0f, 1f)).apply()

    /** Mostra Jarvis (sfera, frasi, grafiche) sopra le altre app quando lo si chiama. */
    var overlay: Boolean
        get() = prefs.getBoolean("overlay", true)
        set(v) = prefs.edit().putBoolean("overlay", v).apply()

    // Contapassi: il sensore restituisce passi totali dall'ultimo riavvio
    var stepBaseDate: String
        get() = prefs.getString("step_base_date", "") ?: ""
        set(v) = prefs.edit().putString("step_base_date", v).apply()
    var stepBaseValue: Float
        get() = prefs.getFloat("step_base_value", -1f)
        set(v) = prefs.edit().putFloat("step_base_value", v).apply()
    var stepLastRaw: Float
        get() = prefs.getFloat("step_last_raw", -1f)
        set(v) = prefs.edit().putFloat("step_last_raw", v).apply()
}
