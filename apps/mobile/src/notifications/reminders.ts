import * as Notifications from 'expo-notifications'
import { localDate } from '../data/date-utils'
import { dayItems, dayNutrients, putSetting, setting } from '../data/repo'
import {
  parseReminderSettings,
  planReminders,
  REMINDER_ID_PREFIX,
  type ReminderSettings,
} from './plan'

/**
 * Local tracking reminders.
 *
 * Every reminder is a one-off LOCAL notification scheduled on this phone —
 * no push service, no server, no token. `syncReminders` re-plans the next
 * three days whenever the app is opened or the day list changes, dropping
 * any of today's reminders whose meal is already logged (see plan.ts).
 */

const SETTINGS_KEY = 'reminders.v1'

let handlerInstalled = false

/** Show reminders as banners even while the app is open. */
export function installNotificationHandler(): void {
  if (handlerInstalled) return
  handlerInstalled = true
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  })
}

export async function loadReminderSettings(): Promise<ReminderSettings> {
  return parseReminderSettings(await setting(SETTINGS_KEY, ''))
}

export async function saveReminderSettings(s: ReminderSettings): Promise<void> {
  await putSetting(SETTINGS_KEY, JSON.stringify(s))
}

export type PermissionState = 'granted' | 'denied' | 'undetermined'

export async function permissionState(): Promise<PermissionState> {
  try {
    const p = await Notifications.getPermissionsAsync()
    if (p.granted) return 'granted'
    return p.canAskAgain ? 'undetermined' : 'denied'
  } catch {
    return 'denied'
  }
}

/** Ask once, at the moment the person turns reminders on — never earlier. */
export async function requestPermission(): Promise<PermissionState> {
  try {
    const p = await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowSound: true, allowBadge: false },
    })
    return p.granted ? 'granted' : p.canAskAgain ? 'undetermined' : 'denied'
  } catch {
    return 'denied'
  }
}

async function cancelOurs(): Promise<void> {
  const scheduled = await Notifications.getAllScheduledNotificationsAsync()
  await Promise.all(
    scheduled
      .filter((n) => n.identifier.startsWith(REMINDER_ID_PREFIX))
      .map((n) => Notifications.cancelScheduledNotificationAsync(n.identifier)),
  )
}

/**
 * Re-plan and reschedule. Safe to call often: it only ever touches this
 * app's own reminder identifiers, and does nothing without permission.
 * Returns how many reminders are now scheduled.
 */
export async function syncReminders(now = Date.now()): Promise<number> {
  try {
    const settings = await loadReminderSettings()
    if (!settings.enabled) {
      await cancelOurs()
      return 0
    }
    if ((await permissionState()) !== 'granted') return 0

    const today = localDate(now)
    const [items, nutrients] = await Promise.all([dayItems(today), dayNutrients(today)])
    const logged = new Set(items.map((i) => i.slot as string))
    const plan = planReminders(now, settings, logged, { days: 3, todayKcal: nutrients.kcal })

    await cancelOurs()
    for (const r of plan) {
      await Notifications.scheduleNotificationAsync({
        identifier: r.id,
        content: { title: r.title, body: r.body, data: { route: '/food-search', slot: r.slot } },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: r.at },
      })
    }
    return plan.length
  } catch {
    // A reminder that fails to schedule must never break logging a meal.
    return 0
  }
}
