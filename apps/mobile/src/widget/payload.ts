/**
 * The summary the home screen widget draws — pure, tested under Node.
 *
 * Keep the shape in step with `TodaySummary` in targets/widget/CaloriesWidget.swift.
 */
export interface WidgetPayload {
  v: 1
  date: string
  kcalEaten: number
  kcalTarget: number
  protein: { eaten: number; target: number }
  carbs: { eaten: number; target: number }
  fat: { eaten: number; target: number }
  mealsLogged: number
}

const r1 = (n: number) => Math.round((Number.isFinite(n) ? n : 0) * 10) / 10

export function buildWidgetPayload(
  date: string,
  totals: { kcal: number; protein_g: number; carbs_g: number; fat_g: number; mealCount: number },
  goal: { targetKcal: number; protein_g: number; carbs_g: number; fat_g: number },
): WidgetPayload {
  return {
    v: 1,
    date,
    kcalEaten: r1(totals.kcal),
    kcalTarget: r1(goal.targetKcal),
    protein: { eaten: r1(totals.protein_g), target: r1(goal.protein_g) },
    carbs: { eaten: r1(totals.carbs_g), target: r1(goal.carbs_g) },
    fat: { eaten: r1(totals.fat_g), target: r1(goal.fat_g) },
    mealsLogged: totals.mealCount,
  }
}
