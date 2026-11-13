package com.jarvisfit.app.device

import android.content.Context
import android.content.Intent
import android.net.Uri
import java.text.Normalizer

/** Apre le app installate cercandole per nome ("apri Spotify"). */
object AppLauncher {

    /** Minuscole, senza accenti né simboli: "Wháts-App " diventa "whatsapp". */
    fun normalize(s: String): String =
        Normalizer.normalize(s.lowercase(), Normalizer.Form.NFD).filter { it.isLetterOrDigit() }

    /**
     * Sceglie, tra le etichette delle app, quella che corrisponde meglio al nome richiesto.
     * Ritorna l'indice in [labels] oppure -1. Preferisce: uguale, poi inizia con, poi contiene.
     */
    fun bestMatch(query: String, labels: List<String>): Int {
        val q = normalize(query)
        if (q.length < 2) return -1
        var best = -1
        var bestScore = 0
        labels.forEachIndexed { i, raw ->
            val l = normalize(raw)
            if (l.isEmpty()) return@forEachIndexed
            val score = when {
                l == q -> 1000
                l.startsWith(q) -> 700 - (l.length - q.length)
                q.startsWith(l) && l.length >= 4 -> 600 - (q.length - l.length)
                l.contains(q) -> 400 - (l.length - q.length)
                else -> 0
            }
            if (score > bestScore) { bestScore = score; best = i }
        }
        if (best >= 0 || q.length < 4) return best
        // Nome storpiato ("joytify", "uozzap"): l'etichetta più simile, se lo è abbastanza.
        var bestSim = 0.0
        labels.forEachIndexed { i, raw ->
            val l = normalize(raw)
            if (l.isEmpty()) return@forEachIndexed
            val sim = 1.0 - distance(q, l).toDouble() / maxOf(q.length, l.length)
            if (sim > bestSim) { bestSim = sim; best = i }
        }
        return if (bestSim >= 0.55) best else -1
    }

    /** Distanza di modifica (quante lettere cambiare, togliere o aggiungere). */
    fun distance(a: String, b: String): Int {
        var prev = IntArray(b.length + 1) { it }
        for (i in 1..a.length) {
            val cur = IntArray(b.length + 1)
            cur[0] = i
            for (j in 1..b.length) {
                cur[j] = minOf(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + if (a[i - 1] == b[j - 1]) 0 else 1)
            }
            prev = cur
        }
        return prev[b.length]
    }

    /** Nomi delle app con icona, per farli conoscere a Jarvis. */
    fun installedLabels(ctx: Context): List<String> = runCatching {
        val pm = ctx.packageManager
        val launcher = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        pm.queryIntentActivities(launcher, 0).filter { it.activityInfo.packageName != ctx.packageName }
            .map { it.loadLabel(pm).toString().trim() }.filter { it.isNotEmpty() }.distinct().sorted()
    }.getOrDefault(emptyList())

    /** Ritorna true se l'app è stata trovata e avviata. */
    fun open(ctx: Context, name: String): Boolean {
        return try {
            val pm = ctx.packageManager
            val launcher = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
            val apps = pm.queryIntentActivities(launcher, 0).filter { it.activityInfo.packageName != ctx.packageName }
            val idx = bestMatch(name, apps.map { it.loadLabel(pm).toString() })
            val intent = if (idx >= 0) pm.getLaunchIntentForPackage(apps[idx].activityInfo.packageName) else null
            if (intent == null) {
                false
            } else {
                ctx.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                true
            }
        } catch (e: Exception) {
            false
        }
    }

    fun openUrl(ctx: Context, url: String): Boolean {
        if (!url.startsWith("https://", ignoreCase = true)) return false
        return try {
            ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            true
        } catch (e: Exception) {
            false
        }
    }
}
