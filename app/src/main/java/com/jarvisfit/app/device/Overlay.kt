package com.jarvisfit.app.device

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.PixelFormat
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.Settings as AndroidSettings
import android.view.Gravity
import android.view.WindowManager
import android.webkit.WebView
import android.webkit.WebViewClient
import com.jarvisfit.app.data.Settings
import com.jarvisfit.app.voice.JarvisState
import org.json.JSONObject

/**
 * Jarvis sopra le altre app: una finestra trasparente in alto con la sfera animata (ascolta, pensa,
 * parla), la frase che sta dicendo e le grafiche che vuole mostrare. Non intercetta mai i tocchi,
 * quindi non blocca l'app che si sta usando. Serve il permesso "Mostra sopra altre app".
 */
object Overlay {
    private val main = Handler(Looper.getMainLooper())
    private var view: WebView? = null
    private var ready = false
    private val queue = mutableListOf<String>()
    private var visualUntil = 0L
    private var status = JarvisState.Status.OFF

    /** Vero quando l'app di Jarvis è in primo piano: lì la sfera c'è già, la finestra non serve. */
    @Volatile var appVisible = false

    fun allowed(ctx: Context) = AndroidSettings.canDrawOverlays(ctx)
    fun enabled(ctx: Context) = Settings.overlay && allowed(ctx) && Settings.cloudEnabled

    fun openSettings(ctx: Context) {
        runCatching {
            ctx.startActivity(Intent(AndroidSettings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + ctx.packageName)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun ensure(ctx: Context): WebView? {
        view?.let { return it }
        if (!enabled(ctx)) return null
        val app = ctx.applicationContext
        val wm = app.getSystemService(WindowManager::class.java) ?: return null
        // Senza ponte verso il telefono: la pagina riceve solo stato, frasi e grafiche.
        val web = WebView(app).apply {
            setBackgroundColor(Color.TRANSPARENT)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = false
            settings.allowFileAccess = false
            webViewClient = object : WebViewClient() {
                override fun onPageFinished(v: WebView?, url: String?) {
                    ready = true
                    queue.forEach { evaluateJavascript(it, null) }
                    queue.clear()
                }
            }
        }
        val h = (app.resources.displayMetrics.heightPixels * 0.62).toInt()
        val lp = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT, h,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT,
        ).apply { gravity = Gravity.TOP; y = (app.resources.displayMetrics.density * 28).toInt() }
        return runCatching {
            wm.addView(web, lp)
            ready = false
            web.loadUrl(Settings.serverUrl.trimEnd('/') + "/overlay.html")
            view = web
            web
        }.getOrNull()
    }

    private fun js(ctx: Context, code: String) = main.post {
        val v = ensure(ctx) ?: return@post
        if (ready) v.evaluateJavascript(code, null) else queue += code
    }

    private fun remove(ctx: Context) {
        val v = view ?: return
        view = null
        ready = false
        queue.clear()
        runCatching { ctx.applicationContext.getSystemService(WindowManager::class.java)?.removeView(v) }
        v.destroy()
    }

    private val hideLater = Runnable { tryHide() }
    private var lastCtx: Context? = null

    private fun tryHide() {
        val ctx = lastCtx ?: return
        val busy = status == JarvisState.Status.LISTENING || status == JarvisState.Status.THINKING || status == JarvisState.Status.SPEAKING
        if (!busy && System.currentTimeMillis() >= visualUntil) remove(ctx)
        else main.postDelayed(hideLater, 1500)
    }

    /** Lo stato del servizio vocale cambia: mostra la sfera mentre ascolta, pensa o parla. */
    fun onStatus(ctx: Context, s: JarvisState.Status) {
        status = s
        lastCtx = ctx.applicationContext
        val active = s == JarvisState.Status.LISTENING || s == JarvisState.Status.THINKING || s == JarvisState.Status.SPEAKING
        if (appVisible || !enabled(ctx)) { if (view != null) main.post { remove(ctx) }; return }
        if (active) {
            main.removeCallbacks(hideLater)
            js(ctx, "window.overlay && window.overlay.state('${s.name}')")
        } else if (view != null) {
            js(ctx, "window.overlay && window.overlay.state('${s.name}')")
            main.removeCallbacks(hideLater)
            main.postDelayed(hideLater, 1200)
        }
    }

    /** La frase che Jarvis sta dicendo, sotto la sfera. */
    fun caption(ctx: Context, text: String) {
        if (appVisible || !enabled(ctx)) return
        js(ctx, "window.overlay && window.overlay.caption(${JSONObject.quote(text)})")
    }

    /** Mostra una grafica sopra le altre app. Ritorna false se l'app è aperta o manca il permesso. */
    fun showVisual(ctx: Context, json: String): Boolean {
        if (appVisible || !enabled(ctx)) return false
        lastCtx = ctx.applicationContext
        val seconds = runCatching { JSONObject(json).optInt("seconds", 12) }.getOrDefault(12).coerceIn(4, 60)
        visualUntil = System.currentTimeMillis() + seconds * 1000L + 600
        main.removeCallbacks(hideLater)
        js(ctx, "window.overlay && window.overlay.show($json, $seconds)")
        main.postDelayed(hideLater, seconds * 1000L + 800)
        return true
    }
}
