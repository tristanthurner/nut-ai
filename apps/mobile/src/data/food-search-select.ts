import type { DbAdapter } from '@nutai/db-adapter'
import type { ScoredCandidate } from '@nutai/resolver'
import type { ManualFoodSelection } from './manual-food'

/**
 * What "select this candidate" means, computed from the (read-only) nutrition
 * corpus alone. ZERO React Native imports, deliberately — same reasoning as
 * backup-core.ts and manual-food.ts — so it is testable under bare Node.
 * food-search.tsx's `onPress` calls this (via `selectFood` in that file,
 * which additionally reaches for the live user-db singleton and so is not
 * itself unit-testable here) for every tap on a result row.
 */

interface FoodRow {
  protein_g: number | null
  fat_g: number | null
  carb_g: number | null
  fiber_g: number | null
  sugar_g: number | null
  sodium_mg: number | null
}

interface PortionRow {
  gram_weight: number
}

export async function resolveSelection(nutritionDb: DbAdapter, candidate: ScoredCandidate): Promise<ManualFoodSelection> {
  const foodId = Number(candidate.foodId)

  const [food, defaultPortion, anyPortion] = await Promise.all([
    nutritionDb.get<FoodRow>(
      'SELECT protein_g, fat_g, carb_g, fiber_g, sugar_g, sodium_mg FROM foods WHERE id = ?',
      [foodId],
    ),
    nutritionDb.get<PortionRow>(
      'SELECT gram_weight FROM food_portions WHERE food_id = ? AND is_fndds_default = 1 LIMIT 1',
      [foodId],
    ),
    nutritionDb.get<PortionRow>(
      'SELECT gram_weight FROM food_portions WHERE food_id = ? ORDER BY id LIMIT 1',
      [foodId],
    ),
  ])

  return {
    foodId,
    displayName: candidate.name,
    // FNDDS default portion first, any recorded portion second, and only
    // then a flat 100 g — matching per-100g basis every corpus row already
    // carries, so at worst the number is "unscaled," never fabricated.
    grams: defaultPortion?.gram_weight ?? anyPortion?.gram_weight ?? 100,
    nutrientSnapshot: {
      kcal: candidate.energyKcal ?? 0,
      protein_g: food?.protein_g ?? 0,
      fat_g: food?.fat_g ?? 0,
      carbs_g: food?.carb_g ?? 0,
      fiber_g: food?.fiber_g ?? null,
      sugar_g: food?.sugar_g ?? null,
      sodium_mg: food?.sodium_mg ?? null,
    },
  }
}

export interface PortionOption {
  label: string
  grams: number
}

function fmtAmount(n: number | null): string {
  if (n == null) return '1'
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100)
}

/**
 * Quick-pick portions for the gram picker: the row's own recorded portions
 * (a packaged product's serving, USDA's "1 large", "1 cup", …) in their
 * recorded order, de-duplicated by weight. The picker adds 100 g itself and
 * always lets the person type any number, so these are shortcuts, never limits.
 */
export async function portionOptions(nutritionDb: DbAdapter, foodId: number, max = 4): Promise<PortionOption[]> {
  const rows = await nutritionDb.all<{
    measure_unit: string | null
    modifier: string | null
    amount: number | null
    gram_weight: number
  }>(
    `SELECT measure_unit, modifier, amount, gram_weight FROM food_portions
     WHERE food_id = ? AND gram_weight > 0
     ORDER BY is_fndds_default DESC, id`,
    [foodId],
  )

  const out: PortionOption[] = []
  const seen = new Set<number>()
  for (const r of rows) {
    const g = Math.round(r.gram_weight * 10) / 10
    if (seen.has(g)) continue
    seen.add(g)
    const unit = r.measure_unit && r.measure_unit !== 'undetermined' ? r.measure_unit : ''
    const label =
      unit === 'serving'
        ? `1 serving${r.modifier ? ` · ${r.modifier}` : ''}`
        : [fmtAmount(r.amount), unit, r.modifier ?? ''].filter(Boolean).join(' ').trim()
    out.push({ label: label || `${g} g`, grams: g })
    if (out.length >= max) break
  }
  return out
}
