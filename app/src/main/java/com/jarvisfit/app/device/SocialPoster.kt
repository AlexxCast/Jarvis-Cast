package com.jarvisfit.app.device

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.FileProvider
import com.jarvisfit.app.JarvisApp
import com.jarvisfit.app.R
import com.jarvisfit.app.net.Cloud
import com.jarvisfit.app.voice.Speaker
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * Monomythos: quando Centro social ha un post che non riesce a pubblicare da solo (TikTok nella posta,
 * Instagram senza chiavi Meta), Kestra lo pubblica dal telefono come farebbe il Capo:
 * salva il video in galleria, copia il testo giusto negli appunti, lo condivide all'app, incolla
 * il testo e pubblica. Dopo Instagram fa gli screenshot delle statistiche e li carica in Centro social.
 *
 * Pubblicare non si può annullare: di base Kestra chiede con una notifica ("Pubblica" / "Salta").
 * Senza chiedere solo se il Capo lo ha scelto in Impostazioni › Monomythos.
 */
object SocialPoster {
    const val ACTION_PUBLISH = "com.jarvisfit.app.SOCIAL_PUBLISH"
    const val ACTION_SKIP = "com.jarvisfit.app.SOCIAL_SKIP"
    private const val NOTIF_BASE = 5300
    private val PACKAGES = mapOf(
        "tiktok" to listOf("com.zhiliaoapp.musically", "com.ss.android.ugc.trill"),
        "instagram" to listOf("com.instagram.android"),
    )
    private val NAMES = mapOf("tiktok" to "TikTok", "instagram" to "Instagram")
    /** Un post alla volta: TikTok e Instagram non si accavallano. */
    private val lock = Mutex()
    /** Stesso post arrivato due volte (servizio e pagina leggono lo stesso avviso): si offre una volta sola ogni 10 minuti. */
    private val seen = mutableMapOf<String, Long>()

    private fun notifId(key: String, platform: String) = NOTIF_BASE + ((key + platform).hashCode() and 0x1ff)

    /** Il server ha trovato un post nuovo ([SOCIAL_POST:key|platform] nell'inbox). */
    fun offer(ctx: Context, key: String, platform: String) {
        val app = ctx.applicationContext
        val now = System.currentTimeMillis()
        synchronized(seen) {
            if (now - (seen["$key|$platform"] ?: 0L) < 10 * 60_000L) return
            seen["$key|$platform"] = now
        }
        JarvisApp.scope.launch {
            val post = Cloud.socialItem(key, platform) ?: return@launch
            // Automatico solo se il Capo l'ha scelto e il telefono si può usare adesso; altrimenti si chiede.
            if (post.auto && PhoneAgent.notReady(app) == null) publish(app, post, confirmed = true)
            else ask(app, post, PhoneAgent.notReady(app))
        }
    }

    /** Dalla notifica: "Pubblica" (conferma del Capo) o "Salta". */
    fun onAction(ctx: Context, action: String, key: String, platform: String) {
        val app = ctx.applicationContext
        NotificationManagerCompat.from(app).cancel(notifId(key, platform))
        JarvisApp.scope.launch {
            if (action == ACTION_SKIP) { Cloud.socialDone(key, platform, false, "saltato dal Capo"); return@launch }
            val post = Cloud.socialItem(key, platform) ?: run { info(app, notifId(key, platform), "Questo post non c'è più: forse è già stato pubblicato."); return@launch }
            publish(app, post, confirmed = true)
        }
    }

    private fun ask(ctx: Context, post: Cloud.SocialPost, why: String?) {
        val id = notifId(post.key, post.platform)
        fun pi(action: String, code: Int) = PendingIntent.getBroadcast(ctx, id * 2 + code,
            Intent(ctx, SocialReceiver::class.java).setAction(action).putExtra("key", post.key).putExtra("platform", post.platform),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val name = NAMES[post.platform] ?: post.platform
        val text = "«${post.title}»\n\n${post.caption.take(300)}" + (why?.let { "\n\nPer pubblicare: $it." } ?: "")
        val publish = NotificationCompat.Action.Builder(0, "Pubblica", pi(ACTION_PUBLISH, 0))
            .setAuthenticationRequired(true) // si sblocca il telefono prima: serve lo schermo libero
            .build()
        val n = NotificationCompat.Builder(ctx, JarvisApp.CH_POPUP)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Post Monomythos pronto per $name")
            .setContentText(post.title)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .addAction(publish)
            .addAction(0, "Salta", pi(ACTION_SKIP, 1))
            .build()
        runCatching { NotificationManagerCompat.from(ctx).notify(id, n) }
    }

    private fun info(ctx: Context, id: Int, text: String) {
        val n = NotificationCompat.Builder(ctx, JarvisApp.CH_POPUP)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Monomythos")
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setAutoCancel(true)
            .build()
        runCatching { NotificationManagerCompat.from(ctx).notify(id, n) }
    }

    private suspend fun publish(ctx: Context, post: Cloud.SocialPost, confirmed: Boolean) = lock.withLock {
        val id = notifId(post.key, post.platform)
        val name = NAMES[post.platform] ?: post.platform
        PhoneAgent.notReady(ctx)?.let { ask(ctx, post, it); return@withLock }
        val pkg = PACKAGES[post.platform].orEmpty().firstOrNull { installed(ctx, it) }
            ?: run { fail(ctx, post, id, "$name non è installata sul telefono"); return@withLock }
        Speaker.init(ctx)
        Speaker.speak("Pubblico il post di Monomythos su $name.")
        val uri = withContext(Dispatchers.IO) { runCatching { download(ctx, post) }.getOrNull() }
            ?: run { fail(ctx, post, id, "non riesco a scaricare il video"); return@withLock }
        // Il testo giusto per questo social negli appunti: poi si incolla, come a mano.
        runCatching { ctx.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText("Monomythos", post.caption)) }
        val share = Intent(Intent.ACTION_SEND).setType("video/mp4").setPackage(pkg)
            .putExtra(Intent.EXTRA_STREAM, uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        if (runCatching { ctx.startActivity(share) }.isFailure) { fail(ctx, post, id, "$name non accetta il video condiviso"); return@withLock }
        delay(4_000) // l'editor dell'app si apre e carica il video
        val out = PhoneAgent.runTask(ctx, goalFor(post), confirmed = confirmed, clip = post.caption, speakEnd = false)
        if (!out.ok) { fail(ctx, post, id, out.say.ifBlank { "mi sono fermata a metà" }); return@withLock }
        Cloud.socialDone(post.key, post.platform, true, out.say)
        info(ctx, id, "Pubblicato su $name: «${post.title}».")
        Speaker.speak("Fatto, il post è su $name.")
        if (post.platform == "instagram" && post.stats) stats(ctx, id)
        Unit
    }

    private suspend fun fail(ctx: Context, post: Cloud.SocialPost, id: Int, why: String) {
        Cloud.socialDone(post.key, post.platform, false, why)
        // Il post resta da fare: la notifica permette di riprovare.
        ask(ctx, post, "ultimo tentativo non riuscito ($why)")
        Speaker.speak("Non sono riuscita a pubblicare su ${NAMES[post.platform] ?: post.platform}: $why.")
    }

    /** Obiettivo per l'agente: il video è già nell'app, il testo è negli appunti. */
    fun goalFor(post: Cloud.SocialPost): String {
        val common = "Il testo della descrizione è già negli appunti: nel campo della descrizione/didascalia usa la mossa paste, non scriverlo a mano e non cambiarlo. " +
            "Non aggiungere suoni, filtri, effetti, tag o luoghi e non toccare le impostazioni. Se compare una finestra di benvenuto o un suggerimento, chiudila. " +
            "Pubblica solo questo video: è il compito che il Capo ha confermato."
        return when (post.platform) {
            "tiktok" -> "Pubblica su TikTok il video di Monomythos «${post.title}». Il video è già stato condiviso a TikTok e si sta aprendo il suo editor. " +
                "Vai avanti con Avanti/Next senza modificare il video fino alla schermata con il campo della descrizione. $common Poi tocca Pubblica (Post) e chiudi con done quando il video è in caricamento o pubblicato."
            else -> "Pubblica su Instagram come Reel il video di Monomythos «${post.title}». Il video è già stato condiviso a Instagram. " +
                "Se Instagram chiede dove condividerlo scegli Reel (se non c'è, Post/Feed; mai Storia né Messaggi). Vai avanti con Avanti/Next senza modificare il video fino alla schermata della didascalia. $common Poi tocca Condividi (Share) e chiudi con done quando il reel è in caricamento o pubblicato."
        }
    }

    private const val STATS_GOAL = "Apri Instagram e vai alle statistiche del profilo: tocca il tuo profilo (icona in basso a destra), poi Dashboard professionale o Statistiche/Insight, " +
        "e apri la panoramica degli ultimi 7 o 30 giorni (account raggiunti, interazioni, follower). Fermati con done appena i numeri sono sullo schermo. " +
        "Solo lettura: non pubblicare, non promuovere, non modificare nulla e non toccare Metti in evidenza/Boost."

    /** Screenshot delle statistiche di Instagram e caricamento nella sezione apposita di Centro social. */
    private suspend fun stats(ctx: Context, id: Int) {
        delay(20_000) // lascia finire il caricamento del reel
        val out = PhoneAgent.runTask(ctx, STATS_GOAL, speakEnd = false)
        if (!out.ok) { info(ctx, id + 1, "Statistiche Instagram non prese: ${out.say}"); return }
        val svc = JarvisAccessibility.instance ?: return
        val shots = mutableListOf<String>()
        delay(1_500)
        svc.capture()?.let { shots += jpeg(it) }
        svc.scroll(null, down = true)
        delay(1_800)
        svc.capture()?.let { shots += jpeg(it) }
        if (shots.isEmpty()) { info(ctx, id + 1, "Non riesco a fare lo screenshot (serve Android 11 o più e Kestra riattivata in Accessibilità)."); return }
        val err = Cloud.socialStats(shots)
        info(ctx, id + 1, if (err == null) "Statistiche Instagram caricate in Centro social (${shots.size} screenshot)." else "Statistiche non caricate: $err")
        svc.home()
    }

    private fun jpeg(src: Bitmap): String {
        val w = src.width.coerceAtMost(1080)
        val bmp = if (src.width > w) Bitmap.createScaledBitmap(src, w, (src.height * w.toFloat() / src.width).toInt(), true) else src
        val out = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.JPEG, 82, out)
        return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }

    private fun installed(ctx: Context, pkg: String) = runCatching { ctx.packageManager.getPackageInfo(pkg, 0); true }.getOrDefault(false)

    /** Scarica il video nella galleria (Film › Monomythos) e ritorna l'indirizzo da condividere. */
    private fun download(ctx: Context, post: Cloud.SocialPost): Uri {
        val name = "monomythos_" + post.key.substringBefore('@').replace(Regex("[^\\w-]"), "_") + ".mp4"
        val conn = (URL(post.video).openConnection() as HttpURLConnection).apply { connectTimeout = 20_000; readTimeout = 60_000; instanceFollowRedirects = true }
        try {
            if (conn.responseCode !in 200..299) error("download ${conn.responseCode}")
            if (Build.VERSION.SDK_INT >= 29) {
                val values = ContentValues().apply {
                    put(MediaStore.Video.Media.DISPLAY_NAME, name)
                    put(MediaStore.Video.Media.MIME_TYPE, "video/mp4")
                    put(MediaStore.Video.Media.RELATIVE_PATH, Environment.DIRECTORY_MOVIES + "/Monomythos")
                    put(MediaStore.Video.Media.IS_PENDING, 1)
                }
                val resolver = ctx.contentResolver
                val uri = resolver.insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, values) ?: error("galleria non disponibile")
                resolver.openOutputStream(uri)!!.use { out -> conn.inputStream.use { it.copyTo(out) } }
                resolver.update(uri, ContentValues().apply { put(MediaStore.Video.Media.IS_PENDING, 0) }, null, null)
                return uri
            }
            val dir = ctx.getExternalFilesDir(Environment.DIRECTORY_MOVIES) ?: error("memoria non disponibile")
            val file = File(dir, name)
            file.outputStream().use { out -> conn.inputStream.use { it.copyTo(out) } }
            return FileProvider.getUriForFile(ctx, ctx.packageName + ".fileprovider", file)
        } finally {
            conn.disconnect()
        }
    }
}

class SocialReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val key = intent.getStringExtra("key") ?: return
        val platform = intent.getStringExtra("platform") ?: return
        SocialPoster.onAction(ctx, intent.action ?: return, key, platform)
    }
}
