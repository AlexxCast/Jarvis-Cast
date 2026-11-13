package com.jarvisfit.app

import com.jarvisfit.app.data.Diary
import com.jarvisfit.app.data.FoodItem
import com.jarvisfit.app.data.Meal
import com.jarvisfit.app.data.Profile
import com.jarvisfit.app.data.Store
import com.jarvisfit.app.data.WeightEntry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class StoreTest {

    @get:Rule
    val tempFolder = TemporaryFolder()

    @Test
    fun testInitWithValidFile() {
        val file = tempFolder.newFile("diary.json")
        Store.initWithFile(file)

        Store.update { current ->
            current.copy(
                profile = Profile(name = "Marco", weightKg = 75.0),
                meals = listOf(
                    Meal(
                        id = "m1",
                        date = "2026-10-26",
                        meal = "lunch",
                        description = "Riso e Pollo",
                        items = listOf(FoodItem("Pollo", grams = 150.0, kcal = 250.0, protein = 45.0, carbs = 0.0, fat = 5.0))
                    )
                ),
                steps = mapOf("2026-10-26" to 7500),
                weights = listOf(WeightEntry("2026-10-26", 74.8))
            )
        }

        // Re-read file with a fresh init
        Store.resetForTest()
        assertEquals("", Store.diary.profile.name) // reset to empty default Profile

        Store.initWithFile(file)
        assertEquals("Marco", Store.diary.profile.name)
        assertEquals(75.0, Store.diary.profile.weightKg, 0.01)
        assertEquals(1, Store.diary.meals.size)
        assertEquals(250.0, Store.diary.meals[0].kcal, 0.01)
        assertEquals(7500, Store.diary.steps["2026-10-26"])
        assertEquals(74.8, Store.diary.weights[0].kg, 0.01)
    }

    @Test
    fun testCorruptFileBackupProtection() {
        val file = tempFolder.newFile("diary.json")
        file.writeText("{ INVALID_JSON_DATA_HERE !!! }")

        Store.initWithFile(file)

        // State should gracefully fall back to default empty diary rather than crashing
        assertNotNull(Store.diary)
        assertEquals("", Store.diary.profile.name)

        // Verify that a backup copy was created in parent folder
        val corruptBackups = file.parentFile?.listFiles { _, name ->
            name.startsWith("diary.corrupt-") && name.endsWith(".json")
        }
        assertNotNull("Backup file should exist", corruptBackups)
        assertTrue("At least one corrupt backup should be preserved", corruptBackups!!.isNotEmpty())
        assertEquals("{ INVALID_JSON_DATA_HERE !!! }", corruptBackups[0].readText())
    }

    @Test
    fun testTmpFileRecovery() {
        val folder = tempFolder.root
        val jsonFile = File(folder, "diary.json")
        val tmpFile = File(folder, "diary.tmp")

        // Suppose diary.tmp was saved but rename didn't happen yet
        tmpFile.writeText("""
            {
                "profile": { "name": "RecoveredUser", "weightKg": 82.0 },
                "meals": [],
                "activities": [],
                "weights": [],
                "steps": {},
                "chat": [],
                "pantry": [],
                "savedRecipes": []
            }
        """.trimIndent())

        assertFalse(jsonFile.exists())
        assertTrue(tmpFile.exists())

        Store.initWithFile(jsonFile)

        // Store should have restored tmp into diary.json
        assertTrue("diary.json should have been restored from diary.tmp", jsonFile.exists())
        assertEquals("RecoveredUser", Store.diary.profile.name)
        assertEquals(82.0, Store.diary.profile.weightKg, 0.01)
    }

    @Test
    fun testNewIdUniqueness() {
        val threadCount = 8
        val iterationsPerThread = 500
        val executor = Executors.newFixedThreadPool(threadCount)
        val seenIds = ConcurrentHashMap.newKeySet<String>()

        for (t in 0 until threadCount) {
            executor.submit {
                for (i in 0 until iterationsPerThread) {
                    val id = Store.newId("entry_")
                    val isNew = seenIds.add(id)
                    assertTrue("ID collision detected: $id", isNew)
                }
            }
        }

        executor.shutdown()
        assertTrue(executor.awaitTermination(5, TimeUnit.SECONDS))
        assertEquals(threadCount * iterationsPerThread, seenIds.size)
    }

    @Test
    fun importBackupMergesWithoutDuplicatesOrLosses() {
        val existing = Meal(id = "m1", date = "2026-11-13", meal = "colazione")
        Store.resetForTest(Diary(meals = listOf(existing), steps = mapOf("2026-11-13" to 500)))
        val backup = Diary(
            profile = Profile(name = "A", birthDate = "2003-05-23", heightCm = 185.0, weightKg = 88.0),
            meals = listOf(existing, Meal(id = "m2", date = "2026-10-10", meal = "pranzo")),
            weights = listOf(WeightEntry("2026-10-10", 88.0)),
            steps = mapOf("2026-11-13" to 300, "2026-10-10" to 4000),
        )
        val text = kotlinx.serialization.json.Json.encodeToString(Diary.serializer(), backup)

        val r = Store.importJson(text)

        assertEquals(1, r.meals)
        assertEquals(1, r.weights)
        assertEquals(listOf("m1", "m2"), Store.diary.meals.map { it.id })
        assertEquals("A", Store.diary.profile.name)
        assertEquals(500, Store.diary.steps["2026-11-13"])
        assertEquals(4000, Store.diary.steps["2026-10-10"])
        // Importare due volte lo stesso file non duplica nulla.
        assertEquals(0, Store.importJson(text).meals)
        assertEquals(2, Store.diary.meals.size)
    }

    @Test(expected = Exception::class)
    fun importRejectsFilesThatAreNotBackups() {
        Store.resetForTest()
        Store.importJson("{\"foo\": 1}")
    }
}
