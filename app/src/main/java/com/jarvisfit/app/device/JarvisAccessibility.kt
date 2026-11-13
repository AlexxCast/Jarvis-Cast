package com.jarvisfit.app.device

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Context
import android.graphics.Path
import android.graphics.Rect
import android.os.Bundle
import android.provider.Settings
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

/**
 * Le "mani e gli occhi" di Jarvis sul telefono. Non fa nulla da solo: legge lo schermo e
 * esegue una mossa solo quando PhoneAgent glielo chiede durante un comando dell'utente.
 */
class JarvisAccessibility : AccessibilityService() {

    data class Item(val n: Int, val kind: String, val text: String)
    data class Screen(val app: String, val items: List<Item>)

    companion object {
        @Volatile var instance: JarvisAccessibility? = null
            private set

        fun enabled(ctx: Context): Boolean {
            if (instance != null) return true
            val list = Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
            return list.split(':').any { it.startsWith(ctx.packageName + "/") }
        }
    }

    /** Elementi dell'ultimo schermo letto, per numero. */
    private var nodes: Map<Int, AccessibilityNodeInfo> = emptyMap()

    override fun onServiceConnected() { instance = this }
    override fun onDestroy() { instance = null; super.onDestroy() }
    override fun onUnbind(intent: android.content.Intent?): Boolean { instance = null; return super.onUnbind(intent) }
    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
    override fun onInterrupt() {}

    private fun label(node: AccessibilityNodeInfo): String {
        val own = listOfNotNull(node.text, node.contentDescription, if (node.isEditable) node.hintText else null)
            .map { it.toString().trim() }.filter { it.isNotEmpty() }.distinct().joinToString(" · ")
        if (own.isNotEmpty()) return own
        // Icone senza testo (es. il tasto invia): il nome tecnico dice spesso cosa sono ("send", "search").
        val id = node.viewIdResourceName?.substringAfter(":id/")?.replace('_', ' ')?.trim().orEmpty()
        if (!node.isClickable) return if (node.isEditable && id.isNotEmpty()) "($id)" else ""
        // Pulsanti "contenitore" (es. una riga di chat): prendiamo i testi dei figli.
        val parts = mutableListOf<String>()
        fun collect(n: AccessibilityNodeInfo?, depth: Int) {
            if (n == null || depth > 4 || parts.size >= 3) return
            (n.text ?: n.contentDescription)?.toString()?.trim()?.takeIf { it.isNotEmpty() }?.let { parts += it }
            for (i in 0 until n.childCount) collect(n.getChild(i), depth + 1)
        }
        for (i in 0 until node.childCount) collect(node.getChild(i), 1)
        return parts.joinToString(" · ").ifEmpty { if (id.isNotEmpty()) "(icona: $id)" else "" }
    }

    fun snapshot(): Screen {
        val root = rootInActiveWindow ?: return Screen("?", emptyList()).also { nodes = emptyMap() }
        val app = root.packageName?.toString().orEmpty()
        val items = mutableListOf<Item>()
        val map = mutableMapOf<Int, AccessibilityNodeInfo>()
        fun walk(node: AccessibilityNodeInfo?) {
            if (node == null || items.size >= 120 || !node.isVisibleToUser) return
            val kind = when {
                node.isEditable -> "campo"
                node.isClickable || node.isCheckable -> if (node.isCheckable) (if (node.isChecked) "spunta sì" else "spunta no") else "pulsante"
                node.isScrollable -> "lista"
                else -> "testo"
            }
            val text = (if (node.isPassword) "(password)" else label(node)) + if (node.isEditable && node.isFocused) " [cursore qui]" else ""
            if (kind != "testo" || text.isNotEmpty()) {
                val n = items.size + 1
                items += Item(n, kind, text.take(160))
                map[n] = node
            }
            for (i in 0 until node.childCount) walk(node.getChild(i))
        }
        walk(root)
        nodes = map
        return Screen(app, items)
    }

    private fun clickable(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        var cur: AccessibilityNodeInfo? = node
        repeat(6) { if (cur?.isClickable == true) return cur; cur = cur?.parent }
        return null
    }

    private fun tapAt(x: Float, y: Float) {
        val path = Path().apply { moveTo(x, y) }
        dispatchGesture(GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path, 0, 60)).build(), null, null)
    }

    /** Ritorna null se ok, altrimenti il motivo per cui non è stato possibile. */
    fun tap(n: Int): String? {
        val node = nodes[n] ?: return "elemento $n non trovato"
        val target = clickable(node)
        if (target != null && target.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return null
        val r = Rect().also { node.getBoundsInScreen(it) }
        if (r.isEmpty) return "elemento $n non visibile"
        tapAt(r.exactCenterX(), r.exactCenterY())
        return null
    }

    fun type(n: Int, text: String): String? {
        val node = nodes[n] ?: return "elemento $n non trovato"
        if (node.isPassword) return "è un campo password: non lo compilo"
        if (!node.isEditable) return "l'elemento $n non è un campo di testo"
        node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        node.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
        val args = Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text) }
        if (node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) return null
        // Alcune app non accettano il testo diretto: lo incolliamo dagli appunti.
        val cm = getSystemService(android.content.ClipboardManager::class.java)
        cm?.setPrimaryClip(android.content.ClipData.newPlainText("jarvis", text))
        return if (node.performAction(AccessibilityNodeInfo.ACTION_PASTE)) null else "non riesco a scrivere nel campo $n"
    }

    fun scroll(n: Int?, down: Boolean): String? {
        val action = if (down) AccessibilityNodeInfo.ACTION_SCROLL_FORWARD else AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
        val node = n?.let { nodes[it] }?.let { var c: AccessibilityNodeInfo? = it; while (c != null && !c.isScrollable) c = c.parent; c }
            ?: nodes.values.firstOrNull { it.isScrollable }
        if (node != null && node.performAction(action)) return null
        // Nessuna lista che scorre: trasciniamo il dito sullo schermo.
        val m = resources.displayMetrics
        val x = m.widthPixels / 2f
        val (y1, y2) = if (down) m.heightPixels * 0.7f to m.heightPixels * 0.3f else m.heightPixels * 0.3f to m.heightPixels * 0.7f
        val path = Path().apply { moveTo(x, y1); lineTo(x, y2) }
        dispatchGesture(GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path, 0, 350)).build(), null, null)
        return null
    }

    fun back() = performGlobalAction(GLOBAL_ACTION_BACK)
    fun home() = performGlobalAction(GLOBAL_ACTION_HOME)
}
