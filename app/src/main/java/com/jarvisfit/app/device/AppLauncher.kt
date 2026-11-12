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
        return best
    }

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
