package com.jarvisfit.app.ui

import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.jarvisfit.app.ai.Brain
import com.jarvisfit.app.data.ImageUtil
import com.jarvisfit.app.data.Nutrition
import com.jarvisfit.app.data.Settings
import com.jarvisfit.app.data.Store
import com.jarvisfit.app.data.WeightEntry
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import kotlin.math.roundToInt

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ProfileScreen(onSaved: () -> Unit) {
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    var importMsg by remember { mutableStateOf("") }
    // Backup del vecchio JarvisFit: si unisce al diario senza cancellare nulla.
    val importBackup = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            val msg = withContext(Dispatchers.IO) {
                runCatching {
                    val text = ctx.contentResolver.openInputStream(uri)?.bufferedReader()?.use { it.readText() }.orEmpty()
                    val r = Store.importJson(text)
                    "Importati ${r.meals} pasti, ${r.activities} allenamenti e ${r.weights} pesate."
                }.getOrElse { "Import non riuscito: ${it.message ?: "file non valido"}" }
            }
            Toast.makeText(ctx, msg, Toast.LENGTH_LONG).show()
            importMsg = msg
            // I campi qui sopra mostrano ancora il profilo di prima: si esce, così non vengono salvati sopra.
            if (msg.startsWith("Importati")) onSaved()
        }
    }
    val p = Store.diary.profile
    var name by remember { mutableStateOf(p.name) }
    var birth by remember { mutableStateOf(toUi(p.birthDate)) }
    var sex by remember { mutableStateOf(p.sex) }
    var height by remember { mutableStateOf(num(p.heightCm)) }
    var weight by remember { mutableStateOf(num(Nutrition.currentWeight(Store.diary))) }
    var targetW by remember { mutableStateOf(num(p.targetWeightKg)) }
    var goal by remember { mutableStateOf(p.goal) }
    var pace by remember { mutableFloatStateOf(p.weeklyChangeKg.toFloat()) }
    var activity by remember { mutableStateOf(p.activityLevel) }
    var likes by remember { mutableStateOf(p.foodLikes) }
    var dislikes by remember { mutableStateOf(p.foodDislikes) }
    var notes by remember { mutableStateOf(p.dietNotes) }
    var photo by remember { mutableStateOf(p.photoPath) }
    var appearance by remember { mutableStateOf(p.appearanceNotes) }

    var claudeKey by remember { mutableStateOf(Settings.anthropicKey) }
    var model by remember { mutableStateOf(Settings.model) }
    var sens by remember { mutableFloatStateOf(Settings.sensitivity) }
    var speak by remember { mutableStateOf(Settings.speakReplies) }
    var msg by remember { mutableStateOf("") }
    var saving by remember { mutableStateOf(false) }

    val takePhoto = rememberPhotoTaker("me") { f -> photo = f.path }
    val pickPhoto = rememberGalleryPicker("me") { f -> photo = f.path }

    val parsedHeight = height.replace(',', '.').toDoubleOrNull() ?: p.heightCm
    val parsedWeight = weight.replace(',', '.').toDoubleOrNull() ?: Nutrition.currentWeight(Store.diary)
    val parsedAge = fromUi(birth)?.let { Nutrition.age(it) } ?: Nutrition.age(p)
    val targetPreview = Nutrition.calculateTarget(
        weightKg = if (parsedWeight > 0) parsedWeight else 70.0,
        heightCm = if (parsedHeight > 0) parsedHeight else 175.0,
        ageYears = parsedAge,
        sex = sex,
        activityLevel = activity,
        goal = goal,
        weeklyChangeKg = if (goal == "mantenere") 0.0 else pace.toDouble()
    )

    Column(
        Modifier.verticalScroll(rememberScrollState()).imePadding().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("Il tuo profilo", fontSize = 22.sp, fontWeight = FontWeight.Bold)
        if (!p.isComplete) Text("Compila i dati: servono a Jarvis per calcolare il tuo fabbisogno.",
            color = MaterialTheme.colorScheme.onSurfaceVariant)

        Field("Nome", name) { name = it }
        Field("Data di nascita (gg/mm/aaaa)", birth, KeyboardType.Number) { birth = it }
        Label("Sesso")
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(sex == "M", { sex = "M" }, { Text("Maschio") })
            FilterChip(sex == "F", { sex = "F" }, { Text("Femmina") })
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Box1(Modifier.weight(1f)) { Field("Altezza (cm)", height, KeyboardType.Decimal) { height = it } }
            Box1(Modifier.weight(1f)) { Field("Peso (kg)", weight, KeyboardType.Decimal) { weight = it } }
        }

        Label("Obiettivo")
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("dimagrire", "mantenere", "massa").forEach { g ->
                FilterChip(goal == g, { goal = g }, { Text(g.replaceFirstChar { it.uppercase() }) })
            }
        }
        if (goal != "mantenere") {
            Field("Peso obiettivo (kg)", targetW, KeyboardType.Decimal) { targetW = it }
            Label("Ritmo: ${"%.2f".format(pace)} kg a settimana")
            Slider(value = pace, onValueChange = { pace = (it * 4).toInt() / 4f }, valueRange = 0.25f..1f, steps = 2)
        }
        Label("Attività fuori dalla palestra")
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("sedentario", "leggero", "moderato", "attivo", "molto attivo").forEach { a ->
                FilterChip(activity == a, { activity = a }, { Text(a) })
            }
        }

        // Card Fabbisogno Energetico Effettivo e Target Calcolato col Deficit
        Card(
            modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.85f)),
            shape = RoundedCornerShape(16.dp)
        ) {
            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("⚡ Fabbisogno Energetico Calcolato", fontWeight = FontWeight.Bold, fontSize = 15.sp, color = MaterialTheme.colorScheme.primary)
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Column(Modifier.weight(1f)) {
                        Text("Fabbisogno effettivo", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text("${targetPreview.maintenance.roundToInt()} kcal", fontSize = 19.sp, fontWeight = FontWeight.Bold)
                        Text("Mantenimento (BMR ${targetPreview.bmr.roundToInt()})", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Column(horizontalAlignment = Alignment.End, modifier = Modifier.weight(1f)) {
                        Text("Target con deficit/surplus", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text("${targetPreview.dailyTarget} kcal", fontSize = 19.sp, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
                        val diff = targetPreview.dailyTarget - targetPreview.maintenance.roundToInt()
                        Text(
                            text = if (diff < 0) "$diff kcal/gg (deficit)" else if (diff > 0) "+$diff kcal/gg (surplus)" else "In pareggio",
                            fontSize = 11.sp,
                            fontWeight = FontWeight.Medium,
                            color = if (diff < 0) MaterialTheme.colorScheme.secondary else MaterialTheme.colorScheme.primary
                        )
                    }
                }
                if (goal == "dimagrire") {
                    val paceLoss = "%.2f".format(pace)
                    val kcalPerDay = (pace * 7700 / 7).roundToInt()
                    Text(
                        "📉 Perdita programmata: $paceLoss kg/settimana (-$kcalPerDay kcal/giorno rispetto al fabbisogno effettivo)." +
                            (if (targetPreview.isCapped) " (Applicata soglia di sicurezza minima a ${targetPreview.safetyFloor.roundToInt()} kcal/gg)" else ""),
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                } else if (goal == "massa") {
                    Text(
                        "📈 Obiettivo massa: surplus di +${targetPreview.delta.roundToInt()} kcal/giorno rispetto al fabbisogno effettivo.",
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                } else {
                    Text(
                        "⚖️ Obiettivo mantenimento: target calorico in pareggio con il fabbisogno effettivo.",
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        }

        Text("Alimentazione", fontSize = 18.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 8.dp))
        Field("Cosa ti piace mangiare", likes, minLines = 2) { likes = it }
        Field("Cosa NON ti piace / eviti", dislikes, minLines = 2) { dislikes = it }
        Field("Altre note (orari, vegetariano, budget, cucina…)", notes, minLines = 2) { notes = it }

        Text("Come appari", fontSize = 18.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 8.dp))
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            if (photo.isNotBlank()) ImageUtil.loadThumb(photo)?.let {
                Image(it.asImageBitmap(), null, Modifier.size(96.dp).clip(RoundedCornerShape(12.dp)),
                    contentScale = ContentScale.Crop)
            }
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                OutlinedButton(onClick = takePhoto) { Text("Scatta foto") }
                OutlinedButton(onClick = pickPhoto) { Text("Dalla galleria") }
            }
        }
        if (appearance.isNotBlank()) Text(appearance, fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text("La foto resta sul telefono; viene inviata a Gemini una sola volta per una descrizione della corporatura.",
            fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)

        Text("Dati", fontSize = 18.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 8.dp))
        OutlinedButton(onClick = { importBackup.launch(arrayOf("application/json", "text/plain", "application/octet-stream")) }, modifier = Modifier.fillMaxWidth()) {
            Text("Importa backup (file .json)")
        }
        if (importMsg.isNotBlank()) Text(importMsg, fontSize = 13.sp, color = MaterialTheme.colorScheme.primary)

        Text("Collegamenti", fontSize = 18.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 8.dp))
        OutlinedButton(onClick = { CloudUi.showSetup.value = true }, modifier = Modifier.fillMaxWidth()) {
            Text("Collega Jarvis Cloud (web, memoria, più modelli)")
        }
        Field("Gemini API key (aistudio.google.com)", claudeKey, password = true) { claudeKey = it }
        Field("Modello", model) { model = it }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            listOf("gemini-3.8-flash", "gemini-flash-latest", "gemini-2.5-flash-lite", "gemini-3-pro-preview").forEach { m ->
                FilterChip(
                    selected = model.trim().removePrefix("models/") == m,
                    onClick = { model = m },
                    label = { Text(m.removePrefix("gemini-"), fontSize = 12.sp) }
                )
            }
        }
        Label("Sensibilità microfono: ${"%.2f".format(sens)}")
        Slider(value = sens, onValueChange = { sens = it }, valueRange = 0.3f..0.9f)
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Risposte a voce", Modifier.weight(1f))
            Switch(checked = speak, onCheckedChange = { speak = it })
        }

        if (msg.isNotBlank()) Text(msg, color = MaterialTheme.colorScheme.tertiary)
        Button(
            enabled = !saving,
            modifier = Modifier.fillMaxWidth().height(52.dp),
            onClick = save@{
                val bd = fromUi(birth)
                val h = height.replace(',', '.').toDoubleOrNull() ?: 0.0
                val w = weight.replace(',', '.').toDoubleOrNull() ?: 0.0
                if (bd == null || h < 100 || w < 30) { msg = "Controlla data di nascita, altezza e peso."; return@save }
                Settings.anthropicKey = claudeKey
                val cleanedModel = model.trim().removePrefix("models/")
                Settings.model = if (cleanedModel.isBlank() || cleanedModel.contains("claude") || cleanedModel.contains("2.0-flash") || cleanedModel.contains("1.5-flash")) {
                    "gemini-3.8-flash"
                } else cleanedModel
                Settings.sensitivity = sens
                Settings.speakReplies = speak
                val photoChanged = photo != p.photoPath
                Store.update { d ->
                    val newWeights = if (w != Nutrition.currentWeight(d))
                        d.weights.filterNot { it.date == Store.today() } + WeightEntry(Store.today(), w) else d.weights
                    d.copy(
                        weights = newWeights,
                        profile = d.profile.copy(
                            name = name.trim(), birthDate = bd, sex = sex, heightCm = h,
                            weightKg = if (d.profile.weightKg == 0.0) w else d.profile.weightKg,
                            targetWeightKg = targetW.replace(',', '.').toDoubleOrNull() ?: 0.0,
                            goal = goal, weeklyChangeKg = if (goal == "mantenere") 0.0 else pace.toDouble(),
                            activityLevel = activity, foodLikes = likes.trim(), foodDislikes = dislikes.trim(),
                            dietNotes = notes.trim(), photoPath = photo,
                            appearanceNotes = if (photoChanged) "" else appearance,
                        )
                    )
                }
                if (photoChanged && photo.isNotBlank() && claudeKey.isNotBlank()) {
                    saving = true
                    msg = "Analizzo la foto…"
                    com.jarvisfit.app.JarvisApp.scope.launch {
                        val res = runCatching {
                            val b64 = withContext(Dispatchers.Default) { ImageUtil.toBase64Jpeg(File(photo)) }
                            Brain.describeAppearance(b64)
                        }
                        res.onSuccess { desc ->
                            appearance = desc
                            Store.update { d -> d.copy(profile = d.profile.copy(appearanceNotes = desc)) }
                            msg = "Salvato. Fabbisogno effettivo: ${Nutrition.maintenance(Store.diary).roundToInt()} kcal | Target: ${Nutrition.dailyTarget(Store.diary)} kcal/giorno"
                        }.onFailure { msg = "Profilo salvato, ma analisi foto non riuscita: ${it.message}" }
                        saving = false
                    }
                } else {
                    msg = "Salvato. Fabbisogno effettivo: ${Nutrition.maintenance(Store.diary).roundToInt()} kcal | Target: ${Nutrition.dailyTarget(Store.diary)} kcal/giorno"
                    if (!p.isComplete) onSaved()
                }
            },
        ) { Text("Salva") }
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun Box1(modifier: Modifier, content: @Composable () -> Unit) =
    androidx.compose.foundation.layout.Box(modifier) { content() }

@Composable
private fun Label(text: String) =
    Text(text, fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)

@Composable
private fun Field(
    label: String, value: String, keyboard: KeyboardType = KeyboardType.Text,
    password: Boolean = false, minLines: Int = 1, onChange: (String) -> Unit,
) = OutlinedTextField(
    value = value, onValueChange = onChange, label = { Text(label) },
    modifier = Modifier.fillMaxWidth(), singleLine = minLines == 1, minLines = minLines,
    keyboardOptions = KeyboardOptions(keyboardType = if (password) KeyboardType.Password else keyboard),
    visualTransformation = if (password) PasswordVisualTransformation()
    else androidx.compose.ui.text.input.VisualTransformation.None,
)

private fun num(d: Double) = if (d == 0.0) "" else if (d % 1.0 == 0.0) d.toInt().toString() else d.toString()

private val uiFmt = DateTimeFormatter.ofPattern("dd/MM/yyyy")
private fun toUi(iso: String) = runCatching { LocalDate.parse(iso).format(uiFmt) }.getOrDefault("")
private fun fromUi(s: String): String? = runCatching {
    LocalDate.parse(s.trim().replace('-', '/').replace('.', '/'), DateTimeFormatter.ofPattern("d/M/yyyy")).toString()
}.getOrNull()

