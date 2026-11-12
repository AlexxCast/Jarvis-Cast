package com.jarvisfit.app.data

import java.time.LocalDate
import java.time.Period
import kotlin.math.roundToInt

object Nutrition {

    fun age(p: Profile): Int = age(p.birthDate)

    fun age(birthDateIso: String): Int = runCatching {
        Period.between(LocalDate.parse(birthDateIso), LocalDate.now()).years
    }.getOrDefault(25)

    /** Peso attuale = ultima pesata registrata, altrimenti quello del profilo. */
    fun currentWeight(d: Diary): Double =
        d.weights.maxByOrNull { it.date }?.kg ?: d.profile.weightKg

    /** Metabolismo basale (Mifflin-St Jeor) parametrizzato. */
    fun bmr(weightKg: Double, heightCm: Double, ageYears: Int, sex: String): Double {
        val base = 10.0 * weightKg + 6.25 * heightCm - 5.0 * ageYears
        return if (sex == "F") base - 161.0 else base + 5.0
    }

    /** Metabolismo basale del diario. */
    fun bmr(d: Diary): Double {
        val p = d.profile
        return bmr(currentWeight(d), p.heightCm, age(p), p.sex)
    }

    fun activityMultiplier(level: String): Double = when (level.lowercase()) {
        "sedentario" -> 1.2
        "leggero" -> 1.375
        "attivo" -> 1.725
        "molto attivo" -> 1.9
        else -> 1.55 // moderato / default
    }

    /** Fabbisogno effettivo di mantenimento TDEE base senza attività extra tracciate. */
    fun maintenance(bmrVal: Double, activityLevel: String): Double =
        bmrVal * activityMultiplier(activityLevel)

    fun maintenance(d: Diary): Double =
        maintenance(bmr(d), d.profile.activityLevel)

    data class TargetPreview(
        val bmr: Double,
        val maintenance: Double,
        val delta: Double,
        val dailyTarget: Int,
        val safetyFloor: Double,
        val isCapped: Boolean
    )

    /** Calcolo target con deficit/surplus calibrato sul ritmo kg/settimana e soglie di sicurezza corrette. */
    fun calculateTarget(
        weightKg: Double,
        heightCm: Double,
        ageYears: Int,
        sex: String,
        activityLevel: String,
        goal: String,
        weeklyChangeKg: Double
    ): TargetPreview {
        val bmrVal = bmr(weightKg, heightCm, ageYears, sex)
        val maint = maintenance(bmrVal, activityLevel)
        // 1 kg di massa grassa ~= 7700 kcal: 0.25 kg -> 275 kcal/gg, 0.50 kg -> 550 kcal/gg, 0.75 kg -> 825 kcal/gg, 1.0 kg -> 1100 kcal/gg
        val delta = (weeklyChangeKg.coerceIn(0.0, 1.25) * 7700.0 / 7.0)
        val raw = when (goal.lowercase()) {
            "dimagrire" -> maint - delta
            "massa" -> maint + delta.coerceAtMost(600.0)
            else -> maint
        }
        // Soglie cliniche minime di sicurezza non forzate al BMR (permettono il deficit reale 0.5 e 0.75 kg/settimana)
        val floor = if (sex == "F") 1200.0 else 1400.0
        val target = maxOf(raw, floor).roundToInt()
        return TargetPreview(
            bmr = bmrVal,
            maintenance = maint,
            delta = delta,
            dailyTarget = target,
            safetyFloor = floor,
            isCapped = raw < floor
        )
    }

    /** Target calorico giornaliero: deficit/surplus da ritmo settimanale. */
    fun dailyTarget(d: Diary): Int {
        val p = d.profile
        return calculateTarget(
            weightKg = currentWeight(d),
            heightCm = p.heightCm,
            ageYears = age(p),
            sex = p.sex,
            activityLevel = p.activityLevel,
            goal = p.goal,
            weeklyChangeKg = p.weeklyChangeKg
        ).dailyTarget
    }

    /** Stima kcal bruciate per passo (~0.0005 kcal/kg/passo). */
    fun kcalPerStep(d: Diary): Double = 0.0005 * currentWeight(d)

    /** Stima totale kcal bruciate dal numero di passi. */
    fun stepBurnedKcal(d: Diary, steps: Int): Double = steps * kcalPerStep(d)

    /** Quota prudente (50%) di calorie da passi accreditata al budget giornaliero. */
    fun stepBonusKcal(d: Diary, steps: Int): Double = stepBurnedKcal(d, steps) * 0.5

    fun proteinTarget(d: Diary): Int = (currentWeight(d) * if (d.profile.goal == "massa") 2.0 else 1.8).roundToInt()

    data class DayTotals(
        val kcal: Double,
        val protein: Double,
        val carbs: Double,
        val fat: Double,
        val burned: Double,
        val steps: Int,
        val stepBurned: Double = 0.0,
        val stepBonus: Double = 0.0,
    )

    fun totals(d: Diary, date: String): DayTotals {
        val meals = d.meals.filter { it.date == date }
        val steps = d.steps[date] ?: 0
        val sBurned = stepBurnedKcal(d, steps)
        val sBonus = sBurned * 0.5
        return DayTotals(
            kcal = meals.sumOf { it.kcal },
            protein = meals.sumOf { it.protein },
            carbs = meals.sumOf { it.carbs },
            fat = meals.sumOf { it.fat },
            burned = d.activities.filter { it.date == date }.sumOf { it.kcalBurned },
            steps = steps,
            stepBurned = sBurned,
            stepBonus = sBonus,
        )
    }

    data class WeeklyAdaptiveInfo(
        val baseDailyTarget: Int,
        val adaptiveDailyTarget: Int,       // Target per oggi ricalcolato sui giorni passati
        val estimatedTomorrowTarget: Int,   // Target stimato per domani riequilibrato su consumi e attività di oggi
        val daysPassed: Int,                // Giorni già conclusi questa settimana (Lun=0)
        val daysRemaining: Int,             // Giorni rimanenti da oggi a Domenica (incluso oggi)
        val weeklyBudgetTotal: Int,         // Budget calorico complessivo della settimana (base * 7)
        val consumedThisWeek: Int,          // Calorie nette consumate nei giorni passati della settimana
        val remainingBudgetWeek: Int,       // Budget rimanente per il resto della settimana da oggi
        val deltaKcal: Int,                 // Scostamento oggi rispetto al base
        val todaySurplusOrDeficit: Int,     // Surplus (>0) o risparmio (<0) netto di oggi
        val tomorrowDeltaKcal: Int,         // Scostamento stimato domani rispetto al base
        val todayActivityBonus: Double      // Credito passi e allenamenti maturato oggi
    ) {
        val consumedPastDays: Int get() = consumedThisWeek
    }

    /**
     * Calcola il target adattivo della settimana:
     * - Considera pasti, passi e attività fisica di tutti i giorni passati.
     * - Ribilancia le calorie del giorno dopo se c'è stato surplus o risparmio oggi.
     */
    fun weeklyAdaptive(d: Diary, today: LocalDate = LocalDate.now()): WeeklyAdaptiveInfo {
        val base = dailyTarget(d)
        val dayOfWeek = today.dayOfWeek.value // 1 = Lunedì, 7 = Domenica
        val monday = today.minusDays((dayOfWeek - 1).toLong())
        val daysPassed = dayOfWeek - 1 // Lunedì = 0 giorni passati prima di oggi
        val daysRemaining = (7 - daysPassed).coerceAtLeast(1)

        val floor = if (d.profile.sex == "F") 1200.0 else 1400.0
        val maxCap = maintenance(d) + 1200.0

        var consumedPastDays = 0.0
        for (i in 0 until daysPassed) {
            val dateStr = monday.plusDays(i.toLong()).toString()
            val t = totals(d, dateStr)
            val activityCredit = t.burned * 0.5 + t.stepBonus
            val pastNet = if (t.kcal > 0) {
                t.kcal - activityCredit
            } else if (activityCredit > 0) {
                (base.toDouble() - activityCredit).coerceAtLeast(floor)
            } else {
                base.toDouble()
            }
            consumedPastDays += pastNet
        }

        val weeklyBudget = base * 7
        val remainingBudget = weeklyBudget - consumedPastDays
        val rawAdaptiveToday = remainingBudget / daysRemaining
        val safeAdaptiveToday = rawAdaptiveToday.coerceIn(floor, maxCap).roundToInt()

        // Calcolo netto di oggi e previsione per DOMANI
        val todayDateStr = today.toString()
        val todayTotals = totals(d, todayDateStr)
        val todayActivityBonus = todayTotals.burned * 0.5 + todayTotals.stepBonus
        val todayNet = if (todayTotals.kcal > 0) (todayTotals.kcal - todayActivityBonus) else 0.0
        val todaySurplusOrDeficit = if (todayTotals.kcal > 0) (todayNet - safeAdaptiveToday).roundToInt() else 0

        val estimatedTomorrowTarget: Int
        if (dayOfWeek < 7) {
            val daysAfterToday = 7 - dayOfWeek
            val effectiveTodayConsumed = if (todayTotals.kcal > 0) {
                todayNet
            } else if (todayActivityBonus > 0) {
                (base.toDouble() - todayActivityBonus).coerceAtLeast(floor)
            } else {
                safeAdaptiveToday.toDouble()
            }
            val consumedUpToToday = consumedPastDays + effectiveTodayConsumed
            val remainingForTomorrow = weeklyBudget - consumedUpToToday
            val rawTomorrow = remainingForTomorrow / daysAfterToday
            estimatedTomorrowTarget = rawTomorrow.coerceIn(floor, maxCap).roundToInt()
        } else {
            // Domenica: la settimana termina, domani parte un nuovo ciclo col target base
            estimatedTomorrowTarget = base
        }

        return WeeklyAdaptiveInfo(
            baseDailyTarget = base,
            adaptiveDailyTarget = safeAdaptiveToday,
            estimatedTomorrowTarget = estimatedTomorrowTarget,
            daysPassed = daysPassed,
            daysRemaining = daysRemaining,
            weeklyBudgetTotal = weeklyBudget,
            consumedThisWeek = consumedPastDays.roundToInt(),
            remainingBudgetWeek = remainingBudget.roundToInt(),
            deltaKcal = safeAdaptiveToday - base,
            todaySurplusOrDeficit = todaySurplusOrDeficit,
            tomorrowDeltaKcal = estimatedTomorrowTarget - base,
            todayActivityBonus = todayActivityBonus
        )
    }

    data class MonthlyBalance(
        val baseDailyTarget: Int,
        val daysCount: Int,
        val targetTotal: Int,              // base * daysCount
        val maintenanceTotal: Int,         // maintenance * daysCount
        val foodKcalTotal: Int,            // Somma calorie cibo registrate
        val stepKcalTotal: Int,            // Somma kcal bruciate da passi
        val stepBonusTotal: Int,           // Somma calorie bonus accreditate da passi (50%)
        val activityKcalTotal: Int,        // Somma kcal bruciate da allenamenti
        val activityBonusTotal: Int,       // Somma calorie bonus accreditate da allenamenti (50%)
        val totalActivityCredits: Int,     // stepBonus + activityBonus
        val netConsumedTotal: Int,         // Cibo netto (foodKcalTotal - totalActivityCredits)
        val netDifferenceVsTarget: Int,    // netConsumedTotal - targetTotal (surplus se > 0, risparmio/deficit se < 0)
        val realizedDeficitVsMaintenance: Int, // maintenanceTotal - netConsumedTotal (deficit reale vs mantenimento)
        val totalSteps: Int,               // Totale passi nel mese
        val avgStepsPerDay: Int,           // Media passi giornalieri
        val avgNetKcalPerDay: Int,         // Media calorie giornaliere nette
        val estimatedWeightChangeKg: Double // Stima variazione peso (netConsumed - maintenanceTotal) / 7700.0
    )

    /**
     * Calcola il bilancio mensile completo (ultimi 30 giorni o dall'inizio se recente)
     * includendo tutti i passi e tutte le attività fisiche svolte ogni singolo giorno.
     */
    fun monthlyBalance(d: Diary, today: LocalDate = LocalDate.now()): MonthlyBalance {
        val base = dailyTarget(d)
        val maint = maintenance(d).roundToInt()
        
        val allRecordedDates = (
            d.meals.map { it.date } +
            d.activities.map { it.date } +
            d.steps.filter { it.value > 0 }.keys +
            d.weights.map { it.date }
        ).distinct().sorted()

        val start = if (allRecordedDates.isNotEmpty()) LocalDate.parse(allRecordedDates.first()) else today
        val daysSinceStart = java.time.temporal.ChronoUnit.DAYS.between(start, today).toInt() + 1
        val days = minOf(30, maxOf(1, daysSinceStart))

        var foodSum = 0.0
        var stepKcalSum = 0.0
        var stepBonusSum = 0.0
        var actKcalSum = 0.0
        var actBonusSum = 0.0
        var stepsSum = 0
        var recordedDays = 0

        for (i in 0 until days) {
            val dateStr = today.minusDays(i.toLong()).toString()
            val t = totals(d, dateStr)
            val hasFood = t.kcal > 0
            val hasSteps = t.steps > 0
            val hasAct = t.burned > 0

            if (hasFood || hasSteps || hasAct) {
                recordedDays++
            }
            foodSum += t.kcal
            stepKcalSum += t.stepBurned
            stepBonusSum += t.stepBonus
            actKcalSum += t.burned
            actBonusSum += (t.burned * 0.5)
            stepsSum += t.steps
        }

        val totalCredits = (stepBonusSum + actBonusSum).roundToInt()
        val netConsumed = (foodSum - totalCredits).roundToInt()
        val targetTot = base * days
        val maintTot = maint * days
        val netDiff = netConsumed - targetTot
        val realizedDeficit = maintTot - netConsumed
        val weightChange = (netConsumed - maintTot) / 7700.0
        val activeDays = if (recordedDays > 0) recordedDays else 1

        return MonthlyBalance(
            baseDailyTarget = base,
            daysCount = days,
            targetTotal = targetTot,
            maintenanceTotal = maintTot,
            foodKcalTotal = foodSum.roundToInt(),
            stepKcalTotal = stepKcalSum.roundToInt(),
            stepBonusTotal = stepBonusSum.roundToInt(),
            activityKcalTotal = actKcalSum.roundToInt(),
            activityBonusTotal = actBonusSum.roundToInt(),
            totalActivityCredits = totalCredits,
            netConsumedTotal = netConsumed,
            netDifferenceVsTarget = netDiff,
            realizedDeficitVsMaintenance = realizedDeficit,
            totalSteps = stepsSum,
            avgStepsPerDay = stepsSum / days,
            avgNetKcalPerDay = netConsumed / activeDays,
            estimatedWeightChangeKg = weightChange
        )
    }

    /**
     * Dati di progresso e bilancio per un singolo giorno e cumulativi fino a quella specifica data
     * ("in quel momento").
     */
    data class DayProgress(
        val date: String,
        val totals: DayTotals,
        val netConsumed: Int,
        val maintenance: Int,
        val dailyDeficit: Int,                         // Deficit vs mantenimento di quel singolo giorno
        val cumulativeDeficit: Int,                    // Deficit cumulativo accumulato da inizio fino a quel giorno
        val cumulativeEstimatedWeightChangeKg: Double, // Variazione peso stimata fino a quel giorno (negativo = peso perso)
        val recordedWeightKg: Double?,                 // Pesata reale a quella data (o più recente fino a quella data)
        val weightLossFromStartKg: Double?,            // Perdita effettiva da inizio fino a quella data (positivo = peso perso)
        val isZeroDay: Boolean
    )

    /**
     * Bilancio complessivo calcolato da quando l'utente ha iniziato a caricare i dati:
     * - Se il primo giorno è a zero (nessun cibo o attività), viene ESCLUSO dal calcolo della media.
     * - Include perdita di peso stimata dal deficit e perdita effettiva registrata con le pesate.
     * - Fornisce il tracciamento progressivo per ogni giorno ("in quel momento").
     */
    data class CumulativeBalance(
        val startDate: String,
        val totalDays: Int,                            // Giorni complessivi di calendario da inizio ad oggi
        val activeDaysCount: Int,                      // Giorni considerati nel calcolo delle medie
        val isFirstDayZeroExcluded: Boolean,           // Indica se il primo giorno era zero ed è stato escluso dalla media
        val totalFoodKcal: Int,
        val totalStepBonus: Int,
        val totalActivityBonus: Int,
        val totalActivityCredits: Int,
        val totalNetConsumed: Int,
        val totalTarget: Int,
        val totalMaintenance: Int,
        val cumulativeDeficitVsMaintenance: Int,       // Deficit totale accumulato vs mantenimento da inizio
        val cumulativeDifferenceVsTarget: Int,          // Scostamento cumulativo vs target programmato
        val estimatedWeightLossKg: Double,             // Stima kg persi (es. 1.25 kg persi)
        val estimatedWeightChangeKg: Double,           // Variazione peso stimata (es. -1.25 kg)
        val avgNetKcalPerDay: Int,                     // Media giornaliera calorie nette (escluso 1° giorno se 0)
        val avgDeficitPerDay: Int,                     // Media giornaliera deficit calorico (escluso 1° giorno se 0)
        val avgStepsPerDay: Int,                       // Media passi giornalieri (escluso 1° giorno se 0)
        val totalSteps: Int,
        val startWeightKg: Double,                     // Peso iniziale registrato
        val currentWeightKg: Double,                   // Peso attuale
        val actualWeightLossKg: Double?,               // Peso effettivamente perso dalle pesate (startWeight - currentWeight)
        val dailyProgressList: List<DayProgress>       // Progresso per ciascun giorno ("in quel momento")
    )

    /**
     * Calcola il deficit e la perdita di peso dall'inizio del caricamento dei dati:
     * Se il primo giorno registrato è a zero (0 calorie consumate), non rientra nel calcolo della media.
     */
    fun cumulativeBalance(d: Diary, today: LocalDate = LocalDate.now()): CumulativeBalance {
        val maint = maintenance(d).roundToInt()
        val baseTarget = dailyTarget(d)

        val allRecordedDates = (
            d.meals.map { it.date } +
            d.activities.map { it.date } +
            d.steps.filter { it.value > 0 }.keys +
            d.weights.map { it.date }
        ).distinct().sorted()

        val start = if (allRecordedDates.isNotEmpty()) LocalDate.parse(allRecordedDates.first()) else today

        // Sequenza continua di giorni da inizio fino a oggi
        val dayList = mutableListOf<LocalDate>()
        var cur = start
        while (!cur.isAfter(today)) {
            dayList.add(cur)
            cur = cur.plusDays(1)
        }

        val startWeight = d.weights.minByOrNull { it.date }?.kg ?: d.profile.weightKg
        val currentW = currentWeight(d)
        val actualLoss = if (startWeight > 0.0 && currentW > 0.0) (startWeight - currentW) else null

        // Verifica se il primo giorno è a zero
        val firstDateStr = start.toString()
        val firstTotals = totals(d, firstDateStr)
        val firstDayIsZero = (firstTotals.kcal <= 0.0 && firstTotals.steps == 0 && firstTotals.burned <= 0.0)

        var cumDeficit = 0
        var cumNet = 0
        var cumMaint = 0
        var cumFood = 0.0
        var cumStepBonus = 0.0
        var cumActBonus = 0.0
        var cumSteps = 0
        var cumTarget = 0

        var sumNetForAvg = 0
        var sumDeficitForAvg = 0
        var sumStepsForAvg = 0
        var daysForAvgCount = 0

        val progress = mutableListOf<DayProgress>()

        for (i in dayList.indices) {
            val date = dayList[i]
            val dateStr = date.toString()
            val t = totals(d, dateStr)
            val hasData = (t.kcal > 0.0 || t.steps > 0 || t.burned > 0.0)

            val isFirst = (i == 0)
            val excludeFromAvg = (isFirst && firstDayIsZero)

            val actCredit = (t.burned * 0.5 + t.stepBonus).roundToInt()
            val net = (t.kcal - actCredit).roundToInt()

            // Se il primo giorno è a zero, non conteggiamo fabbisogno a vuoto
            val dayMaint = if (excludeFromAvg && !hasData) 0 else maint
            val dayTarget = if (excludeFromAvg && !hasData) 0 else baseTarget
            val dailyDeficit = dayMaint - net

            cumFood += t.kcal
            cumStepBonus += t.stepBonus
            cumActBonus += (t.burned * 0.5)
            cumSteps += t.steps
            cumNet += net
            cumMaint += dayMaint
            cumTarget += dayTarget
            cumDeficit += dailyDeficit

            // Aggiungi ai totali delle medie solo se non è il primo giorno vuoto
            if (!excludeFromAvg && (hasData || !isFirst)) {
                daysForAvgCount++
                sumNetForAvg += net
                sumDeficitForAvg += dailyDeficit
                sumStepsForAvg += t.steps
            }

            // Pesata registrata a questa data o l'ultima precedente disponibile
            val weightAtDate = d.weights.filter { !LocalDate.parse(it.date).isAfter(date) }
                .maxByOrNull { it.date }?.kg
            val weightLossAtDate = if (weightAtDate != null && startWeight > 0.0) (startWeight - weightAtDate) else null
            val cumWeightChange = (cumNet - cumMaint) / 7700.0

            progress.add(
                DayProgress(
                    date = dateStr,
                    totals = t,
                    netConsumed = net,
                    maintenance = dayMaint,
                    dailyDeficit = dailyDeficit,
                    cumulativeDeficit = cumDeficit,
                    cumulativeEstimatedWeightChangeKg = cumWeightChange,
                    recordedWeightKg = weightAtDate,
                    weightLossFromStartKg = weightLossAtDate,
                    isZeroDay = !hasData
                )
            )
        }

        val activeDivisor = if (daysForAvgCount > 0) daysForAvgCount else 1
        val totalCredits = (cumStepBonus + cumActBonus).roundToInt()
        val estimatedWeightChange = (cumNet - cumMaint) / 7700.0
        val estimatedWeightLoss = -estimatedWeightChange

        return CumulativeBalance(
            startDate = start.toString(),
            totalDays = dayList.size,
            activeDaysCount = daysForAvgCount,
            isFirstDayZeroExcluded = firstDayIsZero,
            totalFoodKcal = cumFood.roundToInt(),
            totalStepBonus = cumStepBonus.roundToInt(),
            totalActivityBonus = cumActBonus.roundToInt(),
            totalActivityCredits = totalCredits,
            totalNetConsumed = cumNet,
            totalTarget = cumTarget,
            totalMaintenance = cumMaint,
            cumulativeDeficitVsMaintenance = cumDeficit,
            cumulativeDifferenceVsTarget = cumNet - cumTarget,
            estimatedWeightLossKg = estimatedWeightLoss,
            estimatedWeightChangeKg = estimatedWeightChange,
            avgNetKcalPerDay = sumNetForAvg / activeDivisor,
            avgDeficitPerDay = sumDeficitForAvg / activeDivisor,
            avgStepsPerDay = sumStepsForAvg / activeDivisor,
            totalSteps = cumSteps,
            startWeightKg = startWeight,
            currentWeightKg = currentW,
            actualWeightLossKg = actualLoss,
            dailyProgressList = progress
        )
    }
}
