/**
 * The home screen widget: today's calories at a glance.
 *
 * Built by @bacons/apple-targets during `expo prebuild`. The App Group must
 * match the main app's (app.config.ts) so both sides reach the same file —
 * see modules/widget-bridge for how the group is resolved at runtime.
 *
 * @type {import('@bacons/apple-targets/app.plugin').ConfigFunction}
 */
module.exports = (config) => ({
  type: 'widget',
  name: 'NutAIWidget',
  displayName: 'Nut AI',
  bundleIdentifier: '.widget',
  deploymentTarget: '17.0',
  frameworks: ['SwiftUI', 'WidgetKit'],
  colors: {
    $accent: { color: '#111111', darkColor: '#F5F5F5' },
  },
  entitlements: {
    'com.apple.security.application-groups': config.ios.entitlements['com.apple.security.application-groups'],
  },
})
