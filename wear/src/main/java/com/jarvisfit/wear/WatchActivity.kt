package com.jarvisfit.wear

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.speech.RecognizerIntent
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import kotlin.math.cos
import kotlin.math.sin

/**
 * La schermata dell'orologio: la sfera verde di Kestra e le ultime parole.
 * Aprirla fa partire subito l'ascolto; un tocco riparte o chiude la conversazione.
 */
class WatchActivity : ComponentActivity() {

    private val askMic = registerForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        if (ok) startTalking()
    }

    /** Orologi senza riconoscimento in background: si usa la finestra vocale del sistema. */
    private val systemVoice = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { res ->
        val text = res.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()
        if (!text.isNullOrBlank()) KestraWatchService.text(this, text)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WatchState.configured.value = WatchConfig.ready
        setContent { Screen(onTap = ::onTap) }
        lifecycleScope.launch {
            WatchState.phase.collect { p ->
                if (p == WatchState.Phase.IDLE) window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                else window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }
        prepareAndTalk()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // Riaperta col tasto o dalla lista app: ascolta di nuovo.
        if (WatchState.phase.value == WatchState.Phase.IDLE) prepareAndTalk()
    }

    private fun prepareAndTalk() {
        lifecycleScope.launch {
            val ready = PhoneLink.syncConfig(this@WatchActivity)
            WatchState.configured.value = ready
            if (ready) startTalking()
        }
    }

    private fun onTap() {
        when {
            !WatchConfig.ready -> prepareAndTalk()
            WatchState.phase.value == WatchState.Phase.IDLE -> startTalking()
            else -> KestraWatchService.stop(this)
        }
    }

    private fun startTalking() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            askMic.launch(Manifest.permission.RECORD_AUDIO)
            return
        }
        if (KestraWatchService.canRecognize(this)) {
            KestraWatchService.talk(this)
        } else {
            runCatching {
                systemVoice.launch(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE, "it-IT")
                    putExtra(RecognizerIntent.EXTRA_PROMPT, "Parla con Kestra")
                })
            }.onFailure { WatchState.reply.value = "Questo orologio non ha il riconoscimento vocale." }
        }
    }
}

private val Green = Color(0xFF22E07A)
private val DarkGreen = Color(0xFF0B3D24)

@Composable
private fun Screen(onTap: () -> Unit) {
    val phase by WatchState.phase.collectAsState()
    val heard by WatchState.heard.collectAsState()
    val reply by WatchState.reply.collectAsState()
    val level by WatchState.level.collectAsState()
    val configured by WatchState.configured.collectAsState()

    Box(
        Modifier
            .fillMaxSize()
            .background(Color(0xFF040806))
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = onTap),
        contentAlignment = Alignment.Center,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.padding(horizontal = 22.dp)) {
            Orb(phase, level)
            Spacer(Modifier.height(8.dp))
            val label = when {
                !configured -> "Apri Kestra sul telefono per collegare l'orologio. Tocca per riprovare."
                phase == WatchState.Phase.LISTENING -> heard.ifBlank { "Ti ascolto…" }
                phase == WatchState.Phase.THINKING -> heard.ifBlank { "Ci penso…" }
                phase == WatchState.Phase.SPEAKING -> reply
                reply.isNotBlank() -> reply
                else -> "Tocca e parla"
            }
            BasicText(
                text = label,
                modifier = Modifier.fillMaxWidth(),
                maxLines = 5,
                overflow = TextOverflow.Ellipsis,
                style = TextStyle(color = if (phase == WatchState.Phase.SPEAKING) Green else Color(0xFFD7F5E3), fontSize = 13.sp, textAlign = TextAlign.Center),
            )
        }
    }
}

/** Sfera di nodi verdi che pulsa: più veloce quando pensa, segue la voce quando ascolta. */
@Composable
private fun Orb(phase: WatchState.Phase, level: Float) {
    val t = rememberInfiniteTransition(label = "orb")
    val speed = when (phase) { WatchState.Phase.THINKING -> 900; WatchState.Phase.SPEAKING -> 1400; else -> 3200 }
    val spin by t.animateFloat(0f, 360f, infiniteRepeatable(tween(speed * 4, easing = LinearEasing)), label = "spin")
    val pulse by t.animateFloat(0f, 1f, infiniteRepeatable(tween(speed, easing = LinearEasing), RepeatMode.Restart), label = "pulse")
    val boost = when (phase) {
        WatchState.Phase.LISTENING -> 0.15f + level * 0.5f
        WatchState.Phase.SPEAKING -> 0.25f
        WatchState.Phase.THINKING -> 0.2f
        WatchState.Phase.IDLE -> 0f
    }
    Canvas(Modifier.size(92.dp)) {
        val c = Offset(size.width / 2, size.height / 2)
        val r = size.minDimension / 2 * (0.78f + boost * 0.2f)
        drawCircle(Brush.radialGradient(listOf(Green.copy(alpha = 0.35f + boost * 0.4f), Color.Transparent), c, r * 1.3f), r * 1.3f, c)
        drawCircle(DarkGreen, r, c)
        // Nodi sulla superficie, collegati al centro come piste di un circuito.
        val n = 10
        for (i in 0 until n) {
            val a = Math.toRadians((spin + i * 360.0 / n)).toFloat()
            val tilt = 0.55f + 0.45f * sin(a * 2 + i)
            val p = Offset(c.x + cos(a) * r * 0.82f * tilt, c.y + sin(a) * r * 0.82f)
            val lit = ((i.toFloat() / n) - pulse).let { kotlin.math.abs(it) < 0.12f }
            drawLine(Green.copy(alpha = if (lit) 0.9f else 0.25f), c, p, strokeWidth = if (lit) 2.2f else 1.2f)
            drawCircle(Green.copy(alpha = if (lit) 1f else 0.6f), if (lit) 4.5f else 3f, p)
        }
        drawCircle(Green, r * 0.16f + boost * 6f, c)
        drawCircle(Green.copy(alpha = 0.5f), r, c, style = Stroke(1.5f))
        if (phase != WatchState.Phase.IDLE) {
            drawCircle(Green.copy(alpha = (1f - pulse) * 0.6f), r * (1f + pulse * 0.25f), c, style = Stroke(2f))
        }
    }
}
