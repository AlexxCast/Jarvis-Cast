package com.jarvisfit.app.net

import com.jarvisfit.app.ai.Brain
import com.jarvisfit.app.data.Settings
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import java.net.HttpURLConnection
import java.net.URL

/**
 * Client del server Jarvis (Cloudflare Worker). Il "cervello" vive lì: scelta dei modelli,
 * memoria e diario. Il telefono fa da orecchie, voce e sensori.
 */
object Cloud {
    private val json = Json { ignoreUnknownKeys = true }

    class CloudException(msg: String) : Exception(msg)

    /** Accetta "jarvis.nome.workers.dev" o un URL completo; forza sempre https. */
    fun normalizeUrl(raw: String): String {
        var u = raw.trim().trimEnd('/')
        if (u.isBlank()) return ""
        u = u.removePrefix("http://").removePrefix("https://")
        return "https://$u"
    }

    private fun str(o: JsonObject, key: String): String =
        (o[key] as? JsonPrimitive)?.contentOrNull ?: ""

    private fun request(
        method: String,
        path: String,
        body: JsonObject? = null,
        baseUrl: String = Settings.serverUrl,
        token: String = Settings.serverToken,
        readTimeoutMs: Int = 75_000,
    ): JsonObject {
        val conn = (URL(baseUrl.trimEnd('/') + path).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 15_000
            readTimeout = readTimeoutMs
            setRequestProperty("authorization", "Bearer $token")
            setRequestProperty("accept", "application/json")
            if (body != null) {
                doOutput = true
                setRequestProperty("content-type", "application/json")
            }
        }
        try {
            if (body != null) conn.outputStream.use { it.write(body.toString().toByteArray()) }
            val code = conn.responseCode
            val text = (if (code in 200..299) conn.inputStream else conn.errorStream)
                ?.bufferedReader()?.use { it.readText() } ?: ""
            val obj = runCatching { json.parseToJsonElement(text).jsonObject }.getOrNull()
            if (code !in 200..299) {
                val msg = obj?.let { str(it, "error") }.orEmpty().ifBlank { "errore $code" }
                throw CloudException(if (code == 401) "Token non valido." else msg)
            }
            return obj ?: JsonObject(emptyMap())
        } finally {
            conn.disconnect()
        }
    }

    /** Manda una frase al cervello nel cloud. Non lancia eccezioni: in caso di problemi risponde con un messaggio. */
    suspend fun chat(text: String): Brain.Reply = withContext(Dispatchers.IO) {
        try {
            val o = request("POST", "/api/chat", buildJsonObject {
                put("text", text)
                put("source", "voice")
            })
            Brain.Reply(
                text = str(o, "reply").ifBlank { "Fatto." },
                expectReply = (o["expectReply"] as? JsonPrimitive)?.booleanOrNull ?: false,
                photoRequest = str(o, "photoRequest").ifBlank { null },
                cardInfo = str(o, "card").ifBlank { null },
                device = (o["device"] as? JsonArray)?.mapNotNull { el ->
                    val a = el as? JsonObject ?: return@mapNotNull null
                    when (val type = str(a, "type")) {
                        "open_app" -> str(a, "name").ifBlank { null }?.let { type to it }
                        "open_url" -> str(a, "url").ifBlank { null }?.let { type to it }
                        "save_place" -> str(a, "name").ifBlank { null }?.let { type to it }
                        else -> null
                    }
                } ?: emptyList(),
            )
        } catch (e: Exception) {
            Brain.Reply("Non riesco a contattare il server, signore: ${e.message ?: "errore di rete"}.", false, null, null)
        }
    }

    /** "Jarvis" detto in mezzo a una frase: chiede al server se l'utente si sta rivolgendo a lui. */
    suspend fun addressed(text: String): Boolean? = withContext(Dispatchers.IO) {
        runCatching {
            val o = request("POST", "/api/addressed", buildJsonObject { put("text", text) }, readTimeoutMs = 20_000)
            if ((o["error"] as? JsonPrimitive)?.booleanOrNull == true) null
            else (o["addressed"] as? JsonPrimitive)?.booleanOrNull
        }.getOrNull()
    }

    /** Promemoria scaduti e avvisi di compiti completati non ancora consegnati. */
    suspend fun consumeInbox(): List<String> = withContext(Dispatchers.IO) {
        runCatching {
            val o = request("POST", "/api/inbox/consume", JsonObject(emptyMap()), readTimeoutMs = 20_000)
            (o["items"] as? JsonArray)?.mapNotNull { el -> (el as? JsonObject)?.let { str(it, "text") }?.ifBlank { null } }
                ?: emptyList()
        }.getOrDefault(emptyList())
    }

    /** Salva un luogo; ritorna l'elenco aggiornato dei luoghi (JSON) o null se il server non risponde. */
    suspend fun savePlace(name: String, lat: Double, lon: Double): String? = withContext(Dispatchers.IO) {
        runCatching {
            val o = request("POST", "/api/places", buildJsonObject { put("name", name); put("lat", lat); put("lon", lon) }, readTimeoutMs = 20_000)
            (o["places"] as? JsonArray)?.toString()
        }.getOrNull()
    }

    /** Arrivo/uscita da un luogo: il server risponde con i promemoria da mostrare. */
    suspend fun placeEvent(place: String, event: String): List<String> = withContext(Dispatchers.IO) {
        runCatching {
            val o = request("POST", "/api/place-event", buildJsonObject { put("place", place); put("event", event) }, readTimeoutMs = 8_000)
            (o["items"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull?.ifBlank { null } } ?: emptyList()
        }.getOrDefault(emptyList())
    }

    suspend fun sendSteps(date: String, steps: Int) = withContext(Dispatchers.IO) {
        runCatching {
            request("POST", "/api/steps", buildJsonObject { put("date", date); put("steps", steps) }, readTimeoutMs = 20_000)
        }
        Unit
    }

    /** Verifica indirizzo e token. Ritorna null se va tutto bene, altrimenti il messaggio di errore. */
    suspend fun check(baseUrl: String, token: String): String? = withContext(Dispatchers.IO) {
        try {
            request("GET", "/api/state", baseUrl = baseUrl, token = token, readTimeoutMs = 20_000)
            null
        } catch (e: Exception) {
            e.message ?: "Server non raggiungibile."
        }
    }
}
