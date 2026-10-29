import SwiftUI
import WidgetKit

// MARK: - Shared data

/// What the app writes after every change to today's log (WidgetBridgeModule).
struct TodaySummary: Codable {
  struct Macro: Codable { let eaten: Double; let target: Double }
  let v: Int
  let date: String
  let kcalEaten: Double
  let kcalTarget: Double
  let protein: Macro
  let carbs: Macro
  let fat: Macro
  let mealsLogged: Int
}

enum SharedStore {
  static let defaultGroup = "group.com.nutai.app"
  static let fileName = "widget-today.json"

  /// Same resolution as the app side: the first App Group this extension is
  /// actually entitled to. Sideloading tools may rename groups (team ID suffix).
  static func candidateGroups() -> [String] {
    var out: [String] = []
    if let alt = Bundle.main.object(forInfoDictionaryKey: "ALTAppGroups") as? [String] { out += alt }
    if let own = Bundle.main.object(forInfoDictionaryKey: "NutAIAppGroup") as? String { out.append(own) }
    out.append(defaultGroup)
    if let id = Bundle.main.bundleIdentifier {
      // com.nutai.app.widget → group.com.nutai.app ; com.nutai.app.ABCDE.widget → group.com.nutai.app.ABCDE
      let parent = id.components(separatedBy: ".").filter { $0.lowercased() != "widget" }.joined(separator: ".")
      out.append("group.\(parent)")
    }
    var seen = Set<String>()
    return out.filter { seen.insert($0).inserted }
  }

  static func load() -> TodaySummary? {
    for g in candidateGroups() {
      guard let dir = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: g) else { continue }
      let url = dir.appendingPathComponent(fileName)
      if let data = try? Data(contentsOf: url), let s = try? JSONDecoder().decode(TodaySummary.self, from: data) {
        return s
      }
      return nil
    }
    return nil
  }

  static func todayKey(_ date: Date = Date()) -> String {
    let f = DateFormatter()
    f.calendar = Calendar(identifier: .gregorian)
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyy-MM-dd"
    return f.string(from: date)
  }
}

// MARK: - Timeline

struct CaloriesEntry: TimelineEntry {
  let date: Date
  /// nil = the app has never written (not opened yet, or no shared container).
  let summary: TodaySummary?
  let isToday: Bool

  var target: Double { summary?.kcalTarget ?? 0 }
  /// A summary from yesterday must not carry yesterday's total into today.
  var eaten: Double { isToday ? (summary?.kcalEaten ?? 0) : 0 }
  var remaining: Double { target - eaten }
  var progress: Double { target > 0 ? eaten / target : 0 }
  func macro(_ m: TodaySummary.Macro?) -> (Double, Double) {
    guard let m else { return (0, 0) }
    return (isToday ? m.eaten : 0, m.target)
  }
}

struct Provider: TimelineProvider {
  func entry(at date: Date) -> CaloriesEntry {
    let s = SharedStore.load()
    return CaloriesEntry(date: date, summary: s, isToday: s?.date == SharedStore.todayKey(date))
  }

  func placeholder(in context: Context) -> CaloriesEntry {
    let m = TodaySummary.Macro(eaten: 80, target: 140)
    return CaloriesEntry(
      date: Date(),
      summary: TodaySummary(v: 1, date: SharedStore.todayKey(), kcalEaten: 1240, kcalTarget: 2100,
                            protein: m, carbs: TodaySummary.Macro(eaten: 150, target: 230),
                            fat: TodaySummary.Macro(eaten: 45, target: 70), mealsLogged: 2),
      isToday: true)
  }

  func getSnapshot(in context: Context, completion: @escaping (CaloriesEntry) -> Void) {
    completion(context.isPreview && SharedStore.load() == nil ? placeholder(in: context) : entry(at: Date()))
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<CaloriesEntry>) -> Void) {
    let now = Date()
    // A second entry at midnight resets the day even if the app is not opened.
    let midnight = Calendar.current.startOfDay(for: now.addingTimeInterval(86_400))
    let entries = [entry(at: now), entry(at: midnight)]
    completion(Timeline(entries: entries, policy: .after(midnight.addingTimeInterval(60))))
  }
}

// MARK: - Views

private func fmt(_ v: Double) -> String {
  let n = NumberFormatter()
  n.numberStyle = .decimal
  n.maximumFractionDigits = 0
  n.locale = Locale.current
  return n.string(from: NSNumber(value: v.rounded())) ?? "\(Int(v.rounded()))"
}

struct Ring: View {
  let progress: Double
  let lineWidth: CGFloat
  var body: some View {
    ZStack {
      Circle().stroke(Color.primary.opacity(0.12), lineWidth: lineWidth)
      Circle()
        .trim(from: 0, to: min(1, max(0, progress)))
        .stroke(Color.primary, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
        .rotationEffect(.degrees(-90))
      if progress > 1 {
        Circle()
          .trim(from: 0, to: min(1, progress - 1))
          .stroke(Color.orange, style: StrokeStyle(lineWidth: lineWidth * 0.55, lineCap: .round))
          .rotationEffect(.degrees(-90))
          .padding(lineWidth * 1.1)
      }
    }
  }
}

struct CaloriesCenter: View {
  let entry: CaloriesEntry
  var big: CGFloat = 26
  var body: some View {
    VStack(spacing: 0) {
      Text(fmt(abs(entry.remaining)))
        .font(.system(size: big, weight: .heavy, design: .rounded))
        .minimumScaleFactor(0.5)
        .lineLimit(1)
      Text(entry.remaining < 0 ? "kcal over" : "kcal left")
        .font(.system(size: 11, weight: .medium))
        .foregroundStyle(.secondary)
    }
  }
}

struct MacroBar: View {
  let label: String
  let eaten: Double
  let target: Double
  let color: Color
  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      HStack {
        Text(label).font(.system(size: 11, weight: .semibold))
        Spacer()
        Text("\(fmt(eaten))/\(fmt(target)) g").font(.system(size: 11)).foregroundStyle(.secondary)
      }
      GeometryReader { geo in
        ZStack(alignment: .leading) {
          Capsule().fill(Color.primary.opacity(0.1))
          Capsule().fill(color).frame(width: geo.size.width * min(1, target > 0 ? eaten / target : 0))
        }
      }
      .frame(height: 6)
    }
  }
}

struct NoDataView: View {
  var body: some View {
    VStack(spacing: 6) {
      Image(systemName: "fork.knife").font(.title2)
      Text("Open Nut AI once to show today's calories")
        .font(.system(size: 12, weight: .medium))
        .multilineTextAlignment(.center)
        .foregroundStyle(.secondary)
    }
  }
}

struct CaloriesWidgetView: View {
  @Environment(\.widgetFamily) var family
  let entry: CaloriesEntry

  var body: some View {
    Group {
      if entry.summary == nil {
        switch family {
        case .accessoryCircular: Image(systemName: "fork.knife")
        case .accessoryRectangular: Text("Nut AI · open app")
        default: NoDataView()
        }
      } else {
        switch family {
        case .systemMedium: medium
        case .accessoryCircular: circular
        case .accessoryRectangular: rectangular
        default: small
        }
      }
    }
    .containerBackground(.background, for: .widget)
  }

  var small: some View {
    VStack(spacing: 6) {
      ZStack {
        Ring(progress: entry.progress, lineWidth: 9)
        CaloriesCenter(entry: entry, big: 24)
      }
      .padding(.horizontal, 4)
      Text("\(fmt(entry.eaten)) / \(fmt(entry.target)) kcal")
        .font(.system(size: 11, weight: .medium))
        .foregroundStyle(.secondary)
        .lineLimit(1)
        .minimumScaleFactor(0.7)
    }
  }

  var medium: some View {
    let p = entry.macro(entry.summary?.protein)
    let c = entry.macro(entry.summary?.carbs)
    let f = entry.macro(entry.summary?.fat)
    return HStack(spacing: 16) {
      ZStack {
        Ring(progress: entry.progress, lineWidth: 10)
        CaloriesCenter(entry: entry, big: 26)
      }
      .frame(width: 118, height: 118)
      VStack(alignment: .leading, spacing: 8) {
        Text("\(fmt(entry.eaten)) of \(fmt(entry.target)) kcal")
          .font(.system(size: 13, weight: .semibold))
          .lineLimit(1)
          .minimumScaleFactor(0.7)
        MacroBar(label: "Protein", eaten: p.0, target: p.1, color: Color(red: 0.24, green: 0.48, blue: 0.98))
        MacroBar(label: "Carbs", eaten: c.0, target: c.1, color: Color(red: 0.95, green: 0.66, blue: 0.23))
        MacroBar(label: "Fat", eaten: f.0, target: f.1, color: Color(red: 0.48, green: 0.37, blue: 0.65))
      }
    }
  }

  var circular: some View {
    Gauge(value: min(1, max(0, entry.progress))) {
      Image(systemName: "flame")
    } currentValueLabel: {
      Text(fmt(max(0, entry.remaining))).font(.system(size: 12, weight: .bold)).minimumScaleFactor(0.5)
    }
    .gaugeStyle(.accessoryCircularCapacity)
  }

  var rectangular: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(entry.remaining < 0 ? "\(fmt(-entry.remaining)) kcal over" : "\(fmt(entry.remaining)) kcal left")
        .font(.system(size: 15, weight: .bold))
      Text("\(fmt(entry.eaten)) / \(fmt(entry.target)) eaten")
        .font(.system(size: 12))
      ProgressView(value: min(1, max(0, entry.progress)))
    }
  }
}

struct CaloriesWidget: Widget {
  let kind = "NutAICalories"

  var body: some WidgetConfiguration {
    StaticConfiguration(kind: kind, provider: Provider()) { entry in
      CaloriesWidgetView(entry: entry)
    }
    .configurationDisplayName("Today's calories")
    .description("Calories left today, with protein, carbs and fat.")
    .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular])
  }
}

@main
struct NutAIWidgets: WidgetBundle {
  var body: some Widget {
    CaloriesWidget()
  }
}
