import { router, useLocalSearchParams } from 'expo-router'
import { useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type KeyboardTypeOptions,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  createUserFood,
  deleteUserFood,
  getUserFood,
  updateUserFood,
  UserFoodError,
  type UserFoodInput,
} from '../src/data/repo'
import { BarcodeScanSheet } from '../src/components/BarcodeScanSheet'
import { Icon } from '../src/components/Icon'
import { useTheme } from '../src/theme/ThemeProvider'
import { MIN_TAP_TARGET, radius, space, type } from '../src/theme/tokens'

/**
 * Add or edit a self-added product ("Selbst hinzugefügt").
 *
 *   /product-editor                       → new
 *   /product-editor?barcode=9001234567896 → new, barcode pre-filled (from a scan the database missed)
 *   /product-editor?name=Fusilli          → new, name pre-filled (from a search with no result)
 *   /product-editor?id=7                  → edit product 7
 *
 * Every number is PER 100 g, exactly as printed in the left column of an EU
 * nutrition label. The portion is optional and only becomes a quick pick.
 */
type FieldKey = 'name' | 'brand' | 'barcode' | 'kcal' | 'protein_g' | 'carbs_g' | 'sugar_g' | 'fat_g' | 'fiber_g' | 'salt_g' | 'servingG'
type Form = Record<FieldKey, string>

const EMPTY: Form = {
  name: '', brand: '', barcode: '', kcal: '', protein_g: '', carbs_g: '', sugar_g: '',
  fat_g: '', fiber_g: '', salt_g: '', servingG: '',
}

function num(s: string): number | null {
  const t = s.trim().replace(',', '.')
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : Number.NaN
}

function str(n: number | null | undefined, digits = 1): string {
  if (n == null) return ''
  const f = 10 ** digits
  return String(Math.round(n * f) / f).replace('.', ',')
}

export default function ProductEditor() {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const params = useLocalSearchParams<{ id?: string; barcode?: string; name?: string; then?: string }>()
  const editId = params.id ? Number(params.id) : null

  const [form, setForm] = useState<Form>({ ...EMPTY, barcode: params.barcode ?? '', name: params.name ?? '' })
  const [loading, setLoading] = useState(editId != null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<{ field: FieldKey | 'form'; message: string } | null>(null)
  const [scanning, setScanning] = useState(false)

  useEffect(() => {
    if (editId == null) return
    void (async () => {
      const f = await getUserFood(editId)
      if (f) {
        setForm({
          name: f.name,
          brand: f.brand ?? '',
          barcode: f.barcode ?? '',
          kcal: str(f.per100.kcal),
          protein_g: str(f.per100.protein_g),
          carbs_g: str(f.per100.carbs_g),
          sugar_g: str(f.per100.sugar_g),
          fat_g: str(f.per100.fat_g),
          fiber_g: str(f.per100.fiber_g),
          salt_g: f.per100.sodium_mg == null ? '' : str(f.per100.sodium_mg / 400, 2),
          servingG: str(f.servingG),
        })
      }
      setLoading(false)
    })()
  }, [editId])

  const set = (k: FieldKey) => (v: string) => {
    setForm((prev) => ({ ...prev, [k]: v }))
    if (error && (error.field === k || error.field === 'form')) setError(null)
  }

  // Energy from the macros (Atwater 4/4/9), offered when the kcal box is empty
  // or clearly disagrees — a typo check, never an automatic overwrite.
  const atwater = useMemo(() => {
    const p = num(form.protein_g)
    const c = num(form.carbs_g)
    const f = num(form.fat_g)
    if (p == null || c == null || f == null || [p, c, f].some(Number.isNaN)) return null
    return Math.round(p * 4 + c * 4 + f * 9)
  }, [form.protein_g, form.carbs_g, form.fat_g])
  const kcalNow = num(form.kcal)
  const kcalMismatch =
    atwater != null && kcalNow != null && !Number.isNaN(kcalNow) && Math.abs(atwater - kcalNow) > Math.max(40, kcalNow * 0.25)

  function toInput(): UserFoodInput | null {
    const required: FieldKey[] = ['kcal', 'protein_g', 'carbs_g', 'fat_g']
    for (const k of required) {
      const v = num(form[k])
      if (v == null || Number.isNaN(v)) {
        setError({ field: k, message: 'Required — enter the number per 100 g from the label.' })
        return null
      }
    }
    for (const k of ['sugar_g', 'fiber_g', 'salt_g', 'servingG'] as const) {
      if (Number.isNaN(num(form[k]))) {
        setError({ field: k, message: 'That is not a number.' })
        return null
      }
    }
    return {
      name: form.name,
      brand: form.brand,
      barcode: form.barcode.replace(/\s/g, ''),
      kcal: num(form.kcal)!,
      protein_g: num(form.protein_g)!,
      carbs_g: num(form.carbs_g)!,
      fat_g: num(form.fat_g)!,
      sugar_g: num(form.sugar_g),
      fiber_g: num(form.fiber_g),
      salt_g: num(form.salt_g),
      servingG: num(form.servingG),
    }
  }

  async function save() {
    if (saving) return
    if (form.name.trim().length < 2) { setError({ field: 'name', message: 'Enter a product name.' }); return }
    const input = toInput()
    if (!input) return
    setSaving(true)
    try {
      if (editId != null) await updateUserFood(editId, input)
      else await createUserFood(input)
      if (params.then === 'search') router.replace({ pathname: '/food-search', params: { tab: 'user' } } as never)
      else router.back()
    } catch (e) {
      if (e instanceof UserFoodError) setError({ field: e.field as FieldKey | 'form', message: e.message })
      else setError({ field: 'form', message: 'Could not save the product — try again.' })
      setSaving(false)
    }
  }

  function confirmDelete() {
    if (editId == null) return
    Alert.alert('Delete this product?', 'Entries you already logged with it stay in your log.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => { void deleteUserFood(editId).then(() => router.back()) } },
    ])
  }

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={theme.textFaint} />
      </View>
    )
  }

  const field = (k: FieldKey, label: string, opts: { unit?: string; placeholder?: string; keyboard?: KeyboardTypeOptions; required?: boolean } = {}) => (
    <View style={{ marginTop: space.md }}>
      <Text style={[type.label, { color: theme.textMuted }]}>
        {label}{opts.required ? ' *' : ''}
      </Text>
      <View
        style={[
          styles.inputWrap,
          { borderColor: error?.field === k ? theme.safety : theme.border, backgroundColor: theme.bgSunken },
        ]}
      >
        <TextInput
          value={form[k]}
          onChangeText={set(k)}
          placeholder={opts.placeholder}
          placeholderTextColor={theme.textFaint}
          keyboardType={opts.keyboard ?? 'decimal-pad'}
          accessibilityLabel={label}
          autoCorrect={false}
          style={[styles.input, { color: theme.text }]}
        />
        {opts.unit ? <Text style={[type.body, { color: theme.textMuted }]}>{opts.unit}</Text> : null}
      </View>
      {error?.field === k ? <Text style={[type.caption, { color: theme.safety, marginTop: 4 }]}>{error.message}</Text> : null}
    </View>
  )

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: space.lg, paddingTop: insets.top + space.lg, paddingBottom: 160 }}
      >
        <View style={styles.spread}>
          <Text style={[type.title, { color: theme.text }]}>{editId != null ? 'Edit product' : 'New product'}</Text>
          <Pressable onPress={() => router.back()} hitSlop={space.md} accessibilityRole="button">
            <Text style={[type.body, { color: theme.textMuted }]}>Cancel</Text>
          </Pressable>
        </View>
        <Text style={[type.caption, { color: theme.textMuted, marginTop: space.xs, lineHeight: 19 }]}>
          Copy the values from the “per 100 g” column of the label. It is saved under “Selbst hinzugefügt”
          {form.barcode ? ' and found the next time you scan this barcode' : ''}.
        </Text>

        {/* Product */}
        <Text style={[styles.section, { color: theme.text }]}>Product</Text>
        {field('name', 'Name', { placeholder: 'e.g. Fusilli Vollkorn', keyboard: 'default', required: true })}
        {field('brand', 'Brand', { placeholder: 'e.g. Recheis', keyboard: 'default' })}
        <View style={{ marginTop: space.md }}>
          <Text style={[type.label, { color: theme.textMuted }]}>Barcode</Text>
          <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'center' }}>
            <View
              style={[
                styles.inputWrap,
                { flex: 1, borderColor: error?.field === 'barcode' ? theme.safety : theme.border, backgroundColor: theme.bgSunken },
              ]}
            >
              <TextInput
                value={form.barcode}
                onChangeText={set('barcode')}
                placeholder="EAN / UPC — optional"
                placeholderTextColor={theme.textFaint}
                keyboardType="number-pad"
                accessibilityLabel="Barcode"
                style={[styles.input, { color: theme.text }]}
                maxLength={14}
              />
            </View>
            <Pressable
              onPress={() => setScanning(true)}
              accessibilityRole="button"
              accessibilityLabel="Scan barcode"
              style={[styles.scanBtn, { borderColor: theme.border }]}
            >
              <Icon name="barcode" size={20} color={theme.text} />
              <Text style={[type.label, { color: theme.text }]}>Scan</Text>
            </Pressable>
          </View>
          {error?.field === 'barcode' ? <Text style={[type.caption, { color: theme.safety, marginTop: 4 }]}>{error.message}</Text> : null}
        </View>

        {/* Nutrition */}
        <Text style={[styles.section, { color: theme.text }]}>Nutrition per 100 g</Text>
        {field('kcal', 'Energy', { unit: 'kcal', required: true })}
        {atwater != null && (kcalNow == null || kcalMismatch) ? (
          <Pressable onPress={() => set('kcal')(String(atwater))} hitSlop={space.sm} style={{ marginTop: 6 }}>
            <Text style={[type.caption, { color: kcalMismatch ? theme.uncertain : theme.protein }]}>
              {kcalMismatch ? `Your macros add up to about ${atwater} kcal — check the label. ` : ''}
              <Text style={{ color: theme.protein }}>Use {atwater} kcal</Text>
            </Text>
          </Pressable>
        ) : null}
        <View style={styles.row2}>
          <View style={{ flex: 1 }}>{field('protein_g', 'Protein', { unit: 'g', required: true })}</View>
          <View style={{ flex: 1 }}>{field('fat_g', 'Fat', { unit: 'g', required: true })}</View>
        </View>
        <View style={styles.row2}>
          <View style={{ flex: 1 }}>{field('carbs_g', 'Carbohydrates', { unit: 'g', required: true })}</View>
          <View style={{ flex: 1 }}>{field('sugar_g', 'of which sugars', { unit: 'g' })}</View>
        </View>
        <View style={styles.row2}>
          <View style={{ flex: 1 }}>{field('fiber_g', 'Fiber', { unit: 'g' })}</View>
          <View style={{ flex: 1 }}>{field('salt_g', 'Salt', { unit: 'g' })}</View>
        </View>

        {/* Portion */}
        <Text style={[styles.section, { color: theme.text }]}>Portion (optional)</Text>
        {field('servingG', 'One portion weighs', { unit: 'g', placeholder: 'e.g. 80' })}

        {error?.field === 'form' ? (
          <Text style={[type.caption, { color: theme.safety, marginTop: space.lg }]}>{error.message}</Text>
        ) : null}

        {editId != null ? (
          <Pressable onPress={confirmDelete} accessibilityRole="button" style={[styles.secondary, { marginTop: space.xl }]}>
            <Text style={[type.bodyStrong, { color: theme.safety }]}>Delete product</Text>
          </Pressable>
        ) : null}
      </ScrollView>

      <View style={[styles.saveBar, { backgroundColor: theme.bg, borderTopColor: theme.border, paddingBottom: Math.max(insets.bottom, space.lg) }]}>
        <Pressable
          onPress={save}
          disabled={saving}
          accessibilityRole="button"
          style={[styles.primary, { backgroundColor: theme.text, opacity: saving ? 0.5 : 1 }]}
        >
          {saving ? (
            <ActivityIndicator color={theme.bg} />
          ) : (
            <Text style={[type.bodyStrong, { color: theme.bg }]}>{editId != null ? 'Save changes' : 'Add product'}</Text>
          )}
        </Pressable>
      </View>

      <BarcodeScanSheet
        visible={scanning}
        onScanned={(code) => { setScanning(false); set('barcode')(code) }}
        onClose={() => setScanning(false)}
      />
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  spread: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  section: { ...type.heading, marginTop: space.xl },
  inputWrap: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: 6,
    borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: space.md, minHeight: 48,
  },
  input: { flex: 1, fontSize: 16, paddingVertical: space.sm },
  row2: { flexDirection: 'row', gap: space.md },
  scanBtn: {
    flexDirection: 'row', alignItems: 'center', gap: space.xs, marginTop: 6, height: 48,
    paddingHorizontal: space.md, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth,
  },
  saveBar: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: space.lg, paddingTop: space.md, borderTopWidth: StyleSheet.hairlineWidth },
  primary: { height: 52, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  secondary: { alignItems: 'center', justifyContent: 'center', minHeight: MIN_TAP_TARGET },
})
