import { router, useFocusEffect } from 'expo-router'
import { useCallback, useMemo, useState } from 'react'
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Svg, { Circle } from 'react-native-svg'
import { Icon, type IconName } from '../../src/components/Icon'
import {
  currentGoal,
  dayItems,
  addWater,
  dayNutrients,
  dayTotals,
  localDate,
  removeItem,
  runAdaptive,
  setItemGrams,
  setMealSlot,
  undoLastWater,
  WATER_GOAL_ML,
  waterTotal,
  type AdaptiveOutcome,
  type CurrentGoal,
  type DayItem,
  type DayNutrients,
  type DayTotals,
} from '../../src/data/repo'
import { groupBySlot, type Slot } from '../../src/data/day-log'
import { GramEditor, SLOT_LABEL } from '../../src/components/GramEditor'
import { syncReminders } from '../../src/notifications/reminders'
import { WaterSheet } from '../../src/components/WaterSheet'
import { updateWidget } from '../../src/widget/sync'
import { useTheme } from '../../src/theme/ThemeProvider'
import { radius, space, type } from '../../src/theme/tokens'

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * Home.
 *
 * Three rules this screen will not break, all of them about not moralising:
 *
 *   A day with nothing logged reads "no entries logged" in a neutral colour.
 *   Never "missed", never red — red is reserved for safety warnings.
 *
 *   Over target is STATED, not scolded. The ring draws a second overflow arc
 *   rather than clamping at 100% and lying about it.
 *
 *   Pending scans contribute ZERO calories and show as a count. A number that
 *   silently grows later is worse than one that is visibly incomplete.
 */
export default function Home() {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const { width } = useWindowDimensions()

  const [goal, setGoal] = useState<CurrentGoal | null>(null)
  const [totals, setTotals] = useState<DayTotals | null>(null)
  const [adaptive, setAdaptive] = useState<AdaptiveOutcome | null>(null)
  const [offset, setOffset] = useState(0)
  const [page, setPage] = useState(0)
  const [items, setItems] = useState<DayItem[]>([])
  const [nutrients, setNutrients] = useState<DayNutrients | null>(null)
  const [editing, setEditing] = useState<DayItem | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [waterMl, setWaterMl] = useState(0)
  const [waterOpen, setWaterOpen] = useState(false)

  const selected = useMemo(() => Date.now() + offset * 86_400_000, [offset])
  const selectedDate = localDate(selected)

  useFocusEffect(
    useCallback(() => {
      let alive = true
      void (async () => {
        // The adaptive loop runs BEFORE reading the goal, so a target it just
        // changed is the one rendered. Its own gates decide whether it may act.
        const outcome = await runAdaptive(Date.now())
        const date = localDate(selected)
        const [g, t, its, n, w] = await Promise.all([
          currentGoal(),
          dayTotals(date),
          dayItems(date),
          dayNutrients(date),
          waterTotal(date),
        ])
        if (!alive) return
        setAdaptive(outcome)
        setGoal(g)
        setTotals(t)
        setItems(its)
        setNutrients(n)
        setWaterMl(w)
        // Today's log just changed or was opened: drop reminders for meals now
        // logged, and repaint the home screen widget.
        void syncReminders()
        const today = localDate(Date.now())
        if (g) {
          if (date === today) updateWidget(today, t, g)
          else void dayTotals(today).then((tt) => updateWidget(today, tt, g))
        }
      })()
      return () => {
        alive = false
      }
    }, [selected, reloadKey]),
  )

  const reload = () => setReloadKey((k) => k + 1)
  const groups = useMemo(() => groupBySlot(items), [items])
  const editingIsWholeMeal = editing != null && items.filter((i) => i.mealId === editing.mealId).length === 1

  if (!goal || !totals) {
    return (
      <View style={[styles.center, { backgroundColor: theme.bg }]}>
        <Text style={[type.body, { color: theme.textMuted }]}>Loading your day…</Text>
      </View>
    )
  }

  const remaining = goal.targetKcal - totals.kcal
  const over = remaining < 0
  const pct = goal.targetKcal > 0 ? totals.kcal / goal.targetKcal : 0
  const empty = totals.mealCount === 0 && totals.pendingCount === 0
  return (
    <ScrollView
      style={{ backgroundColor: theme.bg }}
      contentContainerStyle={{ paddingTop: insets.top + space.sm, paddingBottom: 150 }}
      showsVerticalScrollIndicator={false}
    >
      {/* Header */}
      <View style={styles.header}>
        <Text style={[styles.wordmark, { color: theme.text }]}>Nut AI</Text>
        <View style={[styles.streakPill, { backgroundColor: theme.bgSunken }]}>
          <Icon name="flame" size={16} color={theme.text} />
          <Text style={[type.bodyStrong, { color: theme.text }]}>0</Text>
        </View>
      </View>

      {/* Day strip */}
      <DayStrip selected={offset} onSelect={setOffset} />

      {/* Paged carousel. pagingEnabled snaps by the VIEWPORT width, so each
          page must be exactly `width` wide with its own internal padding —
          sizing pages narrower and padding the container makes every swipe
          drift further off-grid, clipping the left card and bleeding the
          neighbor in. That was the "30g Fiber left" cut-off. */}
      <ScrollView
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        scrollEventThrottle={16}
        onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>) =>
          setPage(Math.round(e.nativeEvent.contentOffset.x / width))
        }
        style={{ marginTop: space.md }}
      >
        {/* Page 1 — calories and the three macros */}
        <View style={{ width, paddingHorizontal: space.lg }}>
          <View style={[styles.heroCard, { backgroundColor: theme.bgElevated, borderColor: theme.border }]}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.hero, { color: theme.text }]}>
                {Math.abs(Math.round(remaining))}
              </Text>
              <Text style={[type.body, { color: theme.textMuted }]}>
                {over ? 'Calories over' : 'Calories left'}
              </Text>
            </View>
            <Ring pct={pct} over={over} size={128} stroke={12}>
              <Icon name="flame" size={26} color={theme.text} />
            </Ring>
          </View>

          <View style={styles.macroRow}>
            <MacroCard label="Protein" icon="protein" eaten={totals.protein_g} target={goal.protein_g} color={theme.protein} />
            <MacroCard label="Carbs" icon="carbs" eaten={totals.carbs_g} target={goal.carbs_g} color={theme.carbs} />
            <MacroCard label="Fat" icon="fat" eaten={totals.fat_g} target={goal.fat_g} color={theme.fat} />
          </View>
        </View>

        {/* Page 2 — micros and the health score */}
        <View style={{ width, paddingHorizontal: space.lg }}>
          <View style={styles.macroRow}>
            <MacroCard label="Fiber" icon="fiber" eaten={nutrients?.fiber_g ?? 0} target={30} color="#8B7BD8" unit="g" />
            <MacroCard label="Sugar" icon="sugar" eaten={nutrients?.sugar_g ?? 0} target={50} color="#E88BA8" unit="g" />
            <MacroCard label="Sodium" icon="sodium" eaten={nutrients?.sodium_mg ?? 0} target={2300} color="#D6A648" unit="mg" />
          </View>

          <View style={[styles.card, { backgroundColor: theme.bgElevated, borderColor: theme.border }]}>
            <View style={styles.spread}>
              <Text style={[type.heading, { color: theme.text }]}>Health Score</Text>
              <Text style={[type.heading, { color: theme.textMuted }]}>N/A</Text>
            </View>
            <View style={[styles.scoreTrack, { backgroundColor: theme.ringTrack }]} />
            <Text style={[type.caption, { color: theme.textMuted, marginTop: space.md, lineHeight: 19 }]}>
              Log a few foods to generate today's score. Unlike the app we're replacing, the
              formula is published and readable — it is arithmetic over what you logged, not an
              opaque "AI" number.
            </Text>
          </View>
        </View>

        {/* Page 3 — activity and water */}
        <View style={{ width, paddingHorizontal: space.lg }}>
          <View style={{ flexDirection: 'row', gap: space.md }}>
            <View style={[styles.card, { flex: 1, backgroundColor: theme.bgElevated, borderColor: theme.border }]}>
              <Text style={[type.caption, { color: theme.textMuted }]}>Steps</Text>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 4 }}>
                <Text style={[styles.mid, { color: theme.text }]}>—</Text>
                <Text style={[type.caption, { color: theme.textFaint }]}>/10,000</Text>
              </View>
              <View style={{ alignItems: 'center', marginTop: space.md }}>
                <Ring pct={0} over={false} size={92} stroke={9}>
                  <Icon name="steps" size={22} color={theme.textMuted} />
                </Ring>
              </View>
              <Text style={[type.micro, { color: theme.textFaint, marginTop: space.sm }]}>
                Needs Apple Health
              </Text>
            </View>

            <View style={[styles.card, { flex: 1, backgroundColor: theme.bgElevated, borderColor: theme.border }]}>
              <Text style={[type.caption, { color: theme.textMuted }]}>Calories burned</Text>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 4 }}>
                <Text style={[styles.mid, { color: theme.text }]}>—</Text>
                <Text style={[type.caption, { color: theme.textFaint }]}>cal</Text>
              </View>
              <Pressable
                onPress={() => router.push('/log-exercise' as never)}
                style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs, marginTop: space.lg }}
              >
                <Icon name="dumbbell" size={18} color={theme.protein} />
                <Text style={[type.label, { color: theme.protein }]}>Log exercise</Text>
              </Pressable>
            </View>
          </View>

          <View style={[styles.card, { backgroundColor: theme.bgElevated, borderColor: theme.border, marginTop: space.md }]}>
            <View style={styles.spread}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
                <Icon name="water" size={22} color={theme.protein} />
                <View>
                  <Text style={[type.caption, { color: theme.textMuted }]}>Water</Text>
                  <Text style={[type.bodyStrong, { color: theme.text }]}>{Math.round(waterMl)} / {WATER_GOAL_ML} ml</Text>
                </View>
              </View>
              <Pressable
                onPress={() => setWaterOpen(true)}
                accessibilityRole="button"
                accessibilityLabel="Log water"
                hitSlop={space.sm}
                style={[styles.ghost, { borderColor: theme.border }]}
              >
                <Text style={[type.label, { color: theme.text }]}>Log Water</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </ScrollView>

      {/* Page dots */}
      <View style={styles.dots}>
        {[0, 1, 2].map((i) => (
          <View
            key={i}
            style={[styles.dot, { backgroundColor: i === page ? theme.text : theme.border }]}
          />
        ))}
      </View>

      {/* Adaptive target status — always legible, never a silent change. */}
      <View style={{ paddingHorizontal: space.lg }}>
        <View style={[styles.card, { backgroundColor: theme.bgSunken, borderColor: 'transparent' }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
            <Icon name="target" size={18} color={theme.text} />
            <Text style={[type.bodyStrong, { color: theme.text }]}>Your target</Text>
          </View>
          <Text style={[type.caption, { color: theme.textMuted, marginTop: space.xs, lineHeight: 19 }]}>
            {adaptive?.surfaced
              ? `Updated to ${Math.round(adaptive.newKcal ?? 0)} kcal. ${adaptive.explanation}`
              : goal.adaptive
                ? (adaptive?.reason ?? 'Adapting from your own trend and intake.')
                : 'Fixed — you set this by hand, so we leave it alone.'}
          </Text>
          <Pressable
            onPress={() => router.push('/log-weight' as never)}
            hitSlop={space.sm}
            style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs, marginTop: space.md }}
          >
            <Icon name="scale" size={16} color={theme.protein} />
            <Text style={[type.label, { color: theme.protein }]}>Log today's weight</Text>
          </Pressable>
        </View>
      </View>

      {/* Food log — everything eaten on the selected day, item by item */}
      <View style={{ paddingHorizontal: space.lg, marginTop: space.xl }}>
        <View style={styles.spread}>
          <Text style={[type.title, { color: theme.text, fontSize: 24 }]}>{dayTitle(offset, selected)}</Text>
          <Pressable
            onPress={() => router.push({ pathname: '/food-search', params: { date: selectedDate } } as never)}
            accessibilityRole="button"
            accessibilityLabel="Add food to this day"
            style={[styles.addPill, { backgroundColor: theme.text }]}
          >
            <Icon name="plus" size={16} color={theme.bg} />
            <Text style={[type.label, { color: theme.bg }]}>Add food</Text>
          </Pressable>
        </View>

        {!empty ? (
          <Text style={[type.caption, { color: theme.textMuted, marginTop: space.xs }]}>
            {Math.round(totals.kcal)} kcal · P {Math.round(totals.protein_g)} g · C {Math.round(totals.carbs_g)} g · F{' '}
            {Math.round(totals.fat_g)} g
          </Text>
        ) : null}

        {totals.pendingCount > 0 ? (
          <Text style={[type.caption, { color: theme.uncertain, marginTop: space.xs }]}>
            +{totals.pendingCount} still analyzing — not counted yet
          </Text>
        ) : null}

        {empty ? (
          <View style={[styles.emptyCard, { backgroundColor: theme.bgSunken }]}>
            <View style={[styles.ghostRow, { backgroundColor: theme.bgElevated }]}>
              <Icon name="bowl" size={26} color={theme.textFaint} />
              <View style={{ flex: 1, gap: 6 }}>
                <View style={[styles.skeleton, { backgroundColor: theme.ringTrack, width: '70%' }]} />
                <View style={[styles.skeleton, { backgroundColor: theme.ringTrack, width: '45%' }]} />
              </View>
            </View>
            <Text style={[type.body, { color: theme.textMuted, textAlign: 'center', marginTop: space.lg }]}>
              Nothing logged {offset === 0 ? 'today' : 'on this day'} yet
            </Text>
          </View>
        ) : (
          groups.map((g) => (
            <View
              key={g.slot}
              style={[styles.slotCard, { backgroundColor: theme.bgElevated, borderColor: theme.border }]}
            >
              <View style={styles.spread}>
                <Text style={[type.bodyStrong, { color: theme.text }]}>{SLOT_LABEL[g.slot]}</Text>
                <Text style={[type.bodyStrong, { color: theme.text }]}>{Math.round(g.kcal)} kcal</Text>
              </View>
              <Text style={[type.micro, { color: theme.textFaint, marginTop: 2 }]}>
                P {Math.round(g.protein_g)} g · C {Math.round(g.carbs_g)} g · F {Math.round(g.fat_g)} g
              </Text>

              {g.items.map((it) => (
                <Pressable
                  key={it.itemId}
                  onPress={() => setEditing(it)}
                  accessibilityRole="button"
                  accessibilityLabel={`Edit ${it.name}, ${Math.round(it.grams)} grams`}
                  style={({ pressed }) => [
                    styles.itemRow,
                    {
                      borderTopColor: theme.border,
                      borderTopWidth: StyleSheet.hairlineWidth,
                      opacity: pressed ? 0.6 : 1,
                    },
                  ]}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={[type.body, { color: theme.text }]} numberOfLines={1}>{it.name}</Text>
                    <Text style={[type.caption, { color: theme.textMuted, marginTop: 1 }]} numberOfLines={1}>
                      {fmtGrams(it.grams)} · P {Math.round(it.protein_g)} · C {Math.round(it.carbs_g)} · F{' '}
                      {Math.round(it.fat_g)}
                      {it.isEstimate ? ' · estimate' : ''}
                    </Text>
                  </View>
                  <Text style={[type.bodyStrong, { color: theme.text }]}>{Math.round(it.kcal)}</Text>
                  <Icon name="pencil" size={14} color={theme.textFaint} />
                </Pressable>
              ))}
            </View>
          ))
        )}
      </View>

      <WaterSheet
        visible={waterOpen}
        totalMl={waterMl}
        goalMl={WATER_GOAL_ML}
        dayLabel={dayTitle(offset, selected)}
        onAdd={async (ml) => {
          await addWater(selectedDate, ml)
          setWaterMl(await waterTotal(selectedDate))
        }}
        onUndo={async () => {
          await undoLastWater(selectedDate)
          setWaterMl(await waterTotal(selectedDate))
        }}
        onClose={() => setWaterOpen(false)}
      />

      {editing ? (
        <GramEditor
          visible
          title={editing.name}
          subtitle={editing.isEstimate ? 'AI estimate' : null}
          per100={editing.per100}
          initialGrams={editing.grams}
          initialSlot={editingIsWholeMeal ? editing.slot : undefined}
          eatenFraction={editing.eatenFraction}
          confirmLabel="Save"
          onConfirm={async (grams: number, slot: Slot | undefined) => {
            await setItemGrams(editing.itemId, grams)
            if (slot && slot !== editing.slot) await setMealSlot(editing.mealId, slot)
            setEditing(null)
            reload()
          }}
          onDelete={async () => {
            await removeItem(editing.itemId)
            setEditing(null)
            reload()
          }}
          extraAction={{
            label: 'Save meal for later',
            onPress: () => {
              const mealId = editing.mealId
              setEditing(null)
              router.push({ pathname: '/meal-builder', params: { fromMeal: String(mealId) } } as never)
            },
          }}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </ScrollView>
  )
}

function dayTitle(offset: number, ms: number): string {
  if (offset === 0) return 'Today'
  if (offset === -1) return 'Yesterday'
  const d = new Date(ms)
  return `${DAY_LABELS[d.getDay()]} ${d.getDate()}.${d.getMonth() + 1}.`
}

function fmtGrams(g: number): string {
  return `${Number.isInteger(g) ? g : Math.round(g * 10) / 10} g`
}

function DayStrip({ selected, onSelect }: { selected: number; onSelect: (o: number) => void }) {
  const theme = useTheme()
  const now = new Date()
  // Monday-first week containing today.
  const dow = (now.getDay() + 6) % 7
  const days = Array.from({ length: 7 }, (_, i) => i - dow)

  return (
    <View style={styles.strip}>
      {days.map((off) => {
        const d = new Date(Date.now() + off * 86_400_000)
        const isSel = off === selected
        const future = off > 0
        return (
          <Pressable
            key={off}
            disabled={future}
            onPress={() => onSelect(off)}
            accessibilityRole="button"
            accessibilityState={{ selected: isSel, disabled: future }}
            style={[styles.dayCol, isSel && { backgroundColor: theme.bgElevated }]}
          >
            <Text style={[type.caption, { color: future ? theme.textFaint : theme.textMuted }]}>
              {DAY_LABELS[d.getDay()]}
            </Text>
            <View
              style={[
                styles.dayCircle,
                {
                  borderColor: isSel ? theme.text : theme.border,
                  borderStyle: off < 0 ? 'dashed' : 'solid',
                  opacity: future ? 0.4 : 1,
                },
              ]}
            >
              <Text style={[type.bodyStrong, { color: future ? theme.textFaint : theme.text }]}>
                {d.getDate()}
              </Text>
            </View>
          </Pressable>
        )
      })}
    </View>
  )
}

function Ring({
  pct, over, size, stroke, children,
}: {
  pct: number
  over: boolean
  size: number
  stroke: number
  children?: React.ReactNode
}) {
  const theme = useTheme()
  const r = size / 2 - stroke
  const c = 2 * Math.PI * r
  const primary = Math.min(1, pct)
  const overflow = over ? Math.min(1, pct - 1) : 0
  const innerR = r - stroke - 3
  const innerC = 2 * Math.PI * innerR

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={theme.ringTrack} strokeWidth={stroke} fill="none" />
        <Circle
          cx={size / 2} cy={size / 2} r={r}
          stroke={theme.ring} strokeWidth={stroke} fill="none"
          strokeDasharray={`${c * primary} ${c}`}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
        {overflow > 0 ? (
          <Circle
            cx={size / 2} cy={size / 2} r={innerR}
            stroke={theme.uncertain} strokeWidth={stroke * 0.6} fill="none"
            strokeDasharray={`${innerC * overflow} ${innerC}`}
            strokeLinecap="round"
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        ) : null}
      </Svg>
      {children}
    </View>
  )
}

function MacroCard({
  label, icon, eaten, target, color, unit = 'g',
}: {
  label: string
  icon: IconName
  eaten: number
  target: number
  color: string
  unit?: string
}) {
  const theme = useTheme()
  const left = Math.max(0, target - eaten)
  const pct = target > 0 ? Math.min(1, eaten / target) : 0
  const size = 74
  const r = size / 2 - 5
  const c = 2 * Math.PI * r

  return (
    <View style={[styles.macroCard, { backgroundColor: theme.bgElevated, borderColor: theme.border }]}>
      {/* "2300mg" must shrink, never wrap — a two-line number reads broken. */}
      <Text style={[styles.macroNum, { color: theme.text }]} numberOfLines={1} adjustsFontSizeToFit>
        {Math.round(left)}
        {unit}
      </Text>
      <Text style={[type.caption, { color: theme.textMuted }]}>{label} left</Text>

      <View style={{ alignItems: 'center', marginTop: space.md }}>
        <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
          <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
            <Circle cx={size / 2} cy={size / 2} r={r} stroke={theme.ringTrack} strokeWidth={5} fill="none" />
            <Circle
              cx={size / 2} cy={size / 2} r={r}
              stroke={color} strokeWidth={5} fill="none"
              strokeDasharray={`${c * pct} ${c}`}
              strokeLinecap="round"
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            />
          </Svg>
          <Icon name={icon} size={22} color={color} />
        </View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
  },
  wordmark: { fontSize: 30, fontWeight: '800', letterSpacing: -1.2 },
  streakPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
  },
  strip: { flexDirection: 'row', paddingHorizontal: space.md, marginTop: space.lg },
  dayCol: { flex: 1, alignItems: 'center', paddingVertical: space.sm, borderRadius: radius.lg, gap: space.sm },
  dayCircle: {
    width: 40, height: 40, borderRadius: radius.pill, borderWidth: 1.5,
    alignItems: 'center', justifyContent: 'center',
  },
  heroCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: space.xl,
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
  },
  hero: { fontSize: 46, fontWeight: '800', letterSpacing: -1.8 },
  mid: { fontSize: 26, fontWeight: '800', letterSpacing: -0.8 },
  macroRow: { flexDirection: 'row', gap: space.sm, marginTop: space.md },
  macroCard: {
    flex: 1,
    padding: space.md,
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
  },
  macroNum: { fontSize: 22, fontWeight: '800', letterSpacing: -0.6 },
  card: { padding: space.lg, borderRadius: radius.xl, borderWidth: StyleSheet.hairlineWidth },
  spread: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  scoreTrack: { height: 8, borderRadius: 4, marginTop: space.md },
  ghost: {
    paddingHorizontal: space.lg, paddingVertical: space.sm,
    borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth,
  },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: space.sm, marginTop: space.lg },
  dot: { width: 7, height: 7, borderRadius: 4 },
  emptyCard: { marginTop: space.md, padding: space.lg, borderRadius: radius.xl },
  ghostRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    padding: space.lg, borderRadius: radius.lg,
  },
  skeleton: { height: 8, borderRadius: 4 },
  addPill: {
    flexDirection: 'row', alignItems: 'center', gap: space.xs,
    paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill,
  },
  slotCard: {
    marginTop: space.md, paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.xs,
    borderRadius: radius.xl, borderWidth: StyleSheet.hairlineWidth,
  },
  itemRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    paddingVertical: space.md, marginTop: space.sm,
  },
})
