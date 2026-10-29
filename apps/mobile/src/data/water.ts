import type { DbAdapter } from '@nutai/db-adapter'

/**
 * Water — the simplest log in the app: millilitres per day, nothing derived.
 * Pure DbAdapter functions (no React Native), tested under Node.
 */

export const WATER_GOAL_ML = 2500
export const MAX_WATER_ENTRY_ML = 3000

export function isValidWaterMl(ml: number): boolean {
  return Number.isFinite(ml) && ml > 0 && ml <= MAX_WATER_ENTRY_ML
}

export async function addWater(h: DbAdapter, date: string, ml: number, now: number): Promise<void> {
  if (!isValidWaterMl(ml)) throw new Error(`invalid water amount: ${ml}`)
  await h.run('INSERT INTO water_entries (local_date, ml, logged_at) VALUES (?,?,?)', [date, Math.round(ml), now])
}

export async function waterTotal(h: DbAdapter, date: string): Promise<number> {
  const r = await h.get<{ ml: number | null }>('SELECT SUM(ml) AS ml FROM water_entries WHERE local_date = ?', [date])
  return r?.ml ?? 0
}

/** Undo the most recent entry of that day; returns the amount removed (0 if none). */
export async function undoLastWater(h: DbAdapter, date: string): Promise<number> {
  const last = await h.get<{ id: number; ml: number }>(
    'SELECT id, ml FROM water_entries WHERE local_date = ? ORDER BY logged_at DESC, id DESC LIMIT 1',
    [date],
  )
  if (!last) return 0
  await h.run('DELETE FROM water_entries WHERE id = ?', [last.id])
  return last.ml
}
