package com.jarvisfit.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Kitchen
import androidx.compose.material.icons.filled.PhotoLibrary
import androidx.compose.material.icons.filled.RestaurantMenu
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.jarvisfit.app.ai.Brain
import com.jarvisfit.app.data.ImageUtil
import com.jarvisfit.app.data.PantryItem
import com.jarvisfit.app.data.Settings
import com.jarvisfit.app.data.Store
import com.jarvisfit.app.voice.Speaker
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun PantryScreen(onAskJarvisMeal: () -> Unit) {
    val scope = rememberCoroutineScope()
    val diary by Store.state.collectAsState()
    val pantry = diary.pantry

    var newItemName by remember { mutableStateOf("") }
    var newItemQty by remember { mutableStateOf("") }
    var selectedCat by remember { mutableStateOf("generale") }
    var analyzingPhoto by remember { mutableStateOf(false) }
    var statusMsg by remember { mutableStateOf("") }

    val categories = listOf("generale", "proteine", "carboidrati", "verdura", "frutta", "latticini", "condimenti")

    fun addManualItem() {
        val name = newItemName.trim()
        if (name.isBlank()) return
        Store.update { d ->
            d.copy(pantry = d.pantry + PantryItem(
                id = Store.newId("p"),
                name = name,
                quantity = newItemQty.trim(),
                category = selectedCat,
                addedAt = Store.today()
            ))
        }
        newItemName = ""
        newItemQty = ""
        statusMsg = "Aggiunto: $name"
    }

    fun analyzePantryPhoto(file: File) {
        analyzingPhoto = true
        statusMsg = "Jarvis sta analizzando la dispensa..."
        com.jarvisfit.app.JarvisApp.scope.launch {
            val b64 = withContext(Dispatchers.Default) {
                runCatching { ImageUtil.toBase64Jpeg(file) }.getOrNull()
            }
            if (b64 != null) {
                val prompt = "Ho scattato questa foto alla mia dispensa/frigo. Riconosci tutti gli ingredienti alimentari visibili e aggiungili alla mia dispensa con add_pantry_item indicando nome, stima quantità e categoria. Poi dammi una breve risposta parlata di riassunto."
                val reply = Brain.handle(prompt, b64)
                if (Settings.speakReplies) Speaker.speak(reply.text)
                statusMsg = "Dispensa aggiornata da Jarvis!"
            } else {
                statusMsg = "Errore durante il caricamento della foto."
            }
            analyzingPhoto = false
        }
    }

    val takePhoto = rememberPhotoTaker("pantry") { f -> analyzePantryPhoto(f) }
    val pickPhoto = rememberGalleryPicker("pantry") { f -> analyzePantryPhoto(f) }

    Column(
        Modifier.fillMaxSize().imePadding().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        // Intestazione
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Filled.Kitchen, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(28.dp))
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text("Dispensa & Frigo", fontSize = 22.sp, fontWeight = FontWeight.Bold)
                Text("${pantry.size} ingredienti disponibili", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }

        // Azioni Rapide con Jarvis & Foto
        Card(
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
            shape = RoundedCornerShape(14.dp)
        ) {
            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("Rileva da Foto o Chiedi a Jarvis", fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
                Text("Fotografa dispensa, frigo o scontrino/spesa: Jarvis riconoscerà gli ingredienti e li salverà automaticamente.",
                    fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)

                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(
                        onClick = takePhoto,
                        enabled = !analyzingPhoto,
                        modifier = Modifier.weight(1f),
                        colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.primary, contentColor = MaterialTheme.colorScheme.onPrimary)
                    ) {
                        Icon(Icons.Filled.CameraAlt, null, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(6.dp))
                        Text("Scatta Foto")
                    }
                    OutlinedButton(
                        onClick = pickPhoto,
                        enabled = !analyzingPhoto,
                        modifier = Modifier.weight(1f)
                    ) {
                        Icon(Icons.Filled.PhotoLibrary, null, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(6.dp))
                        Text("Galleria")
                    }
                }

                if (analyzingPhoto) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.primary)
                        Text(statusMsg, fontSize = 13.sp, color = MaterialTheme.colorScheme.primary)
                    }
                } else if (statusMsg.isNotBlank()) {
                    Text(statusMsg, fontSize = 12.sp, color = MaterialTheme.colorScheme.tertiary)
                }

                if (pantry.isNotEmpty()) {
                    OutlinedButton(
                        onClick = {
                            com.jarvisfit.app.JarvisApp.scope.launch {
                                val prompt = "In base a quello che ho attualmente in dispensa e al mio target calorico di oggi, proponimi un'idea eccellente per il prossimo pasto con grammature precise."
                                val reply = Brain.handle(prompt)
                                if (Settings.speakReplies) Speaker.speak(reply.text)
                                onAskJarvisMeal()
                            }
                        },
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Icon(Icons.Filled.RestaurantMenu, null, modifier = Modifier.size(18.dp), tint = MaterialTheme.colorScheme.primary)
                        Spacer(Modifier.width(8.dp))
                        Text("Cosa cucino oggi con questa dispensa?", color = MaterialTheme.colorScheme.primary)
                    }
                }
            }
        }

        // Aggiungi manualmente
        Card(
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
            shape = RoundedCornerShape(14.dp)
        ) {
            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Aggiungi Ingrediente", fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = newItemName,
                        onValueChange = { newItemName = it },
                        placeholder = { Text("Nome (es. Riso, Pollo)") },
                        modifier = Modifier.weight(1.5f),
                        singleLine = true
                    )
                    OutlinedTextField(
                        value = newItemQty,
                        onValueChange = { newItemQty = it },
                        placeholder = { Text("Q.tà (es. 500g)") },
                        modifier = Modifier.weight(1f),
                        singleLine = true
                    )
                    IconButton(
                        onClick = { addManualItem() },
                        modifier = Modifier.size(52.dp).clip(RoundedCornerShape(12.dp)).background(MaterialTheme.colorScheme.primary)
                    ) {
                        Icon(Icons.Filled.Add, null, tint = MaterialTheme.colorScheme.onPrimary)
                    }
                }
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    categories.forEach { cat ->
                        FilterChip(
                            selected = selectedCat == cat,
                            onClick = { selectedCat = cat },
                            label = { Text(cat.replaceFirstChar { it.uppercase() }, fontSize = 11.sp) },
                            colors = FilterChipDefaults.filterChipColors(
                                selectedContainerColor = MaterialTheme.colorScheme.primary.copy(alpha = 0.25f),
                                selectedLabelColor = MaterialTheme.colorScheme.primary
                            )
                        )
                    }
                }
            }
        }

        // Lista ingredienti dispensa
        Text("In casa:", fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
        if (pantry.isEmpty()) {
            Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) {
                Text("Dispensa vuota.\nScatta una foto al frigo/dispensa o aggiungi ingredienti a mano!",
                    color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 14.sp)
            }
        } else {
            LazyColumn(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                items(pantry, key = { it.id }) { item ->
                    Card(
                        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                        shape = RoundedCornerShape(12.dp)
                    ) {
                        Row(
                            Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(item.name, fontWeight = FontWeight.Medium, fontSize = 16.sp, color = MaterialTheme.colorScheme.onSurface)
                                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    if (item.quantity.isNotBlank()) {
                                        Text(item.quantity, fontSize = 12.sp, color = MaterialTheme.colorScheme.primary)
                                    }
                                    Text("• ${item.category}", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                            }
                            IconButton(onClick = {
                                Store.update { d -> d.copy(pantry = d.pantry.filterNot { it.id == item.id }) }
                            }) {
                                Icon(Icons.Filled.Delete, "Rimuovi", tint = MaterialTheme.colorScheme.error.copy(alpha = 0.7f), modifier = Modifier.size(20.dp))
                            }
                        }
                    }
                }
            }
        }
    }
}
