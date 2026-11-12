package com.jarvisfit.app.ui

import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.ArrowDownward
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.PhotoLibrary
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import com.jarvisfit.app.ai.Brain
import com.jarvisfit.app.data.ImageUtil
import com.jarvisfit.app.data.Nutrition
import com.jarvisfit.app.data.Settings
import com.jarvisfit.app.data.Store
import com.jarvisfit.app.voice.JarvisService
import com.jarvisfit.app.voice.JarvisState
import com.jarvisfit.app.voice.Speaker
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import kotlin.math.roundToInt

@Composable
fun TodayScreen(photoRequested: MutableState<Boolean>) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val diary by Store.state.collectAsState()
    val status by JarvisState.status.collectAsState()
    val partial by JarvisState.partial.collectAsState()
    val error by JarvisState.error.collectAsState()
    var listening by remember { mutableStateOf(Settings.listeningEnabled) }
    var input by remember { mutableStateOf("") }
    var attached by remember { mutableStateOf<File?>(null) }
    var sending by remember { mutableStateOf(false) }
    var isDashboardExpanded by remember { mutableStateOf(false) }

    val today = Store.today()
    val t = Nutrition.totals(diary, today)
    val adapt = Nutrition.weeklyAdaptive(diary)
    val target = adapt.adaptiveDailyTarget + (t.burned * 0.5 + t.stepBonus).roundToInt()
    val remaining = target - t.kcal.roundToInt()

    fun send(text: String, photo: File?, speak: Boolean) {
        if (text.isBlank() && photo == null) return
        sending = true
        com.jarvisfit.app.JarvisApp.scope.launch {
            val b64 = photo?.let { withContext(Dispatchers.Default) { runCatching { ImageUtil.toBase64Jpeg(it) }.getOrNull() } }
            val msg = text.ifBlank { "Ecco la foto" + diary.pendingPhotoRequest.let { if (it.isBlank()) "" else " ($it)" } }
            val reply = Brain.handle(msg, b64)
            if (speak && Settings.speakReplies) Speaker.speak(reply.text)
            sending = false
        }
    }

    val takePhoto = rememberPhotoTaker("meal") { f ->
        if (Store.diary.pendingPhotoRequest.isNotBlank()) send("", f, speak = true) else attached = f
    }
    val pickPhoto = rememberGalleryPicker("meal") { f -> attached = f }

    LaunchedEffect(photoRequested.value) {
        if (photoRequested.value) { photoRequested.value = false; takePhoto() }
    }

    val permLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { res ->
        if (res[android.Manifest.permission.RECORD_AUDIO] == true) {
            JarvisService.start(ctx); listening = true
            requestIgnoreBatteryOptimizations(ctx)
        } else listening = false
    }
    fun toggleListening(on: Boolean) {
        if (on) {
            val missing = listeningPermissions().any {
                ContextCompat.checkSelfPermission(ctx, it) != PackageManager.PERMISSION_GRANTED
            }
            if (missing) permLauncher.launch(listeningPermissions())
            else { JarvisService.start(ctx); listening = true }
        } else { JarvisService.stop(ctx); listening = false }
    }
    LaunchedEffect(Unit) {
        if (Settings.listeningEnabled && status == JarvisState.Status.OFF) toggleListening(true)
    }

    val listState = rememberLazyListState()
    val chat = diary.chat.takeLast(60)
    LaunchedEffect(chat.size, sending, status) {
        val n = listState.layoutInfo.totalItemsCount
        if (n > 0) listState.animateScrollToItem(n - 1)
    }

    Column(Modifier.fillMaxSize().imePadding()) {

        // ---- BARRA A TENDINA PERSISTENTE (Sintesi Kcal, Macro, Settimana & Jarvis) ----
        Card(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 6.dp)
                .clickable { isDashboardExpanded = !isDashboardExpanded },
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.90f)),
            shape = RoundedCornerShape(16.dp)
        ) {
            Column(Modifier.padding(horizontal = 14.dp, vertical = 10.dp)) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.weight(1f)) {
                        Box(Modifier.size(10.dp).background(statusColor(status), CircleShape))
                        Spacer(Modifier.width(8.dp))
                        Text(
                            text = "${t.kcal.roundToInt()} / $target kcal",
                            fontWeight = FontWeight.Bold,
                            fontSize = 15.sp,
                            color = MaterialTheme.colorScheme.primary
                        )
                        Spacer(Modifier.width(6.dp))
                        Text(
                            text = if (remaining >= 0) "($remaining rimaste)" else "(${-remaining} oltre)",
                            fontSize = 12.sp,
                            color = if (remaining >= 0) MaterialTheme.colorScheme.secondary else MaterialTheme.colorScheme.error
                        )
                        Spacer(Modifier.width(6.dp))
                        Text("• 👣 ${t.steps}", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Icon(
                        imageVector = if (isDashboardExpanded) Icons.Default.KeyboardArrowUp else Icons.Default.KeyboardArrowDown,
                        contentDescription = if (isDashboardExpanded) "Chiudi riepilogo" else "Apri riepilogo",
                        tint = MaterialTheme.colorScheme.primary
                    )
                }

                // Vista espansa della tendina
                AnimatedVisibility(visible = isDashboardExpanded) {
                    Column(Modifier.padding(top = 10.dp)) {
                        LinearProgressIndicator(
                            progress = { (if (target > 0) (t.kcal / target).toFloat() else 0f).coerceIn(0f, 1f) },
                            modifier = Modifier.fillMaxWidth().height(8.dp),
                        )
                        Spacer(Modifier.height(8.dp))
                        Text(
                            text = if (adapt.deltaKcal != 0)
                                "⚡ Target Adattivo Oggi: ${adapt.adaptiveDailyTarget} kcal (${if (adapt.deltaKcal > 0) "+${adapt.deltaKcal}" else "${adapt.deltaKcal}"} kcal compensate da pasti passati)"
                            else "⚡ Target Oggi: ${adapt.adaptiveDailyTarget} kcal (in linea col piano settimanale)",
                            fontSize = 12.sp,
                            color = MaterialTheme.colorScheme.primary,
                            fontWeight = FontWeight.Medium
                        )
                        Spacer(Modifier.height(3.dp))
                        Text(
                            text = "🔮 Stima Domani: ~${adapt.estimatedTomorrowTarget} kcal/giorno " +
                                (if (adapt.tomorrowDeltaKcal != 0) "(${if (adapt.tomorrowDeltaKcal > 0) "+${adapt.tomorrowDeltaKcal}" else "${adapt.tomorrowDeltaKcal}"} kcal per bilanciare la settimana)" else "(in linea col piano)"),
                            fontSize = 12.sp,
                            color = MaterialTheme.colorScheme.tertiary,
                            fontWeight = FontWeight.Medium
                        )
                        if (adapt.todaySurplusOrDeficit != 0) {
                            Spacer(Modifier.height(2.dp))
                            Text(
                                text = if (adapt.todaySurplusOrDeficit > 0)
                                    "⚠️ Surplus oggi di +${adapt.todaySurplusOrDeficit} kcal netti -> compensato nel target di domani"
                                else
                                    "✨ Risparmio oggi di ${-adapt.todaySurplusOrDeficit} kcal netti -> margine ripartito sui giorni seguenti",
                                fontSize = 11.sp,
                                color = if (adapt.todaySurplusOrDeficit > 0) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.secondary
                            )
                        }
                        val activityBonus = (t.burned * 0.5 + t.stepBonus).roundToInt()
                        if (activityBonus > 0) {
                            Spacer(Modifier.height(4.dp))
                            Text(
                                text = "🔥 +$activityBonus kcal aggiunte oggi al budget (${t.stepBonus.roundToInt()} da passi, ${(t.burned * 0.5).roundToInt()} da allenamenti)",
                                fontSize = 12.sp,
                                color = MaterialTheme.colorScheme.secondary,
                                fontWeight = FontWeight.Medium
                            )
                        }
                        Spacer(Modifier.height(10.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            Macro("Proteine", t.protein, Nutrition.proteinTarget(diary).toDouble(), Modifier.weight(1f))
                            Macro("Carbo", t.carbs, null, Modifier.weight(1f))
                            Macro("Grassi", t.fat, null, Modifier.weight(1f))
                        }
                        Spacer(Modifier.height(10.dp))
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text("👣 ${t.steps} passi (${t.stepBurned.roundToInt()} kcal, +${t.stepBonus.roundToInt()} al budget)  ·  🏋️ ${t.burned.roundToInt()} kcal attività",
                                    color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 12.sp)
                                Text("📅 Settimana: ${adapt.remainingBudgetWeek} kcal rimanenti su ${adapt.daysRemaining} gg",
                                    color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 11.sp)
                            }
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(if (listening) "Ascolto ON" else "OFF", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                Spacer(Modifier.width(4.dp))
                                Switch(checked = listening, onCheckedChange = { toggleListening(it) })
                            }
                        }
                    }
                }
            }
        }

        // ---- BANNER FISSO NOTA SESSIONE RICETTA IN CORSO (SE ATTIVA) ----
        diary.activeRecipeSession?.let { rec ->
            Card(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 12.dp, vertical = 4.dp),
                colors = CardDefaults.cardColors(containerColor = Color(0xFF132A1C)),
                border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.primary.copy(alpha = 0.6f)),
                shape = RoundedCornerShape(14.dp)
            ) {
                Column(Modifier.padding(horizontal = 14.dp, vertical = 10.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("🍳 In cucina: ", fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary, fontSize = 14.sp)
                        Text(rec.title, fontWeight = FontWeight.Bold, color = Color.White, fontSize = 14.sp, modifier = Modifier.weight(1f))
                        IconButton(
                            onClick = { Store.update { it.copy(activeRecipeSession = null) } },
                            modifier = Modifier.size(24.dp)
                        ) {
                            Text("✕", fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    if (rec.currentStep.isNotBlank()) {
                        Spacer(Modifier.height(4.dp))
                        Text("Passaggio: ${rec.currentStep}", fontSize = 12.sp, color = MaterialTheme.colorScheme.primary.copy(alpha = 0.9f))
                    }
                    if (rec.ingredientsNeeded.isNotBlank()) {
                        Spacer(Modifier.height(2.dp))
                        Text("Ingredienti: ${rec.ingredientsNeeded}", fontSize = 11.sp, color = Color(0xFFCBD5E1))
                    }
                    if (rec.notes.isNotBlank()) {
                        Spacer(Modifier.height(2.dp))
                        Text("Note: ${rec.notes}", fontSize = 11.sp, color = Color(0xFF94A3B8))
                    }
                }
            }
        }

        // ---- ZONA CHAT CON LAZYCOLUMN E SCROLL TO BOTTOM BUTTON ----
        Box(Modifier.weight(1f).fillMaxWidth()) {
            LazyColumn(
                state = listState,
                modifier = Modifier.fillMaxSize(),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                if (diary.pendingPhotoRequest.isNotBlank()) item {
                    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.tertiary.copy(alpha = 0.18f))) {
                        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text("📸 Jarvis ti chiede una foto: ${diary.pendingPhotoRequest}", Modifier.weight(1f), fontSize = 14.sp)
                            Button(onClick = { takePhoto() }) { Text("Scatta") }
                        }
                    }
                }
                if (chat.isEmpty()) item {
                    Text("Di' \"Jarvis\" o scrivi qui:\n• \"a pranzo ho mangiato pasta al tonno\"\n• \"cosa posso cucinare con quello che ho in dispensa?\"\n" +
                        "• \"ieri ho mangiato una pizza e ho dimenticato di dirtelo\"\n• \"quanto ho ancora a disposizione oggi?\"",
                        color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 14.sp, modifier = Modifier.padding(8.dp))
                }
                items(chat) { m -> Bubble(m.role == "user", m.text, m.hasImage) }

                // Indicatore Jarvis che pensa / scrive
                if (sending || status == JarvisState.Status.THINKING) {
                    item { JarvisThinkingBubble() }
                }
            }

            // Pulsante per tornare rapidamente in fondo alla chat se l'utente è salito in alto
            if (listState.canScrollForward) {
                FloatingActionButton(
                    onClick = {
                        scope.launch {
                            val n = listState.layoutInfo.totalItemsCount
                            if (n > 0) listState.animateScrollToItem(n - 1)
                        }
                    },
                    modifier = Modifier
                        .align(Alignment.BottomEnd)
                        .padding(16.dp)
                        .size(42.dp),
                    containerColor = MaterialTheme.colorScheme.primaryContainer,
                    contentColor = MaterialTheme.colorScheme.onPrimaryContainer
                ) {
                    Icon(Icons.Default.ArrowDownward, contentDescription = "Ultimi messaggi", modifier = Modifier.size(20.dp))
                }
            }
        }

        // ---- BARRA INPUT ----
        attached?.let { f ->
            Row(Modifier.padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                ImageUtil.loadThumb(f.path, 160)?.let {
                    androidx.compose.foundation.Image(it.asImageBitmap(), null, Modifier.size(56.dp))
                }
                Spacer(Modifier.width(8.dp))
                Text("Foto allegata", fontSize = 13.sp, modifier = Modifier.weight(1f))
                IconButton(onClick = { attached = null }) { Text("✕") }
            }
        }
        Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { takePhoto() }) { Icon(Icons.Filled.CameraAlt, "Foto") }
            IconButton(onClick = { pickPhoto() }) { Icon(Icons.Filled.PhotoLibrary, "Galleria") }
            OutlinedTextField(
                value = input, onValueChange = { input = it },
                placeholder = { Text("Scrivi a Jarvis…") },
                modifier = Modifier.weight(1f), maxLines = 4,
                shape = RoundedCornerShape(20.dp),
            )
            Spacer(Modifier.width(6.dp))
            if (input.isBlank() && attached == null) {
                FilledIconButton(onClick = {
                    if (listening) JarvisService.listenNow(ctx) else toggleListening(true)
                }) { Icon(Icons.Filled.Mic, "Parla") }
            } else {
                FilledIconButton(enabled = !sending, onClick = {
                    send(input, attached, speak = false); input = ""; attached = null
                }) { Icon(Icons.AutoMirrored.Filled.Send, "Invia") }
            }
        }
    }
}

@Composable
private fun JarvisThinkingBubble() {
    val infiniteTransition = rememberInfiniteTransition(label = "pulse")
    val alpha by infiniteTransition.animateFloat(
        initialValue = 0.35f,
        targetValue = 1.0f,
        animationSpec = infiniteRepeatable(
            animation = tween(700),
            repeatMode = RepeatMode.Reverse
        ),
        label = "alpha"
    )

    Row(
        Modifier.fillMaxWidth().padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.Start,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(
            Modifier
                .widthIn(max = 300.dp)
                .background(
                    MaterialTheme.colorScheme.surfaceVariant,
                    RoundedCornerShape(16.dp)
                )
                .padding(horizontal = 14.dp, vertical = 10.dp)
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier
                        .size(10.dp)
                        .background(MaterialTheme.colorScheme.primary.copy(alpha = alpha), CircleShape)
                )
                Spacer(Modifier.width(10.dp))
                Text(
                    text = "Jarvis sta elaborando...",
                    fontSize = 14.sp,
                    fontWeight = FontWeight.Medium,
                    color = MaterialTheme.colorScheme.primary.copy(alpha = alpha.coerceAtLeast(0.6f))
                )
            }
        }
    }
}

@Composable
private fun Macro(label: String, value: Double, target: Double?, modifier: Modifier) {
    Column(modifier) {
        Text(label, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(if (target != null) "${value.roundToInt()} / ${target.roundToInt()} g" else "${value.roundToInt()} g",
            fontWeight = FontWeight.SemiBold)
        if (target != null) LinearProgressIndicator(
            progress = { (if (target > 0) (value / target).toFloat() else 0f).coerceIn(0f, 1f) },
            modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
            color = MaterialTheme.colorScheme.secondary,
        )
    }
}

@Composable
private fun Bubble(mine: Boolean, text: String, hasImage: Boolean) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start) {
        Box(
            Modifier.widthIn(max = 300.dp)
                .background(
                    if (mine) MaterialTheme.colorScheme.primary.copy(alpha = 0.18f) else MaterialTheme.colorScheme.surfaceVariant,
                    RoundedCornerShape(16.dp)
                )
                .padding(horizontal = 14.dp, vertical = 10.dp)
        ) { Text((if (hasImage) "📷 " else "") + text, fontSize = 15.sp) }
    }
}

private fun statusColor(s: JarvisState.Status) = when (s) {
    JarvisState.Status.WAITING -> Color(0xFF22C55E)
    JarvisState.Status.LISTENING -> Color(0xFF22D3EE)
    JarvisState.Status.THINKING, JarvisState.Status.SPEAKING -> Color(0xFFF59E0B)
    JarvisState.Status.ERROR -> Color(0xFFF87171)
    JarvisState.Status.OFF -> Color(0xFF64748B)
}

private fun statusText(s: JarvisState.Status, partial: String, error: String) = when (s) {
    JarvisState.Status.OFF -> "Ascolto spento"
    JarvisState.Status.WAITING -> "Di' \"Jarvis\" quando vuoi"
    JarvisState.Status.LISTENING -> if (partial.isBlank()) "Ti ascolto…" else "“$partial”"
    JarvisState.Status.THINKING -> "Sto pensando…"
    JarvisState.Status.SPEAKING -> "Sto rispondendo"
    JarvisState.Status.ERROR -> error
}
