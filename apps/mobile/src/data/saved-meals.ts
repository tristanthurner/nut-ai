import type { DbAdapter } from '@nutai/db-adapter'
import { localDate, slotFor } from './date-utils'

/**
 * Saved meals — "my usual breakfast" as one tap.
 *
 * A saved meal stores the ingredient list itself (name, grams, per-100 g
 * nutrients), never a food name to look up again. Logging it therefore needs
 * no network, no corpus lookup and no questions, and the numbers are identical
 * to the day it was saved — a later corpus rebuild cannot move them.
 *
 * Pure DbAdapter functions, no React Native imports, so the Node test suite
 * runs them against the real user schema.
 */

export interface Per100Full {
  kcal: number
  protein_g: number
  fat_g: number
  carbs_g: number
  fiber_g: number | null
  sugar_g: number | null
  sodium_mg: number | null
}

export interface SavedMealItem {
  /** Row id in the corpus (or in user_foods when `source` is 'user'); null for anything else. */
  foodId: number | null
  /** Which table `foodId` points into. Absent = corpus (meals saved before self-added products). */
  source?: 'corpus' | 'user'
  name: string
  grams: number
  per100: Per100Full
}

export interface SavedMeal {
  id: number
  name: string
  items: SavedMealItem[]
  useCount: number
  lastUsedAt: number | null
}

export interface MealTotals {
  kcal: number
  protein_g: number
  carbs_g: number
  fat_g: number
  grams: number
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** Defensive: a row restored from an old or hand-edited backup must not crash the list. */
export function parseItems(json: string): SavedMealItem[] {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const out: SavedMealItem[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const p = (o.per100 ?? {}) as Record<string, unknown>
    const grams = num(o.grams)
    const kcal = num(p.kcal)
    if (typeof o.name !== 'string' || grams == null || grams <= 0 || kcal == null) continue
    out.push({
      foodId: num(o.foodId),
      ...(o.source === 'user' ? { source: 'user' as const } : {}),
      name: o.name,
      grams,
      per100: {
        kcal,
        protein_g: num(p.protein_g) ?? 0,
        fat_g: num(p.fat_g) ?? 0,
        carbs_g: num(p.carbs_g) ?? 0,
        fiber_g: num(p.fiber_g),
        sugar_g: num(p.sugar_g),
        sodium_mg: num(p.sodium_mg),
      },
    })
  }
  return out
}

export function mealTotals(items: readonly SavedMealItem[]): MealTotals {
  return items.reduce(
    (t, i) => {
      const k = i.grams / 100
      return {
        kcal: t.kcal + i.per100.kcal * k,
        protein_g: t.protein_g + i.per100.protein_g * k,
        carbs_g: t.carbs_g + i.per100.carbs_g * k,
        fat_g: t.fat_g + i.per100.fat_g * k,
        grams: t.grams + i.grams,
      }
    },
    { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, grams: 0 },
  )
}

function validate(name: string, items: readonly SavedMealItem[]): string {
  const n = name.trim()
  if (n.length === 0) throw new Error('a saved meal needs a name')
  if (items.length === 0) throw new Error('a saved meal needs at least one item')
  return n.slice(0, 80)
}

export async function listSavedMeals(h: DbAdapter): Promise<SavedMeal[]> {
  const rows = await h.all<{ id: number; name: string; items_json: string; use_count: number; last_used_at: number | null }>(
    `SELECT id, name, items_json, use_count, last_used_at FROM saved_meals
     ORDER BY use_count DESC, COALESCE(last_used_at, created_at) DESC, id DESC`,
  )
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    items: parseItems(r.items_json),
    useCount: r.use_count,
    lastUsedAt: r.last_used_at,
  }))
}

export async function getSavedMeal(h: DbAdapter, id: number): Promise<SavedMeal | null> {
  const all = await listSavedMeals(h)
  return all.find((m) => m.id === id) ?? null
}

export async function createSavedMeal(h: DbAdapter, name: string, items: readonly SavedMealItem[], now: number): Promise<number> {
  const n = validate(name, items)
  const r = await h.run('INSERT INTO saved_meals (name, items_json, use_count, created_at) VALUES (?,?,0,?)', [
    n,
    JSON.stringify(items),
    now,
  ])
  return Number(r.lastInsertRowId)
}

export async function updateSavedMeal(h: DbAdapter, id: number, name: string, items: readonly SavedMealItem[]): Promise<void> {
  const n = validate(name, items)
  await h.run('UPDATE saved_meals SET name = ?, items_json = ? WHERE id = ?', [n, JSON.stringify(items), id])
}

export async function deleteSavedMeal(h: DbAdapter, id: number): Promise<void> {
  await h.run('DELETE FROM saved_meals WHERE id = ?', [id])
}

/**
 * Log a saved meal as ONE meal with one log item per ingredient, so the day
 * list shows every part and each part's grams can still be corrected there.
 */
export async function logSavedMeal(
  h: DbAdapter,
  id: number,
  now: number,
  opts: { date?: string; slot?: string; scale?: number } = {},
): Promise<number> {
  const meal = await getSavedMeal(h, id)
  if (!meal || meal.items.length === 0) throw new Error('saved meal not found')
  const date = opts.date ?? localDate(now)
  const slot = opts.slot ?? slotFor(now)
  const scale = opts.scale != null && opts.scale > 0 ? opts.scale : 1

  return h.transaction(async (tx) => {
    const m = await tx.run(
      `INSERT INTO meals (logged_at, local_date, meal_slot, portion_eaten_fraction, analysis_status, created_at)
       VALUES (?,?,?,1.0,'complete',?)`,
      [now, date, slot, now],
    )
    const mealId = Number(m.lastInsertRowId)
    let sort = 0
    for (const it of meal.items) {
      await tx.run(
        `INSERT INTO log_items (meal_id, matched_food_id, matched_food_source, display_name, grams,
                                gram_pathway, portion_source, snap_energy_kcal, snap_protein_g, snap_fat_g,
                                snap_carb_g, snap_fiber_g, snap_sugar_g, snap_sodium_mg,
                                is_estimate, macros_user_edited, sort_order, logged_at)
         VALUES (?,?,?,?,?,'user_edited','saved_meal',?,?,?,?,?,?,?,0,0,?,?)`,
        [
          mealId,
          it.foodId,
          it.foodId == null ? 'saved' : it.source === 'user' ? 'user' : 'corpus',
          it.name,
          Math.round(it.grams * scale * 10) / 10,
          it.per100.kcal,
          it.per100.protein_g,
          it.per100.fat_g,
          it.per100.carbs_g,
          it.per100.fiber_g,
          it.per100.sugar_g,
          it.per100.sodium_mg,
          sort++,
          now,
        ],
      )
    }
    await tx.run('UPDATE saved_meals SET use_count = use_count + 1, last_used_at = ? WHERE id = ?', [now, id])
    return mealId
  })
}

/**
 * Turn an already-logged meal (from the day list) into a saved meal — the
 * fastest way to build "my usual" is to log it once and keep it.
 */
export async function savedItemsFromLoggedMeal(h: DbAdapter, mealId: number): Promise<SavedMealItem[]> {
  const rows = await h.all<{
    matched_food_id: number | null
    matched_food_source: string
    display_name: string
    grams: number
    snap_energy_kcal: number | null
    snap_protein_g: number | null
    snap_fat_g: number | null
    snap_carb_g: number | null
    snap_fiber_g: number | null
    snap_sugar_g: number | null
    snap_sodium_mg: number | null
    frac: number | null
  }>(
    `SELECT li.matched_food_id, li.matched_food_source, li.display_name, li.grams, li.snap_energy_kcal,
            li.snap_protein_g, li.snap_fat_g, li.snap_carb_g, li.snap_fiber_g, li.snap_sugar_g,
            li.snap_sodium_mg, m.portion_eaten_fraction AS frac
     FROM log_items li JOIN meals m ON m.id = li.meal_id
     WHERE li.meal_id = ? ORDER BY li.sort_order, li.id`,
    [mealId],
  )
  return rows
    .filter((r) => r.snap_energy_kcal != null && r.grams > 0)
    .map((r) => ({
      foodId: r.matched_food_source === 'corpus' || r.matched_food_source === 'user' ? r.matched_food_id : null,
      ...(r.matched_food_source === 'user' ? { source: 'user' as const } : {}),
      name: r.display_name,
      // "Ate half the plate" becomes half the grams: a saved meal has no
      // separate eaten fraction, so it is folded in here.
      grams: Math.round(r.grams * (r.frac ?? 1) * 10) / 10,
      per100: {
        kcal: r.snap_energy_kcal ?? 0,
        protein_g: r.snap_protein_g ?? 0,
        fat_g: r.snap_fat_g ?? 0,
        carbs_g: r.snap_carb_g ?? 0,
        fiber_g: r.snap_fiber_g,
        sugar_g: r.snap_sugar_g,
        sodium_mg: r.snap_sodium_mg,
      },
    }))
}
