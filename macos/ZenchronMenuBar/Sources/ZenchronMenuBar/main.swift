import AppKit
import Darwin
import Foundation
import ZenchronStatusCore

final class InstanceLock {
    private let descriptor: Int32

    init?() {
        let directory = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Zenchron", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700])
        } catch {
            return nil
        }
        let path = directory.appendingPathComponent("menubar.lock").path
        descriptor = open(path, O_CREAT | O_RDWR | O_CLOEXEC, S_IRUSR | S_IWUSR)
        guard descriptor >= 0, flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            if descriptor >= 0 { close(descriptor) }
            return nil
        }
    }

    deinit {
        flock(descriptor, LOCK_UN)
        close(descriptor)
    }
}

@MainActor
final class MenuBarApp: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let statusURL = URL(string: "http://127.0.0.1:8080/api/v1/system/status")!
    private var instanceLock: InstanceLock?
    private var statusItem: NSStatusItem?
    private var timer: Timer?
    private var status: SystemStatus?
    private var message = "Checking Zenchron…"

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        guard let lock = InstanceLock() else {
            NSApp.terminate(nil)
            return
        }
        instanceLock = lock
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.image = NSImage(systemSymbolName: "circle.dotted", accessibilityDescription: "Zenchron status")
        item.button?.toolTip = "Zenchron status"
        let menu = NSMenu()
        menu.delegate = self
        item.menu = menu
        statusItem = item
        Task { await refresh() }
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        addStatusItems(to: menu)
    }

    func menuWillOpen(_ menu: NSMenu) {
        let interval: TimeInterval = status == nil ? 30 : 15
        timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.refresh() }
        }
        Task { await refresh() }
    }

    func menuDidClose(_ menu: NSMenu) {
        timer?.invalidate()
        timer = nil
    }

    private func addStatusItems(to menu: NSMenu) {
        let revision = status?.revision.map { String($0.prefix(8)) } ?? "revision unknown"
        let title = status == nil ? message : "Zenchron · connected · \(revision)"
        menu.addItem(NSMenuItem(title: title, action: nil, keyEquivalent: ""))
        if let status {
            let workers = "Workers · \(status.workers.online) online / \(status.workers.total)"
            menu.addItem(NSMenuItem(title: workers, action: nil, keyEquivalent: ""))
            let work = [
                "Work · \(status.work.activeGraphs) active · \(status.work.blockedGraphs) blocked",
                "\(status.work.queuedUnits) queued",
                "\(status.work.runningUnits) running",
                "\(status.work.waitingUnits) waiting",
            ].joined(separator: " · ")
            menu.addItem(NSMenuItem(title: work, action: nil, keyEquivalent: ""))
            let actions = [
                "Action required",
                "\(status.work.openDecisions) decisions",
                "\(status.work.failedUnits) failed units",
            ].joined(separator: " · ")
            menu.addItem(NSMenuItem(title: actions, action: nil, keyEquivalent: ""))
            menu.addItem(NSMenuItem(title: "Update · \(status.updateState)", action: nil, keyEquivalent: ""))
            let open = NSMenuItem(title: "Open Dashboard", action: #selector(openDashboard), keyEquivalent: "")
            open.target = self
            menu.addItem(open)
        } else {
            let start = NSMenuItem(title: "Start Zenchron", action: #selector(startZenchron), keyEquivalent: "")
            start.target = self
            menu.addItem(start)
        }
        menu.addItem(NSMenuItem.separator())
        let quit = NSMenuItem(title: "Quit Menu Bar App", action: #selector(quit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
    }

    private func refreshMenu() {
        guard let menu = statusItem?.menu else { return }
        menu.removeAllItems()
        addStatusItems(to: menu)
        let symbol = status == nil ? "exclamationmark.circle.fill" : "circle.fill"
        statusItem?.button?.image = NSImage(systemSymbolName: symbol, accessibilityDescription: "Zenchron status")
        statusItem?.button?.toolTip = status == nil ? "Zenchron disconnected" : "Zenchron connected"
    }

    private func refresh() async {
        do {
            var request = URLRequest(url: statusURL, timeoutInterval: 3)
            request.setValue("http://127.0.0.1:8080", forHTTPHeaderField: "Origin")
            request.cachePolicy = .reloadIgnoringLocalCacheData
            let (data, response) = try await URLSession.shared.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
            status = try decodeSystemStatus(data)
            message = "Connected"
        } catch {
            status = nil
            message = "Zenchron disconnected · \(error.localizedDescription)"
        }
        refreshMenu()
    }

    @objc private func openDashboard() {
        guard let status else { return }
        NSWorkspace.shared.open(status.dashboardURL)
    }

    @objc private func startZenchron() {
        let executable = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".local/bin/zenchron-engineering")
        guard FileManager.default.isExecutableFile(atPath: executable.path) else {
            message = "Canonical Zenchron command is unavailable"
            refreshMenu()
            return
        }
        let process = Process()
        process.executableURL = executable
        process.arguments = ["start"]
        do {
            try process.run()
            message = "Starting Zenchron…"
        } catch {
            message = "Could not start Zenchron · \(error.localizedDescription)"
        }
        refreshMenu()
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }
}

@main
@MainActor
struct ZenchronMenuBarMain {
    static func main() {
        let application = NSApplication.shared
        let delegate = MenuBarApp()
        application.delegate = delegate
        application.run()
    }
}
