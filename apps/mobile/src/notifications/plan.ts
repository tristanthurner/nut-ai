/**
 * Reminder planning — pure, no React Native, tested under Node.
 *
 * Local reminders only. There is no server, so instead of one repeating
 * notification that fires whether or not you already logged, the app plans
 * the next few days of one-off reminders every time it opens or a meal is
 * logged, and leaves out any of TODAY's reminders whose meal is already in
 * the log. Logging breakfast at 8:40 means no 9:00 "log your breakfast".
 */

export type ReminderSlot = 'breakfast' | 'lunch' | 'dinner' | 'evening'

export interface ReminderTime {
  slot: ReminderSlot
  enabled: boolean
  /** Minutes after local midnight. */
  minutes: number
}

export interface ReminderSettings {
  enabled: boolean
  times: ReminderTime[]
}

export interface PlannedReminder {
  /** Stable per day and slot, so a re-plan replaces rather than duplicates. */
  id: string
  at: number
  slot: ReminderSlot
  title: string
  body: string
}

export const DEFAULT_REMINDERS: ReminderSettings = {
  enabled: false,
  times: [
    { slot: 'breakfast', enabled: true, minutes: 9 * 60 },
    { slot: 'lunch', enabled: true, minutes: 13 * 60 },
    { slot: 'dinner', enabled: true, minutes: 19 * 60 + 30 },
    { slot: 'evening', enabled: false, minutes: 21 * 60 + 30 },
  ],
}

export const REMINDER_ID_PREFIX = 'nutai-reminder-'

export const REMINDER_LABEL: Record<ReminderSlot, string> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
  evening: 'Daily check',
}

export function parseReminderSettings(json: string | null | undefined): ReminderSettings {
  if (!json) return DEFAULT_REMINDERS
  try {
    const raw = JSON.parse(json) as Partial<ReminderSettings>
    const times = DEFAULT_REMINDERS.times.map((d) => {
      const t = Array.isArray(raw.times) ? raw.times.find((x) => x && x.slot === d.slot) : undefined
      const minutes = typeof t?.minutes === 'number' && t.minutes >= 0 && t.minutes < 24 * 60 ? Math.round(t.minutes) : d.minutes
      return { slot: d.slot, enabled: typeof t?.enabled === 'boolean' ? t.enabled : d.enabled, minutes }
    })
    return { enabled: raw.enabled === true, times }
  } catch {
    return DEFAULT_REMINDERS
  }
}

export function formatTime(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

function copyFor(slot: ReminderSlot, todayKcal: number | null): { title: string; body: string } {
  switch (slot) {
    case 'breakfast':
      return { title: 'Breakfast logged?', body: 'Add it now while you still remember the grams.' }
    case 'lunch':
      return { title: 'Lunch logged?', body: 'A quick entry keeps your day accurate.' }
    case 'dinner':
      return { title: 'Dinner logged?', body: 'Log it now and see where your day ended up.' }
    case 'evening':
      return {
        title: 'Anything missing today?',
        body: todayKcal != null && todayKcal > 0
          ? `${Math.round(todayKcal)} kcal logged so far — add snacks and drinks before the day closes.`
          : 'Nothing logged yet today — even a rough entry beats none.',
      }
  }
}

/**
 * The reminders to schedule from `now` for `days` days (today included).
 *
 * `loggedToday` holds today's meal slots that already have entries
 * (breakfast | lunch | dinner | snack). The evening check is skipped only
 * when all three main meals are in.
 */
export function planReminders(
  now: number,
  settings: ReminderSettings,
  loggedToday: ReadonlySet<string>,
  opts: { days?: number; todayKcal?: number | null } = {},
): PlannedReminder[] {
  if (!settings.enabled) return []
  const days = opts.days ?? 3
  const out: PlannedReminder[] = []
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)

  for (let d = 0; d < days; d++) {
    const day = new Date(start)
    day.setDate(start.getDate() + d)
    for (const t of settings.times) {
      if (!t.enabled) continue
      const at = new Date(day)
      at.setHours(Math.floor(t.minutes / 60), t.minutes % 60, 0, 0)
      if (at.getTime() <= now + 30_000) continue
      if (d === 0) {
        if (t.slot !== 'evening' && loggedToday.has(t.slot)) continue
        if (t.slot === 'evening' && ['breakfast', 'lunch', 'dinner'].every((s) => loggedToday.has(s))) continue
      }
      const copy = copyFor(t.slot, d === 0 ? (opts.todayKcal ?? null) : null)
      out.push({ id: `${REMINDER_ID_PREFIX}${dayKey(day)}-${t.slot}`, at: at.getTime(), slot: t.slot, ...copy })
    }
  }
  return out.sort((a, b) => a.at - b.at)
}
