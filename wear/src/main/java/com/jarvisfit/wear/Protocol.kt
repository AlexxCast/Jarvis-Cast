package com.jarvisfit.wear

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

/**
 * Formato dei messaggi tra orologio, server e telefono. Logica pura, senza Android: si prova con i test.
 * Gli stessi percorsi sono in app/.../device/WatchLink.kt sul telefono.
 */
object Protocol {
    const val PATH_CONFIG = "/kestra/config"
    const val PATH_CONFIG_REQUEST = "/kestra/config-request"
    const val PATH_DEVICE = "/kestra/device"
    const val PATH_DEVICE_RESULT = "/kestra/device-result"

    private val json = Json { ignoreUnknownKeys = true }

    /** Azioni che il server chiede al telefono: solo queste si possono fare dall'orologio. */
    val PHONE_ACTIONS = setOf("open_app", "open_url", "phone_task", "call")

    data class Reply(
        val text: String,
        val expectReply: Boolean,
        val ignored: Boolean,
        val phone: List<Pair<String, String>>,
    )

    private fun str(o: JsonObject, key: String): String = (o[key] as? JsonPrimitive)?.contentOrNull ?: ""

    /** Risposta di /api/chat. */
    fun parseReply(body: String): Reply {
        val o = runCatching { json.parseToJsonElement(body).jsonObject }.getOrNull()
            ?: return Reply("Risposta del server non valida.", false, false, emptyList())
        if ((o["ignored"] as? JsonPrimitive)?.booleanOrNull == true) return Reply("", false, true, emptyList())
        val phone = (o["device"] as? JsonArray)?.mapNotNull { el ->
            val a = el as? JsonObject ?: return@mapNotNull null
            val type = str(a, "type")
            if (type !in PHONE_ACTIONS) return@mapNotNull null
            val value = when (type) {
                "open_url" -> str(a, "url")
                "phone_task" -> str(a, "goal")
                else -> str(a, "name")
            }
            if (value.isBlank()) null else type to value
        } ?: emptyList()
        return Reply(
            text = str(o, "reply").ifBlank { if (phone.isEmpty()) "Fatto." else "" },
            expectReply = (o["expectReply"] as? JsonPrimitive)?.booleanOrNull ?: false,
            ignored = false,
            phone = phone,
        )
    }

    fun deviceRequest(id: String, actions: List<Pair<String, String>>, password: String?): String = buildJsonObject {
        put("id", id)
        put("actions", JsonArray(actions.map { (t, v) -> buildJsonObject { put("type", t); put("value", v) } }))
        if (password != null) put("password", password)
    }.toString()

    data class DeviceResult(val id: String, val status: String, val say: String)

    /** status: ok, password (serve la parola d'ordine), wrong (parola sbagliata), error. */
    fun parseDeviceResult(body: String): DeviceResult {
        val o = runCatching { json.parseToJsonElement(body).jsonObject }.getOrNull() ?: return DeviceResult("", "error", "")
        return DeviceResult(str(o, "id"), str(o, "status").ifBlank { "error" }, str(o, "say"))
    }

    /** Frasi con cui si chiude la conversazione dall'orologio. */
    fun isGoodbye(text: String): Boolean {
        val t = text.lowercase().trim().trimEnd('.', '!', ' ')
        return t in setOf("basta", "stop", "grazie", "grazie kestra", "ok grazie", "niente", "a posto", "fine", "ciao", "ciao kestra", "va bene grazie")
    }
}
