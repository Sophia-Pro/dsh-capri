// Capri's window watcher for macOS.
//
// Prints one JSON line whenever something changes: the foreground window id and the visible
// windows in z-order (front first), in screen points (origin = top-left of the main display,
// which is exactly what Electron's screen coordinates use on macOS).
//
// No window titles, no contents, no accessibility API: CGWindowListCopyWindowInfo only gives
// owner pid / layer / bounds, which is all she needs to sit on things.
//
//   capri-windows <own pid>

import Cocoa

let selfPid: pid_t = CommandLine.arguments.count > 1 ? pid_t(CommandLine.arguments[1]) ?? 0 : 0
let skipOwners: Set<String> = ["Window Server", "Dock", "Control Center", "Notification Center"]
let MIN_SIDE: CGFloat = 100

struct Item {
    let id: Int
    let pid: pid_t
    let x: CGFloat
    let y: CGFloat
    let w: CGFloat
    let h: CGFloat
    let max: Bool
}

func screenMax(_ r: CGRect) -> Bool {
    for s in NSScreen.screens {
        if s.frame.intersects(r) {
            // a window filling its screen (or bigger) is "maximized": she can't perch on it
            let full = s.frame
            if r.width >= full.width - 2 && r.height >= full.height - 2 { return true }
            if r.width >= full.width - 2 && r.minY <= full.minY + 26 { return true }
        }
    }
    return false
}

func snapshot() -> String {
    var items: [Item] = []
    let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    let list = (CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]]) ?? []
    for w in list {
        guard let layer = w[kCGWindowLayer as String] as? Int, layer == 0 else { continue }
        guard let ownerPid = w[kCGWindowOwnerPID as String] as? Int, pid_t(ownerPid) != selfPid else { continue }
        if let owner = w[kCGWindowOwnerName as String] as? String, skipOwners.contains(owner) { continue }
        if let alpha = w[kCGWindowAlpha as String] as? Double, alpha <= 0.01 { continue }
        guard let b = w[kCGWindowBounds as String] as? [String: Any],
              let x = b["X"] as? Double, let y = b["Y"] as? Double,
              let width = b["Width"] as? Double, let height = b["Height"] as? Double else { continue }
        let r = CGRect(x: x, y: y, width: width, height: height)
        if r.width < MIN_SIDE || r.height < MIN_SIDE { continue }
        guard let number = w[kCGWindowNumber as String] as? Int else { continue }
        items.append(Item(id: number, pid: pid_t(ownerPid), x: CGFloat(x), y: CGFloat(y),
                          w: CGFloat(width), h: CGFloat(height), max: screenMax(r)))
    }
    // the foreground window: the first one belonging to the app that is in front
    var fg = items.first?.id ?? 0
    if let front = NSWorkspace.shared.frontmostApplication?.processIdentifier,
       let hit = items.first(where: { $0.pid == front }) {
        fg = hit.id
    }
    let parts = items.map { it -> String in
        let f = { (v: CGFloat) in String(format: "%.0f", Double(v)) }  // 取整去重，拖动时只在真的动了才发
        return "{\"id\":\(it.id),\"x\":\(f(it.x)),\"y\":\(f(it.y)),\"w\":\(f(it.w)),\"h\":\(f(it.h)),\"max\":\(it.max)}"
    }
    return "{\"fg\":\(fg),\"wins\":[\(parts.joined(separator: ","))]}"
}

setvbuf(stdout, nil, _IOLBF, 0)
var last = ""
while true {
    let now = snapshot()
    if now != last {
        last = now
        print(now)
        fflush(stdout)
    }
    Thread.sleep(forTimeInterval: 0.06)
}
