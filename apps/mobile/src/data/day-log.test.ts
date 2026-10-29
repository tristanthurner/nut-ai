import { beforeEach, describe, expect, it } from 'vitest'
import { migrate, NUTRITION_SCHEMA, REPAIR_DB_SEARCH_SNAPSHOT_SQL, type DbAdapter } from '@nutai/db-adapter'
import { openMemoryDb } from '@nutai/db-adapter/node'
import { dayItems, dayNutrients, deleteItem, groupBySlot, updateItemGrams, updateMealSlot } from './day-log'
import { portionOptions } from './food-search-select'
import { logManualFood } from './manual-food'

const NOW = 1_754_200_000_000
const DAY = '2025-08-03'

let userDb: DbAdapter

const milk = { kcal: 64, protein_g: 3.3, fat_g: 3.5, carbs_g: 4.8, fiber_g: 0, sugar_g: 4.8, sodium_mg: 40 }
const bread = { kcal: 250, protein_g: 8, fat_g: 2, carbs_g: 48, fiber_g: 6, sugar_g: 3, sodium_mg: 450 }

beforeEach(async () => {
  userDb = openMemoryDb()
  await userDb.exec('PRAGMA foreign_keys = ON;')
  await migrate(userDb, NOW)
})

async function log(name: string, n: typeof milk, grams: number, slot: string, at = NOW) {
  return logManualFood(userDb, { foodId: 1, displayName: name, grams, nutrientSnapshot: n }, at, { date: DAY, slot })
}

describe('day list', () => {
  it('lists every item with its own grams and scaled numbers, grouped by meal slot', async () => {
    await log('Bread', bread, 80, 'breakfast', NOW)
    await log('Milk', milk, 250, 'breakfast', NOW + 1)
    await log('Milk', milk, 100, 'snack', NOW + 2)

    const items = await dayItems(userDb, DAY)
    expect(items.map((i) => [i.name, i.grams, Math.round(i.kcal)])).toEqual([
      ['Bread', 80, 200],
      ['Milk', 250, 160],
      ['Milk', 100, 64],
    ])

    const groups = groupBySlot(items)
    expect(groups.map((g) => [g.slot, g.items.length, Math.round(g.kcal)])).toEqual([
      ['breakfast', 2, 360],
      ['snack', 1, 64],
    ])
  })

  it('day nutrients include fiber, sugar and sodium, and agree with the item list', async () => {
    await log('Bread', bread, 80, 'breakfast')
    await log('Milk', milk, 250, 'lunch')
    const n = await dayNutrients(userDb, DAY)
    expect(n.kcal).toBeCloseTo(360, 5)
    expect(n.fiber_g).toBeCloseTo(4.8, 5)
    expect(n.sugar_g).toBeCloseTo(2.4 + 12, 5)
    expect(n.sodium_mg).toBeCloseTo(360 + 100, 5)
  })

  it('changing grams rescales everything and leaves the per-100 g snapshot untouched', async () => {
    await log('Milk', milk, 250, 'breakfast')
    const [item] = await dayItems(userDb, DAY)
    await updateItemGrams(userDb, item!.itemId, 400)

    const [after] = await dayItems(userDb, DAY)
    expect(after!.grams).toBe(400)
    expect(after!.kcal).toBeCloseTo(256, 5)
    expect(after!.per100.kcal).toBe(64)
    const row = await userDb.get<{ gram_pathway: string }>('SELECT gram_pathway FROM log_items WHERE id = ?', [item!.itemId])
    expect(row?.gram_pathway).toBe('user_edited')
  })

  it('rejects nonsense gram values instead of saving them', async () => {
    await log('Milk', milk, 250, 'breakfast')
    const [item] = await dayItems(userDb, DAY)
    await expect(updateItemGrams(userDb, item!.itemId, 0)).rejects.toThrow()
    await expect(updateItemGrams(userDb, item!.itemId, Number.NaN)).rejects.toThrow()
    await expect(updateItemGrams(userDb, item!.itemId, 99999)).rejects.toThrow()
  })

  it('moving a meal to another slot regroups it', async () => {
    const mealId = await log('Milk', milk, 250, 'lunch')
    await updateMealSlot(userDb, mealId, 'breakfast')
    expect(groupBySlot(await dayItems(userDb, DAY)).map((g) => g.slot)).toEqual(['breakfast'])
  })

  it('deleting the last item of a meal removes the meal too', async () => {
    await log('Milk', milk, 250, 'lunch')
    const [item] = await dayItems(userDb, DAY)
    await deleteItem(userDb, item!.itemId)
    expect(await dayItems(userDb, DAY)).toEqual([])
    expect(await userDb.get<{ c: number }>('SELECT COUNT(*) c FROM meals')).toEqual({ c: 0 })
  })

  it('deleting one item of a multi-item meal keeps the rest', async () => {
    const mealId = await log('Bread', bread, 80, 'breakfast')
    await userDb.run(
      `INSERT INTO log_items (meal_id, matched_food_source, display_name, grams, gram_pathway, portion_source,
                              snap_energy_kcal, sort_order, logged_at)
       VALUES (?, 'estimate', 'Butter', 10, 'model_guess', 'model', 717, 1, ?)`,
      [mealId, NOW],
    )
    const items = await dayItems(userDb, DAY)
    await deleteItem(userDb, items[0]!.itemId)
    expect((await dayItems(userDb, DAY)).map((i) => i.name)).toEqual(['Butter'])
  })
})

describe('v2 repair of Food Database entries written pre-scaled', () => {
  it('un-scales db_search rows and leaves scan rows alone', async () => {
    const mealId = await log('Milk', milk, 250, 'breakfast')
    // Simulate a pre-fix row: snapshot stored already scaled to 250 g.
    await userDb.run('UPDATE log_items SET snap_energy_kcal = 160, snap_protein_g = 8.25 WHERE meal_id = ?', [mealId])
    await userDb.run(
      `INSERT INTO log_items (meal_id, matched_food_source, display_name, grams, gram_pathway, portion_source,
                              snap_energy_kcal, sort_order, logged_at)
       VALUES (?, 'estimate', 'Scanned', 200, 'model_guess', 'model', 100, 1, ?)`,
      [mealId, NOW],
    )
    await userDb.exec(REPAIR_DB_SEARCH_SNAPSHOT_SQL)

    const rows = await userDb.all<{ display_name: string; snap_energy_kcal: number; snap_protein_g: number | null }>(
      'SELECT display_name, snap_energy_kcal, snap_protein_g FROM log_items ORDER BY id',
    )
    expect(rows[0]!.snap_energy_kcal).toBeCloseTo(64, 5)
    expect(rows[0]!.snap_protein_g).toBeCloseTo(3.3, 5)
    expect(rows[1]!.snap_energy_kcal).toBe(100)
  })
})

describe('portion options for the gram picker', () => {
  it('offers recorded portions, servings first, de-duplicated by weight', async () => {
    const n = openMemoryDb()
    await n.exec(NUTRITION_SCHEMA)
    await n.run(`INSERT INTO foods (id, source, name, energy_kcal, license) VALUES (1, 'off', 'Vollmilch', 64, 'ODbL-1.0')`)
    await n.run(`INSERT INTO food_portions (food_id, measure_unit, modifier, amount, gram_weight, is_fndds_default) VALUES
      (1, 'cup', NULL, 1, 244, 0),
      (1, 'serving', '250 ml', 1, 250, 1),
      (1, 'undetermined', 'large', 1, 244, 0)`)
    expect(await portionOptions(n, 1)).toEqual([
      { label: '1 serving · 250 ml', grams: 250 },
      { label: '1 cup', grams: 244 },
    ])
  })
})
