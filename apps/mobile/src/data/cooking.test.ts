import { beforeEach, describe, expect, it } from 'vitest'
import { migrate, type DbAdapter } from '@nutai/db-adapter'
import { openMemoryDb } from '@nutai/db-adapter/node'
import {
  applyCook,
  convertGrams,
  cookContextFor,
  cookKindFor,
  nutritionBasis,
  per100Multiplier,
  saveCookPref,
  stripWeighedSuffix,
  weighedName,
} from './cooking'

const NOW = 1_754_200_000_000
let h: DbAdapter

beforeEach(async () => {
  h = openMemoryDb()
  await migrate(h, NOW)
})

describe('cookKindFor', () => {
  it.each([
    ['Goldmarke Spaghetti', 'pasta'],
    ['Recheis Frischei Nudeln Spiralen', 'pasta'],
    ['S-Budget Penne Rigate', 'pasta'],
    ['Pasta, dry, enriched', 'pasta'],
    ['Reisnudeln', 'pasta'],
    ['S-Budget Langkornreis', 'rice'],
    ['Basmati Reis', 'rice'],
    ['Rice, white, long-grain, regular, raw, enriched', 'rice'],
    ['Rice, white, cooked, no added fat', 'rice'],
    ['Quinoa, uncooked', 'grain'],
    ['Couscous', 'grain'],
    ['Lentils, raw', 'legume'],
    ['Rote Linsen', 'legume'],
  ])('%s → %s', (name, kind) => {
    expect(cookKindFor(name)?.id).toBe(kind)
  })

  it.each([
    'Reiswaffeln', 'Reisdrink', 'Rice crackers', 'Spaghetti Bolognese Fertiggericht', 'Nudelsuppe',
    'Pasta Sauce Arrabbiata', 'Reismehl', 'Butterhörnchen', 'Jasmintee', 'Grüne Bohnen', 'Apfel',
    'Spaghetti squash, cooked', 'Milk, whole', 'Preiselbeeren',
  ])('%s is not a cookable staple', (name) => {
    expect(cookKindFor(name)).toBeNull()
  })

  it('uses specific factors where the group default is far off', () => {
    expect(cookKindFor('Polenta')?.factor).toBe(4)
    expect(cookKindFor('Spaghetti')?.factor).toBe(2.4)
    expect(cookKindFor('Frische Pasta')?.factor).toBe(1.6)
    expect(cookKindFor('Frischei Spaghetti')?.factor).toBe(2.4)
  })
})

describe('nutritionBasis', () => {
  it('reads raw and cooked from the name', () => {
    expect(nutritionBasis('Goldmarke Spaghetti')).toBe('raw')
    expect(nutritionBasis('Quinoa, uncooked')).toBe('raw')
    expect(nutritionBasis('Rice, white, parboiled, dry')).toBe('raw')
    expect(nutritionBasis('Rice, white, cooked, no added fat')).toBe('cooked')
    expect(nutritionBasis('Lentils, mature seeds, cooked, boiled')).toBe('cooked')
    expect(nutritionBasis('Kichererbsen in der Dose')).toBe('cooked')
    expect(nutritionBasis('Express Reis')).toBe('cooked')
  })
})

describe('conversion', () => {
  it('converts per-100 g values to the weighed state', () => {
    expect(per100Multiplier('raw', 'raw', 2.4)).toBe(1)
    expect(per100Multiplier('raw', 'cooked', 2.5)).toBeCloseTo(0.4)
    expect(per100Multiplier('cooked', 'raw', 2.5)).toBe(2.5)
  })

  it('keeps the calories when 100 g dry pasta is logged as 240 g cooked', () => {
    const per100 = { kcal: 360, protein_g: 12, fat_g: 1.5, carbs_g: 72, fiber_g: 3, sugar_g: 3, sodium_mg: 5 }
    const ctx = { kind: 'pasta' as const, basis: 'raw' as const, weighed: 'raw' as const, factor: 2.4, key: 'k' }
    const out = applyCook(per100, 'Spaghetti', ctx, { weighed: 'cooked', factor: 2.4 })
    expect((out.per100.kcal * 240) / 100).toBeCloseTo(360)
    expect(out.per100.fiber_g).toBeCloseTo(1.25)
    expect(out.name).toBe('Spaghetti (gekocht gewogen)')
    expect(convertGrams(100, 'raw', 'cooked', 2.4)).toBeCloseTo(240)
    expect(convertGrams(240, 'cooked', 'raw', 2.4)).toBeCloseTo(100)
  })

  it('keeps nulls null and leaves the name alone when nothing changes', () => {
    const per100 = { kcal: 130, protein_g: 2.7, fat_g: 0.3, carbs_g: 28, fiber_g: null, sugar_g: null, sodium_mg: null }
    const ctx = { kind: 'rice' as const, basis: 'cooked' as const, weighed: 'cooked' as const, factor: 2.5, key: 'k' }
    const raw = applyCook(per100, 'Rice, cooked', ctx, { weighed: 'raw', factor: 2.5 })
    expect(raw.per100.kcal).toBeCloseTo(325)
    expect(raw.per100.fiber_g).toBeNull()
    expect(raw.name).toBe('Rice, cooked (roh gewogen)')
    expect(applyCook(per100, 'Rice, cooked', ctx, { weighed: 'cooked', factor: 2.5 }).name).toBe('Rice, cooked')
  })

  it('never stacks suffixes', () => {
    const n = weighedName('Spaghetti (gekocht gewogen)', 'raw', 'cooked')
    expect(n).toBe('Spaghetti (gekocht gewogen)')
    expect(stripWeighedSuffix(n)).toBe('Spaghetti')
  })
})

describe('remembered choice', () => {
  it('defaults to the product state, then remembers per product and per kind', async () => {
    const first = await cookContextFor(h, 'Goldmarke Spaghetti', 'corpus', 11)
    expect(first).toMatchObject({ kind: 'pasta', basis: 'raw', weighed: 'raw', factor: 2.4 })

    await saveCookPref(h, first!, { weighed: 'cooked', factor: 2.2 })
    expect(await cookContextFor(h, 'Goldmarke Spaghetti (gekocht gewogen)', 'corpus', 11)).toMatchObject({
      weighed: 'cooked', factor: 2.2,
    })
    // Another pasta: weighed cooked like last time, but with its own default factor.
    expect(await cookContextFor(h, 'S-Budget Penne', 'corpus', 12)).toMatchObject({ weighed: 'cooked', factor: 2.4 })
    // Rice is a different kind: untouched.
    expect(await cookContextFor(h, 'Basmati Reis', 'user', 3)).toMatchObject({ weighed: 'raw', factor: 2.5 })
    expect(await cookContextFor(h, 'Apfel', 'corpus', 1)).toBeNull()
  })
})
