import type { DbAdapter } from '@nutai/db-adapter'

/**
 * Raw vs. cooked weighing for foods that soak up water when cooked: pasta,
 * rice, grains, dried legumes.
 *
 * A product's nutrition values refer to ONE state: a pack of Recheis spaghetti
 * lists them per 100 g DRY pasta; USDA's "Rice, white, cooked" per 100 g
 * COOKED rice. A person may weigh either: the dry pasta before it goes into
 * the pot, or the cooked pasta on the plate. If the two don't match, the
 * calories are off by a factor of ~2.5.
 *
 * `factor` = grams cooked per 1 g raw (100 g dry spaghetti → ~240 g cooked).
 * The log keeps its invariant (snapshot per 100 g × grams / 100): when the
 * weighed state differs from the product's state, the per-100 g snapshot is
 * converted to the weighed state and the grams stay the number on the scale.
 *
 * ZERO React Native imports, like the other data modules, so it is testable
 * under plain Node.
 */

export type CookState = 'raw' | 'cooked'
export type CookKindId = 'pasta' | 'rice' | 'grain' | 'legume'

export interface CookKind {
  id: CookKindId
  /** Default grams cooked per gram raw. */
  factor: number
}

export interface CookPref {
  weighed: CookState
  factor: number
}

export const MIN_FACTOR = 1.1
export const MAX_FACTOR = 6

/** Names that mention a cookable word but are not the plain staple. */
const EXCLUDE = new RegExp(
  [
    'waffel', 'cake', 'cracker', 'drink', 'milk\\b', 'mehl', 'flour', 'starch', 'stärke',
    'sauce', 'soße', 'sosse', 'chips', 'riegel', '\\bbar\\b', 'crisp', 'keks', 'cookie', 'snack',
    'suppe', 'soup', 'salat', 'salad', 'pudding', 'dessert', 'essig', 'vinegar', 'sirup', 'syrup',
    'puff', 'flakes', 'flocken', 'knusper', 'pfanne', 'fertiggericht', 'auflauf', 'gratin',
    'bolognese', 'carbonara', 'napoli', 'arrabbiata', 'pesto', 'sushi', 'paper', 'papier',
    'wein', 'wine', 'sake', 'kuchen', 'torte', 'tee\\b', 'tea\\b', 'kaffee', 'coffee', 'kakao',
    'cocoa', 'vanill', 'jelly', 'preis', 'brot', 'bread', 'öl\\b', '\\boil\\b', 'bier', 'beer',
    'mit fleisch', 'bran', 'kleie', 'squash', 'kürbis', 'with meat', 'with cheese', 'with sauce', 'casserole', 'dish', 'entree',
  ].join('|'),
  'i',
)

const KINDS: { kind: CookKind; re: RegExp }[] = [
  {
    // Checked before rice so "Reisnudeln" counts as noodles.
    kind: { id: 'pasta', factor: 2.4 },
    re: /\b(pasta|nudel\w*|\w*nudeln|spaghett\w*|penne|fusilli|maccheroni|makkaroni|macaroni|tagliatell\w*|farfalle|rigatoni|linguine|fettuccin\w*|tortiglioni|hörnchen|spiralen|spirelli|orzo|lasagne\w*|noodles?|fleckerl|teigwaren|eierteigwaren|gnocchetti|conchiglie|ditalini|vermicelli)\b/i,
  },
  {
    kind: { id: 'rice', factor: 2.5 },
    re: /\b(\w*reis|rice|basmati|jasmin\w*|risotto|arborio|carnaroli|parboiled)\b/i,
  },
  {
    kind: { id: 'grain', factor: 2.6 },
    re: /\b(quinoa|cous ?cous|bulgur|hirse|millet|graupen|barley|buchweizen|buckwheat|polenta|maisgrie\w*|ebly|freekeh|farro|dinkelreis)\b/i,
  },
  {
    kind: { id: 'legume', factor: 2.4 },
    re: /\b(linsen|lentils?|kichererbsen|chickpeas?|garbanzo|schälerbsen|spalterbsen|split peas|kidneybohnen|kidney beans?|beans?, (?:kidney|black|pinto|navy|white|great northern|red)|weiße bohnen|schwarze bohnen|wachtelbohnen)\b/i,
  },
]

/** Grains/legumes whose own defaults differ a lot from their group's. */
const SPECIFIC_FACTORS: { re: RegExp; factor: number }[] = [
  { re: /\b(fresh|frische?)\b/i, factor: 1.6 },
  { re: /\b(cous ?cous)\b/i, factor: 2.3 },
  { re: /\b(quinoa)\b/i, factor: 2.7 },
  { re: /\b(hirse|millet)\b/i, factor: 2.8 },
  { re: /\b(graupen|barley)\b/i, factor: 3.0 },
  { re: /\b(polenta|maisgrie\w*)\b/i, factor: 4.0 },
  { re: /\b(kichererbsen|chickpeas?|garbanzo)\b/i, factor: 2.2 },
  { re: /\b(linsen|lentils?)\b/i, factor: 2.5 },
]

/** Which cookable staple this food is, or null if raw/cooked weighing doesn't apply. */
export function cookKindFor(name: string): CookKind | null {
  const n = name.trim()
  if (!n || EXCLUDE.test(n)) return null
  for (const { kind, re } of KINDS) {
    if (!re.test(n)) continue
    const specific = SPECIFIC_FACTORS.find((s) => s.re.test(n))
    return specific ? { ...kind, factor: specific.factor } : kind
  }
  return null
}

const COOKED_WORDS =
  /\b(cooked|boiled|steamed|prepared|canned|drained|ready|gekocht|gegart|zubereitet|abgetropft|dose|konserve|im glas|express|mikrowelle\w*|microwave|fertig\w*)\b/i

/**
 * Which state the product's nutrition values refer to. Packaged dry goods and
 * USDA "raw"/"dry"/"uncooked" rows are raw; rows named cooked, boiled, canned
 * or ready-to-eat are cooked.
 */
export function nutritionBasis(name: string): CookState {
  return COOKED_WORDS.test(name) ? 'cooked' : 'raw'
}

export function clampFactor(f: number): number {
  if (!Number.isFinite(f)) return 2.5
  return Math.round(Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, f)) * 10) / 10
}

/**
 * What to multiply the product's per-100 g values by so they refer to the
 * weighed state.
 */
export function per100Multiplier(basis: CookState, weighed: CookState, factor: number): number {
  if (basis === weighed) return 1
  const f = clampFactor(factor)
  return basis === 'raw' ? 1 / f : f
}

/** Grams of the same food in the other state, so switching keeps the calories. */
export function convertGrams(grams: number, from: CookState, to: CookState, factor: number): number {
  if (from === to) return grams
  const f = clampFactor(factor)
  return from === 'raw' ? grams * f : grams / f
}

export interface Per100Like {
  kcal: number
  protein_g: number
  fat_g: number
  carbs_g: number
  fiber_g?: number | null
  sugar_g?: number | null
  sodium_mg?: number | null
}

export function scalePer100<T extends Per100Like>(n: T, m: number): T {
  if (m === 1) return n
  const s = (v: number | null | undefined) => (v == null ? (v as null | undefined) : v * m)
  return {
    ...n,
    kcal: n.kcal * m,
    protein_g: n.protein_g * m,
    fat_g: n.fat_g * m,
    carbs_g: n.carbs_g * m,
    ...(n.fiber_g !== undefined ? { fiber_g: s(n.fiber_g) } : {}),
    ...(n.sugar_g !== undefined ? { sugar_g: s(n.sugar_g) } : {}),
    ...(n.sodium_mg !== undefined ? { sodium_mg: s(n.sodium_mg) } : {}),
  }
}

const SUFFIX_RE = / \((gekocht|roh) gewogen\)$/

/** The name as logged: says how it was weighed whenever that differs from the product. */
export function weighedName(name: string, basis: CookState, weighed: CookState): string {
  const base = stripWeighedSuffix(name)
  if (basis === weighed) return base
  return `${base} (${weighed === 'cooked' ? 'gekocht' : 'roh'} gewogen)`
}

export function stripWeighedSuffix(name: string): string {
  return name.replace(SUFFIX_RE, '')
}

/** Everything a gram picker needs to offer the raw/cooked switch for one food. */
export interface CookContext {
  kind: CookKindId
  basis: CookState
  weighed: CookState
  factor: number
  /** settings key the person's choice is remembered under. */
  key: string
}

const PREF_PREFIX = 'cook.v1.'

export function prefKey(source: 'corpus' | 'user', foodId: number | string): string {
  return `${PREF_PREFIX}${source}:${foodId}`
}

function kindKey(kind: CookKindId): string {
  return `${PREF_PREFIX}kind:${kind}`
}

function parsePref(raw: string | undefined | null): CookPref | null {
  if (!raw) return null
  try {
    const p = JSON.parse(raw) as Partial<CookPref>
    if (p.weighed !== 'raw' && p.weighed !== 'cooked') return null
    return { weighed: p.weighed, factor: clampFactor(Number(p.factor)) }
  } catch {
    return null
  }
}

/**
 * The switch's starting position for a food: what the person chose for THIS
 * product last time, else what they chose for this kind of food (pasta, rice…)
 * last time, else the product's own state with the kind's default factor.
 * Null when the food isn't a cookable staple.
 */
export async function cookContextFor(
  h: DbAdapter,
  name: string,
  source: 'corpus' | 'user',
  foodId: number | string,
): Promise<CookContext | null> {
  const clean = stripWeighedSuffix(name)
  const kind = cookKindFor(clean)
  if (!kind) return null
  const basis = nutritionBasis(clean)
  const key = prefKey(source, foodId)
  const rows = await h.all<{ key: string; value: string }>(
    'SELECT key, value FROM settings WHERE key IN (?, ?)',
    [key, kindKey(kind.id)],
  )
  const own = parsePref(rows.find((r) => r.key === key)?.value)
  const byKind = parsePref(rows.find((r) => r.key === kindKey(kind.id))?.value)
  const pref = own ?? (byKind ? { weighed: byKind.weighed, factor: kind.factor } : null)
  return {
    kind: kind.id,
    basis,
    weighed: pref?.weighed ?? basis,
    factor: pref?.factor ?? kind.factor,
    key,
  }
}

/** Remember the choice for this product and, for its weighing state, for its kind. */
export async function saveCookPref(h: DbAdapter, ctx: CookContext, pref: CookPref): Promise<void> {
  const value = JSON.stringify({ weighed: pref.weighed, factor: clampFactor(pref.factor) })
  await h.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)', [ctx.key, value])
  await h.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)', [kindKey(ctx.kind), value])
}

/** Applied result of a raw/cooked choice: per-100 g values and name to log. */
export function applyCook<T extends Per100Like>(
  per100: T,
  name: string,
  ctx: CookContext,
  pref: CookPref,
): { per100: T; name: string } {
  const m = per100Multiplier(ctx.basis, pref.weighed, pref.factor)
  return { per100: scalePer100(per100, m), name: weighedName(name, ctx.basis, pref.weighed) }
}
