import type { DbAdapter } from '@nutai/db-adapter'
import { normalizeGtin } from '@nutai/resolver'
import { localDate, slotFor } from './date-utils'

/**
 * "Selbst hinzugefügt" — products the person typed in themselves, usually off
 * the package of something the bundled database does not know.
 *
 * Stored in `user_foods` in user.db (never in the read-only corpus), per 100 g
 * like every other row, so they log, edit and back up exactly like everything
 * else. A barcode, when given, is stored in canonical 13-digit GTIN form —
 * the same form the scanner looks up — so the next scan finds it.
 *
 * Pure DbAdapter functions, no React Native imports: tested under Node.
 */

export interface UserFoodInput {
  name: string
  brand?: string | null
  barcode?: string | null
  /** Optional typical portion, e.g. one bar = 45 g. */
  servingG?: number | null
  kcal: number
  protein_g: number
  carbs_g: number
  fat_g: number
  sugar_g?: number | null
  fiber_g?: number | null
  /** Salt as printed on EU labels; stored as sodium (salt ÷ 2.5). */
  salt_g?: number | null
}

export interface UserFood {
  id: number
  name: string
  brand: string | null
  barcode: string | null
  servingG: number | null
  per100: {
    kcal: number
    protein_g: number
    fat_g: number
    carbs_g: number
    fiber_g: number | null
    sugar_g: number | null
    sodium_mg: number | null
  }
  createdAt: number
}

export class UserFoodError extends Error {
  constructor(public readonly field: keyof UserFoodInput | 'form', message: string) {
    super(message)
  }
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** Checks a form the way a label is built, and says which field is wrong. */
export function validateUserFood(input: UserFoodInput): void {
  if (input.name.trim().length < 2) throw new UserFoodError('name', 'Enter a product name.')
  if (!finite(input.kcal) || input.kcal < 0 || input.kcal > 920) {
    throw new UserFoodError('kcal', 'Calories per 100 g must be between 0 and 920.')
  }
  for (const k of ['protein_g', 'carbs_g', 'fat_g'] as const) {
    const v = input[k]
    if (!finite(v) || v < 0 || v > 100) throw new UserFoodError(k, 'Must be between 0 and 100 g per 100 g.')
  }
  if (input.protein_g + input.carbs_g + input.fat_g > 105) {
    throw new UserFoodError('form', 'Protein, carbs and fat add up to more than 100 g per 100 g — check the label.')
  }
  if (input.sugar_g != null && (!finite(input.sugar_g) || input.sugar_g < 0 || input.sugar_g > input.carbs_g + 0.5)) {
    throw new UserFoodError('sugar_g', 'Sugar is part of the carbs, so it cannot be more than the carbs.')
  }
  if (input.fiber_g != null && (!finite(input.fiber_g) || input.fiber_g < 0 || input.fiber_g > 100)) {
    throw new UserFoodError('fiber_g', 'Must be between 0 and 100 g.')
  }
  if (input.salt_g != null && (!finite(input.salt_g) || input.salt_g < 0 || input.salt_g > 100)) {
    throw new UserFoodError('salt_g', 'Must be between 0 and 100 g.')
  }
  if (input.servingG != null && (!finite(input.servingG) || input.servingG <= 0 || input.servingG > 5000)) {
    throw new UserFoodError('servingG', 'Portion must be between 1 and 5000 g.')
  }
  if (input.barcode && input.barcode.trim() !== '' && normalizeGtin(input.barcode) == null) {
    throw new UserFoodError('barcode', 'That is not a valid EAN/UPC barcode (8, 12 or 13 digits).')
  }
}

interface Row {
  id: number
  name: string
  brand: string | null
  barcode: string | null
  serving_size_g: number | null
  energy_kcal: number | null
  protein_g: number | null
  fat_g: number | null
  carb_g: number | null
  fiber_g: number | null
  sugar_g: number | null
  sodium_mg: number | null
  created_at: number | null
}

const COLS = `id, name, brand, barcode, serving_size_g, energy_kcal, protein_g, fat_g, carb_g, fiber_g, sugar_g, sodium_mg, created_at`

function toFood(r: Row): UserFood {
  return {
    id: r.id,
    name: r.name,
    brand: r.brand,
    barcode: r.barcode,
    servingG: r.serving_size_g,
    per100: {
      kcal: r.energy_kcal ?? 0,
      protein_g: r.protein_g ?? 0,
      fat_g: r.fat_g ?? 0,
      carbs_g: r.carb_g ?? 0,
      fiber_g: r.fiber_g,
      sugar_g: r.sugar_g,
      sodium_mg: r.sodium_mg,
    },
    createdAt: r.created_at ?? 0,
  }
}

function values(input: UserFoodInput) {
  const barcode = input.barcode && input.barcode.trim() !== '' ? normalizeGtin(input.barcode) : null
  const brand = input.brand?.trim() ? input.brand.trim().slice(0, 80) : null
  return {
    name: input.name.trim().slice(0, 120),
    brand,
    barcode,
    serving: input.servingG ?? null,
    sodium: input.salt_g != null ? Math.round(input.salt_g * 400) : null,
  }
}

async function assertBarcodeFree(h: DbAdapter, barcode: string | null, exceptId: number | null): Promise<void> {
  if (!barcode) return
  const clash = await h.get<{ id: number; name: string }>(
    'SELECT id, name FROM user_foods WHERE barcode = ? AND (? IS NULL OR id <> ?) LIMIT 1',
    [barcode, exceptId, exceptId],
  )
  if (clash) throw new UserFoodError('barcode', `This barcode is already saved for “${clash.name}”.`)
}

export async function createUserFood(h: DbAdapter, input: UserFoodInput, now: number): Promise<number> {
  validateUserFood(input)
  const v = values(input)
  await assertBarcodeFree(h, v.barcode, null)
  const r = await h.run(
    `INSERT INTO user_foods (name, brand, barcode, basis, serving_size_g, energy_kcal, protein_g, fat_g, carb_g,
                             fiber_g, sugar_g, sodium_mg, pending_resolution, created_at)
     VALUES (?,?,?,'per_100g',?,?,?,?,?,?,?,?,0,?)`,
    [v.name, v.brand, v.barcode, v.serving, input.kcal, input.protein_g, input.fat_g, input.carbs_g,
     input.fiber_g ?? null, input.sugar_g ?? null, v.sodium, now],
  )
  return Number(r.lastInsertRowId)
}

/**
 * Edit a product. Entries already logged keep the numbers they were logged
 * with — the log stores its own snapshot — so fixing a typo here never
 * rewrites last week.
 */
export async function updateUserFood(h: DbAdapter, id: number, input: UserFoodInput): Promise<void> {
  validateUserFood(input)
  const v = values(input)
  await assertBarcodeFree(h, v.barcode, id)
  await h.run(
    `UPDATE user_foods SET name = ?, brand = ?, barcode = ?, serving_size_g = ?, energy_kcal = ?, protein_g = ?,
            fat_g = ?, carb_g = ?, fiber_g = ?, sugar_g = ?, sodium_mg = ? WHERE id = ?`,
    [v.name, v.brand, v.barcode, v.serving, input.kcal, input.protein_g, input.fat_g, input.carbs_g,
     input.fiber_g ?? null, input.sugar_g ?? null, v.sodium, id],
  )
}

export async function deleteUserFood(h: DbAdapter, id: number): Promise<void> {
  await h.run('DELETE FROM user_foods WHERE id = ?', [id])
}

export async function listUserFoods(h: DbAdapter): Promise<UserFood[]> {
  const rows = await h.all<Row>(`SELECT ${COLS} FROM user_foods ORDER BY created_at DESC, id DESC`)
  return rows.map(toFood)
}

export async function getUserFood(h: DbAdapter, id: number): Promise<UserFood | null> {
  const r = await h.get<Row>(`SELECT ${COLS} FROM user_foods WHERE id = ?`, [id])
  return r ? toFood(r) : null
}

/** Scanner lookup: any raw scan (EAN-8, UPC-A, EAN-13) finds the canonical row. */
export async function findUserFoodByBarcode(h: DbAdapter, raw: string): Promise<UserFood | null> {
  const gtin = normalizeGtin(raw)
  if (!gtin) return null
  const r = await h.get<Row>(`SELECT ${COLS} FROM user_foods WHERE barcode = ? LIMIT 1`, [gtin])
  return r ? toFood(r) : null
}

/** Name/brand search for the Food Database screen; every word must match. */
export async function searchUserFoods(h: DbAdapter, query: string, limit = 10): Promise<UserFood[]> {
  const words = query.toLowerCase().split(/\s+/).map((w) => w.trim()).filter((w) => w.length > 0).slice(0, 5)
  if (words.length === 0) return []
  const where = words.map(() => "(lower(name) LIKE ? ESCAPE '\\' OR lower(COALESCE(brand,'')) LIKE ? ESCAPE '\\')").join(' AND ')
  const params: string[] = []
  for (const w of words) {
    const p = `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    params.push(p, p)
  }
  const rows = await h.all<Row>(`SELECT ${COLS} FROM user_foods WHERE ${where} ORDER BY name LIMIT ?`, [...params, limit])
  return rows.map(toFood)
}

/** Log a self-added product, like a Food Database entry but sourced 'user'. */
export async function logUserFood(
  h: DbAdapter,
  food: UserFood,
  grams: number,
  now: number,
  opts: { date?: string; slot?: string } = {},
): Promise<number> {
  const date = opts.date ?? localDate(now)
  const slot = opts.slot ?? slotFor(now)
  return h.transaction(async (tx) => {
    const m = await tx.run(
      `INSERT INTO meals (logged_at, local_date, meal_slot, portion_eaten_fraction, analysis_status, created_at)
       VALUES (?,?,?,1.0,'complete',?)`,
      [now, date, slot, now],
    )
    const mealId = Number(m.lastInsertRowId)
    await tx.run(
      `INSERT INTO log_items (meal_id, matched_food_id, matched_food_source, display_name, grams,
                              gram_pathway, portion_source, snap_energy_kcal, snap_protein_g, snap_fat_g,
                              snap_carb_g, snap_fiber_g, snap_sugar_g, snap_sodium_mg,
                              is_estimate, macros_user_edited, sort_order, logged_at)
       VALUES (?,?,'user',?,?,'user_edited','user_food',?,?,?,?,?,?,?,0,0,0,?)`,
      [
        mealId, food.id, food.name, grams,
        food.per100.kcal, food.per100.protein_g, food.per100.fat_g, food.per100.carbs_g,
        food.per100.fiber_g, food.per100.sugar_g, food.per100.sodium_mg, now,
      ],
    )
    return mealId
  })
}
