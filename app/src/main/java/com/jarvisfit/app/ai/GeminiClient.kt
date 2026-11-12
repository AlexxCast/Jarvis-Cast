package com.jarvisfit.app.ai

import com.jarvisfit.app.data.Settings
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.net.HttpURLConnection
import java.net.URL

/** Client minimale per la Gemini API. */
object GeminiClient {
    private val json = Json { ignoreUnknownKeys = true }

    class ApiException(msg: String) : Exception(msg)

    private val FALLBACK_MODELS = listOf(
        "gemini-3.8-flash",
        "gemini-flash-latest",
        "gemini-2.5-flash-lite",
        "gemini-3-pro-preview",
        "gemini-2.5-pro"
    )

    private fun sanitizeModel(raw: String): String {
        var m = raw.trim().removePrefix("models/").removePrefix("models/")
        if (m.isBlank() || m.contains("claude") || m.contains("2.0-flash") || m.contains("1.5-flash")) {
            m = "gemini-3.8-flash"
        }
        return m
    }

    suspend fun send(body: JsonObject): JsonObject = withContext(Dispatchers.IO) {
        val key = Settings.anthropicKey
        if (key.isBlank()) throw ApiException("Manca la API key: inseriscila nel Profilo.")

        val primary = sanitizeModel(Settings.model)
        Settings.model = primary // Corregge automaticamente modelli deprecati salvati nelle impostazioni

        val candidateModels = buildList {
            add(primary)
            FALLBACK_MODELS.forEach { if (it != primary && !contains(it)) add(it) }
        }

        var lastResponse: HttpResponse? = null
        var lastError: Exception? = null

        // 1. Prova la sequenza di modelli predefiniti (Flash + Pro clusters)
        for (model in candidateModels) {
            val maxAttempts = 2
            for (attempt in 1..maxAttempts) {
                val resp = try {
                    executePost(model, key, body)
                } catch (e: java.net.SocketTimeoutException) {
                    lastError = e
                    break // Timeout: passa subito al modello successivo
                } catch (e: Exception) {
                    if (e is kotlinx.coroutines.CancellationException) throw e
                    lastError = e
                    null
                }

                if (resp != null) {
                    // Successo! Risposta valida
                    if (resp.code in 200..299) {
                        return@withContext json.parseToJsonElement(resp.text).jsonObject
                    }

                    // Se 404 (modello deprecato/inesistente): salta subito senza bloccare
                    if (resp.code == 404 || (resp.code == 400 && resp.text.contains("model", ignoreCase = true))) {
                        break
                    }

                    lastResponse = resp

                    // Se è 503 (sovraccarico globale) o 429 (rate limit):
                    if (resp.code == 503 || resp.code == 429) {
                        if (attempt < maxAttempts) {
                            kotlinx.coroutines.delay(1000)
                            continue
                        } else {
                            break // Passa al modello alternativo (cluster diverso)
                        }
                    }

                    // Errori non legati alla saturazione (es. 401/403 chiave errata)
                    val msg = runCatching {
                        json.parseToJsonElement(resp.text).jsonObject["error"]!!.jsonObject["message"]!!.jsonPrimitive.content
                    }.getOrDefault(resp.text.take(300))
                    throw ApiException("Errore API (${resp.code}): $msg")
                } else {
                    break
                }
            }
        }

        // 2. Se tutti i modelli candidati hanno risposto con errore/503, interroga l'API di Google
        // per provare TUTTI i modelli attivi e supportati per questa specifica chiave utente
        val available = fetchAvailableModels(key)
        for (m in available) {
            if (m in candidateModels || m.contains("2.0-flash") || m.contains("1.5-flash")
                || m.contains("embedding") || m.contains("imagen") || m.contains("tts") || m.contains("aqa")) continue
            val discResp = runCatching { executePost(m, key, body) }.getOrNull()
            if (discResp != null && discResp.code in 200..299) {
                Settings.model = m
                return@withContext json.parseToJsonElement(discResp.text).jsonObject
            }
        }

        if (lastResponse != null) {
            val msg = runCatching {
                json.parseToJsonElement(lastResponse.text).jsonObject["error"]!!.jsonObject["message"]!!.jsonPrimitive.content
            }.getOrDefault(lastResponse.text.take(300))
            if (lastResponse.code == 503) {
                throw ApiException("Errore API (503): I server di Google sono temporaneamente sovraccarichi su tutti i cluster. Riprova tra pochi istanti.")
            }
            throw ApiException("Errore API (${lastResponse.code}): $msg")
        }

        if (lastError is java.net.SocketTimeoutException) {
            throw ApiException("Timeout di rete: Google ha impiegato troppo tempo a rispondere. Riprovo...")
        }

        throw ApiException("Errore di connessione: ${lastError?.message ?: "Impossibile contattare i server Google"}")
    }

    private data class HttpResponse(val code: Int, val text: String)

    private fun executePost(model: String, key: String, body: JsonObject): HttpResponse {
        val url = URL("https://generativelanguage.googleapis.com/v1beta/models/$model:generateContent?key=$key")
        val conn = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 15_000
            readTimeout = 25_000
            doOutput = true
            setRequestProperty("content-type", "application/json")
        }
        try {
            conn.outputStream.use { it.write(body.toString().toByteArray()) }
            val code = conn.responseCode
            val text = (if (code in 200..299) conn.inputStream else conn.errorStream)
                ?.bufferedReader()?.use { it.readText() } ?: ""
            return HttpResponse(code, text)
        } finally {
            conn.disconnect()
        }
    }

    private fun fetchAvailableModels(key: String): List<String> {
        return try {
            val url = URL("https://generativelanguage.googleapis.com/v1beta/models?key=$key")
            val conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 15_000
                readTimeout = 15_000
            }
            val code = conn.responseCode
            val text = (if (code in 200..299) conn.inputStream else conn.errorStream)
                ?.bufferedReader()?.use { it.readText() } ?: ""
            conn.disconnect()

            if (code in 200..299) {
                val list = json.parseToJsonElement(text).jsonObject["models"]?.jsonArray ?: return emptyList()
                list.mapNotNull { el ->
                    val obj = el.jsonObject
                    val name = obj["name"]?.jsonPrimitive?.content ?: return@mapNotNull null
                    val methods = obj["supportedGenerationMethods"]?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList()
                    if (methods.contains("generateContent")) name.removePrefix("models/") else null
                }
            } else {
                emptyList()
            }
        } catch (e: Exception) {
            emptyList()
        }
    }

    /** Restituisce l'input del primo functionCall, oppure null. */
    fun toolInput(response: JsonObject): JsonObject? =
        (response["candidates"] as? JsonArray)?.firstOrNull()
            ?.jsonObject?.get("content")?.jsonObject?.get("parts")?.jsonArray?.firstOrNull {
                it.jsonObject.containsKey("functionCall")
            }?.jsonObject?.get("functionCall")?.jsonObject?.get("args")?.jsonObject

    fun text(response: JsonObject): String =
        (response["candidates"] as? JsonArray)?.firstOrNull()
            ?.jsonObject?.get("content")?.jsonObject?.get("parts")?.jsonArray?.mapNotNull { el: JsonElement ->
                el.jsonObject["text"]?.jsonPrimitive?.content
            }?.joinToString("\n") ?: ""
}
