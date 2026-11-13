package com.jarvisfit.app.data

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.Json
import java.io.File
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import java.util.concurrent.atomic.AtomicLong

/**
 * Diario persistente su file JSON (privato dell'app).
 * Tiene TUTTO lo storico: pasti, attività, peso, passi, chat.
 */
object Store {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true; prettyPrint = false; coerceInputValues = true }
    private var file: File? = null
    private val _state = MutableStateFlow(Diary())
    val state: StateFlow<Diary> = _state
    val diary: Diary get() = _state.value
    private val idCounter = AtomicLong(0)

    fun init(context: Context) = initWithFile(File(context.filesDir, "diary.json"))

    /**
     * Carica il diario da [f]. Se il file è corrotto NON viene sovrascritto con un diario vuoto:
     * viene messo da parte come copia di sicurezza (diary.corrupt-*.json) per non perdere dati.
     */
    fun initWithFile(f: File) {
        file = f
        // Recupera un eventuale salvataggio interrotto (tmp completo ma rename non avvenuto)
        val tmp = File(f.parentFile, "diary.tmp")
        if (!f.exists() && tmp.exists()) tmp.renameTo(f)
        if (!f.exists()) { _state.value = Diary(); return }
        val loaded = runCatching { json.decodeFromString(Diary.serializer(), f.readText()) }
        if (loaded.isSuccess) {
            _state.value = loaded.getOrThrow()
        } else {
            runCatching { f.copyTo(File(f.parentFile, "diary.corrupt-${System.currentTimeMillis()}.json"), overwrite = true) }
            _state.value = Diary()
        }
    }

    @Synchronized
    fun update(block: (Diary) -> Diary) {
        val next = block(_state.value)
        if (next == _state.value) return
        _state.value = next
        val target = file ?: return // nessuna persistenza (es. test JVM)
        runCatching {
            val tmp = File(target.parentFile, "diary.tmp")
            tmp.writeText(json.encodeToString(Diary.serializer(), next))
            if (!tmp.renameTo(target)) {
                target.delete()
                tmp.renameTo(target)
            }
        }
    }

    /** Solo per i test: azzera lo stato in memoria. */
    internal fun resetForTest(d: Diary = Diary()) { file = null; _state.value = d }

    fun today(): String = LocalDate.now().toString()
    fun nowIso(): String = LocalDateTime.now().format(DateTimeFormatter.ISO_LOCAL_DATE_TIME).take(16)

    /** Id univoco anche per più azioni generate nello stesso millisecondo. */
    fun newId(prefix: String) =
        prefix + System.currentTimeMillis().toString(36) + idCounter.incrementAndGet().toString(36)

    fun addChat(role: String, text: String, hasImage: Boolean = false) = update {
        it.copy(chat = (it.chat + ChatMsg(role, text, nowIso(), hasImage)).takeLast(300))
    }

    fun setSteps(date: String, steps: Int) = update { it.copy(steps = it.steps + (date to steps)) }

    private val exportJsonFormat = Json { prettyPrint = true; encodeDefaults = true }
    fun exportJson(): String = exportJsonFormat.encodeToString(Diary.serializer(), diary)

    data class ImportResult(val meals: Int, val activities: Int, val weights: Int)

    /**
     * Importa un backup (lo stesso formato di diary.json) unendolo al diario attuale:
     * non cancella nulla e non duplica ciò che c'è già (stesso id, o stessa data per pesate e passi).
     * Il profilo del backup vale solo se quello attuale non è ancora completo.
     * Lancia un'eccezione se il testo non è un backup valido.
     */
    fun importJson(text: String): ImportResult {
        val b = json.decodeFromString(Diary.serializer(), text)
        require(b.meals.isNotEmpty() || b.weights.isNotEmpty() || b.profile.isComplete) { "Il file non contiene dati di Jarvis." }
        var added = ImportResult(0, 0, 0)
        update { cur ->
            fun <T> union(a: List<T>, extra: List<T>, key: (T) -> String): List<T> {
                val seen = a.map(key).toHashSet()
                return a + extra.filter { seen.add(key(it)) }
            }
            val meals = union(cur.meals, b.meals) { it.id }
            val acts = union(cur.activities, b.activities) { it.id }
            val weights = union(cur.weights, b.weights) { it.date }.sortedBy { it.date }
            added = ImportResult(meals.size - cur.meals.size, acts.size - cur.activities.size, weights.size - cur.weights.size)
            val steps = (b.steps.keys + cur.steps.keys).associateWith { d -> maxOf(b.steps[d] ?: 0, cur.steps[d] ?: 0) }
            cur.copy(
                profile = if (cur.profile.isComplete) cur.profile else b.profile,
                meals = meals,
                activities = acts,
                weights = weights,
                steps = steps,
                chat = if (cur.chat.isEmpty()) b.chat.takeLast(300) else cur.chat,
                pantry = union(cur.pantry, b.pantry) { it.id },
                savedRecipes = union(cur.savedRecipes, b.savedRecipes) { it.id },
                activeRecipeSession = cur.activeRecipeSession ?: b.activeRecipeSession,
            )
        }
        return added
    }
}
