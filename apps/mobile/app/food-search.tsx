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
  logSavedMeal,
  mealTotals,
  recentFoods,
  savedMeals,
  type SavedMeal,
  type TrackedFood,
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

  // Refresh on focus: coming back from the meal builder must show the new meal.
  useFocusEffect(
    useCallback(() => {
      let alive = true
      void (async () => {
        const [r, f, m] = await Promise.all([recentFoods(8), frequentFoods(8), savedMeals()])
        if (!alive) return
        setRecent(r)
        setFrequent(f)
        setMeals(m)
      })()
      return () => { alive = false }
    }, []),
  )

  // Opened from the day list with ?date=YYYY-MM-DD — log into THAT day.
  const params = useLocalSearchParams<{ date?: string }>()
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

  async function handleTracked(f: TrackedFood) {
    setError(null)
    const portions = db ? await portionOptions(db, f.foodId) : []
    setDraft({
      title: f.name,
      subtitle: f.count > 1 ? `Logged ${f.count}× · last time ${Math.round(f.lastGrams)} g` : `Last time ${Math.round(f.lastGrams)} g`,
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
      const userDb = await userDbHandle()
      await logManualFood(userDb, { ...draft.selection, grams }, Date.now(), {
        date: targetDate,
        slot: slot ?? defaultSlot,
        gramsUserSet: true,
      })
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

      {query.trim().length >= 2 && !busy && results.length === 0 && (
        <Text style={[type.caption, { color: theme.textMuted, marginTop: space.lg }]}>
          Nothing matched. That is not a failure — it logs as an AI estimate with an amber badge,
          and you can save it as your own food so it resolves instantly next time.
        </Text>
      )}

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

          <Section title="Zuletzt getrackt">
            {recent.length === 0 ? (
              <Text style={[type.caption, { color: theme.textFaint, marginTop: space.sm }]}>
                Foods you log from here show up in this list, with the grams you used last time.
              </Text>
            ) : (
              recent.map((f) => (
                <TrackedRow key={`r${f.foodId}`} food={f} onPress={() => void handleTracked(f)} />
              ))
            )}
          </Section>

          {frequent.length > 0 ? (
            <Section title="Häufig getrackt">
              {frequent.map((f) => (
                <TrackedRow key={`f${f.foodId}`} food={f} showCount onPress={() => void handleTracked(f)} />
              ))}
            </Section>
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
