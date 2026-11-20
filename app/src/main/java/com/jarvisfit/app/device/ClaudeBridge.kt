package com.jarvisfit.app.device

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.graphics.Rect
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.accessibility.AccessibilityNodeInfo
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.jarvisfit.app.JarvisApp
import com.jarvisfit.app.R
import com.jarvisfit.app.voice.JarvisService
import com.jarvisfit.app.voice.Speaker

/**
 * "Modalità Claude": Kestra fa da voce all'app ufficiale di Claude (dove la voce non funziona dentro i progetti).
 *
 *  - Legge ad alta voce ogni risposta NUOVA di Claude (inglese con voce inglese), un paragrafo alla volta
 *    appena è finito, senza aspettare la fine di tutta la risposta.
 *  - Scrive nella casella di Claude ciò che Alessio detta e preme invia.
 *  - Lavora solo sullo schermo del telefono, con l'Accessibilità "Kestra: usa il telefono": niente accesso
 *    all'account Claude, niente server. Agisce solo quando in primo piano c'è l'app di Claude.
 *
 * Si accende con "Kestra, modalità Claude" e si spegne con "basta" / "stop" / "esci", dalla notifica o dopo 30 minuti
 * senza attività. Le risposte che erano già sullo schermo quando parte non vengono mai lette.
 */
object ClaudeBridge {
    private const val NOTIF_ID = 4343
    const val ACTION_STOP = "com.jarvisfit.app.CLAUDE_STOP"
    private const val POLL_MS = 700L
    private const val STABLE_MS = 1_500L
    private const val IDLE_OFF_MS = 30 * 60_000L

    @Volatile var active = false
        private set

    private val main = Handler(Looper.getMainLooper())
    private var appCtx: Context? = null

    // Stato della conversazione
    private val seen = HashSet<String>()
    private var sent: String? = null          // ultimo messaggio di Alessio (dettato o scritto a mano)
    private var sentAt = 0L
    private var reply: List<String> = emptyList()
    private var replySig = ""
    private var replyChangedAt = 0L
    private var spokenParts = 0
    private var lastReply: List<String> = emptyList()

    /** Lingua in cui ascoltare Alessio: quella dell'ultima risposta di Claude (inglese finché non ce n'è una). */
    @Volatile var listenLang: String = "en"
        private set
    private var replyLang = "en"
    private var lastInput = ""
    private var lastActivity = 0L
    private var baselined = false

    // Voce
    private val queue = ArrayDeque<String>()
    private var speaking = false
    private var speakToken = 0                // la voce può essere interrotta da fuori (es. "Kestra"): si riparte senza doppioni
    private var turnDone = false

    // Diagnosi in Impostazioni › Stato
    @Volatile var info: String = ""
        private set
    @Volatile var readCount = 0
        private set
    @Volatile var sentCount = 0
        private set

    // ---------------------------------------------------------------- accensione

    /** Accende il ponte. Ritorna la frase da dire. */
    fun start(ctx: Context): String {
        val app = ctx.applicationContext
        appCtx = app
        if (JarvisAccessibility.instance == null) {
            info = "spenta: manca l'Accessibilità"
            return "Per la modalità Claude devo essere attivata in Impostazioni, Accessibilità, Kestra usa il telefono."
        }
        if (app.packageManager.getLaunchIntentForPackage(ClaudeChat.PACKAGE) == null) {
            info = "spenta: app di Claude non trovata"
            return "Non trovo l'app di Claude su questo telefono."
        }
        active = true
        seen.clear(); sent = null; reply = emptyList(); spokenParts = 0; lastReply = emptyList()
        queue.clear(); speaking = false; turnDone = false; baselined = false; lastInput = ""; listenLang = "en"
        lastActivity = System.currentTimeMillis()
        info = "attiva, in attesa dell'app di Claude"
        openClaude(app)
        notify(app)
        main.removeCallbacks(poll)
        main.postDelayed(poll, 1_200L)
        return "Modalità Claude attiva. Leggo le nuove risposte; quando ho finito, detta pure in inglese. Per uscire dimmi basta."
    }

    fun stop(ctx: Context? = appCtx) {
        if (!active) return
        active = false
        main.removeCallbacks(poll)
        hush()
        info = "spenta"
        ctx?.let { NotificationManagerCompat.from(it).cancel(NOTIF_ID) }
    }

    /** Kestra sta per cambiare chat o progetto: il messaggio in attesa non conta più, la nuova chat sarà "già vista". */
    fun navigating() {
        hush()
        sent = null
        reply = emptyList(); replySig = ""; spokenParts = 0; turnDone = true
        lastActivity = System.currentTimeMillis()
    }

    /** Smette di leggere (Alessio sta parlando). La risposta resta segnata come letta. */
    fun hush() {
        queue.clear()
        speakToken++
        if (speaking) Speaker.stop()
        speaking = false
    }

    /** Rilegge l'ultima risposta di Claude. */
    fun repeat(): Boolean {
        val last = (if (reply.isNotEmpty()) reply else lastReply)
        if (last.isEmpty()) return false
        lastActivity = System.currentTimeMillis()
        queue.clear()
        queue.addAll(ClaudeChat.chunks(last))
        turnDone = true
        if (!speaking) speakNext()
        return true
    }

    /** Chiamato dall'Accessibilità quando cambia lo schermo dell'app di Claude: controllo anticipato. */
    fun onScreenChanged(pkg: CharSequence?) {
        if (!active || pkg?.toString() != ClaudeChat.PACKAGE) return
        main.removeCallbacks(poll)
        main.postDelayed(poll, 250L)
    }

    private fun openClaude(ctx: Context) {
        if (foregroundRoot() != null) return
        val launch = ctx.packageManager.getLaunchIntentForPackage(ClaudeChat.PACKAGE) ?: return
        runCatching { ctx.startActivity(launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)) }
    }

    // ---------------------------------------------------------------- lettura dello schermo

    private class Shot(
        val blocks: List<ClaudeChat.Block>,
        val input: AccessibilityNodeInfo?,
        val inputText: String,
        val sendButton: AccessibilityNodeInfo?,
        val streaming: Boolean,
    )

    /** La finestra dell'app di Claude, solo se è quella in primo piano. */
    private fun foregroundRoot(): AccessibilityNodeInfo? {
        val svc = JarvisAccessibility.instance ?: return null
        val active = svc.rootInActiveWindow
        if (active?.packageName?.toString() == ClaudeChat.PACKAGE) return active
        // La finestra sopra le app di Kestra non prende il fuoco, ma per sicurezza guardiamo tutte le finestre delle app.
        return runCatching {
            svc.windows.firstOrNull { w ->
                w.type == android.view.accessibility.AccessibilityWindowInfo.TYPE_APPLICATION && w.isActive &&
                    w.root?.packageName?.toString() == ClaudeChat.PACKAGE
            }?.root
        }.getOrNull()
    }

    private fun labelOf(n: AccessibilityNodeInfo): String =
        listOfNotNull(n.text, n.contentDescription).map { it.toString().trim() }.firstOrNull { it.isNotEmpty() }.orEmpty()

    private fun read(root: AccessibilityNodeInfo): Shot {
        // 1. La casella di testo e i pulsanti (invia / interrompi).
        var input: AccessibilityNodeInfo? = null
        var send: AccessibilityNodeInfo? = null
        var streaming = false
        val lists = mutableListOf<Pair<AccessibilityNodeInfo, Int>>()
        fun scan(n: AccessibilityNodeInfo?, depth: Int) {
            if (n == null || depth > 40) return
            if (n.isEditable && input == null) input = n
            if (n.isClickable || n.isEnabled && n.className?.contains("Button") == true) {
                val l = labelOf(n)
                if (ClaudeChat.isStopButton(l)) streaming = true
                if (ClaudeChat.isSendButton(l) && n.isEnabled) send = n
            }
            if (n.isScrollable) lists += n to 0
            for (i in 0 until n.childCount) scan(n.getChild(i), depth + 1)
        }
        scan(root, 0)
        val inputRect = Rect().also { r -> input?.getBoundsInScreen(r) }

        // 2. La lista della conversazione: quella che contiene più testo (non la barra dei modelli o dei progetti).
        fun textIn(n: AccessibilityNodeInfo?, depth: Int = 0): Int {
            if (n == null || depth > 40) return 0
            var c = (n.text?.length ?: 0)
            for (i in 0 until n.childCount) c += textIn(n.getChild(i), depth + 1)
            return c
        }
        val list = lists.map { it.first }.maxByOrNull { textIn(it) }?.takeIf { textIn(it) > 0 }

        // 3. I blocchi di testo in ordine. Anche quelli fuori schermo: una risposta lunga esce dallo schermo mentre arriva.
        val blocks = mutableListOf<ClaudeChat.Block>()
        fun walk(n: AccessibilityNodeInfo?, depth: Int) {
            if (n == null || depth > 40 || blocks.size > 400) return
            if (n.isEditable) return
            if (list == null && !inputRect.isEmpty) {
                // Nessuna lista riconosciuta: si esclude ciò che sta sotto la casella (barra in basso, avvisi).
                val r = Rect().also { n.getBoundsInScreen(it) }
                if (!r.isEmpty && r.top >= inputRect.top) return
            }
            val t = n.text?.toString()?.trim().orEmpty()
            if (t.isNotEmpty()) {
                blocks += ClaudeChat.Block(t, n.isClickable)
                // Un nodo con testo proprio contiene già i figli (testo unito): non si scende per non ripeterlo.
                if (n.isClickable) return
            }
            for (i in 0 until n.childCount) walk(n.getChild(i), depth + 1)
        }
        walk(list ?: root, 0)

        val shown = input?.let { f ->
            val txt = f.text?.toString().orEmpty()
            val hint = f.hintText?.toString().orEmpty()
            if (f.isShowingHintText || txt == hint) "" else txt
        }.orEmpty()
        return Shot(blocks, input, shown, send, streaming)
    }

    // ---------------------------------------------------------------- ciclo

    private val poll = object : Runnable {
        override fun run() {
            if (!active) return
            runCatching { tick() }.onFailure { info = "errore: ${it.message}" }
            if (active) main.postDelayed(this, POLL_MS)
        }
    }

    private fun tick() {
        val ctx = appCtx ?: return
        val now = System.currentTimeMillis()
        if (now - lastActivity > IDLE_OFF_MS && !speaking) {
            stop(ctx)
            Speaker.speak("Esco dalla modalità Claude: nessuna attività da mezz'ora.")
            return
        }
        if (JarvisAccessibility.instance == null) {
            info = "in pausa: l'Accessibilità è stata spenta"
            return
        }
        // La voce è stata fermata da qualcun altro (la callback non arriverà più): si continua con il prossimo pezzo.
        if (speaking && !Speaker.isSpeaking()) { speakToken++; speakNext() }
        val root = foregroundRoot() ?: run { info = "in pausa: l'app di Claude non è in primo piano"; return }
        val v = read(root)

        if (!baselined) {
            // Tutto ciò che c'è già sullo schermo all'accensione è "vecchio": mai letto.
            ClaudeChat.messages(v.blocks).forEach { seen += ClaudeChat.norm(it) }
            baselined = true
            lastInput = v.inputText
            info = "attiva: ${seen.size} messaggi già presenti ignorati" + if (v.input == null) ", ma non trovo la casella di testo" else ""
            return
        }

        // Messaggio scritto a mano da Alessio: la casella si svuota dopo l'invio → è lui il nuovo punto fermo.
        if (lastInput.isNotBlank() && v.inputText.isBlank() && (sent == null || !ClaudeChat.norm(sent!!).startsWith(ClaudeChat.norm(lastInput).take(20)))) {
            newTurn(lastInput)
        }
        lastInput = v.inputText

        val parts = ClaudeChat.update(v.blocks, seen, sent, reply)
        if (parts == null) {
            // Nessun punto fermo e nessuna risposta in attesa: un'altra chat aperta. Il suo contenuto diventa "già visto".
            val waiting = sent != null && now - sentAt < 10 * 60_000L && !turnDone
            if (!waiting && reply.isEmpty()) ClaudeChat.messages(v.blocks).forEach { seen += ClaudeChat.norm(it) }
            return
        }
        lastActivity = now
        val sig = parts.joinToString("\u0001")
        if (sig != replySig) { replySig = sig; replyChangedAt = now }
        reply = parts
        if (turnDone) return
        val stable = now - replyChangedAt >= STABLE_MS
        // Finita: testo fermo e niente tasto "interrompi". Se quel tasto non sparisce mai (etichetta diversa), dopo 12 s si legge comunque.
        val complete = stable && (!v.streaming || now - replyChangedAt >= 12_000L)
        // I paragrafi prima dell'ultimo sono già finiti: si leggono subito (meno attesa con le risposte lunghe).
        val ready = if (complete) parts else parts.dropLast(1)
        // La lingua si decide sull'intera risposta finora: un paragrafo senza indizi prende quella prevalente.
        replyLang = ClaudeChat.language(parts.joinToString(" "))
        if (ready.size > spokenParts) {
            queue.addAll(ClaudeChat.chunks(ready.drop(spokenParts)))
            spokenParts = ready.size
            if (!speaking) speakNext()
        }
        info = if (complete) "attiva: ultima risposta letta" else "attiva: Claude sta scrivendo…"
        if (complete) {
            turnDone = true
            parts.forEach { seen += ClaudeChat.norm(it) }
            lastReply = parts
            listenLang = replyLang
            readCount++
            if (!speaking) speakNext()
        }
    }

    private fun newTurn(text: String) {
        sent = text
        sentAt = System.currentTimeMillis()
        lastActivity = sentAt
        reply = emptyList(); replySig = ""; spokenParts = 0; turnDone = false
        queue.clear()
    }

    private fun speakNext() {
        val ctx = appCtx ?: return
        val next = queue.removeFirstOrNull()
        if (next == null) {
            speaking = false
            // Risposta finita e letta tutta: si ascolta subito Alessio, senza dover dire "Kestra".
            if (active && turnDone) JarvisService.claudeTurn(ctx)
            return
        }
        speaking = true
        val token = ++speakToken
        Speaker.init(ctx)
        Speaker.speak(next, onDone = { main.post { if (token == speakToken) { if (active) speakNext() else speaking = false } } }, preferEnglish = replyLang == "en")
    }

    // ---------------------------------------------------------------- scrittura

    /** Scrive [text] nella casella di Claude e preme invia. Ritorna null se ok, altrimenti il motivo (da dire). */
    fun send(text: String, done: (String?) -> Unit) {
        val ctx = appCtx ?: return done("La modalità Claude non è attiva.")
        lastActivity = System.currentTimeMillis()
        if (JarvisAccessibility.instance == null) return done("Non posso scrivere: l'Accessibilità di Kestra è spenta.")
        hush()
        val root = foregroundRoot()
        if (root == null) {
            openClaude(ctx)
            main.postDelayed({ trySend(text, 0, done) }, 1_500L)
        } else trySend(text, 0, done)
    }

    private fun trySend(text: String, attempt: Int, done: (String?) -> Unit) {
        val root = foregroundRoot() ?: return done("L'app di Claude non è in primo piano, non scrivo.")
        val v = read(root)
        val field = v.input ?: return if (attempt < 2) { main.postDelayed({ trySend(text, attempt + 1, done) }, 700L); Unit } else done("Non trovo la casella di testo di Claude.")
        field.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
        field.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        val args = Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text) }
        if (!field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) {
            val cm = ctx().getSystemService(android.content.ClipboardManager::class.java)
            cm?.setPrimaryClip(android.content.ClipData.newPlainText("kestra", text))
            if (!field.performAction(AccessibilityNodeInfo.ACTION_PASTE)) return done("Non riesco a scrivere nella casella di Claude.")
        }
        newTurn(text)
        lastInput = text
        // Il tasto invia compare (o si abilita) solo dopo che c'è del testo: lo si cerca un attimo dopo.
        main.postDelayed({ pressSend(0, done) }, 450L)
    }

    private fun pressSend(attempt: Int, done: (String?) -> Unit) {
        val root = foregroundRoot() ?: return done("L'app di Claude non è più in primo piano: il testo è scritto ma non inviato.")
        val v = read(root)
        val btn = v.sendButton
        if (btn != null && btn.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
            sentCount++
            info = "attiva: messaggio inviato, aspetto la risposta"
            return done(null)
        }
        if (attempt < 3) { main.postDelayed({ pressSend(attempt + 1, done) }, 500L); return }
        info = "non trovo il tasto invia"
        done("Ho scritto il messaggio ma non trovo il tasto invia: premilo tu.")
    }

    private fun ctx(): Context = appCtx!!

    // ---------------------------------------------------------------- notifica

    private fun notify(ctx: Context) {
        val stop = PendingIntent.getBroadcast(ctx, 43, Intent(ctx, ClaudeStopReceiver::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE)
        val b = NotificationCompat.Builder(ctx, JarvisApp.CH_POPUP)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Modalità Claude attiva")
            .setContentText("Kestra legge le risposte di Claude e scrive ciò che detti.")
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .addAction(0, "Esci", stop)
        runCatching { NotificationManagerCompat.from(ctx).notify(NOTIF_ID, b.build()) }
    }
}

class ClaudeStopReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action == ClaudeBridge.ACTION_STOP) ClaudeBridge.stop(ctx.applicationContext)
    }
}
