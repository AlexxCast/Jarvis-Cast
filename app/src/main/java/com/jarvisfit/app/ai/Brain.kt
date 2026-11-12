package com.jarvisfit.app.ai

import com.jarvisfit.app.data.Activity
import com.jarvisfit.app.data.Diary
import com.jarvisfit.app.data.FoodItem
import com.jarvisfit.app.data.Meal
import com.jarvisfit.app.data.Nutrition
import com.jarvisfit.app.data.Settings
import com.jarvisfit.app.data.Store
import com.jarvisfit.app.data.WeightEntry
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.format.TextStyle
import java.util.Locale
import kotlin.math.roundToInt

/**
 * Il "cervello" di Jarvis: costruisce il contesto (profilo + diario del mese),
 * chiama Claude con un tool obbligatorio e applica le azioni restituite.
 */
object Brain {

    /** [device]: azioni da eseguire sul telefono, come coppie tipo/valore (es. "open_app" a "Spotify"). */
    data class Reply(
        val text: String,
        val expectReply: Boolean,
        val photoRequest: String?,
        val cardInfo: String? = null,
        val device: List<Pair<String, String>> = emptyList(),
    )

    private val mutex = Mutex()

    suspend fun handle(userText: String, imageJpegBase64: String? = null): Reply = kotlinx.coroutines.withContext(kotlinx.coroutines.NonCancellable) {
        mutex.withLock {
            Store.addChat("user", userText, hasImage = imageJpegBase64 != null)
            val reply = try {
                val response = GeminiClient.send(buildRequest(userText, imageJpegBase64))
                val input = GeminiClient.toolInput(response)
                if (input == null) {
                    Reply(GeminiClient.text(response).ifBlank { "Non ho capito, puoi ripetere?" }, true, null, null)
                } else {
                    val photo = applyActions(input["actions"] as? JsonArray, imageJpegBase64 != null)
                    Reply(
                        text = input.s("reply").ifBlank { "Fatto." },
                        expectReply = input["expect_reply"]?.jsonPrimitive?.booleanOrNull ?: false,
                        photoRequest = photo,
                        cardInfo = input.s("card_info").ifBlank { null },
                    )
                }
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                val errorMsg = e.message ?: "Errore sconosciuto"
                val friendly = when {
                    errorMsg.contains("503") || errorMsg.contains("demand", ignoreCase = true) ->
                        "Signore, i server di Google sono momentaneamente saturi per picco di traffico globale (503). Ho memorizzato il contesto, la prego di riprovare tra qualche istante."
                    errorMsg.contains("429") ->
                        "Signore, abbiamo raggiunto temporaneamente il limite di frequenza di Google (429). Attendiamo qualche secondo."
                    errorMsg.contains("Manca la API key") ->
                        "Manca la chiave API di Gemini: la inserisca nel Profilo."
                    else -> "Problema di connessione: $errorMsg"
                }
                Reply(friendly, false, null, null)
            }
            Store.addChat("assistant", reply.text)
            if (imageJpegBase64 != null && reply.photoRequest == null) {
                Store.update { it.copy(pendingPhotoRequest = "") }
            }
            reply
        }
    }

    /** Analizza una sola volta la foto profilo e salva una descrizione neutra. */
    suspend fun describeAppearance(imageJpegBase64: String): String {
        val body = buildJsonObject {
            putJsonArray("contents") {
                addJsonObject {
                    put("role", "user")
                    putJsonArray("parts") {
                        addImage(imageJpegBase64)
                        addJsonObject {
                            put("text", "Questa è la mia foto per un'app di nutrizione. Descrivi in 2-3 frasi neutre e rispettose la corporatura, una stima indicativa della percentuale di massa grassa (come intervallo) e dove sembra esserci più margine di miglioramento. In italiano, niente giudizi estetici.")
                        }
                    }
                }
            }
        }
        return GeminiClient.text(GeminiClient.send(body)).trim()
    }

    // ---------------------------------------------------------------- request

    private fun buildRequest(userText: String, image: String?): JsonObject {
        val d = Store.diary
        return buildJsonObject {
            putJsonObject("systemInstruction") {
                putJsonArray("parts") {
                    addJsonObject { put("text", systemPrompt(d)) }
                }
            }
            putJsonArray("tools") {
                addJsonObject { putJsonArray("functionDeclarations") { add(responseTool) } }
            }
            putJsonObject("toolConfig") {
                putJsonObject("functionCallingConfig") {
                    put("mode", "ANY")
                    putJsonArray("allowedFunctionNames") { add("jarvis_response") }
                }
            }
            putJsonArray("contents") {
                // storia recente (ruoli alternati, l'ultimo messaggio utente è quello corrente)
                val history = d.chat.dropLast(1).takeLast(14)
                    .fold(mutableListOf<Pair<String, String>>()) { acc, m ->
                        val r = if (m.role == "user") "user" else "model"
                        if (acc.isNotEmpty() && acc.last().first == r)
                            acc[acc.lastIndex] = r to acc.last().second + "\n" + m.text
                        else acc += r to m.text
                        acc
                    }.dropWhile { it.first != "user" }
                val trimmed = if (history.lastOrNull()?.first == "user") history.dropLast(1) else history
                trimmed.forEach { (role, text) ->
                    addJsonObject {
                        put("role", role)
                        putJsonArray("parts") { addJsonObject { put("text", text) } }
                    }
                }
                addJsonObject {
                    put("role", "user")
                    putJsonArray("parts") {
                        if (image != null) addImage(image)
                        addJsonObject {
                            put("text", "[${now()}] $userText")
                        }
                    }
                }
            }
        }
    }

    private fun kotlinx.serialization.json.JsonArrayBuilder.addImage(b64: String) = addJsonObject {
        putJsonObject("inlineData") {
            put("mimeType", "image/jpeg")
            put("data", b64)
        }
    }

    private fun now(): String {
        val n = LocalDateTime.now()
        val day = n.dayOfWeek.getDisplayName(TextStyle.FULL, Locale.ITALIAN)
        return "$day ${n.toLocalDate()} ore %02d:%02d".format(n.hour, n.minute)
    }

    private fun Double.r() = roundToInt()

    private fun systemPrompt(d: Diary): String {
        val p = d.profile
        val today = LocalDate.now()
        val target = Nutrition.dailyTarget(d)
        val sb = StringBuilder()
        sb.appendLine("""
Sei JARVIS, l'assistente personale di ${p.name.ifBlank { "del signore" }} ispirato all'intelligenza artificiale di Iron Man.
Personalità: impeccabile, calmo, brillante, rispettoso e devoto ("Certamente, signore", "Subito", "Ai suoi ordini").
Parli SEMPRE in italiano con tono naturale, sintetico ed elegante (1-4 frasi, niente elenchi lunghi, niente markdown, numeri arrotondati).

ADESSO: ${now()}.
Risolvi sempre le date relative ("oggi", "ieri", "l'altro ieri", "stamattina") rispetto ad ADESSO
e scrivi la data esatta yyyy-MM-dd nelle azioni. Se l'utente non specifica il pasto, deducilo dall'ora.
Se parla di un pasto già registrato usa update_meal con l'id esistente.

GESTIONE CONVERSAZIONE CONTINUA:
- L'utente è in modalità conversazione continua. Rimani in ascolto (expect_reply = true) per permettergli di continuare a parlare con te di cibo, allenamenti, pasti, ricette o forma fisica.
- Se l'utente ti ringrazia, dice che è a posto così, dice "basta", "ciao", "a posto" o ti saluta: congedati con eleganza (es. "Sempre un piacere esserle utile, signore. Resto in stand-by.") e imposta expect_reply = false per chiudere la sessione.
- Se il discorso è completamente privo di senso o totalmente fuori contesto rispetto a salute, nutrizione, fitness o alla vita dell'utente: rispondi brevemente con garbo e chiudi la conversazione impostando expect_reply = false.

COMPITI SPECIFICI FIT & NUTRITION:
- Pasti: stima grammi, kcal e macro (carboidrati, proteine, grassi) e registra con add_meal. Se le quantità sono vaghe e importanti chiedi una foto con request_photo oppure la quantità.
- DOPO AVER REGISTRATO UN PASTO O UNO SGARRO: comunica le kcal stimate e quante ne restano oggi rispetto al TARGET ADATTIVO.
- SE L'UTENTE SGARRA O AGGIUNGE PASTI PASSATI DIMENTICATI (es. "ieri ho mangiato una pizza e ho dimenticato di dirtelo"):
  * Registra l'alimento sulla data esatta passata con add_meal.
  * Rassicura l'utente con tono pacato e devoto ("Nessun problema, signore. Il bilancio si gestisce su base settimanale").
  * Spiega chiaramente come il target dei giorni rimanenti si è adattato per compensare gradualmente e mantenere l'obiettivo senza digiuni.
- Allenamenti: registra con add_activity stimando kcal bruciate in modo prudente (MET realistici, peso attuale).
- Passi e target adattivo continuo:
  * Ogni passo compiuto brucia ~${"%.3f".format(Nutrition.kcalPerStep(d))} kcal. Il 50% di questa energia viene accreditato automaticamente ed in tempo reale al target calorico di oggi.
  * Più l'utente cammina, più il suo target e le calorie disponibili aumentano in modo sicuro e motivante.
  * Se l'utente comunica i passi a voce (es. "Oggi ho fatto 8000 passi", "Imposta i passi a 10000"), usa l'azione set_steps per salvarli.
  * Quando parli di calorie rimanenti o fabbisogno di oggi, fai sempre riferimento al TARGET CALORICO EFFETTIVO DI OGGI adattato ai passi e alle attività.
- RICETTE, CUCINA E SESSIONE ATTIVA:
  * OBBLIGATORIO: Quando proponi una ricetta all'utente, quando ne discutete o quando decide di cucinare, DEVI SEMPRE E METTERE SUBITO l'azione update_recipe_session (title, current_step, ingredients_needed, notes) per mostrare a schermo il banner verde "In cucina" e salvare la nota di preparazione!
  * Continua ad accompagnare l'utente passo dopo passo aggiornando la sessione e tenendo traccia della ricetta in corso fino a quando l'utente non dice che ha finito di cucinare, ringrazia o dice basta.
  * Quando l'utente dice "ho finito la ricetta", "ho finito di cucinare", "fatto tutto", chiudi la sessione attiva con l'azione clear_recipe_session.
  * SE ALL'UTENTE PIACE PARTICOLARMENTE L'IDEA O DICE "salva la ricetta" / "mi piace salva questa ricetta":
    salvala nel ricettario permanente con save_recipe (title, ingredients con grammi e kcal, instructions, total_kcal, total_protein, total_carbs, total_fat).
  * RECUPERO E ADATTAMENTO DINAMICO DELLE RICETTE SALVATE:
    Se l'utente vuole cucinare una ricetta salvata o una proposta, ANCHE SE LE CALORIE ORIGINALI NON CORRISPONDONO AL BUDGET DI OGGI, RICALCOLA E MODIFICA AUTOMATICAMENTE LE DOSI (es. riduci la pasta da 100g a 70g, aumenta la fonte proteica o riduci l'olio) oppure sostituisci ingredienti con quello che ha in dispensa, in modo da FAR RIENTRARE PERFETTAMENTE IL PIATTO NEL SUO TARGET CALORICO E DEI MACRO DEL GIORNO, spiegandogli le modifiche alle quantità con chiarezza!
- DISPENSA E ORGANIZZAZIONE PASTI:
  * L'utente ha uno spazio DISPENSA (ingredienti disponibili in casa). Quando chiede cosa mangiare, ricette o come organizzare i pasti, crea proposte basandoti PRIMARIAMENTE su quello che ha in dispensa, rispettando il target adattivo e i suoi gusti.
  * Se l'utente invia foto della dispensa/frigo/spesa o ti elenca cosa ha comprato/in casa: analizza gli ingredienti e registrali in dispensa con l'azione add_pantry_item (name, quantity, category).
  * Se un ingrediente è finito o consumato del tutto, rimuovilo con remove_pantry_item.
- Peso / modifiche profilo: registra con add_weight o update_profile.
- Gestione deficit e bilanciamento: se l'utente ha un surplus oggi o ieri, rassicuralo spiegando che il fabbisogno stimato di domani è già stato ribilanciato su tutta la settimana per mantenere il ritmo di perdita desiderato.
- RICHIESTE DEFICIT, PERDITA DI PESO DA INIZIO DATI E "IN QUEL MOMENTO":
  Se l'utente ti chiede: "calcolami la perdita di peso in quel momento e il deficit da quando ho iniziato a caricare i dati", oppure chiede quanto deficit ha accumulato o quanto peso ha perso:
  * Rispondi fornendo con chiarezza:
    1) Il deficit totale reale accumulato da quando ha iniziato a caricare i dati rispetto al mantenimento (${Nutrition.cumulativeBalance(d, today).cumulativeDeficitVsMaintenance} kcal) e la stima della perdita di peso (${"%.2f".format(Nutrition.cumulativeBalance(d, today).estimatedWeightLossKg)} kg).
    2) La variazione di peso effettiva registrata con le pesate sulla bilancia.
    3) Le medie giornaliere (apporto netto, deficit giornaliero e passi) specificando espressamente che, se il primo giorno registrato era a zero (0 calorie), esso è stato escluso dal calcolo della media come da regola.
    4) Se la domanda riguarda un giorno passato specifico o "in quel momento", consulta la sezione progressiva giorno per giorno sotto e indica il deficit accumulato e la perdita stimata/effettiva fino a quella data precisa.
- Sicurezza: mantieni sempre un approccio sano e sicuro, senza diete estreme o compensazioni dannose.
""".trimIndent())

        val adapt = Nutrition.weeklyAdaptive(d, today)
        val month = Nutrition.monthlyBalance(d, today)
        val cum = Nutrition.cumulativeBalance(d, today)
        val todayTotals = Nutrition.totals(d, today.toString())
        val todayTargetEffective = adapt.adaptiveDailyTarget + (todayTotals.burned * 0.5 + todayTotals.stepBonus).roundToInt()
        val remainingToday = todayTargetEffective - todayTotals.kcal.roundToInt()

        sb.appendLine("\nBILANCIO CUMULATIVO COMPLETO (DA QUANDO HA INIZIATO A CARICARE I DATI: ${cum.startDate})")
        sb.appendLine("- Inizio caricamento dati: ${cum.startDate} (totale ${cum.totalDays} giorni, ${cum.activeDaysCount} giorni considerati per il calcolo delle medie)")
        if (cum.isFirstDayZeroExcluded) {
            sb.appendLine("- REGOLA MEDIA APPLICATA: Il primo giorno (${cum.startDate}) aveva valore pari a zero ed è stato ESCLUSO dal calcolo della media.")
        }
        sb.appendLine("- DEFICIT TOTALE REALE ACCUMULATO DA INIZIO AD OGGI: ${cum.cumulativeDeficitVsMaintenance} kcal vs mantenimento")
        sb.appendLine("- STIMA PERDITA DI PESO DA DEFICIT DA INIZIO: ${"%.2f".format(cum.estimatedWeightLossKg)} kg (variazione stimata ${"%.2f".format(cum.estimatedWeightChangeKg)} kg)")
        if (cum.actualWeightLossKg != null) {
            sb.appendLine("- PESO EFFETTIVO BILANCIA DA INIZIO AD OGGI: ${cum.startWeightKg} kg -> ${cum.currentWeightKg} kg (${if (cum.actualWeightLossKg >= 0) "-${"%.1f".format(cum.actualWeightLossKg)}" else "+${"%.1f".format(-cum.actualWeightLossKg)}"} kg)")
        } else {
            sb.appendLine("- Peso: attuale ${cum.currentWeightKg} kg, iniziale ${cum.startWeightKg} kg")
        }
        sb.appendLine("- MEDIE GIORNALIERE (primo giorno a zero escluso): apporto netto ${cum.avgNetKcalPerDay} kcal/gg | deficit ${cum.avgDeficitPerDay} kcal/gg | passi ${cum.avgStepsPerDay}/gg")
        sb.appendLine("- STORICO GIORNO PER GIORNO (\"IN QUEL MOMENTO\"):")
        cum.dailyProgressList.takeLast(15).forEach { p ->
            val wStr = if (p.recordedWeightKg != null) ", peso effettivo ${p.recordedWeightKg} kg (${if ((p.weightLossFromStartKg ?: 0.0) >= 0) "-${"%.1f".format(p.weightLossFromStartKg)}" else "+${"%.1f".format(-(p.weightLossFromStartKg ?: 0.0))}"} kg da inizio)" else ""
            sb.appendLine("  * [${p.date}] netto ${p.netConsumed} kcal, deficit giorno ${p.dailyDeficit} kcal | Fino a quel momento: deficit accumulato ${p.cumulativeDeficit} kcal, stima perdita ${"%.2f".format(-p.cumulativeEstimatedWeightChangeKg)} kg$wStr")
        }

        sb.appendLine("\nBILANCIO NUTRIZIONALE ADATTIVO (FLESSIBILE SETTIMANALE E MENSILE)")
        sb.appendLine("- Target base teorico: ${adapt.baseDailyTarget} kcal/giorno")
        sb.appendLine("- Target adattato settimanale di OGGI: ${adapt.adaptiveDailyTarget} kcal (compensazione pasti precedenti: ${if (adapt.deltaKcal >= 0) "+${adapt.deltaKcal}" else "${adapt.deltaKcal}"} kcal)")
        sb.appendLine("- OGGI: ${todayTotals.steps} passi (${todayTotals.stepBurned.roundToInt()} kcal bruciate stimate -> +${todayTotals.stepBonus.roundToInt()} kcal accreditate al budget al 50%), attività registrate ${todayTotals.burned.roundToInt()} kcal (+${(todayTotals.burned * 0.5).roundToInt()} kcal al budget)")
        sb.appendLine("- TARGET CALORICO EFFETTIVO DI OGGI (adattato a passi e attività): $todayTargetEffective kcal")
        sb.appendLine("- Mangiato oggi: ${todayTotals.kcal.roundToInt()} kcal | RIMANENTI PER OGGI: $remainingToday kcal (${if (remainingToday >= 0) "disponibili" else "sforate di ${-remainingToday} kcal"})")
        sb.appendLine("- STIMA TARGET DOMANI BILANCIATO SULLA SETTIMANA: ~${adapt.estimatedTomorrowTarget} kcal (scostamento rispetto al base: ${if (adapt.tomorrowDeltaKcal >= 0) "+${adapt.tomorrowDeltaKcal}" else "${adapt.tomorrowDeltaKcal}"} kcal, ricalcolato considerando il bilancio settimanale, surplus e passi/attività)")
        if (adapt.todaySurplusOrDeficit != 0) {
            sb.appendLine("- Bilancio netto di oggi: ${if (adapt.todaySurplusOrDeficit > 0) "SURPLUS di +${adapt.todaySurplusOrDeficit} kcal (compensato riducendo il fabbisogno di domani)" else "RISPARMIO di ${-adapt.todaySurplusOrDeficit} kcal (riaccreditato nei giorni successivi)"}")
        }
        sb.appendLine("- Bilancio settimana corrente: consumate ${adapt.consumedThisWeek} kcal, rimanenti per la settimana: ${adapt.remainingBudgetWeek} kcal su ${adapt.daysRemaining} giorni rimasti (incluso oggi)")
        sb.appendLine("- Bilancio ultimi 30 giorni (aggiornato con passi e attività fisica):")
        sb.appendLine("  * Target mensile programmato: ${month.targetTotal} kcal | Fabbisogno effettivo mantenimento: ${month.maintenanceTotal} kcal")
        sb.appendLine("  * Cibo registrato: ${month.foodKcalTotal} kcal - Bonus passi e allenamenti: ${month.totalActivityCredits} kcal = Consumo netto ${month.netConsumedTotal} kcal")
        sb.appendLine("  * Passi totali: ${month.totalSteps} (media ${month.avgStepsPerDay} passi/giorno) | Allenamenti: ${month.activityKcalTotal} kcal")
        sb.appendLine("  * Scostamento vs target programmato: ${if (month.netDifferenceVsTarget >= 0) "+${month.netDifferenceVsTarget} kcal (surplus)" else "${month.netDifferenceVsTarget} kcal (deficit/risparmio)"}")
        sb.appendLine("  * Deficit reale accumulato vs mantenimento: ${month.realizedDeficitVsMaintenance} kcal (variazione peso stimata: ${if (month.estimatedWeightChangeKg >= 0) "+" else ""}${"%.2f".format(month.estimatedWeightChangeKg)} kg)")

        d.activeRecipeSession?.let { s ->
            sb.appendLine("\n🍳 SESSIONE RICETTA IN CORSO (l'utente sta preparando questo piatto):")
            sb.appendLine("- Titolo: ${s.title}")
            if (s.currentStep.isNotBlank()) sb.appendLine("- Passaggio attuale: ${s.currentStep}")
            if (s.ingredientsNeeded.isNotBlank()) sb.appendLine("- Ingredienti/Dosi: ${s.ingredientsNeeded}")
            if (s.notes.isNotBlank()) sb.appendLine("- Note: ${s.notes}")
            sb.appendLine("(Mantieni il filo logico di questa ricetta finché l'utente non dice che ha finito o chiede di salvarla)")
        }

        if (d.savedRecipes.isNotEmpty()) {
            sb.appendLine("\n📖 RICETTARIO PREFERITO SALVATO DELL'UTENTE:")
            d.savedRecipes.forEach { r ->
                val ingr = r.ingredients.joinToString(", ") { "${it.name} (${it.grams.r()}g)" }
                sb.appendLine("- [${r.id}] \"${r.title}\": ~${r.totalKcal.r()} kcal (P${r.totalProtein.r()} C${r.totalCarbs.r()} G${r.totalFat.r()}) | Ingredienti: $ingr")
            }
        }

        if (d.pantry.isNotEmpty()) {
            sb.appendLine("\nDISPENSA & FRIGO DELL'UTENTE (ingredienti disponibili per cucinare):")
            d.pantry.forEach { item ->
                val q = if (item.quantity.isNotBlank()) " (${item.quantity})" else ""
                sb.appendLine("- [${item.id}] ${item.name}$q [${item.category}]")
            }
        } else {
            sb.appendLine("\nDISPENSA DELL'UTENTE: attualmente vuota. Se l'utente manda una foto o elenca ingredienti, aggiungili con add_pantry_item.")
        }

        sb.appendLine("\nPROFILO")
        sb.appendLine("- Sesso ${if (p.sex == "F") "femmina" else "maschio"}, età ${Nutrition.age(p)}, altezza ${p.heightCm.r()} cm")
        sb.appendLine("- Peso attuale ${"%.1f".format(Nutrition.currentWeight(d))} kg, obiettivo ${p.goal}" +
            (if (p.targetWeightKg > 0) " fino a ${"%.1f".format(p.targetWeightKg)} kg" else "") +
            ", ritmo ${p.weeklyChangeKg} kg/settimana, livello attività: ${p.activityLevel}")
        sb.appendLine("- Metabolismo basale ${Nutrition.bmr(d).r()} kcal, mantenimento ~${Nutrition.maintenance(d).r()} kcal")
        sb.appendLine("- Target base giornaliero $target kcal, proteine ~${Nutrition.proteinTarget(d)} g")
        sb.appendLine("- Sia i passi che le attività registrate aggiungono kcal al budget del giorno al 50% (stime prudenti).")
        if (p.foodLikes.isNotBlank()) sb.appendLine("- Gli piace: ${p.foodLikes}")
        if (p.foodDislikes.isNotBlank()) sb.appendLine("- NON gli piace / evita: ${p.foodDislikes}")
        if (p.dietNotes.isNotBlank()) sb.appendLine("- Note alimentazione: ${p.dietNotes}")
        if (p.appearanceNotes.isNotBlank()) sb.appendLine("- Fisico (dalla foto profilo): ${p.appearanceNotes}")

        if (d.weights.isNotEmpty()) {
            sb.appendLine("\nPESATE: " + d.weights.sortedBy { it.date }.takeLast(20)
                .joinToString(", ") { "${it.date} ${it.kg}kg" })
        }

        sb.appendLine("\nDIARIO ULTIMI 31 GIORNI (più recente in alto). Gli id servono per update/delete.")
        for (i in 0..30) {
            val date = today.minusDays(i.toLong()).toString()
            val meals = d.meals.filter { it.date == date }
            val acts = d.activities.filter { it.date == date }
            val steps = d.steps[date] ?: 0
            if (meals.isEmpty() && acts.isEmpty() && steps == 0 && i > 0) continue
            val t = Nutrition.totals(d, date)
            val label = when (i) { 0 -> " (OGGI)"; 1 -> " (IERI)"; else -> "" }
            val dow = today.minusDays(i.toLong()).dayOfWeek.getDisplayName(TextStyle.SHORT, Locale.ITALIAN)
            sb.appendLine("## $dow $date$label — mangiato ${t.kcal.r()} kcal (P${t.protein.r()} C${t.carbs.r()} G${t.fat.r()}), " +
                "attività ${t.burned.r()} kcal, passi $steps (+${t.stepBonus.r()} kcal bonus)")
            meals.sortedBy { mealOrder(it.meal) }.forEach { m ->
                sb.appendLine("  - [${m.id}] ${m.meal}: ${m.items.joinToString("; ") { "${it.name} ${it.grams.r()}g ${it.kcal.r()}kcal" }}")
            }
            acts.forEach { a -> sb.appendLine("  - [${a.id}] attività ${a.type}: ${a.description} ${a.durationMin.r()} min ~${a.kcalBurned.r()} kcal") }
        }
        val older = d.meals.filter { LocalDate.parse(it.date).isBefore(today.minusDays(30)) }
        if (older.isNotEmpty()) {
            val days = older.map { it.date }.distinct()
            sb.appendLine("\nPrima di 31 giorni fa: ${days.size} giorni registrati, media ${(older.sumOf { it.kcal } / days.size).r()} kcal/giorno.")
        }
        if (d.pendingPhotoRequest.isNotBlank()) sb.appendLine("\nHai chiesto una foto per: ${d.pendingPhotoRequest}")
        return sb.toString()
    }

    private fun mealOrder(m: String) = when (m) { "colazione" -> 0; "pranzo" -> 1; "spuntino" -> 2; else -> 3 }

    private val responseTool = buildJsonObject {
        put("name", "jarvis_response")
        put("description", "Unico modo per rispondere: testo parlato + azioni sul diario.")
        putJsonObject("parameters") {
            put("type", "object")
            putJsonArray("required") { add("reply"); add("actions"); add("expect_reply") }
            putJsonObject("properties") {
                putJsonObject("reply") { put("type", "string"); put("description", "Risposta da leggere ad alta voce, in italiano") }
                putJsonObject("card_info") {
                    put("type", "string")
                    put("description", "SCHEDA SINTETICA DATI/NOTIFICA A SCHERMO: quando comunichi dati numerici (kcal, macro, passi rimanenti, target) o ricetta/dosi in corso, inserisci qui SOLO il riassunto schematico (es. '🔥 Pranzo: 520 kcal (P38 C45 G12) • Rimanenti: 680 kcal' oppure '🍳 Pollo al curry • Passaggio 2: Rosola 200g di pollo con 1 cucchiaio d'olio'). NON mettere il discorso parlato.")
                }
                putJsonObject("expect_reply") { put("type", "boolean") }
                putJsonObject("actions") {
                    put("type", "array")
                    putJsonObject("items") {
                        put("type", "object")
                        putJsonArray("required") { add("type") }
                        putJsonObject("properties") {
                            putJsonObject("type") {
                                put("type", "string")
                                putJsonArray("enum") {
                                    listOf("add_meal", "update_meal", "delete_meal", "add_activity", "delete_activity",
                                        "add_weight", "set_steps", "request_photo", "update_profile", "add_pantry_item", "remove_pantry_item",
                                        "update_recipe_session", "clear_recipe_session", "save_recipe", "delete_recipe").forEach { add(it) }
                                }
                            }
                            putJsonObject("name") { put("type", "string"); put("description", "per add_pantry_item o remove_pantry_item") }
                            putJsonObject("quantity") { put("type", "string"); put("description", "per add_pantry_item (es. 500g, 1 confezione, 4 uova)") }
                            putJsonObject("category") { put("type", "string"); put("description", "per add_pantry_item (proteine, carboidrati, verdura, condimento, frutta, altro)") }
                            putJsonObject("title") { put("type", "string"); put("description", "titolo ricetta (per update_recipe_session o save_recipe)") }
                            putJsonObject("current_step") { put("type", "string"); put("description", "passaggio attuale in corso nella preparazione") }
                            putJsonObject("ingredients_needed") { put("type", "string"); put("description", "dosi e ingredienti per la sessione o note") }
                            putJsonObject("notes") { put("type", "string"); put("description", "note di cottura, tempi o consigli") }
                            putJsonObject("instructions") { put("type", "string"); put("description", "procedimento completo della ricetta per save_recipe") }
                            putJsonObject("total_kcal") { put("type", "number"); put("description", "kcal totali ricetta") }
                            putJsonObject("total_protein") { put("type", "number"); put("description", "proteine totali ricetta") }
                            putJsonObject("total_carbs") { put("type", "number"); put("description", "carboidrati totali ricetta") }
                            putJsonObject("total_fat") { put("type", "number"); put("description", "grassi totali ricetta") }
                            putJsonObject("id") { put("type", "string"); put("description", "id esistente per update/delete/remove") }
                            putJsonObject("date") { put("type", "string"); put("description", "yyyy-MM-dd") }
                            putJsonObject("meal") {
                                put("type", "string")
                                putJsonArray("enum") { listOf("colazione", "pranzo", "spuntino", "cena").forEach { add(it) } }
                            }
                            putJsonObject("description") { put("type", "string") }
                            putJsonObject("items") {
                                put("type", "array")
                                put("description", "per add_meal/update_meal o save_recipe: lista degli alimenti/ingredienti con grammi e calorie")
                                putJsonObject("items") {
                                    put("type", "object")
                                    putJsonArray("required") { add("name"); add("grams"); add("kcal") }
                                    putJsonObject("properties") {
                                        putJsonObject("name") { put("type", "string") }
                                        listOf("grams", "kcal", "protein", "carbs", "fat").forEach { f ->
                                            putJsonObject(f) { put("type", "number") }
                                        }
                                    }
                                }
                            }
                            putJsonObject("activity_type") { put("type", "string") }
                            putJsonObject("duration_min") { put("type", "number") }
                            putJsonObject("kcal_burned") { put("type", "number") }
                            putJsonObject("kg") { put("type", "number") }
                            putJsonObject("steps") { put("type", "number"); put("description", "numero di passi per set_steps") }
                            putJsonObject("reason") { put("type", "string"); put("description", "per request_photo") }
                            putJsonObject("field") {
                                put("type", "string")
                                put("description", "per update_profile: targetWeightKg, goal, weeklyChangeKg, activityLevel, foodLikes, foodDislikes, dietNotes, heightCm")
                            }
                            putJsonObject("value") { put("type", "string") }
                        }
                    }
                }
            }
        }
    }

    // ---------------------------------------------------------------- actions

    private fun JsonObject.s(k: String): String = (this[k] as? JsonPrimitive)?.content ?: ""
    private fun JsonObject.n(k: String): Double = (this[k] as? JsonPrimitive)?.doubleOrNull ?: 0.0

    private fun items(o: JsonObject): List<FoodItem> = (o["items"] as? JsonArray)?.map {
        val i = it.jsonObject
        FoodItem(i.s("name"), i.n("grams"), i.n("kcal"), i.n("protein"), i.n("carbs"), i.n("fat"))
    } ?: emptyList()

    private fun validDate(s: String) = runCatching { LocalDate.parse(s).toString() }.getOrDefault(Store.today())

    /** Applica le azioni; ritorna il motivo se è stata chiesta una foto. */
    private fun applyActions(actions: JsonArray?, hadPhoto: Boolean): String? {
        var photo: String? = null
        actions?.forEach { el ->
            val a = el.jsonObject
            when (a.s("type")) {
                "add_meal" -> Store.update { d ->
                    d.copy(meals = d.meals + Meal(
                        id = Store.newId("m"), date = validDate(a.s("date")), meal = a.s("meal").ifBlank { "spuntino" },
                        description = a.s("description"), items = items(a), loggedAt = Store.nowIso(), hasPhoto = hadPhoto,
                    ))
                }
                "update_meal" -> Store.update { d ->
                    d.copy(meals = d.meals.map { m ->
                        if (m.id != a.s("id")) m else m.copy(
                            date = if (a.s("date").isNotBlank()) validDate(a.s("date")) else m.date,
                            meal = a.s("meal").ifBlank { m.meal },
                            description = a.s("description").ifBlank { m.description },
                            items = items(a).ifEmpty { m.items },
                            hasPhoto = m.hasPhoto || hadPhoto,
                        )
                    })
                }
                "delete_meal" -> Store.update { d -> d.copy(meals = d.meals.filterNot { it.id == a.s("id") }) }
                "add_activity" -> Store.update { d ->
                    d.copy(activities = d.activities + Activity(
                        id = Store.newId("a"), date = validDate(a.s("date")),
                        type = a.s("activity_type").ifBlank { "allenamento" }, description = a.s("description"),
                        durationMin = a.n("duration_min"), kcalBurned = a.n("kcal_burned"),
                    ))
                }
                "delete_activity" -> Store.update { d -> d.copy(activities = d.activities.filterNot { it.id == a.s("id") }) }
                "add_weight" -> if (a.n("kg") > 20) Store.update { d ->
                    val date = validDate(a.s("date"))
                    d.copy(weights = d.weights.filterNot { it.date == date } + WeightEntry(date, a.n("kg")))
                }
                "set_steps" -> {
                    val st = a.n("steps").toInt()
                    val date = if (a.s("date").isNotBlank()) validDate(a.s("date")) else Store.today()
                    if (st >= 0) Store.setSteps(date, st)
                }
                "request_photo" -> {
                    photo = a.s("reason").ifBlank { "stimare le porzioni" }
                    Store.update { it.copy(pendingPhotoRequest = photo!!) }
                }
                "update_profile" -> Store.update { d ->
                    val v = a.s("value")
                    val p = d.profile
                    d.copy(profile = when (a.s("field")) {
                        "targetWeightKg" -> p.copy(targetWeightKg = v.toDoubleOrNull() ?: p.targetWeightKg)
                        "goal" -> p.copy(goal = v)
                        "weeklyChangeKg" -> p.copy(weeklyChangeKg = v.toDoubleOrNull() ?: p.weeklyChangeKg)
                        "activityLevel" -> p.copy(activityLevel = v)
                        "foodLikes" -> p.copy(foodLikes = v)
                        "foodDislikes" -> p.copy(foodDislikes = v)
                        "dietNotes" -> p.copy(dietNotes = v)
                        "heightCm" -> p.copy(heightCm = v.toDoubleOrNull() ?: p.heightCm)
                        else -> p
                    })
                }
                "add_pantry_item" -> Store.update { d ->
                    val name = a.s("name").trim()
                    if (name.isNotBlank()) {
                        d.copy(pantry = d.pantry + com.jarvisfit.app.data.PantryItem(
                            id = Store.newId("p"),
                            name = name,
                            quantity = a.s("quantity").trim(),
                            category = a.s("category").ifBlank { "generale" },
                            addedAt = Store.today()
                        ))
                    } else d
                }
                "remove_pantry_item" -> Store.update { d ->
                    val id = a.s("id")
                    val name = a.s("name").lowercase().trim()
                    d.copy(pantry = d.pantry.filterNot { 
                        (id.isNotBlank() && it.id == id) || (name.isNotBlank() && it.name.lowercase().contains(name)) 
                    })
                }
                "update_recipe_session" -> Store.update { d ->
                    val title = a.s("title").ifBlank { d.activeRecipeSession?.title ?: "Ricetta in corso" }
                    val currentStep = a.s("current_step").ifBlank { d.activeRecipeSession?.currentStep ?: "" }
                    val ingredientsNeeded = a.s("ingredients_needed").ifBlank { d.activeRecipeSession?.ingredientsNeeded ?: "" }
                    val notes = a.s("notes").ifBlank { d.activeRecipeSession?.notes ?: "" }
                    d.copy(activeRecipeSession = com.jarvisfit.app.data.ActiveRecipeSession(
                        title = title,
                        currentStep = currentStep,
                        ingredientsNeeded = ingredientsNeeded,
                        notes = notes,
                        startedAt = d.activeRecipeSession?.startedAt ?: Store.nowIso()
                    ))
                }
                "clear_recipe_session" -> Store.update { d ->
                    d.copy(activeRecipeSession = null)
                }
                "save_recipe" -> Store.update { d ->
                    val recipeItems = items(a)
                    val title = a.s("title").ifBlank { d.activeRecipeSession?.title ?: "Ricetta preferita" }
                    val calcKcal = if (a.n("total_kcal") > 0) a.n("total_kcal") else recipeItems.sumOf { it.kcal }
                    val calcProt = if (a.n("total_protein") > 0) a.n("total_protein") else recipeItems.sumOf { it.protein }
                    val calcCarbs = if (a.n("total_carbs") > 0) a.n("total_carbs") else recipeItems.sumOf { it.carbs }
                    val calcFat = if (a.n("total_fat") > 0) a.n("total_fat") else recipeItems.sumOf { it.fat }
                    val recipe = com.jarvisfit.app.data.Recipe(
                        id = Store.newId("rec"),
                        title = title,
                        ingredients = recipeItems,
                        instructions = a.s("instructions").ifBlank { d.activeRecipeSession?.notes ?: "" },
                        totalKcal = calcKcal,
                        totalProtein = calcProt,
                        totalCarbs = calcCarbs,
                        totalFat = calcFat,
                        createdAt = Store.today()
                    )
                    d.copy(
                        savedRecipes = d.savedRecipes + recipe,
                        activeRecipeSession = null // chiude la sessione attiva ora che è salvata
                    )
                }
                "delete_recipe" -> Store.update { d ->
                    val id = a.s("id")
                    val title = a.s("title").lowercase().trim()
                    d.copy(savedRecipes = d.savedRecipes.filterNot {
                        (id.isNotBlank() && it.id == id) || (title.isNotBlank() && it.title.lowercase() == title)
                    })
                }
            }
        }
        return photo
    }
}
