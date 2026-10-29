import { beforeEach, describe, expect, it } from 'vitest'
import { migrate, type DbAdapter } from '@nutai/db-adapter'
import { openMemoryDb } from '@nutai/db-adapter/node'
import { dayItems, dayNutrients } from './day-log'
import { frequentFoods, recentFoods } from './history'
import { logManualFood } from './manual-food'
import {
  createUserFood,
  deleteUserFood,
  findUserFoodByBarcode,
  getUserFood,
  listUserFoods,
  logUserFood,
  searchUserFoods,
  updateUserFood,
  UserFoodError,
  type UserFoodInput,
} from './user-foods'

const NOW = 1_754_200_000_000
const DAY = '2025-08-03'

// A real, check-digit-valid EAN-13 and EAN-8.
const EAN13 = '9001234567896'
const EAN8 = '96385074'

const fusilli: UserFoodInput = {
  name: 'Fusilli Vollkorn',
  brand: 'Recheis',
  barcode: EAN13,
  servingG: 80,
  kcal: 352,
  protein_g: 13,
  carbs_g: 64,
  fat_g: 2.5,
  sugar_g: 3,
  fiber_g: 8,
  salt_g: 0.02,
}

let h: DbAdapter

beforeEach(async () => {
  h = openMemoryDb()
  await h.exec('PRAGMA foreign_keys = ON;')
  await migrate(h, NOW)
})

describe('self-added products', () => {
  it('saves a product per 100 g with salt stored as sodium and the barcode canonical', async () => {
    const id = await createUserFood(h, fusilli, NOW)
    const f = await getUserFood(h, id)
    expect(f).toMatchObject({
      name: 'Fusilli Vollkorn',
      brand: 'Recheis',
      barcode: EAN13,
      servingG: 80,
      per100: { kcal: 352, protein_g: 13, carbs_g: 64, fat_g: 2.5, sugar_g: 3, fiber_g: 8, sodium_mg: 8 },
    })
  })

  it('finds a product by any form of its barcode', async () => {
    await createUserFood(h, { ...fusilli, barcode: EAN8 }, NOW)
    expect((await findUserFoodByBarcode(h, EAN8))?.name).toBe('Fusilli Vollkorn')
    expect((await findUserFoodByBarcode(h, `00000${EAN8}`))?.name).toBe('Fusilli Vollkorn')
    expect(await findUserFoodByBarcode(h, EAN13)).toBeNull()
  })

  it('rejects impossible labels and says which field is wrong', async () => {
    const bad = async (patch: Partial<UserFoodInput>) => {
      try {
        await createUserFood(h, { ...fusilli, ...patch }, NOW)
        return null
      } catch (e) {
        return e instanceof UserFoodError ? e.field : 'other'
      }
    }
    expect(await bad({ name: ' ' })).toBe('name')
    expect(await bad({ kcal: 1500 })).toBe('kcal')
    expect(await bad({ protein_g: -1 })).toBe('protein_g')
    expect(await bad({ protein_g: 50, carbs_g: 50, fat_g: 20 })).toBe('form')
    expect(await bad({ sugar_g: 70 })).toBe('sugar_g')
    expect(await bad({ barcode: '1234567890123' })).toBe('barcode')
    expect(await bad({ barcode: '' })).toBeNull()
  })

  it('refuses a second product with the same barcode, but an edit may keep its own', async () => {
    const id = await createUserFood(h, fusilli, NOW)
    await expect(createUserFood(h, { ...fusilli, name: 'Penne' }, NOW)).rejects.toThrow(/already saved/)
    await updateUserFood(h, id, { ...fusilli, kcal: 350 })
    expect((await getUserFood(h, id))?.per100.kcal).toBe(350)
  })

  it('lists newest first, searches by name or brand, deletes', async () => {
    await createUserFood(h, { ...fusilli, barcode: null }, NOW)
    const id2 = await createUserFood(h, { ...fusilli, name: 'Spaghetti', brand: 'S-Budget', barcode: null }, NOW + 1)
    expect((await listUserFoods(h)).map((f) => f.name)).toEqual(['Spaghetti', 'Fusilli Vollkorn'])
    expect((await searchUserFoods(h, 'budget spag')).map((f) => f.name)).toEqual(['Spaghetti'])
    expect((await searchUserFoods(h, 'recheis')).map((f) => f.name)).toEqual(['Fusilli Vollkorn'])
    expect(await searchUserFoods(h, '100%_')).toEqual([])
    await deleteUserFood(h, id2)
    expect((await listUserFoods(h)).map((f) => f.name)).toEqual(['Fusilli Vollkorn'])
  })

  it('logs into the day list and counts toward totals and history as its own source', async () => {
    const id = await createUserFood(h, fusilli, NOW)
    const food = (await getUserFood(h, id))!
    await logUserFood(h, food, 125, NOW, { date: DAY, slot: 'lunch' })
    await logUserFood(h, food, 100, NOW + 5, { date: DAY, slot: 'dinner' })
    // A corpus food with the SAME numeric id must not merge with it.
    await logManualFood(h, { foodId: id, displayName: 'Corpus thing', grams: 50, nutrientSnapshot: { kcal: 100, protein_g: 1, fat_g: 1, carbs_g: 1 } }, NOW + 9, { date: DAY })

    const items = await dayItems(h, DAY)
    expect(items.map((i) => [i.name, i.grams])).toEqual([
      ['Fusilli Vollkorn', 125],
      ['Fusilli Vollkorn', 100],
      ['Corpus thing', 50],
    ])
    expect((await dayNutrients(h, DAY)).kcal).toBeCloseTo(352 * 2.25 + 50, 5)

    const recent = await recentFoods(h)
    expect(recent.map((f) => [f.source, f.name, f.lastGrams])).toEqual([
      ['corpus', 'Corpus thing', 50],
      ['user', 'Fusilli Vollkorn', 100],
    ])
    expect((await frequentFoods(h)).map((f) => [f.source, f.count])).toEqual([['user', 2]])
  })
})
