import AppKit
import Foundation
import Security
import ServiceManagement
import ZenchronStatusCore

@MainActor
final class MenuBarApp: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let statusClient = CompanionStatusClient(credential: {
        try selectStatusCredential(dashboardGrant: StatusCredentialStore.read()) { try Self.localStatusToken() }
    }, send: { request in
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        return (data, httpResponse.statusCode)
    })
    private var instanceLock: MenuBarInstanceLock?
    private var statusItem: NSStatusItem?
    private var timer: Timer?
    private var menuVisible = false
    private var status: SystemStatus?
    private var message = "Checking Zenchron…"
    private var requiresOperatorSession = false
    private var startFailure: String?
    private var launchAtLoginError: String?
    private var pairingError: String?
    private var refreshGeneration: UInt64 = 0
    private var startAttempt: UUID?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        let supportDirectory = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Zenchron", isDirectory: true)
        guard let lock = MenuBarInstanceLock(lockFileURL: supportDirectory.appendingPathComponent("menubar.lock")) else {
            NSApp.terminate(nil)
            return
        }
        instanceLock = lock
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(systemDidWake(_:)),
            name: NSWorkspace.didWakeNotification, object: nil)
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.image = NSImage(systemSymbolName: "circle.dotted", accessibilityDescription: "Zenchron status")
        item.button?.toolTip = "Zenchron status"
        let menu = NSMenu()
        menu.delegate = self
        item.menu = menu
        statusItem = item
        armPollingTimer()
        Task { await refresh() }
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        addStatusItems(to: menu)
    }

    func menuWillOpen(_ menu: NSMenu) {
        menuVisible = true
        armPollingTimer()
        Task { await refresh() }
    }

    private func armPollingTimer() {
        timer?.invalidate()
        let interval = SystemStatus.refreshInterval(menuVisible: menuVisible, connected: status != nil)
        let timer = Timer(timeInterval: interval, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.refresh() }
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    @objc private func systemDidWake(_ notification: Notification) {
        Task { await refresh() }
    }

    func menuDidClose(_ menu: NSMenu) {
        menuVisible = false
        armPollingTimer()
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
            let dashboard = status.dashboardAvailable.map { $0 ? "available" : "unavailable" } ?? "unknown"
            menu.addItem(NSMenuItem(title: "Dashboard · \(dashboard)", action: nil, keyEquivalent: ""))
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
            if let usage = status.usage {
                let tokens = usage.inputTokens.flatMap { input in
                    usage.outputTokens.map { output in
                        "\(input) in / \(output) out · \(usage.runsWithUsage)/\(usage.runs) stored runs"
                    }
                } ?? "tokens unknown · \(usage.runsWithUsage)/\(usage.runs) stored runs"
                let cost = usage.costUSD.map {
                    String(format: "$%.4f · cost %d/%d runs", $0, usage.runsWithCost, usage.runs)
                } ?? "cost unknown · \(usage.runsWithCost)/\(usage.runs) runs"
                menu.addItem(NSMenuItem(title: "Usage · \(tokens) · \(cost)", action: nil, keyEquivalent: ""))
            } else {
                menu.addItem(NSMenuItem(title: "Usage · unavailable", action: nil, keyEquivalent: ""))
            }
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
        let pair = NSMenuItem(title: "Pair with Dashboard…", action: #selector(pairWithDashboard), keyEquivalent: "")
        pair.target = self
        menu.addItem(pair)
        if let pairingError {
            menu.addItem(NSMenuItem(title: pairingError, action: nil, keyEquivalent: ""))
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
            let decoded = try await statusClient.refresh()
            guard generation == refreshGeneration else { return }
            status = decoded
            requiresOperatorSession = false
            startFailure = nil
            message = "Connected"
        } catch StatusClientError.pairingRequired {
            guard generation == refreshGeneration else { return }
            status = nil
            requiresOperatorSession = true
            message = "Status pairing expired or was revoked; pair again in Dashboard Settings"
        } catch StatusClientError.localCredentialRejected {
            guard generation == refreshGeneration else { return }
            status = nil
            requiresOperatorSession = true
            message = "Managed status credential was rejected; pair this Mac in Dashboard Settings"
        } catch StatusClientError.administratorRequired {
            guard generation == refreshGeneration else { return }
            status = nil
            requiresOperatorSession = true
            message = "Administrator access is required for local status"
        } catch StatusClientError.accessPolicyUnavailable {
            guard generation == refreshGeneration else { return }
            status = nil
            requiresOperatorSession = true
            message = "Access policy is unavailable; menu status is blocked until repaired"
        } catch StatusClientError.localInstallationUnavailable {
            guard generation == refreshGeneration else { return }
            status = nil
            requiresOperatorSession = false
            message = "Local installation status credential is unavailable"
        } catch StatusClientError.unexpectedStatus(let statusCode) {
            guard generation == refreshGeneration else { return }
            status = nil
            requiresOperatorSession = false
            message = "Zenchron disconnected · HTTP \(statusCode) from local status endpoint"
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

    private static func localStatusToken() throws -> String {
        try loadManagedInstallationCredential(homeDirectory: FileManager.default.homeDirectoryForCurrentUser)
    }

    @objc private func openDashboard() {
        guard let status else {
            guard requiresOperatorSession else { return }
            NSWorkspace.shared.open(SystemStatus.canonicalDashboardURL)
            return
        }
        NSWorkspace.shared.open(status.dashboardURL)
    }

    @objc private func pairWithDashboard() {
        var components = URLComponents(url: SystemStatus.canonicalDashboardURL, resolvingAgainstBaseURL: false)!
        components.fragment = "settings"
        NSWorkspace.shared.open(components.url!)
        let input = NSTextField(frame: NSRect(x: 0, y: 0, width: 360, height: 24))
        input.placeholderString = "Paste the one-time credential from Settings"
        let alert = NSAlert()
        alert.messageText = "Pair Zenchron Menu Bar"
        alert.informativeText = "Create a menu-bar grant in Dashboard Settings, then paste it here. The credential is stored in this Mac’s Keychain."
        alert.accessoryView = input
        alert.addButton(withTitle: "Pair")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        do {
            try persistStatusGrant(input.stringValue) { try StatusCredentialStore.save($0) }
            pairingError = nil
            message = "Paired with Dashboard"
            Task { await refresh() }
        } catch StatusClientError.invalidPairingCredential {
            pairingError = "Pairing credential is empty or invalid"
        } catch {
            pairingError = "Could not save pairing credential · \(error.localizedDescription)"
        }
        refreshMenu()
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

private enum StatusCredentialStore {
    private static let service = "com.zenchron.engineering.menubar"
    private static let account = "system-status-grant"

    static func read() throws -> String? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service, kSecAttrAccount as String: account,
            kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data,
              let value = String(data: data, encoding: .utf8) else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
        return value
    }

    static func save(_ value: String) throws {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service, kSecAttrAccount as String: account]
        let attributes: [String: Any] = [kSecValueData as String: Data(value.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var item = query
            attributes.forEach { item[$0.key] = $0.value }
            let addStatus = SecItemAdd(item as CFDictionary, nil)
            guard addStatus == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(addStatus)) }
            return
        }
        guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
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
