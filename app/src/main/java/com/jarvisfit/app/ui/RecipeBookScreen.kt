package com.jarvisfit.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.MenuBook
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.jarvisfit.app.data.ActiveRecipeSession
import com.jarvisfit.app.data.Recipe
import com.jarvisfit.app.data.Store
import kotlin.math.roundToInt

@Composable
fun RecipeBookScreen(onStartCooking: () -> Unit) {
    val diary by Store.state.collectAsState()
    val recipes = diary.savedRecipes

    Column(
        Modifier
            .fillMaxSize()
            .padding(16.dp)
    ) {
        // Intestazione
        Row(
            Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(
                Icons.Filled.MenuBook,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.padding(end = 10.dp)
            )
            Column {
                Text("Ricettario Personale", fontSize = 22.sp, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
                Text("Le tue ricette preferite salvate con Jarvis", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }

        Spacer(Modifier.height(16.dp))

        if (recipes.isEmpty()) {
            Box(
                Modifier
                    .fillMaxSize()
                    .padding(32.dp),
                contentAlignment = Alignment.Center
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("📖", fontSize = 48.sp)
                    Spacer(Modifier.height(12.dp))
                    Text(
                        "Nessuna ricetta salvata finora",
                        fontWeight = FontWeight.Bold,
                        fontSize = 16.sp,
                        color = Color.White
                    )
                    Spacer(Modifier.height(6.dp))
                    Text(
                        "Quando chiedi una ricetta a Jarvis e ti piace l'idea, digli:\n\"Jarvis, salva questa ricetta\"\ne la troverai catalogata qui pronta per essere cucinata!",
                        fontSize = 13.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = androidx.compose.ui.text.style.TextAlign.Center
                    )
                }
            }
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                verticalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                items(recipes, key = { it.id }) { recipe ->
                    RecipeCard(recipe = recipe, onStartCooking = onStartCooking)
                }
            }
        }
    }
}

@Composable
private fun RecipeCard(recipe: Recipe, onStartCooking: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
        shape = RoundedCornerShape(16.dp)
    ) {
        Column(Modifier.padding(16.dp)) {
            Row(
                Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column(Modifier.weight(1f)) {
                    Text(recipe.title, fontSize = 18.sp, fontWeight = FontWeight.Bold, color = Color.White)
                    Text(
                        "${recipe.totalKcal.roundToInt()} kcal  ·  P: ${recipe.totalProtein.roundToInt()}g  C: ${recipe.totalCarbs.roundToInt()}g  G: ${recipe.totalFat.roundToInt()}g",
                        fontSize = 13.sp,
                        color = MaterialTheme.colorScheme.primary,
                        fontWeight = FontWeight.Medium
                    )
                }
                IconButton(onClick = {
                    Store.update { d -> d.copy(savedRecipes = d.savedRecipes.filterNot { it.id == recipe.id }) }
                }) {
                    Icon(Icons.Filled.Delete, contentDescription = "Elimina", tint = MaterialTheme.colorScheme.error)
                }
            }

            Spacer(Modifier.height(10.dp))

            // Ingredienti
            Text("Ingredienti:", fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurfaceVariant)
            recipe.ingredients.forEach { item ->
                Text("• ${item.name}: ${item.grams.roundToInt()}g (${item.kcal.roundToInt()} kcal)", fontSize = 12.sp, color = Color.LightGray)
            }

            if (recipe.instructions.isNotBlank()) {
                Spacer(Modifier.height(8.dp))
                Text("Preparazione:", fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(recipe.instructions, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface)
            }

            Spacer(Modifier.height(12.dp))

            Button(
                onClick = {
                    // Avvia la sessione di cucina attiva con questa ricetta
                    Store.update { d ->
                        d.copy(
                            activeRecipeSession = ActiveRecipeSession(
                                title = recipe.title,
                                currentStep = "Inizio preparazione",
                                ingredientsNeeded = recipe.ingredients.joinToString(", ") { "${it.name} ${it.grams.roundToInt()}g" },
                                notes = recipe.instructions,
                                startedAt = Store.nowIso()
                            )
                        )
                    }
                    onStartCooking()
                },
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(10.dp)
            ) {
                Icon(Icons.Filled.PlayArrow, contentDescription = null, modifier = Modifier.padding(end = 6.dp))
                Text("Cucina ora questa ricetta")
            }
        }
    }
}
