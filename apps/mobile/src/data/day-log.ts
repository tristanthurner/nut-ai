import type { DbAdapter } from '@nutai/db-adapter'

/**
 * The day list: everything logged on one date, item by item, and the two edits
 * a person actually makes afterwards — "it was 180 g, not 120" and "that was
 * not today".
 *
 * Pure DbAdapter functions with ZERO React Native imports (same reasoning as
 * manual-food.ts and backup-core.ts), so they run under the Node test suite
 * against the real user schema.
 *
 * Every number here is derived the way dayTotals derives it:
 *   snap_* (per 100 g) × grams / 100 × the meal's portion_eaten_fraction.
 * Changing grams therefore never touches the snapshot — the nutrition values
 * captured at log time stay exactly as they were.
 */

export const SLOT_ORDER = ['breakfast', 'lunch', 'dinner', 'snack'] as const
export type Slot = (typeof SLOT_ORDER)[number]

export interface DayItem {
  itemId: number
  mealId: number
  slot: Slot
  loggedAt: number
  name: string
  grams: number
  /** Already multiplied by grams/100 and the eaten fraction. */
  kcal: number
  protein_g: number
  carbs_g: number
  fat_g: number
  /** Per 100 g, for previewing a gram change before saving it. */
  per100: { kcal: number; protein_g: number; carbs_g: number; fat_g: number }
  eatenFraction: number
  isEstimate: boolean
}

export interface SlotGroup {
  slot: Slot
  items: DayItem[]
  kcal: number
  protein_g: number
  carbs_g: number
  fat_g: number
}

export interface DayNutrients {
  kcal: number
  protein_g: number
  carbs_g: number
  fat_g: number
  fiber_g: number
  sugar_g: number
  sodium_mg: number
}

function asSlot(s: string | null): Slot {
  return (SLOT_ORDER as readonly string[]).includes(s ?? '') ? (s as Slot) : 'snack'
}

interface Row {
  item_id: number
  meal_id: number
  meal_slot: string | null
  logged_at: number
  display_name: string
  grams: number
  frac: number | null
  kcal: number | null
  p: number | null
  c: number | null
  f: number | null
  is_estimate: number
}

/** Every completed item on `date`, in the order it was eaten. */
export async function dayItems(h: DbAdapter, date: string): Promise<DayItem[]> {
  const rows = await h.all<Row>(
    `SELECT li.id AS item_id, m.id AS meal_id, m.meal_slot, m.logged_at,
            li.display_name, li.grams, m.portion_eaten_fraction AS frac,
            li.snap_energy_kcal AS kcal, li.snap_protein_g AS p,
            li.snap_carb_g AS c, li.snap_fat_g AS f, li.is_estimate
     FROM meals m
     JOIN log_items li ON li.meal_id = m.id
     WHERE m.local_date = ? AND m.analysis_status IN ('complete','manual')
     ORDER BY m.logged_at, m.id, li.sort_order, li.id`,
    [date],
  )

  return rows.map((r) => {
    const frac = r.frac ?? 1
    const k = (r.grams / 100) * frac
    const per100 = { kcal: r.kcal ?? 0, protein_g: r.p ?? 0, carbs_g: r.c ?? 0, fat_g: r.f ?? 0 }
    return {
      itemId: r.item_id,
      mealId: r.meal_id,
      slot: asSlot(r.meal_slot),
      loggedAt: r.logged_at,
      name: r.display_name,
      grams: r.grams,
      kcal: per100.kcal * k,
      protein_g: per100.protein_g * k,
      carbs_g: per100.carbs_g * k,
      fat_g: per100.fat_g * k,
      per100,
      eatenFraction: frac,
      isEstimate: r.is_estimate === 1,
    }
  })
}

/** The same items grouped into breakfast → lunch → dinner → snack. Empty slots are omitted. */
export function groupBySlot(items: readonly DayItem[]): SlotGroup[] {
  return SLOT_ORDER.map((slot) => {
    const its = items.filter((i) => i.slot === slot)
    return {
      slot,
      items: its,
      kcal: its.reduce((a, i) => a + i.kcal, 0),
      protein_g: its.reduce((a, i) => a + i.protein_g, 0),
      carbs_g: its.reduce((a, i) => a + i.carbs_g, 0),
      fat_g: its.reduce((a, i) => a + i.fat_g, 0),
    }
  }).filter((g) => g.items.length > 0)
}

/** Fiber, sugar and sodium as well as the big four — for the second home page. */
export async function dayNutrients(h: DbAdapter, date: string): Promise<DayNutrients> {
  const r = await h.get<Record<string, number | null>>(
    `SELECT
       SUM(li.snap_energy_kcal * li.grams / 100.0 * m.portion_eaten_fraction) AS kcal,
       SUM(li.snap_protein_g   * li.grams / 100.0 * m.portion_eaten_fraction) AS p,
       SUM(li.snap_carb_g      * li.grams / 100.0 * m.portion_eaten_fraction) AS c,
       SUM(li.snap_fat_g       * li.grams / 100.0 * m.portion_eaten_fraction) AS f,
       SUM(li.snap_fiber_g     * li.grams / 100.0 * m.portion_eaten_fraction) AS fiber,
       SUM(li.snap_sugar_g     * li.grams / 100.0 * m.portion_eaten_fraction) AS sugar,
       SUM(li.snap_sodium_mg   * li.grams / 100.0 * m.portion_eaten_fraction) AS sodium
     FROM meals m
     JOIN log_items li ON li.meal_id = m.id
     WHERE m.local_date = ? AND m.analysis_status IN ('complete','manual')`,
    [date],
  )
  return {
    kcal: r?.kcal ?? 0,
    protein_g: r?.p ?? 0,
    carbs_g: r?.c ?? 0,
    fat_g: r?.f ?? 0,
    fiber_g: r?.fiber ?? 0,
    sugar_g: r?.sugar ?? 0,
    sodium_mg: r?.sodium ?? 0,
  }
}

/** Upper bound for a typed gram amount. Anything above is a typo, not a meal. */
export const MAX_GRAMS = 5000

export function isValidGrams(g: number): boolean {
  return Number.isFinite(g) && g > 0 && g <= MAX_GRAMS
}

/**
 * Set an item's grams. The snapshot is per 100 g, so this is the whole edit:
 * every derived number follows from the new grams automatically.
 */
export async function updateItemGrams(h: DbAdapter, itemId: number, grams: number): Promise<void> {
  if (!isValidGrams(grams)) throw new Error(`invalid grams: ${grams}`)
  await h.run(
    "UPDATE log_items SET grams = ?, gram_pathway = 'user_edited', band_half_pct = NULL WHERE id = ?",
    [Math.round(grams * 10) / 10, itemId],
  )
}

/** Move a whole meal to another slot (an entry logged at 11:05 that was really breakfast). */
export async function updateMealSlot(h: DbAdapter, mealId: number, slot: Slot): Promise<void> {
  await h.run('UPDATE meals SET meal_slot = ? WHERE id = ?', [slot, mealId])
}

/** Remove one item; a meal left with no items goes with it. */
export async function deleteItem(h: DbAdapter, itemId: number): Promise<void> {
  await h.transaction(async (tx) => {
    const row = await tx.get<{ meal_id: number }>('SELECT meal_id FROM log_items WHERE id = ?', [itemId])
    if (!row) return
    await tx.run('DELETE FROM log_items WHERE id = ?', [itemId])
    const left = await tx.get<{ c: number }>('SELECT COUNT(*) c FROM log_items WHERE meal_id = ?', [row.meal_id])
    if ((left?.c ?? 0) === 0) {
      // The scan cost ledger keys on meal_id without a foreign key, so what a
      // scan cost stays on record after the meal itself is gone.
      await tx.run('DELETE FROM meals WHERE id = ?', [row.meal_id])
    }
  })
}
