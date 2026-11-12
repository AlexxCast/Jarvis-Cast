import Foundation

struct DayTotals {
    var kcal: Double = 0
    var protein: Double = 0
    var carbs: Double = 0
    var fat: Double = 0
    var burned: Double = 0
    var steps: Int = 0
    var stepBurned: Double = 0
    var stepBonus: Double = 0
}

struct WeeklyAdaptiveInfo {
    var targetDailyBase: Int
    var adaptiveDailyTarget: Int
    var deltaKcal: Int
    var remainingBudgetWeek: Int
    var daysRemaining: Int
}

enum Nutrition {
    
    static func bmr(profile: Profile) -> Double {
        // Mifflin-St Jeor
        let w = profile.weightKg
        let h = profile.heightCm
        let a = Double(profile.age)
        let s = profile.sex.uppercased() == "F" ? -161.0 : 5.0
        return max(800.0, 10.0 * w + 6.25 * h - 5.0 * a + s)
    }
    
    static func tdee(profile: Profile) -> Double {
        let mult: Double
        switch profile.activityLevel.lowercased() {
        case "sedentary": mult = 1.2
        case "light": mult = 1.375
        case "active": mult = 1.725
        case "very_active": mult = 1.9
        default: mult = 1.55 // moderate
        }
        return bmr(profile: profile) * mult
    }
    
    static func baseDailyTarget(diary: Diary) -> Int {
        if diary.profile.targetKcalManual > 500 {
            return Int(diary.profile.targetKcalManual)
        }
        let t = tdee(profile: diary.profile)
        switch diary.profile.goal.lowercased() {
        case "lose": return max(1200, Int(t - 400))
        case "gain": return Int(t + 350)
        default: return Int(t)
        }
    }
    
    static func proteinTarget(diary: Diary) -> Double {
        if diary.profile.proteinGramsManual > 20 {
            return diary.profile.proteinGramsManual
        }
        let multiplier: Double
        switch diary.profile.goal.lowercased() {
        case "lose": multiplier = 2.0
        case "gain": multiplier = 1.8
        default: multiplier = 1.6
        }
        return diary.profile.weightKg * multiplier
    }

    static func kcalPerStep(diary: Diary) -> Double {
        return 0.0005 * max(40.0, diary.profile.weightKg)
    }

    static func stepBurnedKcal(diary: Diary, steps: Int) -> Double {
        return Double(steps) * kcalPerStep(diary: diary)
    }

    static func stepBonusKcal(diary: Diary, steps: Int) -> Double {
        return stepBurnedKcal(diary: diary, steps: steps) * 0.5
    }
    
    static func totals(diary: Diary, date: String) -> DayTotals {
        guard let day = diary.days[date] else { return DayTotals() }
        var tot = DayTotals()
        tot.steps = day.steps
        tot.stepBurned = stepBurnedKcal(diary: diary, steps: day.steps)
        tot.stepBonus = stepBonusKcal(diary: diary, steps: day.steps)
        for m in day.meals {
            tot.kcal += m.totalKcal
            tot.protein += m.totalProtein
            tot.carbs += m.totalCarbs
            tot.fat += m.totalFat
        }
        for a in day.activities {
            tot.burned += a.burnedKcal
        }
        return tot
    }
    
    static func weeklyAdaptive(diary: Diary, referenceDate: Date = Date()) -> WeeklyAdaptiveInfo {
        let calendar = Calendar.current
        let base = baseDailyTarget(diary: diary)
        let weeklyBudget = base * 7
        
        let weekday = calendar.component(.weekday, from: referenceDate) // Domenica=1, Lunedì=2 ...
        // Converti a lunedì = 1, domenica = 7
        let currentDayOfWeek = weekday == 1 ? 7 : weekday - 1
        let daysPassedBeforeToday = currentDayOfWeek - 1
        let daysRemainingIncludingToday = 8 - currentDayOfWeek
        
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        
        var kcalConsumedPastDays: Double = 0
        if daysPassedBeforeToday > 0 {
            for i in 1...daysPassedBeforeToday {
                let daysAgo = currentDayOfWeek - i
                if let pastDate = calendar.date(byAdding: .day, value: -daysAgo, to: referenceDate) {
                    let dStr = formatter.string(from: pastDate)
                    let t = totals(diary: diary, date: dStr)
                    let net = t.kcal - (t.burned * 0.5 + t.stepBonus)
                    kcalConsumedPastDays += (t.kcal > 0 ? net : Double(base))
                }
            }
        }
        
        let remainingBudgetWeek = max(0, weeklyBudget - Int(kcalConsumedPastDays))
        let adaptiveDaily = daysRemainingIncludingToday > 0
            ? max(1000, remainingBudgetWeek / daysRemainingIncludingToday)
            : base
        let delta = adaptiveDaily - base
        
        return WeeklyAdaptiveInfo(
            targetDailyBase: base,
            adaptiveDailyTarget: adaptiveDaily,
            deltaKcal: delta,
            remainingBudgetWeek: remainingBudgetWeek,
            daysRemaining: daysRemainingIncludingToday
        )
    }
}
