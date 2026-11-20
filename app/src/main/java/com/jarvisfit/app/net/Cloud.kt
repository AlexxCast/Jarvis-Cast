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
    /**
     * [followup] = frase sentita a conversazione aperta senza dire "Kestra": il server decide se era
     * rivolta all'assistente o era la TV / altre persone (in quel caso risponde ignored = true e non dice nulla).
     */
    suspend fun chat(text: String, followup: Boolean = false, afterWake: Boolean = false, media: Boolean = false): Brain.Reply = withContext(Dispatchers.IO) {
        try {
            val o = request("POST", "/api/chat", buildJsonObject {
                put("text", text)
                put("source", "voice")
                if (followup) put("followup", true)
                // Prima frase dopo il nome sentito dal modello: il server scarta TV/video (falso allarme).
                if (afterWake) put("afterWake", true)
                if (afterWake && media) put("media", true)
            })
            // Lingua e pause per la prossima frase: in inglese con pause lunghe durante la lezione di inglese.
            (o["listen"] as? JsonObject)?.let { l ->
                com.jarvisfit.app.voice.ListenMode.update(str(l, "lang"), str(l, "alt"), (l["silenceMs"] as? JsonPrimitive)?.content?.toLongOrNull() ?: 0L)
            }
            if ((o["ignored"] as? JsonPrimitive)?.booleanOrNull == true) return@withContext Brain.Reply("", false, null, null, ignored = true)
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
                        "save_place", "call" -> str(a, "name").ifBlank { null }?.let { type to it }
                        "phone_task" -> str(a, "goal").ifBlank { null }?.let { type to it }
                        "visual" -> (a["data"] as? JsonObject)?.let { type to it.toString() }
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

    /** Una notifica del telefono letta da KestraNotifications. */
    data class PhoneNotification(val app: String, val label: String, val title: String, val text: String, val at: Long)

    /** Manda al server un gruppo di notifiche. Silenzioso: se il server non risponde non succede nulla. */
    suspend fun notify(items: List<PhoneNotification>) = withContext(Dispatchers.IO) {
        runCatching {
            request("POST", "/api/notify", buildJsonObject {
                put("items", JsonArray(items.map { n ->
                    buildJsonObject { put("app", n.app); put("label", n.label); put("title", n.title); put("text", n.text); put("at", n.at) }
                }))
            }, readTimeoutMs = 20_000)
        }
    }

    /** Avvisi da consegnare e tra quanti ms scade il prossimo promemoria (null se non ce ne sono). */
    data class Inbox(val items: List<String>, val nextInMs: Long?)

    /** Promemoria scaduti e avvisi di compiti completati non ancora consegnati. */
    suspend fun consumeInbox(): Inbox = withContext(Dispatchers.IO) {
        runCatching {
            val o = request("POST", "/api/inbox/consume", JsonObject(emptyMap()), readTimeoutMs = 20_000)
            Inbox(
                (o["items"] as? JsonArray)?.mapNotNull { el -> (el as? JsonObject)?.let { str(it, "text") }?.ifBlank { null } } ?: emptyList(),
                (o["nextInMs"] as? JsonPrimitive)?.contentOrNull?.toDoubleOrNull()?.toLong(),
            )
        }.getOrDefault(Inbox(emptyList(), null))
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

    data class PhoneMove(val kind: String, val n: Int?, val text: String, val dir: String, val say: String)

    /** Una mossa per il controllo del telefono: mandiamo lo schermo, il server sceglie cosa fare. */
    suspend fun phoneStep(goal: String, step: Int, history: List<String>, screen: com.jarvisfit.app.device.JarvisAccessibility.Screen, confirmed: Boolean = false): PhoneMove =
        withContext(Dispatchers.IO) {
            try {
                val o = request("POST", "/api/phone/step", buildJsonObject {
                    put("goal", goal)
                    put("step", step)
                    // Senza conferma prima di inviare o chiamare solo se il telefono ha appena riconosciuto la voce del Capo.
                    put("voiceTrusted", com.jarvisfit.app.voice.VoiceId.isTrusted())
                    // Il Capo ha già confermato questo compito con un tocco (es. "Pubblica" su un post di Monomythos).
                    if (confirmed) put("confirmed", true)
                    put("history", JsonArray(history.map { JsonPrimitive(it) }))
                    put("screen", buildJsonObject {
                        put("app", screen.app)
                        put("items", JsonArray(screen.items.map { i ->
                            buildJsonObject { put("n", i.n); put("kind", i.kind); put("text", i.text) }
                        }))
                    })
                }, readTimeoutMs = 45_000)
                PhoneMove(
                    kind = str(o, "do").ifBlank { "ask" },
                    n = (o["n"] as? JsonPrimitive)?.contentOrNull?.toIntOrNull(),
                    text = str(o, "text"),
                    dir = str(o, "dir"),
                    say = str(o, "say"),
                )
            } catch (e: Exception) {
                PhoneMove("ask", null, "", "", "Non riesco a contattare il server: ${e.message ?: "errore di rete"}.")
            }
        }

    // ---------------------------------------------------------------- Monomythos (Centro social)

    data class SocialPost(val key: String, val platform: String, val title: String, val video: String, val caption: String, val auto: Boolean, val stats: Boolean)

    /** Dettagli di un post da pubblicare (null se non c'è più o il server non risponde). */
    suspend fun socialItem(key: String, platform: String): SocialPost? = withContext(Dispatchers.IO) {
        runCatching {
            val q = "key=" + java.net.URLEncoder.encode(key, "UTF-8") + "&platform=" + java.net.URLEncoder.encode(platform, "UTF-8")
            val o = request("GET", "/api/social/item?$q", readTimeoutMs = 30_000)
            SocialPost(str(o, "key"), str(o, "platform"), str(o, "title"), str(o, "video"), str(o, "caption"),
                (o["auto"] as? JsonPrimitive)?.booleanOrNull == true, (o["stats"] as? JsonPrimitive)?.booleanOrNull != false)
        }.getOrNull()
    }

    suspend fun socialDone(key: String, platform: String, ok: Boolean, note: String) = withContext(Dispatchers.IO) {
        runCatching { request("POST", "/api/social/done", buildJsonObject { put("key", key); put("platform", platform); put("ok", ok); put("note", note.take(200)) }, readTimeoutMs = 30_000) }
        Unit
    }

    /** Carica gli screenshot (JPEG in base64) nella sezione statistiche di Centro social. Ritorna l'errore o null. */
    suspend fun socialStats(images: List<String>): String? = withContext(Dispatchers.IO) {
        runCatching { request("POST", "/api/social/stats", buildJsonObject { put("images", JsonArray(images.map { JsonPrimitive(it) })) }, readTimeoutMs = 60_000); null }
            .getOrElse { it.message ?: "errore" }
    }

    /** Elenco delle app installate, così Jarvis capisce anche i nomi detti male. */
    suspend fun sendApps(apps: List<String>) = withContext(Dispatchers.IO) {
        runCatching { request("POST", "/api/apps", buildJsonObject { put("apps", JsonArray(apps.map { JsonPrimitive(it) })) }, readTimeoutMs = 20_000) }
        Unit
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
