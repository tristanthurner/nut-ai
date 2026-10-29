import { useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { isValidGrams, SLOT_ORDER, type Slot } from '../data/day-log'
import type { PortionOption } from '../data/food-search-select'
import { clampFactor, convertGrams, per100Multiplier, type CookPref, type CookState } from '../data/cooking'
import { useTheme } from '../theme/ThemeProvider'
import { MIN_TAP_TARGET, radius, space, type } from '../theme/tokens'

export const SLOT_LABEL: Record<Slot, string> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
  snack: 'Snack',
}

export interface Per100 {
  kcal: number
  protein_g: number
  carbs_g: number
  fat_g: number
}

interface Props {
  visible: boolean
  title: string
  subtitle?: string | null
  per100: Per100
  initialGrams: number
  portions?: readonly PortionOption[]
  /** Shown when set; hidden when undefined (editing a single item of a scanned meal). */
  initialSlot?: Slot
  confirmLabel: string
  /** The meal's portion_eaten_fraction, so the preview matches the day list exactly. */
  eatenFraction?: number
  /** `cook` is set when the raw/cooked switch was shown: how the grams were weighed. */
  onConfirm: (grams: number, slot: Slot | undefined, cook?: CookPref) => Promise<void> | void
  onDelete?: () => Promise<void> | void
  /** An optional secondary action under the main button, e.g. "Save meal as favourite". */
  extraAction?: { label: string; onPress: () => void }
  /**
   * Pasta, rice & co.: offer "Gewogen: roh | gekocht". `basis` is the state
   * the per100 values refer to; `weighed`/`factor` the starting position.
   */
  cook?: { basis: CookState; weighed: CookState; factor: number }
  onClose: () => void
}

/** "1,5" from a German keyboard is 1.5, not NaN. */
export function parseGrams(text: string): number {
  const t = text.trim().replace(',', '.')
  if (t === '') return Number.NaN
  return Number(t)
}

function fmt(n: number, digits = 0): string {
  const f = 10 ** digits
  return String(Math.round(n * f) / f)
}

/**
 * The one place grams are chosen: when adding from the Food Database and when
 * correcting an entry in the day list. Type any amount, or tap a recorded
 * portion; the numbers underneath follow live, so the choice is never blind.
 */
export function GramEditor({
  visible, title, subtitle, per100, initialGrams, portions = [], initialSlot,
  confirmLabel, eatenFraction = 1, onConfirm, onDelete, extraAction, cook, onClose,
}: Props) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const [text, setText] = useState(fmt(initialGrams, 1))
  const [slot, setSlot] = useState<Slot | undefined>(initialSlot)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [weighed, setWeighed] = useState<CookState>(cook?.weighed ?? 'raw')
  const [factor, setFactor] = useState(clampFactor(cook?.factor ?? 2.5))

  // Re-seed whenever the sheet opens for a different food or entry.
  useEffect(() => {
    if (visible) {
      setText(fmt(initialGrams, 1))
      setSlot(initialSlot)
      setBusy(false)
      setConfirmDelete(false)
      setWeighed(cook?.weighed ?? 'raw')
      setFactor(clampFactor(cook?.factor ?? 2.5))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, initialGrams, initialSlot, title])

  // The values for what is on the scale: dry pasta's per-100 g turned into
  // cooked pasta's when it is weighed cooked, and the other way round.
  const m = cook ? per100Multiplier(cook.basis, weighed, factor) : 1
  const eff = { kcal: per100.kcal * m, protein_g: per100.protein_g * m, carbs_g: per100.carbs_g * m, fat_g: per100.fat_g * m }

  function switchWeighed(next: CookState) {
    if (next === weighed) return
    const g = parseGrams(text)
    // Same food, other state: 100 g dry becomes ~240 g cooked, same kcal.
    if (isValidGrams(g)) setText(fmt(convertGrams(g, weighed, next, factor), 0))
    setWeighed(next)
  }

  function nudgeFactor(delta: number) {
    setFactor((f) => clampFactor(f + delta))
  }

  const grams = parseGrams(text)
  const valid = isValidGrams(grams)
  const k = valid ? (grams / 100) * eatenFraction : 0

  const chips = useMemo(() => {
    // Recorded portions are in the product's own state (a serving of DRY pasta).
    const all = portions.map((p) =>
      cook && cook.basis !== weighed
        ? { ...p, grams: Math.round(convertGrams(p.grams, cook.basis, weighed, factor)) }
        : p,
    )
    if (!all.some((p) => p.grams === 100)) all.push({ label: '100 g', grams: 100 })
    return all
  }, [portions, cook, weighed, factor])

  function nudge(delta: number) {
    const base = valid ? grams : 0
    const next = Math.max(1, Math.round(base + delta))
    setText(String(next))
  }

  async function confirm() {
    if (!valid || busy) return
    setBusy(true)
    try {
      await onConfirm(Math.round(grams * 10) / 10, slot, cook ? { weighed, factor } : undefined)
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!onDelete || busy) return
    if (!confirmDelete) { setConfirmDelete(true); return }
    setBusy(true)
    try {
      await onDelete()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />
        <View
          style={[
            styles.sheet,
            { backgroundColor: theme.bgElevated, borderColor: theme.border, paddingBottom: Math.max(insets.bottom, space.lg) },
          ]}
        >
          <ScrollView keyboardShouldPersistTaps="handled" bounces={false}>
            <View style={styles.handle}>
              <View style={[styles.handleBar, { backgroundColor: theme.border }]} />
            </View>

            <Text style={[type.heading, { color: theme.text }]} numberOfLines={2}>{title}</Text>
            {subtitle ? (
              <Text style={[type.caption, { color: theme.textMuted, marginTop: 2 }]} numberOfLines={1}>{subtitle}</Text>
            ) : null}
            <Text style={[type.caption, { color: theme.textFaint, marginTop: space.xs }]}>
              {fmt(eff.kcal)} kcal per 100 g{cook ? (weighed === 'cooked' ? ' gekocht' : ' roh') : ''}
            </Text>

            {cook ? (
              <View style={[styles.cookBox, { backgroundColor: theme.bgSunken }]}>
                <View style={styles.cookRow}>
                  <Text style={[type.label, { color: theme.textMuted }]}>Gewogen</Text>
                  <View style={[styles.segment, { borderColor: theme.border }]}>
                    {(['raw', 'cooked'] as const).map((s) => (
                      <Pressable
                        key={s}
                        onPress={() => switchWeighed(s)}
                        accessibilityRole="button"
                        accessibilityState={{ selected: weighed === s }}
                        style={[styles.segBtn, weighed === s && { backgroundColor: theme.text }]}
                      >
                        <Text style={[type.label, { color: weighed === s ? theme.bg : theme.text }]}>
                          {s === 'raw' ? 'Roh' : 'Gekocht'}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
                <View style={[styles.cookRow, { marginTop: space.sm }]}>
                  <Text style={[type.caption, { color: theme.textMuted, flex: 1 }]}>
                    100 g roh ≈ {fmt(100 * factor)} g gekocht
                  </Text>
                  <Pressable onPress={() => nudgeFactor(-0.1)} accessibilityLabel="Faktor kleiner" style={[styles.miniBtn, { borderColor: theme.border }]}>
                    <Text style={[type.bodyStrong, { color: theme.text }]}>−</Text>
                  </Pressable>
                  <Text style={[type.bodyStrong, { color: theme.text, minWidth: 40, textAlign: 'center' }]}>
                    ×{fmt(factor, 1).replace('.', ',')}
                  </Text>
                  <Pressable onPress={() => nudgeFactor(0.1)} accessibilityLabel="Faktor größer" style={[styles.miniBtn, { borderColor: theme.border }]}>
                    <Text style={[type.bodyStrong, { color: theme.text }]}>+</Text>
                  </Pressable>
                </View>
                {cook.basis !== weighed ? (
                  <Text style={[type.micro, { color: theme.textFaint, marginTop: space.xs }]}>
                    Die Nährwerte des Produkts gelten {cook.basis === 'raw' ? 'roh' : 'gekocht'} — umgerechnet mit diesem Faktor.
                  </Text>
                ) : null}
              </View>
            ) : null}

            {/* Amount */}
            <View style={styles.amountRow}>
              <Pressable
                onPress={() => nudge(-10)}
                accessibilityLabel="10 grams less"
                style={[styles.stepBtn, { borderColor: theme.border }]}
              >
                <Text style={[type.heading, { color: theme.text }]}>−</Text>
              </Pressable>
              <View style={[styles.inputWrap, { borderColor: valid ? theme.border : theme.safety, backgroundColor: theme.bgSunken }]}>
                <TextInput
                  value={text}
                  onChangeText={setText}
                  keyboardType="decimal-pad"
                  selectTextOnFocus
                  accessibilityLabel="Grams"
                  style={[styles.input, { color: theme.text }]}
                  maxLength={6}
                />
                <Text style={[type.bodyStrong, { color: theme.textMuted }]}>g</Text>
              </View>
              <Pressable
                onPress={() => nudge(10)}
                accessibilityLabel="10 grams more"
                style={[styles.stepBtn, { borderColor: theme.border }]}
              >
                <Text style={[type.heading, { color: theme.text }]}>+</Text>
              </Pressable>
            </View>

            {/* Quick portions */}
            <View style={styles.chips}>
              {chips.map((p) => {
                const on = valid && Math.abs(grams - p.grams) < 0.05
                return (
                  <Pressable
                    key={`${p.label}-${p.grams}`}
                    onPress={() => setText(fmt(p.grams, 1))}
                    style={[
                      styles.chip,
                      { borderColor: on ? theme.text : theme.border, backgroundColor: on ? theme.bgSunken : 'transparent' },
                    ]}
                  >
                    <Text style={[type.label, { color: theme.text }]} numberOfLines={1}>
                      {p.label}{p.label.endsWith(' g') ? '' : ` · ${fmt(p.grams)} g`}
                    </Text>
                  </Pressable>
                )
              })}
            </View>

            {/* Live numbers */}
            <View style={[styles.preview, { backgroundColor: theme.bgSunken }]}>
              <View>
                <Text style={[styles.kcal, { color: theme.text }]}>{valid ? fmt(eff.kcal * k) : '–'}</Text>
                <Text style={[type.caption, { color: theme.textMuted }]}>kcal</Text>
              </View>
              <Macro label="Protein" value={eff.protein_g * k} color={theme.protein} show={valid} />
              <Macro label="Carbs" value={eff.carbs_g * k} color={theme.carbs} show={valid} />
              <Macro label="Fat" value={eff.fat_g * k} color={theme.fat} show={valid} />
            </View>
            {eatenFraction !== 1 ? (
              <Text style={[type.micro, { color: theme.textFaint, marginTop: space.xs }]}>
                Includes the {Math.round(eatenFraction * 100)}% of the plate you said you ate.
              </Text>
            ) : null}

            {/* Meal slot */}
            {slot !== undefined ? (
              <>
                <Text style={[type.label, { color: theme.textMuted, marginTop: space.lg }]}>Meal</Text>
                <View style={styles.chips}>
                  {SLOT_ORDER.map((s) => (
                    <Pressable
                      key={s}
                      onPress={() => setSlot(s)}
                      style={[
                        styles.chip,
                        { borderColor: slot === s ? theme.text : theme.border, backgroundColor: slot === s ? theme.bgSunken : 'transparent' },
                      ]}
                    >
                      <Text style={[type.label, { color: theme.text }]}>{SLOT_LABEL[s]}</Text>
                    </Pressable>
                  ))}
                </View>
              </>
            ) : null}

            <Pressable
              onPress={confirm}
              disabled={!valid || busy}
              accessibilityRole="button"
              style={[styles.primary, { backgroundColor: theme.text, opacity: !valid || busy ? 0.4 : 1 }]}
            >
              {busy ? (
                <ActivityIndicator color={theme.bg} />
              ) : (
                <Text style={[type.bodyStrong, { color: theme.bg }]}>{confirmLabel}</Text>
              )}
            </Pressable>

            {extraAction ? (
              <Pressable onPress={extraAction.onPress} disabled={busy} accessibilityRole="button" style={styles.secondary}>
                <Text style={[type.bodyStrong, { color: theme.protein }]}>{extraAction.label}</Text>
              </Pressable>
            ) : null}

            {onDelete ? (
              <Pressable onPress={remove} disabled={busy} accessibilityRole="button" style={styles.secondary}>
                <Text style={[type.bodyStrong, { color: theme.safety }]}>
                  {confirmDelete ? 'Tap again to remove' : 'Remove entry'}
                </Text>
              </Pressable>
            ) : (
              <Pressable onPress={onClose} accessibilityRole="button" style={styles.secondary}>
                <Text style={[type.body, { color: theme.textMuted }]}>Cancel</Text>
              </Pressable>
            )}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}

function Macro({ label, value, color, show }: { label: string; value: number; color: string; show: boolean }) {
  const theme = useTheme()
  return (
    <View style={{ alignItems: 'flex-start' }}>
      <Text style={[type.bodyStrong, { color: theme.text }]}>{show ? `${fmt(value, 1)} g` : '–'}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
        <Text style={[type.caption, { color: theme.textMuted }]}>{label}</Text>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: {
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.lg,
    maxHeight: '88%',
  },
  handle: { alignItems: 'center', paddingVertical: space.sm },
  handleBar: { width: 40, height: 5, borderRadius: 3 },
  amountRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space.lg },
  stepBtn: {
    width: MIN_TAP_TARGET + 8, height: MIN_TAP_TARGET + 8, borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center',
  },
  inputWrap: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    borderRadius: radius.md, borderWidth: 1, paddingHorizontal: space.lg, height: MIN_TAP_TARGET + 12,
  },
  input: { fontSize: 28, fontWeight: '700', minWidth: 60, textAlign: 'right', marginRight: space.xs },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.md },
  chip: {
    paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth, minHeight: 36, justifyContent: 'center', maxWidth: '100%',
  },
  preview: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    padding: space.lg, borderRadius: radius.lg, marginTop: space.lg,
  },
  cookBox: { borderRadius: radius.lg, padding: space.md, marginTop: space.md },
  cookRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm },
  segment: { flexDirection: 'row', borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.pill, padding: 2 },
  segBtn: { paddingHorizontal: space.lg, minHeight: 34, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  miniBtn: {
    width: 34, height: 34, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center', justifyContent: 'center',
  },
  kcal: { fontSize: 28, fontWeight: '800', letterSpacing: -0.8 },
  primary: {
    marginTop: space.xl, height: 52, borderRadius: radius.pill,
    alignItems: 'center', justifyContent: 'center',
  },
  secondary: { alignItems: 'center', justifyContent: 'center', minHeight: MIN_TAP_TARGET, marginTop: space.sm },
})
