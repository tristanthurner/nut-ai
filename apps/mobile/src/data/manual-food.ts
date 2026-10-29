import type { DbAdapter } from '@nutai/db-adapter'
import type { NutrientRow100g } from '@nutai/core-schema'
import { localDate, slotFor } from './date-utils'

/**
 * A food picked directly off the Food Database search screen — no photo, no
 * model call. `nutrientSnapshot` is the resolved row's real per-100 g values;
 * `logManualFood` copies them in at log time, exactly like every other logging
 * path, so a later corpus rebuild can never move a historical log's numbers.
 *
 * THE SNAPSHOT IS STORED PER 100 g, NOT PRE-SCALED. Every reader (dayTotals,
 * the day list) multiplies `snap_*` by `grams / 100` itself. Storing an
 * already-scaled value here counted those entries twice over — the v2 user
 * migration repairs rows written that way. Keeping the snapshot per 100 g is
 * also what makes changing the grams later a one-column update.
 *
 * This takes its `DbAdapter` as a parameter rather than reaching for repo.ts's
 * cached app singleton — same shape as `backup-core.ts` — specifically so it
 * is testable under plain Node against `@nutai/db-adapter/node`'s
 * `openMemoryDb()`. The singleton's `db()` calls `openUserDb()` in
 * `apps/mobile/src/db/expo-adapter.ts`, which imports `expo-sqlite`; that
 * import throws under Node, so any function that hard-codes it can only ever
 * be exercised inside a running app, never in this test suite.
 */
export interface ManualFoodSelection {
  foodId: number
  displayName: string
  grams: number
  nutrientSnapshot: NutrientRow100g
}

export interface ManualFoodOptions {
  /** breakfast | lunch | dinner | snack. Defaults to the slot for `now`. */
  slot?: string
  /** YYYY-MM-DD to log into. Defaults to the local date of `now`. */
  date?: string
  /** The user typed or picked the grams — recorded as ground truth. */
  gramsUserSet?: boolean
}

export async function logManualFood(
  h: DbAdapter,
  selection: ManualFoodSelection,
  now: number,
  opts: ManualFoodOptions = {},
): Promise<number> {
  const date = opts.date ?? localDate(now)
  const slot = opts.slot ?? slotFor(now)
  const n = selection.nutrientSnapshot

  return h.transaction(async (tx) => {
    const meal = await tx.run(
      `INSERT INTO meals (logged_at, local_date, meal_slot, portion_eaten_fraction, analysis_status, created_at)
       VALUES (?,?,?,1.0,'complete',?)`,
      [now, date, slot, now],
    )
    const mealId = Number(meal.lastInsertRowId)

    await tx.run(
      `INSERT INTO log_items (meal_id, matched_food_id, matched_food_source, display_name, grams,
                              gram_pathway, portion_source, snap_energy_kcal, snap_protein_g, snap_fat_g,
                              snap_carb_g, snap_fiber_g, snap_sugar_g, snap_sodium_mg,
                              is_estimate, macros_user_edited, sort_order, logged_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,0,?)`,
      [
        mealId,
        selection.foodId,
        'corpus',
        selection.displayName,
        selection.grams,
        opts.gramsUserSet ? 'user_edited' : 'fndds_standard_portion',
        'db_search',
        n.kcal,
        n.protein_g,
        n.fat_g,
        n.carbs_g,
        n.fiber_g ?? null,
        n.sugar_g ?? null,
        n.sodium_mg ?? null,
        now,
      ],
    )

    return mealId
  })
}
