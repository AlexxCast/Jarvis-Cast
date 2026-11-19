package com.jarvisfit.app.device

import android.content.Context
import android.os.Handler
import android.os.Looper
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.PutDataMapRequest
import com.google.android.gms.wearable.Wearable
import com.google.android.gms.wearable.WearableListenerService
import com.jarvisfit.app.data.Settings
import com.jarvisfit.app.voice.VoiceId
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

/**
 * Ponte con Kestra sull'orologio (Wear OS). Funziona solo tra telefono e orologio associati
 * che hanno la stessa app con la stessa firma: è Google a garantirlo.
 * - Passa all'orologio indirizzo del server e token, così sull'orologio non si scrive nulla.
 * - Esegue sul telefono le azioni che il server chiede parlando all'orologio, con le stesse regole
 *   della voce: parola d'ordine se serve, conferme del controllo del telefono invariate.
 */
class WatchLink : WearableListenerService() {

    companion object {
        const val PATH_CONFIG = "/kestra/config"
        const val PATH_CONFIG_REQUEST = "/kestra/config-request"
        const val PATH_DEVICE = "/kestra/device"
        const val PATH_DEVICE_RESULT = "/kestra/device-result"
        private val json = Json { ignoreUnknownKeys = true }

        /** Pubblica indirizzo e token per l'orologio. Silenzioso se manca Google Play o l'orologio. */
        fun publishConfig(ctx: Context) {
            if (!Settings.cloudEnabled) return
            runCatching {
                val req = PutDataMapRequest.create(PATH_CONFIG).apply {
                    dataMap.putString("url", Settings.serverUrl)
                    dataMap.putString("token", Settings.serverToken)
                }.asPutDataRequest().setUrgent()
                Wearable.getDataClient(ctx.applicationContext).putDataItem(req)
            }
        }

        private fun str(o: JsonObject, key: String) = (o[key] as? JsonPrimitive)?.contentOrNull ?: ""
    }

    private val main = Handler(Looper.getMainLooper())

    override fun onMessageReceived(event: MessageEvent) {
        when (event.path) {
            PATH_CONFIG_REQUEST -> publishConfig(this)
            PATH_DEVICE -> {
                val body = String(event.data)
                val from = event.sourceNodeId
                // Aprire app e attività va fatto dal thread principale.
                main.post {
                    val result = runCatching { run(body) }.getOrElse {
                        buildJsonObject { put("status", "error"); put("say", "Il telefono ha avuto un errore.") }
                    }
                    val id = runCatching { str(json.parseToJsonElement(body).jsonObject, "id") }.getOrDefault("")
                    val out = JsonObject(result + ("id" to JsonPrimitive(id)))
                    runCatching { Wearable.getMessageClient(this).sendMessage(from, PATH_DEVICE_RESULT, out.toString().toByteArray()) }
                }
            }
        }
    }

    private fun run(body: String): JsonObject {
        val o = json.parseToJsonElement(body).jsonObject
        val actions = (o["actions"] as? JsonArray)?.mapNotNull { el ->
            val a = el as? JsonObject ?: return@mapNotNull null
            val t = str(a, "type"); val v = str(a, "value")
            if (t.isBlank() || v.isBlank()) null else t to v
        }.orEmpty()
        val password = (o["password"] as? JsonPrimitive)?.contentOrNull
        if (password != null) {
            if (!VoiceId.matchesPassword(password)) return buildJsonObject { put("status", "wrong") }
            VoiceId.trustNow()
        }
        val sensitive = actions.any { it.first == "phone_task" || it.first == "call" || it.first == "open_app" }
        if (sensitive && VoiceId.needed(this)) return buildJsonObject { put("status", "password") }

        val problems = mutableListOf<String>()
        for ((type, value) in actions) {
            when (type) {
                "open_app" -> if (!AppLauncher.open(this, value)) problems += "Non sono riuscita ad aprire $value sul telefono."
                "open_url" -> if (!AppLauncher.openUrl(this, value)) problems += "Non sono riuscita ad aprire il link sul telefono."
                "phone_task" -> when (PhoneAgent.start(this, value)) {
                    "ok" -> {}
                    "bloccato" -> problems += "Il telefono è bloccato, sbloccalo e riprova."
                    "spento" -> problems += "Sul telefono manca l'accessibilità di Kestra."
                    else -> problems += "Il telefono non è partito."
                }
                "call" -> Dialer.problem(Dialer.call(this, value), value)?.let { problems += it }
            }
        }
        return buildJsonObject {
            put("status", "ok")
            put("say", problems.joinToString(" "))
        }
    }
}
