import { beforeEach, describe, expect, it } from 'vitest'
import { migrate, type DbAdapter } from '@nutai/db-adapter'
import { openMemoryDb } from '@nutai/db-adapter/node'
import { addWater, undoLastWater, waterTotal } from './water'

const NOW = 1_754_200_000_000
let h: DbAdapter

beforeEach(async () => {
  h = openMemoryDb()
  await migrate(h, NOW)
})

describe('water', () => {
  it('adds up per day and keeps days apart', async () => {
    await addWater(h, '2025-08-03', 250, NOW)
    await addWater(h, '2025-08-03', 500, NOW + 1)
    await addWater(h, '2025-08-04', 330, NOW + 2)
    expect(await waterTotal(h, '2025-08-03')).toBe(750)
    expect(await waterTotal(h, '2025-08-04')).toBe(330)
    expect(await waterTotal(h, '2025-08-05')).toBe(0)
  })

  it('undo removes only the latest entry of that day', async () => {
    await addWater(h, '2025-08-03', 250, NOW)
    await addWater(h, '2025-08-03', 500, NOW + 1)
    expect(await undoLastWater(h, '2025-08-03')).toBe(500)
    expect(await waterTotal(h, '2025-08-03')).toBe(250)
    expect(await undoLastWater(h, '2025-08-09')).toBe(0)
  })

  it('rejects nonsense amounts', async () => {
    await expect(addWater(h, '2025-08-03', 0, NOW)).rejects.toThrow()
    await expect(addWater(h, '2025-08-03', -5, NOW)).rejects.toThrow()
    await expect(addWater(h, '2025-08-03', 10_000, NOW)).rejects.toThrow()
  })
})
