import { router, useLocalSearchParams } from 'expo-router'
import { useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { DbAdapter } from '@nutai/db-adapter'
import { resolveByText, type ScoredCandidate } from '@nutai/resolver'
import { openNutritionDb } from '../src/db/expo-adapter'
import { portionOptions, resolveSelection, type PortionOption } from '../src/data/food-search-select'
import {
  createSavedMeal,
  deleteSavedMeal,
  mealTotals,
  recentFoods,
  savedItemsFromLoggedMeal,
  savedMeal,
  searchUserFoods,
  updateSavedMeal,
  type SavedMealItem,
  type TrackedFood,
  type UserFood,
} from '../src/data/repo'
import { GramEditor } from '../src/components/GramEditor'
import { Icon } from '../src/components/Icon'
import { useTheme } from '../src/theme/ThemeProvider'
import { MIN_TAP_TARGET, radius, space, type } from '../src/theme/tokens'

/**
 * Build or edit a saved meal: a name and a list of ingredients with grams.
 *
 *   /meal-builder              → new, empty
 *   /meal-builder?id=12        → edit saved meal 12
 *   /meal-builder?fromMeal=34  → new, pre-filled from a meal already in the log
 */
interface Pending {
  /** Index into items when editing an existing ingredient; null when adding. */
  index: number | null
  item: SavedMealItem
  portions: PortionOption[]
  brand?: string | null
}

export default function MealBuilder() {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const params = useLocalSearchParams<{ id?: string; fromMeal?: string }>()
  const editId = params.id ? Number(params.id) : null

  const [name, setName] = useState('')
  const [items, setItems] = useState<SavedMealItem[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [nutritionDb, setNutritionDb] = useState<DbAdapter | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ScoredCandidate[]>([])
  const [mineResults, setMineResults] = useState<UserFood[]>([])
  const [recent, setRecent] = useState<TrackedFood[]>([])
  const [searching, setSearching] = useState(false)
  const [pending, setPending] = useState<Pending | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      const [ndb, rec] = await Promise.all([openNutritionDb(), recentFoods(6)])
      let n = ''
      let its: SavedMealItem[] = []
      if (editId != null && Number.isFinite(editId)) {
        const m = await savedMeal(editId)
        if (m) { n = m.name; its = m.items }
      } else if (params.fromMeal) {
        its = await savedItemsFromLoggedMeal(Number(params.fromMeal))
      }
      if (!alive) return
      setNutritionDb(ndb)
      setRecent(rec)
      setName(n)
      setItems(its)
      setLoading(false)
    })()
    return () => { alive = false }
  }, [editId, params.fromMeal])

  useEffect(() => {
    if (!nutritionDb || query.trim().length < 2) { setResults([]); return }
    let alive = true
    setSearching(true)
    const timer = setTimeout(async () => {
      const r = await resolveByText(nutritionDb, {
        canonicalFoodKey: query, observedBrand: null, prepFacet: null, modelCategory: null, estimatedGrams: 150,
      })
      if (!alive) return
      setResults(r.outcome.kind === 'auto_accept' ? [r.outcome.match] : r.outcome.kind === 'disambiguate' ? r.outcome.candidates : [])
      setSearching(false)
    }, 180)
    return () => { alive = false; clearTimeout(timer) }
  }, [nutritionDb, query])

  useEffect(() => {
    if (query.trim().length < 2) { setMineResults([]); return }
    let alive = true
    void searchUserFoods(query, 6).then((r) => { if (alive) setMineResults(r) })
    return () => { alive = false }
  }, [query])

  const totals = useMemo(() => mealTotals(items), [items])

  function pickUserFood(f: UserFood) {
    setPending({
      index: null,
      brand: f.brand,
      portions: f.servingG != null ? [{ label: '1 portion', grams: f.servingG }] : [],
      item: { foodId: f.id, source: 'user', name: f.name, grams: f.servingG ?? 100, per100: f.per100 },
    })
  }

  async function pickCandidate(c: ScoredCandidate) {
    if (!nutritionDb) return
    const [sel, portions] = await Promise.all([resolveSelection(nutritionDb, c), portionOptions(nutritionDb, Number(c.foodId))])
    const n = sel.nutrientSnapshot
    setPending({
      index: null,
      brand: c.brand,
      portions,
      item: {
        foodId: sel.foodId,
        name: c.name,
        grams: sel.grams,
        per100: {
          kcal: n.kcal, protein_g: n.protein_g, fat_g: n.fat_g, carbs_g: n.carbs_g,
          fiber_g: n.fiber_g ?? null, sugar_g: n.sugar_g ?? null, sodium_mg: n.sodium_mg ?? null,
        },
      },
    })
  }

  async function pickRecent(f: TrackedFood) {
    const portions = nutritionDb && f.source === 'corpus' ? await portionOptions(nutritionDb, f.foodId) : []
    setPending({
      index: null,
      portions,
      item: { foodId: f.foodId, ...(f.source === 'user' ? { source: 'user' as const } : {}), name: f.name, grams: f.lastGrams, per100: f.per100 },
    })
  }

  async function editItem(index: number) {
    const it = items[index]
    if (!it) return
    const portions = nutritionDb && it.foodId != null && it.source !== 'user' ? await portionOptions(nutritionDb, it.foodId) : []
    setPending({ index, item: it, portions })
  }

  function commitPending(grams: number) {
    if (!pending) return
    const next = { ...pending.item, grams }
    setItems((prev) => {
      if (pending.index == null) return [...prev, next]
      return prev.map((x, i) => (i === pending.index ? next : x))
    })
    setPending(null)
    setQuery('')
  }

  function removePending() {
    if (!pending || pending.index == null) return
    const idx = pending.index
    setItems((prev) => prev.filter((_, i) => i !== idx))
    setPending(null)
  }

  async function save() {
    if (saving) return
    if (name.trim().length === 0) { setError('Give the meal a name.'); return }
    if (items.length === 0) { setError('Add at least one ingredient.'); return }
    setSaving(true)
    setError(null)
    try {
      if (editId != null) await updateSavedMeal(editId, name, items)
      else await createSavedMeal(name, items)
      router.back()
    } catch {
      setError('Could not save the meal — try again.')
      setSaving(false)
    }
  }

  function confirmDelete() {
    if (editId == null) return
    Alert.alert('Delete this meal?', 'Meals you already logged with it stay in your log.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => { void deleteSavedMeal(editId).then(() => router.back()) },
      },
    ])
  }

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: theme.bg }]}>
        <ActivityIndicator color={theme.textFaint} />
      </View>
    )
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: space.lg, paddingTop: insets.top + space.lg, paddingBottom: 140 }}
      >
        <View style={styles.spread}>
          <Text style={[type.title, { color: theme.text }]}>{editId != null ? 'Edit meal' : 'New meal'}</Text>
          <Pressable onPress={() => router.back()} hitSlop={space.md} accessibilityRole="button">
            <Text style={[type.body, { color: theme.textMuted }]}>Cancel</Text>
          </Pressable>
        </View>

        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Name, e.g. “Porridge with banana”"
          placeholderTextColor={theme.textFaint}
          accessibilityLabel="Meal name"
          maxLength={80}
          style={[styles.input, { color: theme.text, borderColor: theme.border, backgroundColor: theme.bgSunken, fontWeight: '600' }]}
        />

        {/* Ingredients */}
        <Text style={[type.label, { color: theme.textMuted, marginTop: space.xl }]}>Ingredients</Text>
        {items.length === 0 ? (
          <Text style={[type.caption, { color: theme.textFaint, marginTop: space.sm }]}>
            Nothing yet — search below and tap a food to add it with its grams.
          </Text>
        ) : (
          <View style={[styles.card, { backgroundColor: theme.bgElevated, borderColor: theme.border }]}>
            {items.map((it, i) => (
              <Pressable
                key={`${it.name}-${i}`}
                onPress={() => void editItem(i)}
                accessibilityRole="button"
                accessibilityLabel={`Edit ${it.name}`}
                style={[styles.row, { borderTopColor: theme.border, borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth }]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[type.body, { color: theme.text }]} numberOfLines={1}>{it.name}</Text>
                  <Text style={[type.caption, { color: theme.textMuted }]}>{Math.round(it.grams * 10) / 10} g</Text>
                </View>
                <Text style={[type.bodyStrong, { color: theme.text }]}>{Math.round((it.per100.kcal * it.grams) / 100)} kcal</Text>
                <Icon name="pencil" size={14} color={theme.textFaint} />
              </Pressable>
            ))}
            <View style={[styles.totalRow, { borderTopColor: theme.border }]}>
              <Text style={[type.bodyStrong, { color: theme.text }]}>Total</Text>
              <Text style={[type.bodyStrong, { color: theme.text }]}>
                {Math.round(totals.kcal)} kcal · P {Math.round(totals.protein_g)} · C {Math.round(totals.carbs_g)} · F {Math.round(totals.fat_g)}
              </Text>
            </View>
          </View>
        )}

        {/* Add ingredient */}
        <Text style={[type.label, { color: theme.textMuted, marginTop: space.xl }]}>Add ingredient</Text>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search foods"
          placeholderTextColor={theme.textFaint}
          autoCorrect={false}
          autoCapitalize="none"
          accessibilityLabel="Search foods to add"
          style={[styles.input, { color: theme.text, borderColor: theme.border, backgroundColor: theme.bgSunken }]}
        />
        {searching ? <ActivityIndicator style={{ marginTop: space.md }} color={theme.textFaint} /> : null}

        {query.trim().length >= 2
          ? mineResults.map((f) => (
              <Pressable
                key={`u${f.id}`}
                onPress={() => pickUserFood(f)}
                accessibilityRole="button"
                style={[styles.result, { borderBottomColor: theme.border }]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[type.body, { color: theme.text }]} numberOfLines={1}>{f.name}</Text>
                  <Text style={[type.caption, { color: theme.textMuted }]}>
                    {Math.round(f.per100.kcal)} kcal / 100 g · Selbst hinzugefügt
                  </Text>
                </View>
                <Text style={[type.heading, { color: theme.textFaint }]}>+</Text>
              </Pressable>
            ))
          : null}
        {query.trim().length >= 2
          ? results.map((r) => (
              <Pressable
                key={r.foodId}
                onPress={() => void pickCandidate(r)}
                accessibilityRole="button"
                style={[styles.result, { borderBottomColor: theme.border }]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[type.body, { color: theme.text }]} numberOfLines={2}>{r.name}</Text>
                  <Text style={[type.caption, { color: theme.textMuted }]}>
                    {r.energyKcal != null ? `${Math.round(r.energyKcal)} kcal / 100 g` : ''}{r.brand ? ` · ${r.brand}` : ''}
                  </Text>
                </View>
                <Text style={[type.heading, { color: theme.textFaint }]}>+</Text>
              </Pressable>
            ))
          : recent.map((f) => (
              <Pressable
                key={`r${f.source}${f.foodId}`}
                onPress={() => void pickRecent(f)}
                accessibilityRole="button"
                style={[styles.result, { borderBottomColor: theme.border }]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[type.body, { color: theme.text }]} numberOfLines={1}>{f.name}</Text>
                  <Text style={[type.caption, { color: theme.textMuted }]}>Last time: {Math.round(f.lastGrams)} g</Text>
                </View>
                <Text style={[type.heading, { color: theme.textFaint }]}>+</Text>
              </Pressable>
            ))}

        {editId != null ? (
          <Pressable onPress={confirmDelete} accessibilityRole="button" style={[styles.secondary, { marginTop: space.xl }]}>
            <Text style={[type.bodyStrong, { color: theme.safety }]}>Delete meal</Text>
          </Pressable>
        ) : null}
      </ScrollView>

      {/* Save bar */}
      <View style={[styles.saveBar, { backgroundColor: theme.bg, borderTopColor: theme.border, paddingBottom: Math.max(insets.bottom, space.lg) }]}>
        {error ? <Text style={[type.caption, { color: theme.safety, marginBottom: space.sm }]}>{error}</Text> : null}
        <Pressable
          onPress={save}
          disabled={saving}
          accessibilityRole="button"
          style={[styles.primary, { backgroundColor: theme.text, opacity: saving ? 0.5 : 1 }]}
        >
          {saving ? <ActivityIndicator color={theme.bg} /> : <Text style={[type.bodyStrong, { color: theme.bg }]}>Save meal</Text>}
        </Pressable>
      </View>

      {pending ? (
        <GramEditor
          visible
          title={pending.item.name}
          subtitle={pending.brand ?? null}
          per100={pending.item.per100}
          initialGrams={pending.item.grams}
          portions={pending.portions}
          confirmLabel={pending.index == null ? 'Add to meal' : 'Save'}
          onConfirm={(g) => commitPending(g)}
          onDelete={pending.index != null ? removePending : undefined}
          onClose={() => setPending(null)}
        />
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  spread: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  input: {
    marginTop: space.md, paddingHorizontal: space.lg, paddingVertical: space.md,
    borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, fontSize: 16, minHeight: 48,
  },
  card: { marginTop: space.sm, borderRadius: radius.xl, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: space.lg },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.md, minHeight: MIN_TAP_TARGET },
  totalRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: space.sm,
    paddingVertical: space.md, borderTopWidth: StyleSheet.hairlineWidth, flexWrap: 'wrap',
  },
  result: {
    flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth, minHeight: MIN_TAP_TARGET,
  },
  saveBar: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: space.lg, paddingTop: space.md, borderTopWidth: StyleSheet.hairlineWidth },
  primary: { height: 52, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  secondary: { alignItems: 'center', justifyContent: 'center', minHeight: MIN_TAP_TARGET },
})
