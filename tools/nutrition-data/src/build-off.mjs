#!/usr/bin/env node
/**
 * The Austrian branded tier: Open Food Facts products sold in Austria.
 *
 * Runs AFTER build.mjs and appends to the nutrition.db it produced. The USDA
 * generic tier stays exactly as it was; this stage only adds rows, brands,
 * search entries and serving portions, then updates the build manifest.
 *
 * Source: the Open Food Facts full CSV export (tab-separated, gzip, ~1 GB),
 * streamed and filtered by `countries_tags` so the 9 GB uncompressed file is
 * never written to disk. Data licence: ODbL-1.0 (database) / DbCL (contents),
 * attribution "Open Food Facts contributors, openfoodfacts.org".
 *
 * Same rules as the USDA build:
 *   - every row is per 100 g, values copied from the *_100g columns, never
 *     converted from a per-serving figure;
 *   - NULL never becomes 0;
 *   - a row whose energy cannot be trusted is dropped, not repaired.
 *
 * Env:
 *   OFF_CSV      path to an already-downloaded .csv.gz (skips the download)
 *   OFF_COUNTRY  countries_tags value to keep (default en:austria)
 *   OUT          nutrition.db path (default apps/mobile/assets/nutrition.db)
 */

import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '../../..')

const OUT = process.env.OUT ?? join(REPO, 'apps/mobile/assets/nutrition.db')
const COUNTRY = process.env.OFF_COUNTRY ?? 'en:austria'
const OFF_URL = 'https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz'
const OFF_DIR = process.env.OFF_DIR ?? '/tmp/off'

/** Columns this build cannot work without. Checked against the real header. */
const REQUIRED = [
  'code', 'product_name', 'brands', 'countries_tags',
  'proteins_100g', 'fat_100g', 'carbohydrates_100g',
]

// ---------------------------------------------------------------------------
// GTIN normalisation — a straight port of packages/resolver/src/gtin.ts, so a
// barcode is stored in exactly the form the app's resolveByBarcode looks up.
// ---------------------------------------------------------------------------

function upcEToUpcA(d) {
  if (d.length !== 8) return null
  const ns = d[0]
  const check = d[7]
  const body = d.slice(1, 7)
  if (ns !== '0' && ns !== '1') return null
  const m = body[5]
  const f5 = body.slice(0, 5)
  let mfr
  let item
  switch (m) {
    case '0': case '1': case '2': mfr = `${f5.slice(0, 2)}${m}00`; item = `00${f5.slice(2, 5)}`; break
    case '3': mfr = `${f5.slice(0, 3)}00`; item = `000${f5.slice(3, 5)}`; break
    case '4': mfr = `${f5.slice(0, 4)}0`; item = `0000${f5.slice(4, 5)}`; break
    default: mfr = f5; item = `0000${m}`
  }
  return `${ns}${mfr}${item}${check}`
}

function gs1CheckDigit(body) {
  let sum = 0
  ;[...body].reverse().forEach((ch, i) => { sum += i % 2 === 0 ? Number(ch) * 3 : Number(ch) })
  return (10 - (sum % 10)) % 10
}

function isValidGtin(d) {
  if (![8, 12, 13, 14].includes(d.length)) return false
  return gs1CheckDigit(d.slice(0, -1)) === Number(d.slice(-1))
}

export function normalizeGtin(raw) {
  const d = String(raw ?? '').replace(/\D/g, '')
  if (d.length === 0) return null
  if (d.length === 8) {
    const upca = upcEToUpcA(d)
    if (upca && isValidGtin(upca)) return upca.padStart(13, '0')
    return isValidGtin(d) ? d.padStart(13, '0') : null
  }
  if (d.length === 12 || d.length === 13) return isValidGtin(d) ? d.padStart(13, '0') : null
  if (d.length === 14) {
    const inner = d.slice(1)
    if (isValidGtin(inner)) return inner
    return isValidGtin(d) ? d : null
  }
  return null
}

// ---------------------------------------------------------------------------

function num(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function clean(s) {
  return (s ?? '').replace(/\s+/g, ' ').trim()
}

async function ensureCsv() {
  if (process.env.OFF_CSV) return process.env.OFF_CSV
  const path = join(OFF_DIR, 'en.openfoodfacts.org.products.csv.gz')
  try {
    const s = await stat(path)
    if (s.size > 100 * 1024 * 1024) {
      console.log(`  using cached ${path} (${(s.size / 1024 / 1024).toFixed(0)} MB)`)
      return path
    }
  } catch { /* not downloaded yet */ }

  await mkdir(OFF_DIR, { recursive: true })
  console.log(`  downloading ${OFF_URL}`)
  const res = await fetch(OFF_URL, { headers: { 'User-Agent': 'NutAI-AT-corpus-build/1.0 (open-source fork; bulk export)' } })
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(path))
  const s = await stat(path)
  console.log(`  downloaded ${(s.size / 1024 / 1024).toFixed(0)} MB`)
  return path
}

/**
 * Energy per 100 g, or null when it cannot be trusted.
 * kcal column first; the kJ `energy_100g` column only as a fallback.
 */
function energyKcal(row, col) {
  let kcal = num(row[col['energy-kcal_100g']])
  if (kcal == null) {
    const kj = num(row[col.energy_100g])
    if (kj != null) kcal = Math.round((kj / 4.184) * 10) / 10
  }
  return kcal
}

/** Plausibility gate. A dropped row is better than a wrong number. */
function plausible(f) {
  const { kcal, protein, fat, carb } = f
  if (kcal == null || protein == null || fat == null || carb == null) return false
  if (kcal < 0 || kcal > 920) return false
  for (const v of [protein, fat, carb]) if (v < 0 || v > 100) return false
  if (protein + fat + carb > 105) return false
  if (f.sugar != null && (f.sugar < 0 || f.sugar > carb + 0.5)) return false
  if (f.satFat != null && (f.satFat < 0 || f.satFat > fat + 0.5)) return false
  if (f.fiber != null && (f.fiber < 0 || f.fiber > 100)) return false
  // Atwater cross-check: the label's energy must roughly agree with its own
  // macros. Catches kJ typed into the kcal field and per-serving rows.
  const atwater = protein * 4 + carb * 4 + fat * 9
  if (Math.abs(atwater - kcal) > Math.max(60, kcal * 0.35)) return false
  return true
}

async function readProducts(csvPath) {
  const input = createReadStream(csvPath).pipe(createGunzip())
  const rl = createInterface({ input, crlfDelay: Infinity })

  let col = null
  let lines = 0
  const products = []
  const seenBarcodes = new Set()

  for await (const line of rl) {
    if (!col) {
      const header = line.split('\t').map((h) => h.trim())
      const missing = REQUIRED.filter((c) => !header.includes(c))
      if (!header.includes('energy-kcal_100g') && !header.includes('energy_100g')) missing.push('energy-kcal_100g|energy_100g')
      if (missing.length > 0) {
        throw new Error(
          `HEADER MISMATCH in the Open Food Facts export\n  MISSING: ${missing.join(', ')}\n` +
            '  The export changed shape. Do not guess column meanings — update REQUIRED after checking.',
        )
      }
      col = Object.fromEntries(header.map((h, i) => [h, i]))
      continue
    }
    lines++
    if (lines % 500000 === 0) console.log(`  …${lines.toLocaleString('en')} rows scanned, ${products.length} kept`)

    // Cheap substring prefilter before splitting a 200-column line.
    if (!line.includes(COUNTRY)) continue
    const row = line.split('\t')
    const countries = (row[col.countries_tags] ?? '').split(',')
    if (!countries.includes(COUNTRY)) continue

    const name = clean(row[col.product_name]) ||
      clean(col.abbreviated_product_name != null ? row[col.abbreviated_product_name] : '') ||
      clean(col.generic_name != null ? row[col.generic_name] : '')
    if (!name || name.length < 2) continue

    const f = {
      code: clean(row[col.code]),
      name: name.slice(0, 160),
      brand: clean((row[col.brands] ?? '').split(',')[0]).slice(0, 80) || null,
      kcal: energyKcal(row, col),
      protein: num(row[col.proteins_100g]),
      fat: num(row[col.fat_100g]),
      carb: num(row[col.carbohydrates_100g]),
      satFat: col['saturated-fat_100g'] != null ? num(row[col['saturated-fat_100g']]) : null,
      fiber: col.fiber_100g != null ? num(row[col.fiber_100g]) : null,
      sugar: col.sugars_100g != null ? num(row[col.sugars_100g]) : null,
      sodiumMg: null,
      servingG: col.serving_quantity != null ? num(row[col.serving_quantity]) : null,
      servingDesc: col.serving_size != null ? clean(row[col.serving_size]).slice(0, 60) || null : null,
      scans: col.unique_scans_n != null ? num(row[col.unique_scans_n]) ?? 0 : 0,
    }

    const sodium = col.sodium_100g != null ? num(row[col.sodium_100g]) : null
    const salt = col.salt_100g != null ? num(row[col.salt_100g]) : null
    if (sodium != null && sodium >= 0 && sodium <= 40) f.sodiumMg = Math.round(sodium * 1000)
    else if (salt != null && salt >= 0 && salt <= 100) f.sodiumMg = Math.round(salt * 400)

    if (f.servingG != null && (f.servingG <= 0 || f.servingG > 2000)) f.servingG = null

    if (!plausible(f)) continue

    f.barcode = normalizeGtin(f.code)
    // One row per product: by canonical GTIN, or by the raw code when it is
    // not a valid GTIN (store-internal codes) — never by name.
    const key = f.barcode ?? (f.code ? `raw:${f.code}` : null)
    if (key) {
      if (seenBarcodes.has(key)) continue
      seenBarcodes.add(key)
    }
    products.push(f)
  }

  if (!col) throw new Error('Open Food Facts export was empty')
  console.log(`  scanned ${lines.toLocaleString('en')} rows, kept ${products.length} for ${COUNTRY}`)
  return products
}

async function main() {
  console.log(`nutai-nutrition-data — adding Open Food Facts products for ${COUNTRY}\n`)

  try { await stat(OUT) } catch {
    throw new Error(`${OUT} not found — run \`npm run data:build\` (the USDA tier) first.`)
  }

  const csv = await ensureCsv()
  const products = await readProducts(csv)
  if (products.length < 100) {
    throw new Error(`only ${products.length} products for ${COUNTRY} — the filter or the export is wrong`)
  }

  // Most-scanned first, so popularity_rank means something within this tier.
  products.sort((a, b) => (b.scans - a.scans) || a.name.localeCompare(b.name))

  const db = new Database(OUT)
  db.pragma('journal_mode = DELETE')
  db.pragma('foreign_keys = OFF')

  // Idempotent: a re-run replaces this tier and leaves the USDA rows alone.
  const old = db.prepare("SELECT id FROM foods WHERE source = 'off'").all().map((r) => r.id)
  if (old.length > 0) {
    const delFts = db.prepare("INSERT INTO food_fts (food_fts, rowid, name, brand, synonyms) VALUES ('delete', ?, ?, ?, '')")
    const delTri = db.prepare("INSERT INTO food_fts_trigram (food_fts_trigram, rowid, name) VALUES ('delete', ?, ?)")
    const rows = db.prepare("SELECT f.id, f.name, b.canonical_name brand FROM foods f LEFT JOIN brands b ON b.id = f.brand_id WHERE f.source = 'off'").all()
    db.transaction(() => {
      for (const r of rows) { delFts.run(r.id, r.name, r.brand ?? ''); delTri.run(r.id, r.name) }
      db.exec("DELETE FROM food_portions WHERE food_id IN (SELECT id FROM foods WHERE source = 'off')")
      db.exec("DELETE FROM foods WHERE source = 'off'")
    })()
    console.log(`  removed ${old.length} rows from a previous run`)
  }

  const maxId = db.prepare('SELECT COALESCE(MAX(id), 0) m FROM foods').get().m
  const maxRank = db.prepare('SELECT COALESCE(MAX(popularity_rank), 0) m FROM foods').get().m

  const brandIds = new Map(
    db.prepare('SELECT id, canonical_name FROM brands').all().map((b) => [b.canonical_name.toLowerCase(), b.id]),
  )
  const insertBrand = db.prepare('INSERT INTO brands (canonical_name) VALUES (?)')
  const insertFood = db.prepare(`
    INSERT INTO foods (id, source, source_id, name, brand_id, basis, basis_confidence,
                       serving_size_g, serving_desc, barcode,
                       energy_kcal, protein_g, fat_g, sat_fat_g, carb_g, fiber_g,
                       sugar_g, sodium_mg, completeness_score, popularity_rank,
                       license, updated_at)
    VALUES (?, 'off', ?, ?, ?, 'per_100g', 'high', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ODbL-1.0', ?)
  `)
  const insertFts = db.prepare('INSERT INTO food_fts (rowid, name, brand, synonyms) VALUES (?,?,?,?)')
  const insertTri = db.prepare('INSERT INTO food_fts_trigram (rowid, name) VALUES (?,?)')
  const insertPortion = db.prepare(`
    INSERT INTO food_portions (food_id, measure_unit, modifier, amount, gram_weight, is_fndds_default)
    VALUES (?, 'serving', ?, 1, ?, 1)
  `)

  const now = Date.now()
  let id = maxId
  let rank = maxRank
  let withBarcode = 0
  let withServing = 0

  db.transaction(() => {
    for (const p of products) {
      let brandId = null
      if (p.brand) {
        const key = p.brand.toLowerCase()
        brandId = brandIds.get(key) ?? null
        if (brandId == null) {
          brandId = Number(insertBrand.run(p.brand).lastInsertRowid)
          brandIds.set(key, brandId)
        }
      }

      id++
      rank++
      const optional = ['satFat', 'fiber', 'sugar', 'sodiumMg'].filter((k) => p[k] != null).length
      insertFood.run(
        id, p.code, p.name, brandId,
        p.servingG, p.servingDesc, p.barcode,
        p.kcal, p.protein, p.fat, p.satFat, p.carb, p.fiber, p.sugar, p.sodiumMg,
        0.75 + optional / 16, rank, now,
      )
      insertFts.run(id, p.name, p.brand ?? '', '')
      insertTri.run(id, p.name)
      if (p.barcode) withBarcode++
      if (p.servingG != null) {
        insertPortion.run(id, p.servingDesc, p.servingG)
        withServing++
      }
    }
  })()

  const manifest = db.prepare('INSERT OR REPLACE INTO build_manifest (key, value) VALUES (?,?)')
  const get = (k) => db.prepare('SELECT value FROM build_manifest WHERE key = ?').get(k)?.value ?? ''
  const strip = (s, part) => s.split(' | ').filter((x) => x && !x.startsWith(part)).join(' | ')
  const foods = db.prepare('SELECT COUNT(*) c FROM foods').get().c
  const portions = db.prepare('SELECT COUNT(*) c FROM food_portions').get().c
  db.transaction(() => {
    manifest.run('tier', 'generic+branded-at')
    manifest.run('sources', [strip(get('sources'), 'Open Food Facts'), `Open Food Facts (${COUNTRY}, ${new Date(now).toISOString().slice(0, 10)})`].filter(Boolean).join(' | '))
    manifest.run('licenses', [strip(get('licenses'), 'ODbL'), 'ODbL-1.0 (Open Food Facts)'].filter(Boolean).join(' | '))
    manifest.run('attribution', [strip(get('attribution'), 'Open Food Facts'), 'Open Food Facts contributors, https://openfoodfacts.org'].filter(Boolean).join(' | '))
    manifest.run('off_country', COUNTRY)
    manifest.run('off_count', String(products.length))
    manifest.run('food_count', String(foods))
    manifest.run('portion_count', String(portions))
    manifest.run('built_at', new Date(now).toISOString())
  })()

  db.exec('VACUUM')
  db.close()

  const size = (await stat(OUT)).size
  console.log('\nUpdated', OUT)
  console.log(`  Open Food Facts rows: ${products.length} (${withBarcode} with barcode, ${withServing} with serving size)`)
  console.log(`  foods total:          ${foods}`)
  console.log(`  size:                 ${(size / 1024 / 1024).toFixed(1)} MB`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error('\nOPEN FOOD FACTS STAGE FAILED\n')
    console.error(err.message)
    process.exit(1)
  })
}
