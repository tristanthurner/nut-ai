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

  static func candidateGroups() -> [String] {
    var out: [String] = []
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
