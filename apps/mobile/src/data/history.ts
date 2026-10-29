import type { DbAdapter } from '@nutai/db-adapter'
import type { Per100Full } from './saved-meals'

/**
 * "Zuletzt getrackt" and "Häufig getrackt" for the Food Database screen.
 *
 * Built only from the person's own log — no corpus lookup — so the per-100 g
 * values offered are exactly the ones they logged last time, and the grams
 * default to what they actually ate last time rather than a generic portion.
 *
 * Only Food Database / saved-meal items that point at a corpus row are
 * included: an AI estimate has no stable identity to group repeats by.
 */
export interface TrackedFood {
  foodId: number
  name: string
  lastGrams: number
  count: number
  lastAt: number
  per100: Per100Full
}

interface Row {
  fid: number
  name: string
  grams: number
  logged_at: number
  cnt: number
  kcal: number | null
  p: number | null
  f: number | null
  c: number | null
  fiber: number | null
  sugar: number | null
  sodium: number | null
}

const LATEST_PER_FOOD = `
SELECT fid, name, grams, logged_at, cnt, kcal, p, f, c, fiber, sugar, sodium FROM (
  SELECT li.matched_food_id AS fid, li.display_name AS name, li.grams, li.logged_at,
         li.snap_energy_kcal AS kcal, li.snap_protein_g AS p, li.snap_fat_g AS f, li.snap_carb_g AS c,
         li.snap_fiber_g AS fiber, li.snap_sugar_g AS sugar, li.snap_sodium_mg AS sodium,
         ROW_NUMBER() OVER (PARTITION BY li.matched_food_id ORDER BY li.logged_at DESC, li.id DESC) AS rn,
         COUNT(*) OVER (PARTITION BY li.matched_food_id) AS cnt
  FROM log_items li
  JOIN meals m ON m.id = li.meal_id
  WHERE li.matched_food_source = 'corpus'
    AND li.matched_food_id IS NOT NULL
    AND li.snap_energy_kcal IS NOT NULL
    AND li.grams > 0
    AND m.analysis_status IN ('complete','manual')
)
WHERE rn = 1
`

function toTracked(r: Row): TrackedFood {
  return {
    foodId: r.fid,
    name: r.name,
    lastGrams: r.grams,
    count: r.cnt,
    lastAt: r.logged_at,
    per100: {
      kcal: r.kcal ?? 0,
      protein_g: r.p ?? 0,
      fat_g: r.f ?? 0,
      carbs_g: r.c ?? 0,
      fiber_g: r.fiber,
      sugar_g: r.sugar,
      sodium_mg: r.sodium,
    },
  }
}

/** Distinct foods, most recently logged first. */
export async function recentFoods(h: DbAdapter, limit = 8): Promise<TrackedFood[]> {
  const rows = await h.all<Row>(`${LATEST_PER_FOOD} ORDER BY logged_at DESC LIMIT ?`, [limit])
  return rows.map(toTracked)
}

/** Foods logged at least twice, most often first; ties go to the more recent. */
export async function frequentFoods(h: DbAdapter, limit = 8): Promise<TrackedFood[]> {
  const rows = await h.all<Row>(`${LATEST_PER_FOOD} AND cnt >= 2 ORDER BY cnt DESC, logged_at DESC LIMIT ?`, [limit])
  return rows.map(toTracked)
}
