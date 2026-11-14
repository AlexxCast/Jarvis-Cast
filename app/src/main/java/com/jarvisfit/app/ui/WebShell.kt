package com.jarvisfit.app.ui

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import com.jarvisfit.app.data.Settings
import com.jarvisfit.app.device.AppLauncher
import com.jarvisfit.app.device.Places
import com.jarvisfit.app.device.PhoneAgent
import com.jarvisfit.app.device.JarvisAccessibility
import com.jarvisfit.app.data.Store
import com.jarvisfit.app.net.Cloud
import com.jarvisfit.app.voice.JarvisService
import com.jarvisfit.app.voice.JarvisState
import com.jarvisfit.app.voice.Speaker
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Stato condiviso per aprire la finestra "Collega Jarvis Cloud" da qualunque schermata. */
object CloudUi {
    val showSetup = mutableStateOf(false)
}

/**
 * Ponte tra la web app e il telefono: espone solo ciò che il browser non può fare
 * (ascolto in background, voce, contapassi, dati della vecchia app).
 * I metodi sono chiamati da JavaScript su un thread secondario.
 */
class JarvisBridge(
    private val activity: ComponentActivity,
    private val requestListening: () -> Unit,
    private val onDisconnect: () -> Unit,
    private val onRequestLocation: () -> Unit,
) {
    @JavascriptInterface
    fun getConfig(): String = buildJsonObject {
        put("token", Settings.serverToken)
        put("listening", Settings.listeningEnabled)
        put("speakReplies", Settings.speakReplies)
        put("sensitivity", Settings.sensitivity)
        put("micGuard", Settings.micGuard)
        put("overlay", Settings.overlay)
        put("overlayAllowed", com.jarvisfit.app.device.Overlay.allowed(activity))
        put("voiceEnrolled", com.jarvisfit.app.voice.VoiceId.enrolled)
        put("voiceLock", Settings.voiceLock)
        put("voiceStrictness", Settings.voiceStrictness)
        put("voicePhrase", com.jarvisfit.app.voice.VoiceId.PHRASE)
        put("status", JarvisState.status.value.name)
        put("version", runCatching { activity.packageManager.getPackageInfo(activity.packageName, 0).versionName }.getOrNull() ?: "")
    }.toString()

    /** Il diario salvato sul telefono dall'app classica (resta dov'è: viene solo letto). */
    @JavascriptInterface
    fun exportLegacyDiary(): String = Store.exportJson()

    @JavascriptInterface
    fun getSteps(): String {
        val today = Store.today()
        return buildJsonObject {
            put("date", today)
            put("steps", Store.diary.steps[today] ?: 0)
        }.toString()
    }

    @JavascriptInterface
    fun setListening(on: Boolean) = activity.runOnUiThread {
        if (on) requestListening() else JarvisService.stop(activity)
    }

    @JavascriptInterface
    fun setSpeakReplies(on: Boolean) { Settings.speakReplies = on }

    @JavascriptInterface
    fun setMicGuard(on: Boolean) { Settings.micGuard = on }

    @JavascriptInterface
    fun setSensitivity(value: Double) { Settings.sensitivity = value.toFloat().coerceIn(0f, 1f) }

    @JavascriptInterface
    fun speak(text: String) = activity.runOnUiThread { Speaker.speak(text) }

    @JavascriptInterface
    fun listenNow() = activity.runOnUiThread {
        if (Settings.listeningEnabled) JarvisService.listenNow(activity) else requestListening()
    }

    /** "Apri Spotify": cerca l'app per nome e la avvia. */
    @JavascriptInterface
    fun openApp(name: String): Boolean = AppLauncher.open(activity, name)

    @JavascriptInterface
    fun openUrl(url: String): Boolean = AppLauncher.openUrl(activity, url)

    @JavascriptInterface
    fun locationStatus(): String = Places.status(activity)

    @JavascriptInterface
    fun requestLocation() = activity.runOnUiThread { onRequestLocation() }

    @JavascriptInterface
    fun savePlaceHere(name: String): String {
        val st = Places.saveHere(activity, name)
        if (st == "permesso") activity.runOnUiThread { onRequestLocation() }
        return st
    }

    @JavascriptInterface
    fun phoneControlStatus(): Boolean = JarvisAccessibility.enabled(activity)

    @JavascriptInterface
    fun openPhoneControlSettings() = activity.runOnUiThread { PhoneAgent.openSettings(activity) }

    @JavascriptInterface
    fun runPhoneTask(goal: String): String = PhoneAgent.start(activity, goal)

    /** Registra la voce del proprietario (tre frasi). L'esito arriva alla pagina con window.jarvisVoiceEnroll. */
    @JavascriptInterface
    fun enrollVoice() {
        val hasMic = ContextCompat.checkSelfPermission(activity, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        if (!hasMic) { activity.runOnUiThread { androidx.core.app.ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.RECORD_AUDIO), 78) }; onVoiceEnroll("Conceda il microfono a Jarvis e riprovi.", true); return }
        com.jarvisfit.app.JarvisApp.scope.launch {
            // Ferma l'ascolto di "Jarvis" finché registriamo, così il microfono è tutto per la voce.
            val wasListening = Settings.listeningEnabled
            if (wasListening) JarvisService.stop(activity)
            kotlinx.coroutines.delay(600)
            val error = com.jarvisfit.app.voice.VoiceId.enroll(activity) { msg -> onVoiceEnroll(msg, false) }
            if (wasListening) activity.runOnUiThread { JarvisService.start(activity) }
            onVoiceEnroll(error ?: "", true)
        }
    }

    private fun onVoiceEnroll(msg: String, done: Boolean) {
        JarvisState.voiceEnroll.value = "${if (done) "done" else "step"}|$msg|${System.nanoTime()}"
    }

    @JavascriptInterface
    fun setOverlay(on: Boolean) { Settings.overlay = on }

    @JavascriptInterface
    fun openOverlaySettings() = activity.runOnUiThread { com.jarvisfit.app.device.Overlay.openSettings(activity) }

    @JavascriptInterface
    fun setVoiceLock(on: Boolean) { Settings.voiceLock = on && com.jarvisfit.app.voice.VoiceId.enrolled }

    @JavascriptInterface
    fun setVoiceStrictness(value: Double) { Settings.voiceStrictness = value.toFloat() }

    @JavascriptInterface
    fun forgetVoice() = com.jarvisfit.app.voice.VoiceId.forget()

    /** "ok:<nome>", "permesso", "sconosciuto" oppure "errore". Senza permessi li chiede subito. */
    @JavascriptInterface
    fun callContact(who: String): String {
        val r = com.jarvisfit.app.device.Dialer.call(activity, who)
        if (r == "permesso") requestCallPermission()
        return r
    }

    @JavascriptInterface
    fun callPermission(): Boolean = com.jarvisfit.app.device.Dialer.hasPermission(activity)

    @JavascriptInterface
    fun requestCallPermission() = activity.runOnUiThread {
        androidx.core.app.ActivityCompat.requestPermissions(activity, com.jarvisfit.app.device.Dialer.permissions, 77)
    }

    @JavascriptInterface
    fun syncPlaces(json: String) = Places.sync(activity, json)

    @JavascriptInterface
    fun disconnectCloud() = activity.runOnUiThread { onDisconnect() }
}

/** La web app di Jarvis dentro l'app: si aggiorna da sola a ogni pubblicazione, senza reinstallare nulla. */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun WebShell(onDisconnect: () -> Unit) {
    val ctx = LocalContext.current
    val activity = ctx as ComponentActivity
    val serverUrl = remember { Settings.serverUrl }
    val serverHost = remember { Uri.parse(serverUrl).host.orEmpty() }

    // Scelta/scatto di una foto richiesti dalla pagina (<input type="file">)
    var fileCallback by remember { mutableStateOf<ValueCallback<Array<Uri>>?>(null) }
    fun deliver(uri: Uri?) {
        fileCallback?.onReceiveValue(if (uri != null) arrayOf(uri) else null)
        fileCallback = null
    }
    val gallery = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri: Uri? -> deliver(uri) }
    val takePhoto = rememberPhotoTaker("web") { file ->
        deliver(FileProvider.getUriForFile(ctx, ctx.packageName + ".fileprovider", file))
    }

    val listenPerms = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
        if (granted[Manifest.permission.RECORD_AUDIO] == true) JarvisService.start(ctx)
    }
    val requestListening: () -> Unit = {
        val hasMic = ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        if (hasMic) JarvisService.start(ctx) else listenPerms.launch(listeningPermissions())
    }

    // Posizione: prima "mentre usi l'app", poi (Android 10+) "consenti sempre" per gli avvisi ad app chiusa.
    val backgroundLocation = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { Places.register(ctx) }
    val foregroundLocation = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
        if (granted.values.any { it } && Build.VERSION.SDK_INT >= 29) backgroundLocation.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
        Places.register(ctx)
    }
    val requestLocation: () -> Unit = {
        when (Places.status(ctx)) {
            "none" -> foregroundLocation.launch(Places.foregroundPermissions())
            "foreground" -> if (Build.VERSION.SDK_INT >= 29) backgroundLocation.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
        }
    }

    // Jarvis impara i nomi delle app installate (una volta per avvio).
    LaunchedEffect(Unit) { Cloud.sendApps(AppLauncher.installedLabels(ctx)) }

    val webView = remember {
        WebView(ctx).apply {
            // Senza questo la WebView prende l'altezza del contenuto (wrap_content) e la pagina,
            // che a sua volta è alta "il 100% della finestra", resta schiacciata in alto.
            layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = true
            setBackgroundColor(0xFF050F05.toInt())
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    // Il ponte nativo deve restare visibile solo al server di Jarvis: tutto il resto si apre nel browser.
                    val url = request.url
                    if (url.scheme == "https" && url.host == serverHost) return false
                    runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                    return true
                }
            }
            webChromeClient = object : WebChromeClient() {
                override fun onShowFileChooser(
                    view: WebView,
                    callback: ValueCallback<Array<Uri>>,
                    params: WebChromeClient.FileChooserParams,
                ): Boolean {
                    // Una richiesta precedente rimasta senza risposta (es. fotocamera annullata) va chiusa prima.
                    fileCallback?.onReceiveValue(null)
                    fileCallback = callback
                    return runCatching {
                        // Le foto passano dalla fotocamera o dalla galleria; un backup (.json) dal selettore dei file.
                        val wantsImage = params.acceptTypes.orEmpty().all { it.isBlank() || it.startsWith("image/") }
                        when {
                            params.isCaptureEnabled -> takePhoto()
                            wantsImage -> gallery.launch("image/*")
                            else -> gallery.launch("*/*")
                        }
                        true
                    }.getOrElse {
                        deliver(null)
                        false
                    }
                }
            }
            addJavascriptInterface(JarvisBridge(activity, requestListening, onDisconnect, requestLocation), "JarvisNative")
            loadUrl(serverUrl)
        }
    }

    // Dopo ogni scambio vocale la pagina ricarica chat e dati.
    val exchanges by JarvisState.exchanges.collectAsState()
    LaunchedEffect(exchanges) {
        if (exchanges > 0) webView.evaluateJavascript("window.jarvisRefresh && window.jarvisRefresh()", null)
    }
    // La sfera nella pagina segue lo stato del servizio vocale (ascolta, pensa, parla).
    val voiceEnroll by JarvisState.voiceEnroll.collectAsState()
    LaunchedEffect(voiceEnroll) {
        val parts = voiceEnroll.split('|')
        if (parts.size >= 3) {
            val msg = org.json.JSONObject.quote(parts[1])
            webView.evaluateJavascript("window.jarvisVoiceEnroll && window.jarvisVoiceEnroll(${parts[0] == "done"}, $msg)", null)
        }
    }
    val voiceStatus by JarvisState.status.collectAsState()
    LaunchedEffect(voiceStatus) {
        webView.evaluateJavascript("window.jarvisStatus && window.jarvisStatus('${voiceStatus.name}')", null)
    }
    // Se l'ascolto era attivo, riparte insieme all'app.
    LaunchedEffect(Unit) {
        val hasMic = ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        if (Settings.listeningEnabled && hasMic && JarvisState.status.value == JarvisState.Status.OFF) JarvisService.start(ctx)
    }
    BackHandler(enabled = true) {
        if (webView.canGoBack()) webView.goBack() else activity.moveTaskToBack(true)
    }
    DisposableEffect(Unit) {
        onDispose {
            fileCallback?.onReceiveValue(null)
            webView.removeJavascriptInterface("JarvisNative")
            webView.destroy()
        }
    }

    Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).systemBarsPadding().imePadding()) {
        AndroidView(factory = { webView }, modifier = Modifier.fillMaxSize())
    }
}

/** Finestra per collegare l'app al proprio server Jarvis. */
@Composable
fun CloudSetupDialog(onDismiss: () -> Unit, onConnected: () -> Unit) {
    val scope = rememberCoroutineScope()
    var url by remember { mutableStateOf(Settings.serverUrl) }
    var token by remember { mutableStateOf(Settings.serverToken) }
    var message by remember { mutableStateOf("") }
    var checking by remember { mutableStateOf(false) }

    AlertDialog(
        onDismissRequest = { if (!checking) onDismiss() },
        title = { Text("Collega Jarvis Cloud") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(
                    "Con il server Jarvis l'app si aggiorna da sola, ha memoria persistente e sceglie il modello migliore " +
                        "tra quelli gratuiti. I dati di dieta e sport salvati sul telefono vengono copiati sul server, non cancellati.",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                OutlinedTextField(
                    value = url, onValueChange = { url = it }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                    label = { Text("Indirizzo (es. jarvis.nome.workers.dev)") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                )
                OutlinedTextField(
                    value = token, onValueChange = { token = it }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                    label = { Text("Token (JARVIS_TOKEN)") },
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                )
                if (message.isNotBlank()) Text(message, color = MaterialTheme.colorScheme.error)
            }
        },
        confirmButton = {
            TextButton(
                enabled = !checking && url.isNotBlank() && token.isNotBlank(),
                onClick = {
                    checking = true
                    message = ""
                    scope.launch {
                        val clean = Cloud.normalizeUrl(url)
                        val error = Cloud.check(clean, token.trim())
                        checking = false
                        if (error == null) {
                            Settings.serverUrl = clean
                            Settings.serverToken = token
                            onConnected()
                        } else {
                            message = "Collegamento non riuscito: $error"
                        }
                    }
                },
            ) { Text(if (checking) "Verifico…" else "Collega") }
        },
        dismissButton = { TextButton(enabled = !checking, onClick = onDismiss) { Text("Più tardi") } },
    )
}
