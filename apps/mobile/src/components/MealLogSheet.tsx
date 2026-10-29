import { useEffect, useState } from 'react'
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { SLOT_ORDER, type Slot } from '../data/day-log'
import { mealTotals, type SavedMeal } from '../data/saved-meals'
import { useTheme } from '../theme/ThemeProvider'
import { MIN_TAP_TARGET, radius, space, type } from '../theme/tokens'
import { SLOT_LABEL } from './GramEditor'

const SCALES = [0.5, 1, 1.5, 2] as const

interface Props {
  meal: SavedMeal | null
  initialSlot: Slot
  onLog: (scale: number, slot: Slot) => Promise<void> | void
  onEdit?: () => void
  onClose: () => void
}

/** Log a saved meal: pick the meal slot and, if it was a bigger or smaller plate, a portion. */
export function MealLogSheet({ meal, initialSlot, onLog, onEdit, onClose }: Props) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const [scale, setScale] = useState(1)
  const [slot, setSlot] = useState<Slot>(initialSlot)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (meal) {
      setScale(1)
      setSlot(initialSlot)
      setBusy(false)
    }
  }, [meal, initialSlot])

  if (!meal) return null
  const t = mealTotals(meal.items)

  async function log() {
    if (busy) return
    setBusy(true)
    try {
      await onLog(scale, slot)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />
      <View
        style={[
          styles.sheet,
          { backgroundColor: theme.bgElevated, borderColor: theme.border, paddingBottom: Math.max(insets.bottom, space.lg) },
        ]}
      >
        <ScrollView bounces={false}>
          <View style={styles.handle}>
            <View style={[styles.handleBar, { backgroundColor: theme.border }]} />
          </View>
          <View style={styles.spread}>
            <Text style={[type.heading, { color: theme.text, flex: 1 }]} numberOfLines={2}>{meal.name}</Text>
            {onEdit ? (
              <Pressable onPress={onEdit} hitSlop={space.md} accessibilityRole="button">
                <Text style={[type.label, { color: theme.protein }]}>Edit</Text>
              </Pressable>
            ) : null}
          </View>

          <View style={[styles.items, { backgroundColor: theme.bgSunken }]}>
            {meal.items.map((it, i) => (
              <View key={`${it.name}-${i}`} style={styles.itemRow}>
                <Text style={[type.caption, { color: theme.text, flex: 1 }]} numberOfLines={1}>{it.name}</Text>
                <Text style={[type.caption, { color: theme.textMuted }]}>
                  {Math.round(it.grams * scale)} g · {Math.round((it.per100.kcal * it.grams * scale) / 100)} kcal
                </Text>
              </View>
            ))}
          </View>

          <Text style={[type.label, { color: theme.textMuted, marginTop: space.lg }]}>Portion</Text>
          <View style={styles.chips}>
            {SCALES.map((s) => (
              <Pressable
                key={s}
                onPress={() => setScale(s)}
                style={[styles.chip, { borderColor: scale === s ? theme.text : theme.border, backgroundColor: scale === s ? theme.bgSunken : 'transparent' }]}
              >
                <Text style={[type.label, { color: theme.text }]}>{s === 1 ? '1×' : `${String(s).replace('.', ',')}×`}</Text>
              </Pressable>
            ))}
          </View>

          <Text style={[type.label, { color: theme.textMuted, marginTop: space.lg }]}>Meal</Text>
          <View style={styles.chips}>
            {SLOT_ORDER.map((s) => (
              <Pressable
                key={s}
                onPress={() => setSlot(s)}
                style={[styles.chip, { borderColor: slot === s ? theme.text : theme.border, backgroundColor: slot === s ? theme.bgSunken : 'transparent' }]}
              >
                <Text style={[type.label, { color: theme.text }]}>{SLOT_LABEL[s]}</Text>
              </Pressable>
            ))}
          </View>

          <View style={[styles.total, { backgroundColor: theme.bgSunken }]}>
            <Text style={[styles.kcal, { color: theme.text }]}>{Math.round(t.kcal * scale)} kcal</Text>
            <Text style={[type.caption, { color: theme.textMuted }]}>
              P {Math.round(t.protein_g * scale)} g · C {Math.round(t.carbs_g * scale)} g · F {Math.round(t.fat_g * scale)} g
            </Text>
          </View>

          <Pressable onPress={log} disabled={busy} accessibilityRole="button" style={[styles.primary, { backgroundColor: theme.text, opacity: busy ? 0.5 : 1 }]}>
            {busy ? <ActivityIndicator color={theme.bg} /> : <Text style={[type.bodyStrong, { color: theme.bg }]}>Add to log</Text>}
          </Pressable>
          <Pressable onPress={onClose} accessibilityRole="button" style={styles.secondary}>
            <Text style={[type.body, { color: theme.textMuted }]}>Cancel</Text>
          </Pressable>
        </ScrollView>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: {
    borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: space.lg, maxHeight: '85%',
  },
  handle: { alignItems: 'center', paddingVertical: space.sm },
  handleBar: { width: 40, height: 5, borderRadius: 3 },
  spread: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  items: { marginTop: space.md, padding: space.md, borderRadius: radius.lg, gap: space.sm },
  itemRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.sm },
  chip: {
    paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth, minHeight: 36, justifyContent: 'center',
  },
  total: { marginTop: space.lg, padding: space.lg, borderRadius: radius.lg },
  kcal: { fontSize: 24, fontWeight: '800', letterSpacing: -0.6 },
  primary: { marginTop: space.xl, height: 52, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  secondary: { alignItems: 'center', justifyContent: 'center', minHeight: MIN_TAP_TARGET, marginTop: space.sm },
})
