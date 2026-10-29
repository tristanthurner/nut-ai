import { router, useFocusEffect, useLocalSearchParams } from 'expo-router'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { DbAdapter } from '@nutai/db-adapter'
import { resolveByText, type ScoredCandidate } from '@nutai/resolver'
import { nutritionCorpusInfo, openNutritionDb } from '../src/db/expo-adapter'
import {
  db as userDbHandle,
  frequentFoods,
  getUserFood,
  listUserFoods,
  logSavedMeal,
  logUserFood,
  searchUserFoods,
  mealTotals,
  recentFoods,
  savedMeals,
  type SavedMeal,
  type TrackedFood,
  type UserFood,
} from '../src/data/repo'
import { MealLogSheet } from '../src/components/MealLogSheet'
import { portionOptions, resolveSelection, type PortionOption } from '../src/data/food-search-select'
import { logManualFood, type ManualFoodSelection } from '../src/data/manual-food'
import { localDate, slotFor } from '../src/data/date-utils'
import type { Slot } from '../src/data/day-log'
import { GramEditor } from '../src/components/GramEditor'
import { useTheme } from '../src/theme/ThemeProvider'
import { MIN_TAP_TARGET, radius, space, type } from '../src/theme/tokens'

/**
 * What a tap on a candidate row does, end to end: resolve its default grams +
 * per-100 g snapshot from the (read-only) nutrition corpus (`resolveSelection`),
 * let the person set the grams and the meal in the GramEditor sheet, then log
 * it into the chosen day in the user db (`logManualFood`). Both data functions
 * are pure and covered in food-search-select.test.ts / day-log.test.ts; this
 * file only wires them to the screen.
 */
interface Draft {
  title: string
  subtitle: string | null
  selection: ManualFoodSelection
  portions: PortionOption[]
  /** Set when the food is a self-added product: logs as source 'user'. */
  userFood?: UserFood
}

type Tab = 'recent' | 'frequent' | 'user'
const TABS: { key: Tab; label: string }[] = [
  { key: 'recent', label: 'Zuletzt getrackt' },
  { key: 'frequent', label: 'Häufig getrackt' },
  { key: 'user', label: 'Selbst hinzugefügt' },
]

function userFoodPortions(f: UserFood): PortionOption[] {
  return f.servingG != null ? [{ label: '1 portion', grams: f.servingG }] : []
}

function userFoodSelection(f: UserFood, grams: number): ManualFoodSelection {
  return {
    foodId: f.id,
    displayName: f.name,
    grams,
    nutrientSnapshot: {
      kcal: f.per100.kcal,
      protein_g: f.per100.protein_g,
      fat_g: f.per100.fat_g,
      carbs_g: f.per100.carbs_g,
      fiber_g: f.per100.fiber_g,
      sugar_g: f.per100.sugar_g,
      sodium_mg: f.per100.sodium_mg,
    },
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Foods — the library that replaces the incumbent's `Groups` social feed.
 *
 * Right now it is also the honest way to test the whole resolution stack on
 * device WITHOUT an API key: type a food, and the query runs through the real
 * `@nutai/resolver` — FTS5 candidate generation, six-signal scoring, the two-part
 * auto-accept rule — against the real 7,928-row USDA corpus. Everything here is
 * local. No network request is made by this screen, ever.
 */
export default function FoodSearch() {
  const theme = useTheme()
  const insets = useSafeAreaInsets()

  const [db, setDb] = useState<DbAdapter | null>(null)
  const [corpus, setCorpus] = useState<{ foods: number; portions: number; builtAt: string | null } | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ScoredCandidate[]>([])
  const [outcome, setOutcome] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [selectingId, setSelectingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [recent, setRecent] = useState<TrackedFood[]>([])
  const [frequent, setFrequent] = useState<TrackedFood[]>([])
  const [meals, setMeals] = useState<SavedMeal[]>([])
  const [logMeal, setLogMeal] = useState<SavedMeal | null>(null)
  const [mine, setMine] = useState<UserFood[]>([])
  const [mineResults, setMineResults] = useState<UserFood[]>([])

  // Opened from the day list with ?date=YYYY-MM-DD — log into THAT day.
  // ?tab=user opens straight on "Selbst hinzugefügt" (after adding a product).
  const params = useLocalSearchParams<{ date?: string; tab?: string }>()
  const [tab, setTab] = useState<Tab>(params.tab === 'user' ? 'user' : 'recent')

  // Refresh on focus: coming back from the meal builder or the product
  // editor must show the new meal or product.
  useFocusEffect(
    useCallback(() => {
      let alive = true
      void (async () => {
        const [r, f, m, u] = await Promise.all([recentFoods(10), frequentFoods(10), savedMeals(), listUserFoods()])
        if (!alive) return
        setRecent(r)
        setFrequent(f)
        setMeals(m)
        setMine(u)
      })()
      return () => { alive = false }
    }, []),
  )

  // Self-added products are searched alongside the corpus.
  useEffect(() => {
    if (query.trim().length < 2) { setMineResults([]); return }
    let alive = true
    void searchUserFoods(query, 8).then((r) => { if (alive) setMineResults(r) })
    return () => { alive = false }
  }, [query, mine])

  const today = localDate(Date.now())
  const targetDate = typeof params.date === 'string' && ISO_DATE.test(params.date) ? params.date : today
  const defaultSlot = slotFor(Date.now()) as Slot

  useEffect(() => {
    let alive = true
    ;(async () => {
      const handle = await openNutritionDb()
      const info = await nutritionCorpusInfo(handle)
      if (!alive) return
      setDb(handle)
      setCorpus(info)
    })()
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (!db || query.trim().length < 2) { setResults([]); setOutcome(''); return }
    let alive = true
    setBusy(true)
    const timer = setTimeout(async () => {
      const r = await resolveByText(db, {
        canonicalFoodKey: query,
        observedBrand: null,
        prepFacet: null,
        modelCategory: null,
        estimatedGrams: 150,
      })
      if (!alive) return
      if (r.outcome.kind === 'auto_accept') {
        setResults([r.outcome.match])
        setOutcome(`auto-accepted (score ${r.outcome.match.score.toFixed(2)})`)
      } else if (r.outcome.kind === 'disambiguate') {
        setResults(r.outcome.candidates)
        setOutcome(`${r.outcome.candidates.length} candidates — tap the right one`)
      } else {
        setResults([])
        setOutcome('no match — this would log as an AI estimate')
      }
      setBusy(false)
    }, 180)
    return () => { alive = false; clearTimeout(timer) }
  }, [db, query])

  async function handleSelect(candidate: ScoredCandidate) {
    if (!db || selectingId != null) return
    setSelectingId(candidate.foodId)
    setError(null)
    try {
      const [selection, portions] = await Promise.all([
        resolveSelection(db, candidate),
        portionOptions(db, Number(candidate.foodId)),
      ])
      setDraft({ title: candidate.name, subtitle: candidate.brand, selection, portions })
    } catch {
      setError('Could not open that food — try again.')
    } finally {
      setSelectingId(null)
    }
  }

  function handleUserFood(f: UserFood, grams?: number, subtitle?: string) {
    setError(null)
    setDraft({
      title: f.name,
      subtitle: subtitle ?? ['Selbst hinzugefügt', f.brand].filter(Boolean).join(' · '),
      portions: userFoodPortions(f),
      selection: userFoodSelection(f, grams ?? f.servingG ?? 100),
      userFood: f,
    })
  }

  async function handleTracked(f: TrackedFood) {
    setError(null)
    const subtitle = f.count > 1 ? `Logged ${f.count}× · last time ${Math.round(f.lastGrams)} g` : `Last time ${Math.round(f.lastGrams)} g`
    if (f.source === 'user') {
      const uf = await getUserFood(f.foodId)
      if (uf) { handleUserFood(uf, f.lastGrams, subtitle); return }
      // Deleted since: log it once more with the numbers it was logged with.
      handleUserFood(
        { id: f.foodId, name: f.name, brand: null, barcode: null, servingG: null, per100: f.per100, createdAt: 0 },
        f.lastGrams,
        subtitle,
      )
      return
    }
    const portions = db ? await portionOptions(db, f.foodId) : []
    setDraft({
      title: f.name,
      subtitle,
      portions,
      selection: {
        foodId: f.foodId,
        displayName: f.name,
        grams: f.lastGrams,
        nutrientSnapshot: {
          kcal: f.per100.kcal,
          protein_g: f.per100.protein_g,
          fat_g: f.per100.fat_g,
          carbs_g: f.per100.carbs_g,
          fiber_g: f.per100.fiber_g,
          sugar_g: f.per100.sugar_g,
          sodium_mg: f.per100.sodium_mg,
        },
      },
    })
  }

  async function confirmDraft(grams: number, slot: Slot | undefined) {
    if (!draft) return
    try {
      if (draft.userFood) {
        await logUserFood(draft.userFood, grams, { date: targetDate, slot: slot ?? defaultSlot })
      } else {
        const userDb = await userDbHandle()
        await logManualFood(userDb, { ...draft.selection, grams }, Date.now(), {
          date: targetDate,
          slot: slot ?? defaultSlot,
          gramsUserSet: true,
        })
      }
      setDraft(null)
      router.back()
    } catch {
      setError('Could not log that food — try again.')
      setDraft(null)
    }
  }

  const corpusLine = useMemo(() => {
    if (!corpus) return 'Loading corpus…'
    if (corpus.foods === 0) {
      return 'Corpus missing — the app bundled without nutrition.db. Run `npm run data:build`.'
    }
    return `${corpus.foods.toLocaleString()} foods · USDA generic foods + Open Food Facts (Austria, ODbL)`
  }, [corpus])

  return (
    <ScrollView
      style={{ backgroundColor: theme.bg }}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ padding: space.lg, paddingTop: insets.top + space.lg, paddingBottom: 160 }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={[type.title, { color: theme.text }]}>Food Database</Text>
        <Pressable accessibilityRole="button" onPress={() => router.back()} hitSlop={space.md}>
          <Text style={[type.body, { color: theme.textMuted }]}>Done</Text>
        </Pressable>
      </View>
      <Text style={[type.caption, { color: corpus?.foods === 0 ? theme.safety : theme.textMuted, marginTop: space.xs }]}>
        {corpusLine}
      </Text>

      {targetDate !== today ? (
        <Text style={[type.label, { color: theme.protein, marginTop: space.sm }]}>Adding to {targetDate}</Text>
      ) : null}

      <TextInput
        accessibilityLabel="Search foods"
        placeholder="Search — try “Vollmilch” or “Manner”"
        placeholderTextColor={theme.textFaint}
        value={query}
        onChangeText={setQuery}
        autoCorrect={false}
        autoCapitalize="none"
        style={[styles.input, { color: theme.text, borderColor: theme.border, backgroundColor: theme.bgSunken }]}
      />

      {busy && <ActivityIndicator style={{ marginTop: space.lg }} color={theme.textFaint} />}

      {outcome !== '' && (
        <Text style={[type.micro, { color: theme.textFaint, marginTop: space.md }]}>{outcome.toUpperCase()}</Text>
      )}

      {error != null && (
        <Text style={[type.caption, { color: theme.safety, marginTop: space.md }]}>{error}</Text>
      )}

      {mineResults.map((f) => (
        <UserFoodRow key={`u${f.id}`} food={f} onPress={() => handleUserFood(f)} />
      ))}

      {results.map((r) => (
        <Pressable
          key={r.foodId}
          testID={`food-search-row-${r.foodId}`}
          accessibilityRole="button"
          accessibilityLabel={`Log ${r.name}`}
          disabled={selectingId != null}
          onPress={() => handleSelect(r)}
          style={({ pressed }) => [
            styles.row,
            { borderColor: theme.border, minHeight: MIN_TAP_TARGET, opacity: pressed ? 0.6 : 1 },
          ]}
        >
          <View style={{ flex: 1 }}>
            <Text style={[type.body, { color: theme.text }]} numberOfLines={2}>{r.name}</Text>
            <Text style={[type.caption, { color: theme.textMuted, marginTop: 2 }]}>
              {r.energyKcal != null ? `${Math.round(r.energyKcal)} kcal / 100 g` : 'energy not reported'}
              {r.brand ? ` · ${r.brand}` : ''}
            </Text>
          </View>
          {selectingId === r.foodId ? (
            <ActivityIndicator color={theme.textFaint} />
          ) : (
            <Text style={[type.heading, { color: theme.textFaint }]}>+</Text>
          )}
        </Pressable>
      ))}

      {query.trim().length >= 2 && !busy ? (
        <Pressable
          onPress={() => router.push({ pathname: '/product-editor', params: { name: query.trim(), then: 'search' } } as never)}
          accessibilityRole="button"
          style={[styles.addProduct, { borderColor: theme.border }]}
        >
          <Text style={[type.heading, { color: theme.protein }]}>+</Text>
          <View style={{ flex: 1 }}>
            <Text style={[type.bodyStrong, { color: theme.text }]}>
              {results.length === 0 && mineResults.length === 0 ? 'Not found — add it yourself' : 'Not the right one? Add your own product'}
            </Text>
            <Text style={[type.caption, { color: theme.textMuted }]}>Name, barcode and the values from the label</Text>
          </View>
        </Pressable>
      ) : null}

      {query.trim().length < 2 ? (
        <>
          {meals.length > 0 ? (
            <Section title="Saved meals" action={{ label: '+ New', onPress: () => router.push('/meal-builder' as never) }}>
              {meals.slice(0, 5).map((m) => {
                const t = mealTotals(m.items)
                return (
                  <Pressable
                    key={`m${m.id}`}
                    onPress={() => setLogMeal(m)}
                    accessibilityRole="button"
                    accessibilityLabel={`Log ${m.name}`}
                    style={({ pressed }) => [styles.row, { borderColor: theme.border, minHeight: MIN_TAP_TARGET, opacity: pressed ? 0.6 : 1 }]}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={[type.body, { color: theme.text }]} numberOfLines={1}>{m.name}</Text>
                      <Text style={[type.caption, { color: theme.textMuted, marginTop: 2 }]}>
                        {m.items.length} {m.items.length === 1 ? 'item' : 'items'} · {Math.round(t.kcal)} kcal
                      </Text>
                    </View>
                    <Text style={[type.heading, { color: theme.textFaint }]}>+</Text>
                  </Pressable>
                )
              })}
            </Section>
          ) : null}

          {/* Recent | Frequent | Self-added, side by side */}
          <View style={[styles.segment, { backgroundColor: theme.bgSunken, marginTop: space.xl }]}>
            {TABS.map((t) => (
              <Pressable
                key={t.key}
                onPress={() => setTab(t.key)}
                accessibilityRole="tab"
                accessibilityState={{ selected: tab === t.key }}
                style={[styles.segItem, tab === t.key && { backgroundColor: theme.bgElevated }]}
              >
                <Text
                  style={[type.micro, { color: tab === t.key ? theme.text : theme.textMuted, textAlign: 'center' }]}
                  numberOfLines={2}
                >
                  {t.label}
                </Text>
              </Pressable>
            ))}
          </View>

          {tab === 'recent' ? (
            recent.length === 0 ? (
              <Text style={[type.caption, { color: theme.textFaint, marginTop: space.md }]}>
                Foods you log from here show up in this list, with the grams you used last time.
              </Text>
            ) : (
              recent.map((f) => <TrackedRow key={`r${f.source}${f.foodId}`} food={f} onPress={() => void handleTracked(f)} />)
            )
          ) : null}

          {tab === 'frequent' ? (
            frequent.length === 0 ? (
              <Text style={[type.caption, { color: theme.textFaint, marginTop: space.md }]}>
                Anything you log at least twice shows up here, most often first.
              </Text>
            ) : (
              frequent.map((f) => <TrackedRow key={`f${f.source}${f.foodId}`} food={f} showCount onPress={() => void handleTracked(f)} />)
            )
          ) : null}

          {tab === 'user' ? (
            <>
              <Pressable
                onPress={() => router.push({ pathname: '/product-editor', params: { then: 'search' } } as never)}
                accessibilityRole="button"
                style={[styles.addProduct, { borderColor: theme.border }]}
              >
                <Text style={[type.heading, { color: theme.protein }]}>+</Text>
                <View style={{ flex: 1 }}>
                  <Text style={[type.bodyStrong, { color: theme.text }]}>New product</Text>
                  <Text style={[type.caption, { color: theme.textMuted }]}>For anything the database does not know</Text>
                </View>
              </Pressable>
              {mine.length === 0 ? (
                <Text style={[type.caption, { color: theme.textFaint, marginTop: space.md }]}>
                  Products you add yourself appear here. Give one a barcode and scanning it finds it from then on.
                </Text>
              ) : (
                mine.map((f) => <UserFoodRow key={`m${f.id}`} food={f} onPress={() => handleUserFood(f)} />)
              )}
            </>
          ) : null}
        </>
      ) : null}

      <MealLogSheet
        meal={logMeal}
        initialSlot={defaultSlot}
        onEdit={
          logMeal
            ? () => {
                const id = logMeal.id
                setLogMeal(null)
                router.push({ pathname: '/meal-builder', params: { id: String(id) } } as never)
              }
            : undefined
        }
        onLog={async (scale, slot) => {
          if (!logMeal) return
          await logSavedMeal(logMeal.id, { date: targetDate, slot, scale })
          setLogMeal(null)
          router.back()
        }}
        onClose={() => setLogMeal(null)}
      />

      {draft ? (
        <GramEditor
          visible
          title={draft.title}
          subtitle={draft.subtitle}
          per100={{
            kcal: draft.selection.nutrientSnapshot.kcal,
            protein_g: draft.selection.nutrientSnapshot.protein_g,
            carbs_g: draft.selection.nutrientSnapshot.carbs_g,
            fat_g: draft.selection.nutrientSnapshot.fat_g,
          }}
          initialGrams={draft.selection.grams}
          portions={draft.portions}
          initialSlot={defaultSlot}
          confirmLabel="Add to log"
          onConfirm={confirmDraft}
          extraAction={
            draft.userFood && draft.userFood.createdAt > 0
              ? {
                  label: 'Edit product',
                  onPress: () => {
                    const id = draft.userFood!.id
                    setDraft(null)
                    router.push({ pathname: '/product-editor', params: { id: String(id) } } as never)
                  },
                }
              : undefined
          }
          onClose={() => setDraft(null)}
        />
      ) : null}
    </ScrollView>
  )
}

function Section({
  title, action, children,
}: {
  title: string
  action?: { label: string; onPress: () => void }
  children: React.ReactNode
}) {
  const theme = useTheme()
  return (
    <View style={{ marginTop: space.xl }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={[type.label, { color: theme.textMuted }]}>{title}</Text>
        {action ? (
          <Pressable onPress={action.onPress} hitSlop={space.md} accessibilityRole="button">
            <Text style={[type.label, { color: theme.protein }]}>{action.label}</Text>
          </Pressable>
        ) : null}
      </View>
      {children}
    </View>
  )
}

function UserFoodRow({ food, onPress }: { food: UserFood; onPress: () => void }) {
  const theme = useTheme()
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Log ${food.name}`}
      style={({ pressed }) => [styles.row, { borderColor: theme.border, minHeight: MIN_TAP_TARGET, opacity: pressed ? 0.6 : 1 }]}
    >
      <View style={{ flex: 1 }}>
        <Text style={[type.body, { color: theme.text }]} numberOfLines={1}>{food.name}</Text>
        <Text style={[type.caption, { color: theme.textMuted, marginTop: 2 }]} numberOfLines={1}>
          {Math.round(food.per100.kcal)} kcal / 100 g{food.brand ? ` · ${food.brand}` : ''} · Selbst hinzugefügt
        </Text>
      </View>
      <Text style={[type.heading, { color: theme.textFaint }]}>+</Text>
    </Pressable>
  )
}

function TrackedRow({ food, showCount, onPress }: { food: TrackedFood; showCount?: boolean; onPress: () => void }) {
  const theme = useTheme()
  const kcal = (food.per100.kcal * food.lastGrams) / 100
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Log ${food.name}`}
      style={({ pressed }) => [styles.row, { borderColor: theme.border, minHeight: MIN_TAP_TARGET, opacity: pressed ? 0.6 : 1 }]}
    >
      <View style={{ flex: 1 }}>
        <Text style={[type.body, { color: theme.text }]} numberOfLines={1}>{food.name}</Text>
        <Text style={[type.caption, { color: theme.textMuted, marginTop: 2 }]}>
          {Math.round(food.lastGrams)} g · {Math.round(kcal)} kcal{showCount ? ` · ${food.count}×` : ''}
        </Text>
      </View>
      <Text style={[type.heading, { color: theme.textFaint }]}>+</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  segment: { flexDirection: 'row', borderRadius: radius.md, padding: 3, gap: 3 },
  segItem: { flex: 1, minHeight: 40, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  addProduct: {
    flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space.lg,
    padding: space.md, borderRadius: radius.lg, borderWidth: 1, borderStyle: 'dashed',
  },
  input: {
    marginTop: space.lg,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 16,
    minHeight: 48,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
})
