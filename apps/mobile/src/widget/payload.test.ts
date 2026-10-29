import { describe, expect, it } from 'vitest'
import { buildWidgetPayload } from './payload'

describe('widget payload', () => {
  it('rounds to one decimal and carries the date the numbers belong to', () => {
    const p = buildWidgetPayload(
      '2025-08-04',
      { kcal: 1234.567, protein_g: 80.04, carbs_g: 150.96, fat_g: Number.NaN, mealCount: 3 },
      { targetKcal: 2100, protein_g: 140, carbs_g: 230, fat_g: 70 },
    )
    expect(p).toEqual({
      v: 1,
      date: '2025-08-04',
      kcalEaten: 1234.6,
      kcalTarget: 2100,
      protein: { eaten: 80, target: 140 },
      carbs: { eaten: 151, target: 230 },
      fat: { eaten: 0, target: 70 },
      mealsLogged: 3,
    })
    // Exactly the keys the Swift decoder requires.
    expect(Object.keys(JSON.parse(JSON.stringify(p))).sort()).toEqual(
      ['carbs', 'date', 'fat', 'kcalEaten', 'kcalTarget', 'mealsLogged', 'protein', 'v'],
    )
  })
})
