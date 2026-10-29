import { router } from 'expo-router'
import { useEffect, useState } from 'react'
import { Linking, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { formatTime, REMINDER_LABEL, type ReminderSettings, type ReminderTime } from '../src/notifications/plan'
import {
  loadReminderSettings,
  permissionState,
  requestPermission,
  saveReminderSettings,
  syncReminders,
  type PermissionState,
} from '../src/notifications/reminders'
import { useTheme } from '../src/theme/ThemeProvider'
import { MIN_TAP_TARGET, radius, space, type } from '../src/theme/tokens'

const STEP = 15

/**
 * Reminder settings. The system permission prompt appears only when the
 * person switches reminders on here — the one moment it is obviously wanted.
 */
export default function Reminders() {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const [s, setS] = useState<ReminderSettings | null>(null)
  const [perm, setPerm] = useState<PermissionState>('undetermined')
  const [scheduled, setScheduled] = useState<number | null>(null)

  useEffect(() => {
    void (async () => {
      const [settings, p] = await Promise.all([loadReminderSettings(), permissionState()])
      setS(settings)
      setPerm(p)
    })()
  }, [])

  async function apply(next: ReminderSettings) {
    setS(next)
    await saveReminderSettings(next)
    setScheduled(await syncReminders())
  }

  async function toggleAll(on: boolean) {
    if (!s) return
    if (on) {
      let p = await permissionState()
      if (p !== 'granted') p = await requestPermission()
      setPerm(p)
      if (p !== 'granted') {
        await apply({ ...s, enabled: false })
        return
      }
    }
    await apply({ ...s, enabled: on })
  }

  function updateTime(slot: ReminderTime['slot'], patch: Partial<ReminderTime>) {
    if (!s) return
    void apply({ ...s, times: s.times.map((t) => (t.slot === slot ? { ...t, ...patch } : t)) })
  }

  if (!s) return <View style={{ flex: 1, backgroundColor: theme.bg }} />

  return (
    <ScrollView
      style={{ backgroundColor: theme.bg }}
      contentContainerStyle={{ padding: space.lg, paddingTop: insets.top + space.lg, paddingBottom: 120 }}
    >
      <View style={styles.spread}>
        <Text style={[type.title, { color: theme.text }]}>Reminders</Text>
        <Pressable onPress={() => router.back()} hitSlop={space.md} accessibilityRole="button">
          <Text style={[type.body, { color: theme.textMuted }]}>Done</Text>
        </Pressable>
      </View>

      <View style={[styles.card, { backgroundColor: theme.bgSunken }]}>
        <View style={styles.spread}>
          <View style={{ flex: 1 }}>
            <Text style={[type.bodyStrong, { color: theme.text }]}>Remind me to track</Text>
            <Text style={[type.caption, { color: theme.textMuted, marginTop: 2, lineHeight: 18 }]}>
              Skipped automatically for any meal you already logged that day.
            </Text>
          </View>
          <Switch value={s.enabled} onValueChange={(v) => void toggleAll(v)} accessibilityLabel="Reminders on" />
        </View>
        {perm === 'denied' ? (
          <Pressable onPress={() => void Linking.openSettings()} style={{ marginTop: space.md }}>
            <Text style={[type.caption, { color: theme.safety }]}>
              Notifications are turned off for Nut AI. <Text style={{ color: theme.protein }}>Open Settings</Text>
            </Text>
          </Pressable>
        ) : null}
        {s.enabled && scheduled != null ? (
          <Text style={[type.caption, { color: theme.textFaint, marginTop: space.sm }]}>
            {scheduled} reminders planned for the next 3 days.
          </Text>
        ) : null}
      </View>

      <View style={[styles.card, { backgroundColor: theme.bgSunken, opacity: s.enabled ? 1 : 0.5 }]}>
        {s.times.map((t, i) => (
          <View
            key={t.slot}
            style={[styles.row, { borderTopColor: theme.border, borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth }]}
          >
            <Switch
              value={t.enabled}
              disabled={!s.enabled}
              onValueChange={(v) => updateTime(t.slot, { enabled: v })}
              accessibilityLabel={`${REMINDER_LABEL[t.slot]} reminder`}
            />
            <Text style={[type.body, { color: theme.text, flex: 1 }]}>{REMINDER_LABEL[t.slot]}</Text>
            <Pressable
              disabled={!s.enabled || !t.enabled}
              onPress={() => updateTime(t.slot, { minutes: (t.minutes - STEP + 1440) % 1440 })}
              style={[styles.step, { borderColor: theme.border }]}
              accessibilityLabel={`${REMINDER_LABEL[t.slot]} 15 minutes earlier`}
            >
              <Text style={[type.bodyStrong, { color: theme.text }]}>−</Text>
            </Pressable>
            <Text style={[type.bodyStrong, { color: theme.text, width: 56, textAlign: 'center' }]}>{formatTime(t.minutes)}</Text>
            <Pressable
              disabled={!s.enabled || !t.enabled}
              onPress={() => updateTime(t.slot, { minutes: (t.minutes + STEP) % 1440 })}
              style={[styles.step, { borderColor: theme.border }]}
              accessibilityLabel={`${REMINDER_LABEL[t.slot]} 15 minutes later`}
            >
              <Text style={[type.bodyStrong, { color: theme.text }]}>+</Text>
            </Pressable>
          </View>
        ))}
      </View>

      <Text style={[type.caption, { color: theme.textFaint, marginTop: space.lg, lineHeight: 18 }]}>
        Reminders are scheduled on this phone only. “Daily check” tells you in the evening how much
        you logged so far, so a forgotten snack still makes it in.
      </Text>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  spread: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md },
  card: { marginTop: space.lg, padding: space.lg, borderRadius: radius.xl },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.md, minHeight: MIN_TAP_TARGET },
  step: {
    width: 36, height: 36, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center', justifyContent: 'center',
  },
})
