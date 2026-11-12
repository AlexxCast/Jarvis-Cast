package com.jarvisfit.app

import com.jarvisfit.app.data.Diary
import com.jarvisfit.app.data.FoodItem
import com.jarvisfit.app.data.Meal
import com.jarvisfit.app.data.Nutrition
import com.jarvisfit.app.data.Profile
import com.jarvisfit.app.data.WeightEntry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate

class NutritionTest {

    private fun testDiary(
        weightKg: Double = 80.0,
        heightCm: Double = 180.0,
        birthDate: String = "1996-01-01",
        sex: String = "M",
        activityLevel: String = "moderato",
        goal: String = "dimagrire",
        weeklyChangeKg: Double = 0.5
    ) = Diary(
        profile = Profile(
            name = "Alex",
            birthDate = birthDate,
            sex = sex,
            heightCm = heightCm,
            weightKg = weightKg,
            activityLevel = activityLevel,
            goal = goal,
            weeklyChangeKg = weeklyChangeKg
        )
    )

    @Test
    fun testBmrCalculation() {
        // Male: 10 * 80 + 6.25 * 180 - 5 * 30 + 5 = 800 + 1125 - 150 + 5 = 1780.0
        val maleBmr = Nutrition.bmr(weightKg = 80.0, heightCm = 180.0, ageYears = 30, sex = "M")
        assertEquals(1780.0, maleBmr, 0.01)

        // Female: 10 * 60 + 6.25 * 165 - 5 * 25 - 161 = 600 + 1031.25 - 125 - 161 = 1345.25
        val femaleBmr = Nutrition.bmr(weightKg = 60.0, heightCm = 165.0, ageYears = 25, sex = "F")
        assertEquals(1345.25, femaleBmr, 0.01)
    }

    @Test
    fun testMaintenanceAndTargetKcal() {
        val diary = testDiary()
        val maint = Nutrition.maintenance(diary).toInt()
        val target = Nutrition.dailyTarget(diary)

        // For cut at 0.5 kg/week: deficit is 0.5 * 7700 / 7 = 550 kcal/day
        assertEquals(maint - 550, target)

        // Maintain goal
        val maintainDiary = diary.copy(profile = diary.profile.copy(goal = "mantenere"))
        assertEquals(maint, Nutrition.dailyTarget(maintainDiary))

        // Bulk goal (0.25 kg/week = +275 kcal)
        val bulkDiary = diary.copy(profile = diary.profile.copy(goal = "massa", weeklyChangeKg = 0.25))
        assertEquals(maint + 275, Nutrition.dailyTarget(bulkDiary))
    }

    @Test
    fun testProteinTarget() {
        val cutDiary = testDiary(weightKg = 80.0, goal = "dimagrire")
        // 80 * 1.8 = 144g
        assertEquals(144, Nutrition.proteinTarget(cutDiary))

        val bulkDiary = testDiary(weightKg = 80.0, goal = "massa")
        // 80 * 2.0 = 160g
        assertEquals(160, Nutrition.proteinTarget(bulkDiary))
    }

    @Test
    fun testCumulativeBalance_FirstDayZeroExcludedFromAverages() {
        val diary = testDiary().copy(
            weights = listOf(
                WeightEntry(date = "2026-10-01", kg = 80.0),
                WeightEntry(date = "2026-10-03", kg = 79.5)
            ),
            // Day 1 (2026-10-01) has NO meals and 0 steps (user registered, zero calories logged)
            meals = listOf(
                Meal(
                    id = "m1",
                    date = "2026-10-02",
                    meal = "lunch",
                    items = listOf(FoodItem("Pasta", grams = 200.0, kcal = 2000.0, protein = 50.0, carbs = 300.0, fat = 20.0))
                ),
                Meal(
                    id = "m2",
                    date = "2026-10-03",
                    meal = "dinner",
                    items = listOf(FoodItem("Pollo", grams = 300.0, kcal = 1800.0, protein = 150.0, carbs = 50.0, fat = 30.0))
                )
            ),
            steps = mapOf(
                "2026-10-01" to 0,
                "2026-10-02" to 8000,
                "2026-10-03" to 10000
            )
        )

        val balance = Nutrition.cumulativeBalance(diary, today = LocalDate.parse("2026-10-03"))

        // Requirement 1: First day zero is flagged and excluded from averages
        assertTrue("First day zero must be detected", balance.isFirstDayZeroExcluded)
        assertEquals(3, balance.totalDays)
        assertEquals(2, balance.activeDaysCount)

        // Day-by-day progress ("in quel momento") tracking
        assertEquals(3, balance.dailyProgressList.size)

        val dp1 = balance.dailyProgressList[0]
        assertEquals("2026-10-01", dp1.date)
        assertTrue("Day 1 is zero day", dp1.isZeroDay)

        val dp2 = balance.dailyProgressList[1]
        assertEquals("2026-10-02", dp2.date)
        assertFalse("Day 2 is not zero day", dp2.isZeroDay)
        assertTrue("Cumulative deficit should accumulate", dp2.cumulativeDeficit > 0)

        val dp3 = balance.dailyProgressList[2]
        assertEquals("2026-10-03", dp3.date)
        assertFalse("Day 3 is not zero day", dp3.isZeroDay)
        assertEquals(balance.cumulativeDeficitVsMaintenance, dp3.cumulativeDeficit)

        // Averages only computed over active days (2 & 3)
        // Steps avg: (8000 + 10000) / 2 = 9000
        assertEquals(9000, balance.avgStepsPerDay)

        // Estimated weight loss = totalDeficit / 7700.0
        val expectedKgLoss = balance.cumulativeDeficitVsMaintenance / 7700.0
        assertEquals(expectedKgLoss, balance.estimatedWeightLossKg, 0.01)

        // Scale weigh-in delta = 80.0 - 79.5 = 0.5 kg
        assertNotNull(balance.actualWeightLossKg)
        assertEquals(0.5, balance.actualWeightLossKg!!, 0.01)
    }

    @Test
    fun testCumulativeBalance_FirstDayNonZeroIncluded() {
        val diary = testDiary().copy(
            meals = listOf(
                Meal(
                    id = "m1",
                    date = "2026-10-01",
                    meal = "lunch",
                    items = listOf(FoodItem("Pranzo", 100.0, 1500.0, 40.0, 100.0, 20.0))
                ),
                Meal(
                    id = "m2",
                    date = "2026-10-02",
                    meal = "dinner",
                    items = listOf(FoodItem("Cena", 100.0, 2000.0, 50.0, 150.0, 30.0))
                )
            ),
            steps = mapOf(
                "2026-10-01" to 5000,
                "2026-10-02" to 7000
            )
        )

        val balance = Nutrition.cumulativeBalance(diary, today = LocalDate.parse("2026-10-02"))

        assertFalse("First day has meals, should not be excluded", balance.isFirstDayZeroExcluded)
        assertEquals(2, balance.totalDays)
        assertEquals(2, balance.activeDaysCount)
        assertEquals((5000 + 7000) / 2, balance.avgStepsPerDay)
    }

    @Test
    fun testAdaptiveDailyBudgetSafetyFloor() {
        val diary = testDiary(sex = "M").copy(
            meals = listOf(
                Meal(
                    id = "m1",
                    date = "2026-10-20",
                    meal = "all",
                    items = listOf(FoodItem("Overeating", 1000.0, 9000.0, 100.0, 800.0, 200.0))
                )
            )
        )
        val budget = Nutrition.weeklyAdaptive(diary, today = LocalDate.parse("2026-10-21"))

        // Male safety floor is 1400 kcal
        assertTrue(
            "Adaptive target should not drop below safety floor 1400 kcal, was ${budget.adaptiveDailyTarget}",
            budget.adaptiveDailyTarget >= 1400
        )
    }
}
