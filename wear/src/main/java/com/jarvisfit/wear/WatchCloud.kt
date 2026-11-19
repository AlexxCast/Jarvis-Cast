package com.jarvisfit.wear

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.net.HttpURLConnection
import java.net.URL

/** Lo stesso server del telefono: /api/chat con la stessa sessione, così la conversazione continua dove l'hai lasciata. */
object WatchCloud {
    suspend fun chat(text: String, followup: Boolean): Protocol.Reply = withContext(Dispatchers.IO) {
        try {
            val body = buildJsonObject {
                put("text", text)
                put("source", "voice")
                if (followup) put("followup", true)
            }.toString()
            val conn = (URL(WatchConfig.url.trimEnd('/') + "/api/chat").openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 15_000
                readTimeout = 75_000
                doOutput = true
                setRequestProperty("authorization", "Bearer ${WatchConfig.token}")
                setRequestProperty("content-type", "application/json")
                setRequestProperty("accept", "application/json")
            }
            try {
                conn.outputStream.use { it.write(body.toByteArray()) }
                val code = conn.responseCode
                val res = (if (code in 200..299) conn.inputStream else conn.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
                when {
                    code == 401 -> Protocol.Reply("Il token non è valido: apri Kestra sul telefono per aggiornarlo.", false, false, emptyList())
                    code !in 200..299 -> Protocol.Reply("Il server ha risposto con un errore $code.", false, false, emptyList())
                    else -> Protocol.parseReply(res)
                }
            } finally {
                conn.disconnect()
            }
        } catch (e: Exception) {
            Protocol.Reply("Non riesco a contattare il server: ${e.message ?: "errore di rete"}.", false, false, emptyList())
        }
    }
}
