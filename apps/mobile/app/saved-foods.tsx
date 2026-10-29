import { router, useFocusEffect } from 'expo-router'
import { useCallback, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { localDate, logSavedMeal, mealTotals, savedMeals, slotFor, type SavedMeal } from '../src/data/repo'
import type { Slot } from '../src/data/day-log'
import { Icon } from '../src/components/Icon'
import { MealLogSheet } from '../src/components/MealLogSheet'
import { useTheme } from '../src/theme/ThemeProvider'
import { radius, space, type } from '../src/theme/tokens'

/**
 * Saved meals.
 *
 * A saved meal stores the ingredient list itself — name, grams, per-100 g
 * values — not a food name to re-analyze. That is what makes relogging free:
 * zero network requests, zero clarifying questions, and identical numbers to
 * the day it was saved. Build one here, or from any meal in the day list.
 */
export default function SavedFoods() {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const [meals, setMeals] = useState<SavedMeal[]>([])
  const [logging, setLogging] = useState<SavedMeal | null>(null)
  const [done, setDone] = useState<string | null>(null)

  useFocusEffect(
    useCallback(() => {
      let alive = true
      void (async () => {
        const rows = await savedMeals()
        if (alive) setMeals(rows)
      })()
      return () => { alive = false }
    }, []),
  )

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg, paddingTop: insets.top + space.lg }}>
      <View style={styles.head}>
        <Text style={[type.title, { color: theme.text }]}>Saved meals</Text>
        <Pressable onPress={() => router.back()} hitSlop={space.md} accessibilityRole="button">
          <Text style={[type.body, { color: theme.textMuted }]}>Done</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: 140 }}>
        <Pressable
          onPress={() => router.push('/meal-builder' as never)}
          accessibilityRole="button"
          style={[styles.newBtn, { borderColor: theme.border }]}
        >
          <Icon name="plus" size={18} color={theme.text} />
          <Text style={[type.bodyStrong, { color: theme.text }]}>Create a meal</Text>
        </Pressable>

        {done ? (
          <Text style={[type.caption, { color: theme.affirm, marginBottom: space.md }]}>{done}</Text>
        ) : null}

        {meals.length === 0 ? (
          <View style={[styles.empty, { backgroundColor: theme.bgSunken }]}>
            <Text style={[type.bodyStrong, { color: theme.text }]}>No saved meals yet</Text>
            <Text style={[type.caption, { color: theme.textMuted, marginTop: space.xs, lineHeight: 19 }]}>
              Put together your usual breakfast once — oats, milk, banana, each with its grams — and
              log it with one tap from then on. You can also save any meal straight from your day
              list: tap an entry, then “Save meal for later”.
            </Text>
          </View>
        ) : (
          meals.map((m) => {
            const t = mealTotals(m.items)
            return (
              <Pressable
                key={m.id}
                onPress={() => { setDone(null); setLogging(m) }}
                accessibilityRole="button"
                accessibilityLabel={`Log ${m.name}`}
                style={({ pressed }) => [styles.row, { backgroundColor: theme.bgSunken, opacity: pressed ? 0.7 : 1 }]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[type.bodyStrong, { color: theme.text }]} numberOfLines={1}>{m.name}</Text>
                  <Text style={[type.caption, { color: theme.textMuted }]} numberOfLines={1}>
                    {m.items.length} {m.items.length === 1 ? 'item' : 'items'} · {Math.round(t.kcal)} kcal · P {Math.round(t.protein_g)} g
                    {m.useCount > 0 ? ` · logged ${m.useCount}×` : ''}
                  </Text>
                </View>
                <Pressable
                  onPress={() => router.push({ pathname: '/meal-builder', params: { id: String(m.id) } } as never)}
                  hitSlop={space.md}
                  accessibilityRole="button"
                  accessibilityLabel={`Edit ${m.name}`}
                >
                  <Icon name="pencil" size={16} color={theme.textMuted} />
                </Pressable>
                <Text style={[type.label, { color: theme.protein }]}>Log</Text>
              </Pressable>
            )
          })
        )}
      </ScrollView>

      <MealLogSheet
        meal={logging}
        initialSlot={slotFor(Date.now()) as Slot}
        onEdit={
          logging
            ? () => {
                const id = logging.id
                setLogging(null)
                router.push({ pathname: '/meal-builder', params: { id: String(id) } } as never)
              }
            : undefined
        }
        onLog={async (scale, slot) => {
          if (!logging) return
          await logSavedMeal(logging.id, { date: localDate(Date.now()), slot, scale })
          setDone(`${logging.name} added to today.`)
          setLogging(null)
          setMeals(await savedMeals())
        }}
        onClose={() => setLogging(null)}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  head: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: space.lg,
  },
  newBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm,
    height: 52, borderRadius: radius.pill, borderWidth: 1, borderStyle: 'dashed', marginBottom: space.lg,
  },
  empty: { padding: space.lg, borderRadius: radius.xl },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    padding: space.lg, borderRadius: radius.lg, marginBottom: space.sm,
  },
})
