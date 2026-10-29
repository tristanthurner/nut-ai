import { describe, expect, it } from 'vitest'
import { DEFAULT_REMINDERS, formatTime, parseReminderSettings, planReminders, type ReminderSettings } from './plan'

const ON: ReminderSettings = { ...DEFAULT_REMINDERS, enabled: true }
// Local 2025-08-04 08:00.
const MORNING = new Date(2025, 7, 4, 8, 0, 0).getTime()

describe('reminder planning', () => {
  it('plans nothing while reminders are off', () => {
    expect(planReminders(MORNING, DEFAULT_REMINDERS, new Set())).toEqual([])
  })

  it('plans the enabled meal times for three days, in order, with stable ids', () => {
    const p = planReminders(MORNING, ON, new Set())
    expect(p).toHaveLength(9)
    expect(p[0]!.slot).toBe('breakfast')
    expect(new Date(p[0]!.at).getHours()).toBe(9)
    expect(p.map((r) => r.id)).toContain('nutai-reminder-20250804-lunch')
    expect([...p].sort((a, b) => a.at - b.at)).toEqual(p)
    expect(new Set(p.map((r) => r.id)).size).toBe(p.length)
  })

  it("skips today's reminder for a meal that is already logged, but keeps tomorrow's", () => {
    const p = planReminders(MORNING, ON, new Set(['breakfast']))
    expect(p.find((r) => r.id === 'nutai-reminder-20250804-breakfast')).toBeUndefined()
    expect(p.find((r) => r.id === 'nutai-reminder-20250805-breakfast')).toBeDefined()
  })

  it('never schedules in the past', () => {
    const evening = new Date(2025, 7, 4, 20, 0, 0).getTime()
    const p = planReminders(evening, ON, new Set())
    expect(p.every((r) => r.at > evening)).toBe(true)
    expect(p[0]!.id).toBe('nutai-reminder-20250805-breakfast')
  })

  it('the evening check mentions what is logged and disappears once all meals are in', () => {
    const s: ReminderSettings = { enabled: true, times: ON.times.map((t) => ({ ...t, enabled: t.slot === 'evening' })) }
    const p = planReminders(MORNING, s, new Set(['breakfast']), { days: 1, todayKcal: 812.4 })
    expect(p).toHaveLength(1)
    expect(p[0]!.body).toContain('812 kcal')
    expect(planReminders(MORNING, s, new Set(['breakfast', 'lunch', 'dinner']), { days: 1 })).toEqual([])
  })

  it('parses stored settings defensively and formats times', () => {
    expect(parseReminderSettings('garbage')).toEqual(DEFAULT_REMINDERS)
    const s = parseReminderSettings(JSON.stringify({ enabled: true, times: [{ slot: 'lunch', enabled: false, minutes: 750 }] }))
    expect(s.enabled).toBe(true)
    expect(s.times.find((t) => t.slot === 'lunch')).toEqual({ slot: 'lunch', enabled: false, minutes: 750 })
    expect(s.times).toHaveLength(4)
    expect(formatTime(750)).toBe('12:30')
    expect(formatTime(9 * 60)).toBe('09:00')
  })
})
