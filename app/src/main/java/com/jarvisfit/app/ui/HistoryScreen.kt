package com.jarvisfit.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.jarvisfit.app.data.Nutrition
import com.jarvisfit.app.data.Store
import java.time.LocalDate
import java.time.format.TextStyle
import java.util.Locale
import kotlin.math.roundToInt

@Composable
fun HistoryScreen() {
    val diary by Store.state.collectAsState()
    var expanded by remember { mutableStateOf(Store.today()) }
    val target = Nutrition.dailyTarget(diary)

    val days = (diary.meals.map { it.date } + diary.activities.map { it.date } + diary.steps.keys + Store.today())
        .distinct().sortedDescending()

    val cum = Nutrition.cumulativeBalance(diary)
    val month = Nutrition.monthlyBalance(diary)

    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item {
            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
                Column(Modifier.padding(16.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("Bilancio da Inizio Dati (${cum.startDate} → Oggi)", fontWeight = FontWeight.Bold, fontSize = 18.sp)
                    
                    if (cum.isFirstDayZeroExcluded) {
                        Text(
                            "💡 Il primo giorno (${cum.startDate}) è a zero ed è stato escluso dal calcolo delle medie.",
                            fontSize = 11.sp,
                            fontWeight = FontWeight.Medium,
                            color = MaterialTheme.colorScheme.tertiary
                        )
                    }

                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Column {
                            Text("Deficit Totale Reale", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Text(
                                "${cum.cumulativeDeficitVsMaintenance} kcal",
                                fontSize = 18.sp,
                                fontWeight = FontWeight.Bold,
                                color = MaterialTheme.colorScheme.primary
                            )
                        }
                        Column(horizontalAlignment = Alignment.End) {
                            Text("Perdita Peso Stimata", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Text(
                                "${if (cum.estimatedWeightLossKg >= 0) "-${"%.2f".format(cum.estimatedWeightLossKg)}" else "+${"%.2f".format(-cum.estimatedWeightLossKg)}"} kg",
                                fontSize = 18.sp,
                                fontWeight = FontWeight.Bold,
                                color = MaterialTheme.colorScheme.secondary
                            )
                        }
                    }

                    if (cum.actualWeightLossKg != null) {
                        Text(
                            "⚖️ Peso effettivo pesate: ${cum.startWeightKg} → ${cum.currentWeightKg} kg (${if (cum.actualWeightLossKg >= 0) "-${"%.1f".format(cum.actualWeightLossKg)}" else "+${"%.1f".format(-cum.actualWeightLossKg)}"} kg da inizio)",
                            fontSize = 13.sp, fontWeight = FontWeight.SemiBold
                        )
                    } else if (cum.startWeightKg > 0) {
                        Text("Peso registrato: ${cum.currentWeightKg} kg (iniziale: ${cum.startWeightKg} kg)", fontSize = 13.sp)
                    }

                    Text(
                        "Medie giornaliere (${cum.activeDaysCount} gg): ${cum.avgNetKcalPerDay} kcal netti/gg · ${cum.avgDeficitPerDay} kcal deficit/gg · ${cum.avgStepsPerDay} passi/gg",
                        fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Text(
                        "Consumo netto totale: ${cum.totalNetConsumed} kcal (Cibo: ${cum.totalFoodKcal} kcal - Bonus passi/attività: ${cum.totalActivityCredits} kcal)",
                        fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Text(
                        "👣 Passi totali: ${cum.totalSteps} · 🏋️ Allenamenti registrati: ${month.activityKcalTotal} kcal",
                        fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        }
        items(days, key = { it }) { date ->
            val t = Nutrition.totals(diary, date)
            val meals = diary.meals.filter { it.date == date }
            val acts = diary.activities.filter { it.date == date }
            val dayProg = cum.dailyProgressList.find { it.date == date }
            val ld = LocalDate.parse(date)
            val label = when (ld) {
                LocalDate.now() -> "Oggi"
                LocalDate.now().minusDays(1) -> "Ieri"
                else -> ld.dayOfWeek.getDisplayName(TextStyle.FULL, Locale.ITALIAN)
                    .replaceFirstChar { it.uppercase() } + " " + ld.dayOfMonth + " " +
                    ld.month.getDisplayName(TextStyle.SHORT, Locale.ITALIAN)
            }
            Card(
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                modifier = Modifier.clickable { expanded = if (expanded == date) "" else date },
            ) {
                Column(Modifier.padding(16.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(label, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                        Text(
                            "${t.kcal.roundToInt()} kcal",
                            color = if (t.kcal > target + t.burned * 0.5 + t.stepBonus) MaterialTheme.colorScheme.error
                            else MaterialTheme.colorScheme.secondary
                        )
                    }
                    Text(
                        "P ${t.protein.roundToInt()} · C ${t.carbs.roundToInt()} · G ${t.fat.roundToInt()} · " +
                            "${t.steps} passi" + (if (t.stepBonus > 0) " (+${t.stepBonus.roundToInt()} kcal)" else "") +
                            " · ${t.burned.roundToInt()} kcal attività",
                        fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
                    )

                    // Deficit del giorno e progresso in quel momento
                    dayProg?.let { p ->
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text(
                                text = if (p.dailyDeficit >= 0) "⚡ Deficit giorno: +${p.dailyDeficit} kcal" else "⚠️ Surplus giorno: ${-p.dailyDeficit} kcal",
                                fontSize = 12.sp,
                                fontWeight = FontWeight.Medium,
                                color = if (p.dailyDeficit >= 0) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error
                            )
                        }
                        Text(
                            text = "📊 In quel momento: deficit accumulato ${p.cumulativeDeficit} kcal (stima ${if (-p.cumulativeEstimatedWeightChangeKg >= 0) "-${"%.2f".format(-p.cumulativeEstimatedWeightChangeKg)}" else "+${"%.2f".format(p.cumulativeEstimatedWeightChangeKg)}"} kg)" +
                                (if (p.recordedWeightKg != null) " · ⚖️ peso ${p.recordedWeightKg} kg" + (if (p.weightLossFromStartKg != null) " (${if (p.weightLossFromStartKg >= 0) "-${"%.1f".format(p.weightLossFromStartKg)}" else "+${"%.1f".format(-p.weightLossFromStartKg)}"} kg)" else "") else ""),
                            fontSize = 11.sp,
                            color = MaterialTheme.colorScheme.tertiary
                        )
                    }

                    if (expanded == date) {
                        Spacer(Modifier.height(8.dp))
                        meals.sortedBy { listOf("colazione", "pranzo", "spuntino", "cena").indexOf(it.meal) }.forEach { m ->
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Column(Modifier.weight(1f).padding(vertical = 4.dp)) {
                                    Text(
                                        "${m.meal.replaceFirstChar { it.uppercase() }} · ${m.kcal.roundToInt()} kcal" +
                                            if (m.hasPhoto) " 📷" else "", fontWeight = FontWeight.Medium
                                    )
                                    Text(
                                        m.items.joinToString(", ") { "${it.name} ${it.grams.roundToInt()}g" },
                                        fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
                                    )
                                }
                                IconButton(onClick = {
                                    Store.update { d -> d.copy(meals = d.meals.filterNot { it.id == m.id }) }
                                }) { Icon(Icons.Filled.Delete, "Elimina", Modifier.size(18.dp)) }
                            }
                        }
                        acts.forEach { a ->
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(
                                    "🏋️ ${a.type}: ${a.description} · ${a.durationMin.roundToInt()} min · ${a.kcalBurned.roundToInt()} kcal",
                                    fontSize = 13.sp, modifier = Modifier.weight(1f)
                                )
                                IconButton(onClick = {
                                    Store.update { d -> d.copy(activities = d.activities.filterNot { it.id == a.id }) }
                                }) { Icon(Icons.Filled.Delete, "Elimina", Modifier.size(18.dp)) }
                            }
                        }
                        if (meals.isEmpty() && acts.isEmpty()) Text("Niente registrato.", fontSize = 13.sp)
                    }
                }
            }
        }
    }
}
