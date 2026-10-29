import { beforeEach, describe, expect, it } from 'vitest'
import { migrate, type DbAdapter } from '@nutai/db-adapter'
import { openMemoryDb } from '@nutai/db-adapter/node'
import { dayItems, dayNutrients } from './day-log'
import { frequentFoods, recentFoods } from './history'
import { logManualFood } from './manual-food'
import {
  createSavedMeal,
  deleteSavedMeal,
  listSavedMeals,
  logSavedMeal,
  mealTotals,
  parseItems,
  savedItemsFromLoggedMeal,
  updateSavedMeal,
  type SavedMealItem,
} from './saved-meals'

const NOW = 1_754_200_000_000
const DAY = '2025-08-03'

const oats: SavedMealItem = {
  foodId: 10,
  name: 'Haferflocken',
  grams: 60,
  per100: { kcal: 372, protein_g: 13.5, fat_g: 7, carbs_g: 58.7, fiber_g: 10, sugar_g: 0.7, sodium_mg: 5 },
}
const milk: SavedMealItem = {
  foodId: 11,
  name: 'Vollmilch',
  grams: 200,
  per100: { kcal: 64, protein_g: 3.3, fat_g: 3.5, carbs_g: 4.8, fiber_g: 0, sugar_g: 4.8, sodium_mg: 40 },
}

let h: DbAdapter

beforeEach(async () => {
  h = openMemoryDb()
  await h.exec('PRAGMA foreign_keys = ON;')
  await migrate(h, NOW)
})

describe('saved meals', () => {
  it('creates, lists with totals, renames and deletes', async () => {
    const id = await createSavedMeal(h, '  Porridge  ', [oats, milk], NOW)
    let [m] = await listSavedMeals(h)
    expect(m?.name).toBe('Porridge')
    expect(m?.items).toHaveLength(2)
    expect(Math.round(mealTotals(m!.items).kcal)).toBe(Math.round(372 * 0.6 + 64 * 2))

    await updateSavedMeal(h, id, 'Porridge groß', [{ ...oats, grams: 90 }, milk])
    ;[m] = await listSavedMeals(h)
    expect(m?.name).toBe('Porridge groß')
    expect(m?.items[0]?.grams).toBe(90)

    await deleteSavedMeal(h, id)
    expect(await listSavedMeals(h)).toEqual([])
  })

  it('refuses a nameless or empty meal', async () => {
    await expect(createSavedMeal(h, '   ', [oats], NOW)).rejects.toThrow()
    await expect(createSavedMeal(h, 'Nichts', [], NOW)).rejects.toThrow()
  })

  it('logs as one meal with one editable line per ingredient, and counts the use', async () => {
    const id = await createSavedMeal(h, 'Porridge', [oats, milk], NOW)
    await logSavedMeal(h, id, NOW + 1, { date: DAY, slot: 'breakfast' })

    const items = await dayItems(h, DAY)
    expect(items.map((i) => [i.name, i.grams, i.slot])).toEqual([
      ['Haferflocken', 60, 'breakfast'],
      ['Vollmilch', 200, 'breakfast'],
    ])
    expect(new Set(items.map((i) => i.mealId)).size).toBe(1)
    const n = await dayNutrients(h, DAY)
    expect(n.kcal).toBeCloseTo(372 * 0.6 + 128, 5)
    expect(n.fiber_g).toBeCloseTo(6, 5)

    const [m] = await listSavedMeals(h)
    expect(m?.useCount).toBe(1)
    expect(m?.lastUsedAt).toBe(NOW + 1)
  })

  it('can log a scaled portion of a saved meal', async () => {
    const id = await createSavedMeal(h, 'Porridge', [oats, milk], NOW)
    await logSavedMeal(h, id, NOW, { date: DAY, scale: 1.5 })
    expect((await dayItems(h, DAY)).map((i) => i.grams)).toEqual([90, 300])
  })

  it('turns a logged meal into saved-meal items, folding in the eaten fraction', async () => {
    const mealId = await logManualFood(h, { foodId: 11, displayName: 'Vollmilch', grams: 250, nutrientSnapshot: { ...milk.per100 } }, NOW, { date: DAY })
    await h.run('UPDATE meals SET portion_eaten_fraction = 0.5 WHERE id = ?', [mealId])
    const items = await savedItemsFromLoggedMeal(h, mealId)
    expect(items).toEqual([{ ...milk, grams: 125 }])
  })

  it('ignores malformed stored items instead of crashing', () => {
    expect(parseItems('not json')).toEqual([])
    expect(parseItems('{"a":1}')).toEqual([])
    expect(parseItems(JSON.stringify([{ name: 'x', grams: -1, per100: { kcal: 1 } }, oats]))).toEqual([oats])
  })
})

describe('recently and frequently tracked', () => {
  async function log(foodId: number, name: string, grams: number, at: number) {
    await logManualFood(
      h,
      { foodId, displayName: name, grams, nutrientSnapshot: { kcal: 100, protein_g: 1, fat_g: 1, carbs_g: 1 } },
      at,
      { date: DAY },
    )
  }

  it('recent: distinct foods, newest first, with the grams eaten last time', async () => {
    await log(1, 'Apfel', 150, NOW)
    await log(2, 'Brot', 80, NOW + 10)
    await log(1, 'Apfel', 180, NOW + 20)
    const r = await recentFoods(h)
    expect(r.map((f) => [f.name, f.lastGrams, f.count])).toEqual([
      ['Apfel', 180, 2],
      ['Brot', 80, 1],
    ])
  })

  it('frequent: only foods logged at least twice, most often first', async () => {
    for (let i = 0; i < 3; i++) await log(3, 'Joghurt', 150, NOW + i)
    for (let i = 0; i < 2; i++) await log(1, 'Apfel', 150, NOW + 10 + i)
    await log(2, 'Brot', 80, NOW + 100)
    expect((await frequentFoods(h)).map((f) => [f.name, f.count])).toEqual([
      ['Joghurt', 3],
      ['Apfel', 2],
    ])
  })

  it('ignores AI estimates that have no corpus identity', async () => {
    const mealId = await logManualFood(h, { foodId: 1, displayName: 'Apfel', grams: 150, nutrientSnapshot: { kcal: 52, protein_g: 0, fat_g: 0, carbs_g: 14 } }, NOW, { date: DAY })
    await h.run(
      `INSERT INTO log_items (meal_id, matched_food_source, display_name, grams, gram_pathway, portion_source,
                              snap_energy_kcal, sort_order, logged_at)
       VALUES (?, 'estimate', 'Pasta', 200, 'model_guess', 'model', 150, 1, ?)`,
      [mealId, NOW + 5],
    )
    expect((await recentFoods(h)).map((f) => f.name)).toEqual(['Apfel'])
  })
})

describe('saved meals with self-added products', () => {
  it('keeps the user source through save, log and re-save', async () => {
    const { createUserFood, getUserFood } = await import('./user-foods')
    const uid = await createUserFood(h, { name: 'Mein Müsli', kcal: 400, protein_g: 10, carbs_g: 60, fat_g: 12 }, NOW)
    const f = (await getUserFood(h, uid))!
    const id = await createSavedMeal(h, 'Frühstück', [{ foodId: uid, source: 'user', name: f.name, grams: 70, per100: f.per100 }, milk], NOW)
    const mealId = await logSavedMeal(h, id, NOW, { date: DAY })
    const src = await h.all<{ matched_food_source: string }>('SELECT matched_food_source FROM log_items WHERE meal_id = ? ORDER BY sort_order', [mealId])
    expect(src.map((r) => r.matched_food_source)).toEqual(['user', 'corpus'])
    const again = await savedItemsFromLoggedMeal(h, mealId)
    expect(again[0]).toMatchObject({ foodId: uid, source: 'user', grams: 70 })
    expect(again[1]!.source).toBeUndefined()
  })
})
