import { useEffect, useState } from 'react'
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { isValidWaterMl } from '../data/water'
import { useTheme } from '../theme/ThemeProvider'
import { MIN_TAP_TARGET, radius, space, type } from '../theme/tokens'
import { Icon } from './Icon'

const QUICK = [
  { ml: 250, label: 'Glass' },
  { ml: 330, label: 'Can' },
  { ml: 500, label: 'Bottle' },
  { ml: 1000, label: '1 litre' },
]

interface Props {
  visible: boolean
  totalMl: number
  goalMl: number
  dayLabel: string
  onAdd: (ml: number) => Promise<void> | void
  onUndo: () => Promise<void> | void
  onClose: () => void
}

/** Log water in one tap; the sheet stays open so a second glass is one more tap. */
export function WaterSheet({ visible, totalMl, goalMl, dayLabel, onAdd, onUndo, onClose }: Props) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const [custom, setCustom] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => { if (visible) setCustom('') }, [visible])

  const customMl = Number(custom.trim().replace(',', '.'))
  const customOk = custom.trim() !== '' && isValidWaterMl(customMl)
  const pct = goalMl > 0 ? Math.min(1, totalMl / goalMl) : 0

  async function run(fn: () => Promise<void> | void) {
    if (busy) return
    setBusy(true)
    try { await fn() } finally { setBusy(false) }
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />
        <View style={[styles.sheet, { backgroundColor: theme.bgElevated, borderColor: theme.border, paddingBottom: Math.max(insets.bottom, space.lg) }]}>
          <View style={styles.handle}><View style={[styles.handleBar, { backgroundColor: theme.border }]} /></View>

          <View style={styles.spread}>
            <View>
              <Text style={[type.caption, { color: theme.textMuted }]}>Water · {dayLabel}</Text>
              <Text style={[styles.big, { color: theme.text }]}>
                {Math.round(totalMl)} <Text style={[type.body, { color: theme.textMuted }]}>/ {goalMl} ml</Text>
              </Text>
            </View>
            <Icon name="water" size={34} color={theme.protein} />
          </View>
          <View style={[styles.track, { backgroundColor: theme.ringTrack }]}>
            <View style={{ width: `${pct * 100}%`, height: 8, borderRadius: 4, backgroundColor: theme.protein }} />
          </View>

          <View style={styles.grid}>
            {QUICK.map((q) => (
              <Pressable
                key={q.ml}
                disabled={busy}
                onPress={() => void run(() => onAdd(q.ml))}
                accessibilityRole="button"
                accessibilityLabel={`Add ${q.ml} millilitres`}
                style={({ pressed }) => [styles.quick, { backgroundColor: theme.bgSunken, opacity: pressed ? 0.6 : 1 }]}
              >
                <Text style={[type.bodyStrong, { color: theme.text }]}>+{q.ml} ml</Text>
                <Text style={[type.caption, { color: theme.textMuted }]}>{q.label}</Text>
              </Pressable>
            ))}
          </View>

          <View style={[styles.customRow]}>
            <View style={[styles.inputWrap, { borderColor: theme.border, backgroundColor: theme.bgSunken }]}>
              <TextInput
                value={custom}
                onChangeText={setCustom}
                placeholder="Other amount"
                placeholderTextColor={theme.textFaint}
                keyboardType="number-pad"
                accessibilityLabel="Other amount in millilitres"
                style={[styles.input, { color: theme.text }]}
                maxLength={4}
              />
              <Text style={[type.body, { color: theme.textMuted }]}>ml</Text>
            </View>
            <Pressable
              disabled={!customOk || busy}
              onPress={() => void run(async () => { await onAdd(customMl); setCustom('') })}
              accessibilityRole="button"
              style={[styles.addBtn, { backgroundColor: theme.text, opacity: customOk && !busy ? 1 : 0.35 }]}
            >
              <Text style={[type.bodyStrong, { color: theme.bg }]}>Add</Text>
            </Pressable>
          </View>

          <View style={[styles.spread, { marginTop: space.lg }]}>
            <Pressable
              disabled={busy || totalMl <= 0}
              onPress={() => void run(onUndo)}
              accessibilityRole="button"
              style={[styles.secondary, { opacity: totalMl > 0 ? 1 : 0.35 }]}
            >
              <Text style={[type.body, { color: theme.textMuted }]}>Undo last</Text>
            </Pressable>
            <Pressable onPress={onClose} accessibilityRole="button" style={styles.secondary}>
              <Text style={[type.bodyStrong, { color: theme.text }]}>Done</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: {
    borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: space.lg,
  },
  handle: { alignItems: 'center', paddingVertical: space.sm },
  handleBar: { width: 40, height: 5, borderRadius: 3 },
  spread: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  big: { fontSize: 30, fontWeight: '800', letterSpacing: -0.8 },
  track: { height: 8, borderRadius: 4, marginTop: space.md, overflow: 'hidden' },
  grid: { flexDirection: 'row', gap: space.sm, marginTop: space.lg },
  quick: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: space.md, borderRadius: radius.lg, minHeight: 64 },
  customRow: { flexDirection: 'row', gap: space.sm, marginTop: space.md, alignItems: 'center' },
  inputWrap: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.sm,
    borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: space.md, minHeight: 48,
  },
  input: { flex: 1, fontSize: 16 },
  addBtn: { height: 48, paddingHorizontal: space.xl, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  secondary: { minHeight: MIN_TAP_TARGET, justifyContent: 'center', paddingHorizontal: space.sm },
})
