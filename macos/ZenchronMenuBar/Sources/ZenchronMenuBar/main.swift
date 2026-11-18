import AppKit
import Darwin
import Foundation
import ServiceManagement
import ZenchronStatusCore

private enum StatusAccessError: Error {
    case signInRequired
    case administratorRequired
    case localInstallationUnavailable
}

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
    private var requiresOperatorSession = false
    private var startFailure: String?
    private var launchAtLoginError: String?
    private var refreshGeneration: UInt64 = 0
    private var startAttempt: UUID?

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
        armPollingTimer()
        Task { await refresh() }
    }

    private func armPollingTimer() {
        timer?.invalidate()
        let interval: TimeInterval = status == nil ? 30 : 15
        let timer = Timer(timeInterval: interval, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.refresh() }
        }
        RunLoop.main.add(timer, forMode: .eventTracking)
        self.timer = timer
    }

    func menuDidClose(_ menu: NSMenu) {
        timer?.invalidate()
        timer = nil
    }

    private func addStatusItems(to menu: NSMenu) {
        let revision = status?.revision.map { String($0.prefix(8)) } ?? "revision unknown"
        let title: String
        if let status {
            title = "Zenchron · \(status.indicator.description) · \(revision)"
        } else {
            title = startFailure ?? (startAttempt == nil ? message : "Starting Zenchron…")
        }
        menu.addItem(NSMenuItem(title: title, action: nil, keyEquivalent: ""))
        if let status {
            let workers = "Workers · \(status.workers.online) online / \(status.workers.total)"
            menu.addItem(NSMenuItem(title: workers, action: nil, keyEquivalent: ""))
            if let providers = status.workers.providers {
                let summary = providers.map { "\($0.id) \($0.readyWorkers)/\($0.reportedWorkers) ready" }
                    .joined(separator: " · ")
                menu.addItem(NSMenuItem(title: "Providers · \(summary)", action: nil, keyEquivalent: ""))
            }
            let work = [
                "Work · \(status.work.activeGraphs) active · \(status.work.blockedGraphs) blocked",
                "\(status.work.queuedUnits) queued",
                "\(status.work.runningUnits) running",
                "\(status.work.waitingUnits) waiting",
            ].joined(separator: " · ")
            menu.addItem(NSMenuItem(title: work, action: nil, keyEquivalent: ""))
            for graph in status.work.activeGraphLinks ?? (status.work.activeGraph.map { [$0] } ?? []) {
                let title = graph.objectiveTitle.isEmpty ? "Open active work" : "Open · \(graph.objectiveTitle)"
                if let url = status.activeWorkURL(for: graph) {
                    menu.addItem(linkItem(title: title, url: url))
                }
            }
            for decision in status.work.decisions ?? [] {
                guard let url = status.decisionURL(for: decision) else { continue }
                let context = decision.objectiveTitle.isEmpty ? "decision" : decision.objectiveTitle
                let title = "Decision · \(context) · \(decision.from) · \(decision.id)"
                menu.addItem(linkItem(title: title, url: url))
            }
            let actions = [
                "Action required",
                "\(status.work.openDecisions) decisions",
                "\(status.work.failedUnits) failed units",
            ].joined(separator: " · ")
            menu.addItem(NSMenuItem(title: actions, action: nil, keyEquivalent: ""))
            menu.addItem(NSMenuItem(title: "Update · \(status.updateState)", action: nil, keyEquivalent: ""))
            if let revision = status.updateRevision {
                menu.addItem(NSMenuItem(title: "Candidate · \(revision.prefix(8))", action: nil, keyEquivalent: ""))
            }
            if let progress = status.updateProgress, !progress.isEmpty {
                menu.addItem(NSMenuItem(title: progress, action: nil, keyEquivalent: ""))
            }
            if let reason = status.updateReason, !reason.isEmpty {
                let item = NSMenuItem(title: String(reason.prefix(120)), action: nil, keyEquivalent: "")
                item.toolTip = reason
                menu.addItem(item)
            }
            let open = NSMenuItem(title: "Open Dashboard", action: #selector(openDashboard), keyEquivalent: "")
            open.target = self
            menu.addItem(open)
        } else {
            if requiresOperatorSession {
                let open = NSMenuItem(title: "Open Dashboard for access", action: #selector(openDashboard),
                    keyEquivalent: "")
                open.target = self
                menu.addItem(open)
            } else {
                let start = NSMenuItem(title: "Start Zenchron", action: #selector(startZenchron), keyEquivalent: "")
                start.target = self
                start.isEnabled = startAttempt == nil
                menu.addItem(start)
            }
        }
        addLaunchAtLoginItem(to: menu)
        menu.addItem(NSMenuItem.separator())
        let quit = NSMenuItem(title: "Quit Menu Bar App", action: #selector(quit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
    }

    private func refreshMenu() {
        guard let menu = statusItem?.menu else { return }
        menu.removeAllItems()
        addStatusItems(to: menu)
        let indicator = status?.indicator
        let symbol = indicator?.systemSymbolName ?? "exclamationmark.circle.fill"
        let description = indicator.map { "Zenchron \($0.description)" } ?? "Zenchron disconnected"
        statusItem?.button?.image = NSImage(systemSymbolName: symbol, accessibilityDescription: description)
        statusItem?.button?.toolTip = description
    }

    private func addLaunchAtLoginItem(to menu: NSMenu) {
        let service = SMAppService.mainApp
        let title = service.status == .requiresApproval ? "Approve Launch at Login…"
            : service.status == .notFound ? "Launch at Login unavailable" : "Launch at Login"
        let item = NSMenuItem(title: title, action: #selector(toggleLaunchAtLogin), keyEquivalent: "")
        item.target = self
        item.state = service.status == .enabled ? .on : .off
        item.isEnabled = service.status != .notFound
        menu.addItem(item)
        if let launchAtLoginError {
            menu.addItem(NSMenuItem(title: launchAtLoginError, action: nil, keyEquivalent: ""))
        }
    }

    @objc private func toggleLaunchAtLogin() {
        let service = SMAppService.mainApp
        launchAtLoginError = nil
        do {
            switch service.status {
            case .enabled:
                try service.unregister()
                message = "Launch at Login disabled"
            case .requiresApproval:
                SMAppService.openSystemSettingsLoginItems()
                message = "Approve Launch at Login in System Settings"
            default:
                try service.register()
                message = "Launch at Login registered; macOS may require approval"
            }
        } catch {
            let reason = error.localizedDescription.prefix(160)
            launchAtLoginError = "Launch at Login could not be changed · \(reason)"
        }
        refreshMenu()
    }

    private func refresh() async {
        refreshGeneration &+= 1
        let generation = refreshGeneration
        let wasConnected = status != nil
        do {
            var request = URLRequest(url: statusURL, timeoutInterval: 3)
            request.setValue(try localStatusToken(), forHTTPHeaderField: "X-Zenchron-Local-Status-Token")
            request.cachePolicy = .reloadIgnoringLocalCacheData
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
            if httpResponse.statusCode == 401 { throw StatusAccessError.signInRequired }
            if httpResponse.statusCode == 403 { throw StatusAccessError.administratorRequired }
            guard httpResponse.statusCode == 200 else { throw URLError(.badServerResponse) }
            let decoded = try decodeSystemStatus(data)
            guard generation == refreshGeneration else { return }
            status = decoded
            requiresOperatorSession = false
            startFailure = nil
            message = "Connected"
        } catch StatusAccessError.signInRequired {
            guard generation == refreshGeneration else { return }
            status = nil
            requiresOperatorSession = true
            message = "Menu status is unavailable; open the dashboard to sign in"
        } catch StatusAccessError.administratorRequired {
            guard generation == refreshGeneration else { return }
            status = nil
            requiresOperatorSession = true
            message = "Administrator access is required for local status"
        } catch StatusAccessError.localInstallationUnavailable {
            guard generation == refreshGeneration else { return }
            status = nil
            requiresOperatorSession = false
            message = "Local installation status credential is unavailable"
        } catch {
            guard generation == refreshGeneration else { return }
            status = nil
            requiresOperatorSession = false
            message = "Zenchron disconnected · \(error.localizedDescription)"
        }
        if wasConnected != (status != nil), timer != nil {
            armPollingTimer()
        }
        refreshMenu()
    }

    private func localStatusToken() throws -> String {
        let launchAgentURL = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/com.bogdaniel.zenchron-engineering-os.plist")
        guard let data = try? Data(contentsOf: launchAgentURL),
              let plist = try? PropertyListSerialization.propertyList(from: data, options: [], format: nil) as? [String: Any],
              let environment = plist["EnvironmentVariables"] as? [String: String],
              let token = environment["ZENCHRON_LOCAL_STATUS_TOKEN"], !token.isEmpty else {
            throw StatusAccessError.localInstallationUnavailable
        }
        return token
    }

    @objc private func openDashboard() {
        guard let status else {
            guard requiresOperatorSession else { return }
            NSWorkspace.shared.open(SystemStatus.canonicalDashboardURL)
            return
        }
        NSWorkspace.shared.open(status.dashboardURL)
    }

    private func linkItem(title: String, url: URL) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: #selector(openMenuLink), keyEquivalent: "")
        item.target = self
        item.representedObject = url
        return item
    }

    @objc private func openMenuLink(_ sender: NSMenuItem) {
        guard let url = sender.representedObject as? URL else { return }
        NSWorkspace.shared.open(url)
    }

    @objc private func startZenchron() {
        guard startAttempt == nil else { return }
        let attempt = UUID()
        startAttempt = attempt
        startFailure = nil
        let executable = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".local/bin/zenchron-engineering")
        guard FileManager.default.isExecutableFile(atPath: executable.path) else {
            startAttempt = nil
            message = "Canonical Zenchron command is unavailable"
            refreshMenu()
            return
        }
        let process = Process()
        process.executableURL = executable
        process.arguments = ["start"]
        process.terminationHandler = { [weak self] process in
            let exitStatus = process.terminationStatus
            Task { @MainActor [weak self] in
                guard let self else { return }
                guard self.startAttempt == attempt else { return }
                self.startAttempt = nil
                guard exitStatus == 0 else {
                    self.startFailure = "Zenchron start failed · exit code \(exitStatus)"
                    self.refreshMenu()
                    return
                }
                self.message = "Zenchron start command finished · checking status…"
                await self.refresh()
            }
        }
        do {
            try process.run()
            message = "Starting Zenchron…"
        } catch {
            startAttempt = nil
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
        withExtendedLifetime(delegate) { application.run() }
    }
}
