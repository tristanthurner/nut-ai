import { CameraView, useCameraPermissions } from 'expo-camera'
import { useRef } from 'react'
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '../theme/ThemeProvider'
import { radius, space, type } from '../theme/tokens'

/** A full-screen barcode reader that returns the first code it sees. */
export function BarcodeScanSheet({
  visible, onScanned, onClose,
}: {
  visible: boolean
  onScanned: (code: string) => void
  onClose: () => void
}) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const [permission, requestPermission] = useCameraPermissions()
  const done = useRef(false)

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} onShow={() => { done.current = false }}>
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        {permission?.granted ? (
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['ean13', 'ean8', 'upc_a', 'upc_e'] }}
            onBarcodeScanned={({ data }) => {
              if (done.current) return
              done.current = true
              onScanned(data)
            }}
          />
        ) : (
          <View style={styles.center}>
            <Text style={[type.body, { color: '#fff', textAlign: 'center' }]}>
              Nut AI needs the camera to read the barcode.
            </Text>
            <Pressable onPress={() => void requestPermission()} style={[styles.btn, { backgroundColor: '#fff' }]}>
              <Text style={[type.bodyStrong, { color: '#000' }]}>Allow camera</Text>
            </Pressable>
          </View>
        )}

        <View style={[styles.frame, { borderColor: 'rgba(255,255,255,0.9)' }]} pointerEvents="none" />
        <View style={[styles.top, { paddingTop: insets.top + space.md }]}>
          <Text style={[type.bodyStrong, { color: '#fff' }]}>Point at the barcode</Text>
          <Pressable onPress={onClose} hitSlop={space.md} accessibilityRole="button">
            <Text style={[type.body, { color: '#fff' }]}>Cancel</Text>
          </Pressable>
        </View>
        <Text style={[type.caption, { color: theme.textFaint, position: 'absolute', bottom: insets.bottom + space.xl, alignSelf: 'center' }]}>
          EAN-13, EAN-8 and UPC codes
        </Text>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.lg },
  btn: { paddingHorizontal: space.xl, paddingVertical: space.md, borderRadius: radius.pill },
  top: {
    position: 'absolute', left: 0, right: 0, top: 0, paddingHorizontal: space.lg,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  frame: {
    position: 'absolute', left: '12%', right: '12%', top: '38%', height: 140,
    borderWidth: 2, borderRadius: radius.lg,
  },
})
