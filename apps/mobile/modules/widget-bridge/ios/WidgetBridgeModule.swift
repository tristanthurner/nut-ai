import ExpoModulesCore
import Foundation
import WidgetKit

/// Writes today's summary into the App Group container shared with the home
/// screen widget, then asks WidgetKit to redraw.
///
/// The App Group name is RESOLVED, not hard-coded: sideloading tools register
/// groups under their own account and may rename them (AltStore and SideStore
/// append the team ID and record the result under `ALTAppGroups` in
/// Info.plist). A group the app is not actually entitled to returns no
/// container URL, so the first candidate that does is the real one. The
/// widget runs the identical resolution, so both sides land on the same file.
public class WidgetBridgeModule: Module {
  static let defaultGroup = "group.com.nutai.app"
  static let fileName = "widget-today.json"

  /// The App Groups this install is ACTUALLY entitled to, read from the
  /// provisioning profile the sideloading tool embedded when it signed the
  /// app. This is the authoritative list — tools may register the group under
  /// a different name (e.g. with the team ID appended), and only the profile
  /// says which.
  static func profileAppGroups() -> [String] {
    guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
          let data = try? Data(contentsOf: url),
          let raw = String(data: data, encoding: .isoLatin1),
          let start = raw.range(of: "<?xml"),
          let end = raw.range(of: "</plist>", range: start.upperBound..<raw.endIndex)
    else { return [] }
    let xml = String(raw[start.lowerBound..<end.upperBound])
    guard let plistData = xml.data(using: .isoLatin1),
          let plist = try? PropertyListSerialization.propertyList(from: plistData, format: nil) as? [String: Any],
          let ents = plist["Entitlements"] as? [String: Any],
          let groups = ents["com.apple.security.application-groups"] as? [String]
    else { return [] }
    return groups
  }

  static func candidateGroups() -> [String] {
    var out: [String] = profileAppGroups()
    if let alt = Bundle.main.object(forInfoDictionaryKey: "ALTAppGroups") as? [String] {
      out.append(contentsOf: alt)
    }
    if let own = Bundle.main.object(forInfoDictionaryKey: "NutAIAppGroup") as? String {
      out.append(own)
    }
    out.append(defaultGroup)
    if let bundleId = Bundle.main.bundleIdentifier {
      out.append("group.\(bundleId)")
    }
    var seen = Set<String>()
    return out.filter { seen.insert($0).inserted }
  }

  static func container() -> (String, URL)? {
    for g in candidateGroups() {
      if let url = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: g) {
        return (g, url)
      }
    }
    return nil
  }

  public func definition() -> ModuleDefinition {
    Name("WidgetBridge")

    /// The App Group in use, or nil when this install has none (the widget
    /// then cannot show live numbers — e.g. a build installed without it).
    Function("appGroup") { () -> String? in
      return WidgetBridgeModule.container()?.0
    }

    /// Diagnostics for the Profile screen: which group (if any) is usable,
    /// what the profile grants, and whether the widget file exists.
    Function("status") { () -> [String: Any] in
      let resolved = WidgetBridgeModule.container()
      var fileExists = false
      if let (_, dir) = resolved {
        fileExists = FileManager.default.fileExists(atPath: dir.appendingPathComponent(WidgetBridgeModule.fileName).path)
      }
      return [
        "group": resolved?.0 ?? NSNull(),
        "profileGroups": WidgetBridgeModule.profileAppGroups(),
        "candidates": WidgetBridgeModule.candidateGroups(),
        "fileExists": fileExists,
        "bundleId": Bundle.main.bundleIdentifier ?? "",
      ]
    }

    /// Store the JSON payload and reload all widget timelines.
    Function("write") { (json: String) -> Bool in
      guard let (_, dir) = WidgetBridgeModule.container() else { return false }
      let url = dir.appendingPathComponent(WidgetBridgeModule.fileName)
      do {
        try json.data(using: .utf8)?.write(to: url, options: .atomic)
      } catch {
        return false
      }
      if #available(iOS 14.0, *) {
        WidgetCenter.shared.reloadAllTimelines()
      }
      return true
    }
  }
}
