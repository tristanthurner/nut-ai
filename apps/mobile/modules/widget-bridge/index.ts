import { requireOptionalNativeModule } from 'expo'

export interface WidgetBridgeStatus {
  group: string | null
  profileGroups: string[]
  candidates: string[]
  fileExists: boolean
  bundleId: string
}

interface WidgetBridgeNative {
  appGroup(): string | null
  write(json: string): boolean
  status(): WidgetBridgeStatus
}

/**
 * Optional on purpose: a build without the native module (Android, Expo Go,
 * tests) simply has no widget, and every call here becomes a no-op.
 */
const native = requireOptionalNativeModule<WidgetBridgeNative>('WidgetBridge')

export function widgetAppGroup(): string | null {
  try {
    return native?.appGroup() ?? null
  } catch {
    return null
  }
}

export function writeWidgetData(json: string): boolean {
  try {
    return native?.write(json) ?? false
  } catch {
    return false
  }
}

/** null when this build has no widget module at all. */
export function widgetStatus(): WidgetBridgeStatus | null {
  try {
    return native?.status() ?? null
  } catch {
    return null
  }
}
