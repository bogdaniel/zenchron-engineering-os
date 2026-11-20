import Foundation
import XCTest
@testable import ZenchronStatusCore

final class SystemStatusTests: XCTestCase {
    func testNotFoundLaunchAtLoginCanStillBeEnabledByTheUser() {
        XCTAssertEqual(LaunchAtLoginMenuState(status: .notFound),
            LaunchAtLoginMenuState(title: "Enable Launch at Login…", isEnabled: true, isChecked: false))
    }

    func testLaunchAtLoginMenuReflectsRegisteredAndApprovalStates() {
        XCTAssertEqual(LaunchAtLoginMenuState(status: .enabled),
            LaunchAtLoginMenuState(title: "Launch at Login", isEnabled: true, isChecked: true))
        XCTAssertEqual(LaunchAtLoginMenuState(status: .requiresApproval),
            LaunchAtLoginMenuState(title: "Approve Launch at Login…", isEnabled: true, isChecked: false))
        XCTAssertEqual(LaunchAtLoginMenuState(status: .notRegistered),
            LaunchAtLoginMenuState(title: "Launch at Login", isEnabled: true, isChecked: false))
    }

    func testStatusRefreshCadenceKeepsClosedIconCurrentWithoutBusyPolling() {
        XCTAssertEqual(SystemStatus.refreshInterval(menuVisible: true, connected: true), 15)
        XCTAssertEqual(SystemStatus.refreshInterval(menuVisible: true, connected: false), 30)
        XCTAssertEqual(SystemStatus.refreshInterval(menuVisible: false, connected: true), 30)
        XCTAssertEqual(SystemStatus.refreshInterval(menuVisible: false, connected: false), 30)
    }

    func testCompanionUsesKeychainGrantForCanonicalAuthenticatedStatusRequest() async throws {
        var localCredentialRead = false
        let responseStatus = status(revision: "a")
        let client = CompanionStatusClient(credential: {
            try selectStatusCredential(dashboardGrant: "one-time-status-grant") {
                localCredentialRead = true
                return "must-not-be-read"
            }
        }, send: { request in
            XCTAssertEqual(request.url, CompanionStatusClient.endpoint)
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.cachePolicy, .reloadIgnoringLocalCacheData)
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Zenchron-Status-Grant"), "one-time-status-grant")
            XCTAssertNil(request.value(forHTTPHeaderField: "X-Zenchron-Local-Status-Token"))
            XCTAssertNil(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems)
            return (responseStatus, 200)
        })

        let value = try await client.refresh()
        XCTAssertEqual(value.revision, "a")
        XCTAssertFalse(localCredentialRead)
    }

    func testCompanionUsesManagedCredentialOnlyWhenNoDashboardGrantExists() async throws {
        let responseStatus = status(revision: "b")
        let client = CompanionStatusClient(credential: {
            try selectStatusCredential(dashboardGrant: nil) { "launch-agent-local-token" }
        }, send: { request in
            XCTAssertEqual(request.url, CompanionStatusClient.endpoint)
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Zenchron-Local-Status-Token"),
                "launch-agent-local-token")
            XCTAssertNil(request.value(forHTTPHeaderField: "X-Zenchron-Status-Grant"))
            return (responseStatus, 200)
        })

        let value = try await client.refresh()
        XCTAssertEqual(value.revision, "b")
    }

    func testPairingTrimsInputAndPersistsOnlyValidatedCredential() throws {
        var stored: String?
        try persistStatusGrant("  one-time-grant\n") { stored = $0 }
        XCTAssertEqual(stored, "one-time-grant")

        for invalid in [" \n", String(repeating: "x", count: 257)] {
            var saveWasCalled = false
            XCTAssertThrowsError(try persistStatusGrant(invalid) { _ in saveWasCalled = true })
            XCTAssertFalse(saveWasCalled)
        }
    }

    func testStaleDashboardGrantRequiresRepairAndNeverFallsBackToLocalCredential() async {
        var localCredentialRead = false
        let client = CompanionStatusClient(credential: {
            try selectStatusCredential(dashboardGrant: "revoked-grant") {
                localCredentialRead = true
                return "must-not-be-read"
            }
        }, send: { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Zenchron-Status-Grant"), "revoked-grant")
            return (Data(), 401)
        })
        var pairingRequired = false
        do {
            _ = try await client.refresh()
            XCTFail("revoked status grant was accepted")
        } catch StatusClientError.pairingRequired {
            pairingRequired = true
        } catch {
            XCTFail("revoked status grant produced the wrong error: \(error)")
        }
        XCTAssertTrue(pairingRequired)
        XCTAssertFalse(localCredentialRead)
    }

    func testRejectedManagedCredentialOffersPairingInsteadOfClaimingAValidStatus() async {
        let client = CompanionStatusClient(credential: { .managedInstallation("stale-local-token") }, send: { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Zenchron-Local-Status-Token"), "stale-local-token")
            return (Data(), 401)
        })
        var rejectedAsLocalCredential = false
        do {
            _ = try await client.refresh()
            XCTFail("stale local credential was accepted")
        } catch StatusClientError.localCredentialRejected {
            rejectedAsLocalCredential = true
        } catch {
            XCTFail("stale local credential produced the wrong error: \(error)")
        }
        XCTAssertTrue(rejectedAsLocalCredential)
    }

    func testCompanionReportsAuthorizationAndPolicyFailuresSeparately() async {
        for (httpStatus, expected) in [(403, StatusClientError.administratorRequired),
                                       (503, StatusClientError.accessPolicyUnavailable)] {
            let client = CompanionStatusClient(credential: { .dashboardGrant("grant") }, send: { _ in
                (Data(), httpStatus)
            })
            do {
                _ = try await client.refresh()
                XCTFail("HTTP \(httpStatus) was accepted")
            } catch StatusClientError.administratorRequired where httpStatus == 403 {
                XCTAssertEqual(httpStatus, 403)
            } catch StatusClientError.accessPolicyUnavailable where httpStatus == 503 {
                XCTAssertEqual(httpStatus, 503)
            } catch {
                XCTFail("HTTP \(httpStatus) produced the wrong error: \(error); expected \(expected)")
            }
        }
    }

    func testCompanionReconnectsAndObservesTheNewActiveRevisionAfterRestart() async throws {
        var calls = 0
        let oldStatus = status(revision: "old")
        let newStatus = status(revision: "new")
        let client = CompanionStatusClient(credential: { .dashboardGrant("grant") }, send: { request in
            XCTAssertEqual(request.url, CompanionStatusClient.endpoint)
            calls += 1
            return (calls == 1 ? oldStatus : newStatus, 200)
        })

        let beforeRestart = try await client.refresh()
        let afterRestart = try await client.refresh()

        XCTAssertEqual(beforeRestart.revision, "old")
        XCTAssertEqual(afterRestart.revision, "new")
        XCTAssertEqual(calls, 2)
    }

    func testDisconnectedRequestCanReconnectWithoutShowingStaleStatusAsCurrent() async throws {
        var calls = 0
        let responseStatus = status(revision: "current")
        let client = CompanionStatusClient(credential: { .dashboardGrant("grant") }, send: { _ in
            calls += 1
            if calls == 1 { throw URLError(.notConnectedToInternet) }
            return (responseStatus, 200)
        })

        do {
            _ = try await client.refresh()
            XCTFail("offline endpoint returned a status")
        } catch URLError.notConnectedToInternet {
            // The app clears its displayed status for this error and continues polling.
        }
        let reconnected = try await client.refresh()
        XCTAssertEqual(reconnected.revision, "current")
    }

    func testLaunchAgentCredentialDiscoveryUsesExplicitHomeFixtureOnly() throws {
        let temporaryHome = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: temporaryHome) }
        let launchAgentURL = managedLaunchAgentURL(homeDirectory: temporaryHome)
        let expectedURL = temporaryHome.appendingPathComponent(
            "Library/LaunchAgents/com.bogdaniel.zenchron-engineering-os.plist")
        XCTAssertEqual(launchAgentURL.path, expectedURL.path)
        XCTAssertThrowsError(try loadManagedInstallationCredential(homeDirectory: temporaryHome))
        try FileManager.default.createDirectory(at: launchAgentURL.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        let data = try PropertyListSerialization.data(fromPropertyList: [
            "EnvironmentVariables": ["ZENCHRON_LOCAL_STATUS_TOKEN": "isolated-fixture-token"],
        ], format: .xml, options: 0)
        try data.write(to: launchAgentURL)
        XCTAssertEqual(try loadManagedInstallationCredential(homeDirectory: temporaryHome), "isolated-fixture-token")
        XCTAssertEqual(try readManagedInstallationCredential(fromLaunchAgent: data), "isolated-fixture-token")
        XCTAssertThrowsError(try readManagedInstallationCredential(fromLaunchAgent: Data("{}".utf8)))
    }

    func testInstanceLockAllowsOnlyOneOwnerAndReleasesForRestart() throws {
        let lockURL = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
            .appendingPathComponent("menubar.lock")
        var first: MenuBarInstanceLock? = MenuBarInstanceLock(lockFileURL: lockURL)
        XCTAssertNotNil(first)
        XCTAssertNil(MenuBarInstanceLock(lockFileURL: lockURL))

        first = nil
        XCTAssertNotNil(MenuBarInstanceLock(lockFileURL: lockURL))
    }

    func testStatusIndicatorReflectsWorkUpdateAndWorkerState() throws {
        XCTAssertEqual(try status().indicator, .connected)
        XCTAssertEqual(try status(activeGraphs: 1).indicator, .active)
        XCTAssertEqual(try status(queuedUnits: 1).indicator, .active)
        XCTAssertEqual(try status(openDecisions: 1).indicator, .actionRequired)
        XCTAssertEqual(try status(blockedGraphs: 1).indicator, .actionRequired)
        XCTAssertEqual(try status(updateState: "activating").indicator, .updating)
        XCTAssertEqual(try status(updateState: "blocked").indicator, .degraded)
        XCTAssertEqual(try status(onlineWorkers: 0, totalWorkers: 1).indicator, .degraded)
        XCTAssertEqual(try status(dashboardAvailable: "false").indicator, .degraded)
        XCTAssertEqual(try status(dashboardAvailable: nil).indicator, .degraded)
    }

    func testDecodesRecordedStatusAndCanonicalDashboardURL() throws {
        let data = Data("""
        {"revision":"abc123","dashboard_url":"http://127.0.0.1:8080/?mode=live","dashboard_available":true,
         "workers":{"online":1,"total":2,"providers":[
         {"id":"codex-cli","ready_workers":1,"reported_workers":2},
         {"id":"claude-code","ready_workers":0,"reported_workers":1}]},
         "work":{"active_graphs":1,"active_graph":{"graph_id":"graph-7","objective_id":"objective-2",
         "objective_title":"Ship the dashboard"},"blocked_graphs":0,"queued_units":2,"running_units":1,
         "active_graph_links":[{"graph_id":"graph-7","objective_id":"objective-2",
         "objective_title":"Ship the dashboard"}],"decisions":[{"id":"decision-4","graph_id":"graph-7",
         "objective_id":"objective-2","objective_title":"Ship the dashboard","from":"reviewer"}],
         "waiting_units":1,"failed_units":0,"open_decisions":1},
         "usage":{"runs":3,"runs_with_usage":2,"input_tokens":200,"output_tokens":40,
         "runs_with_cost":1,"cost_usd":0.25},
         "update_state":"blocked","update_revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
         "update_reason":"active runs must finish"}
        """.utf8)
        let status = try decodeSystemStatus(data)
        XCTAssertEqual(status.workers.online, 1)
        XCTAssertEqual(status.dashboardAvailable, true)
        XCTAssertEqual(status.workers.providers?.map(\.readyWorkers), [1, 0])
        XCTAssertEqual(status.work.queuedUnits, 2)
        XCTAssertEqual(status.usage?.runs, 3)
        XCTAssertEqual(status.usage?.runsWithUsage, 2)
        XCTAssertEqual(status.usage?.inputTokens, 200)
        XCTAssertEqual(status.usage?.outputTokens, 40)
        XCTAssertEqual(status.usage?.runsWithCost, 1)
        XCTAssertEqual(status.usage?.costUSD, 0.25)
        XCTAssertEqual(status.updateState, "blocked")
        XCTAssertEqual(status.updateRevision, String(repeating: "a", count: 40))
        XCTAssertEqual(status.updateReason, "active runs must finish")
        XCTAssertEqual(SystemStatus.canonicalDashboardURL.absoluteString, "http://127.0.0.1:8080/?mode=live")
        XCTAssertEqual(status.dashboardURL.absoluteString, "http://127.0.0.1:8080/?mode=live")
        XCTAssertEqual(status.work.activeGraphLinks?.first.flatMap(status.activeWorkURL(for:))?.absoluteString,
            "http://127.0.0.1:8080/?mode=live&objective=objective-2&tab=plan&graph_id=graph-7#objectives")
        XCTAssertEqual(status.work.decisions?.first.flatMap(status.decisionURL(for:))?.absoluteString,
            "http://127.0.0.1:8080/?mode=live&objective=objective-2&tab=plan&graph_id=graph-7&decision=decision-4#objectives")
    }

    func testRejectsInvalidProviderReadinessCounts() {
        let data = Data("""
        {"dashboard_url":"http://127.0.0.1:8080/?mode=live",
         "workers":{"online":1,"total":1,"providers":[
         {"id":"codex-cli","ready_workers":2,"reported_workers":1}]},
         "work":{"active_graphs":0,"blocked_graphs":0,"queued_units":0,"running_units":0,
         "waiting_units":0,"failed_units":0,"open_decisions":0},"update_state":"unknown"}
        """.utf8)
        XCTAssertThrowsError(try decodeSystemStatus(data))
    }

    func testRejectsUsageCoverageThatExceedsRetainedRunCount() {
        let data = Data("""
        {"dashboard_url":"http://127.0.0.1:8080/?mode=live","workers":{"online":0,"total":0},
         "work":{"active_graphs":0,"blocked_graphs":0,"queued_units":0,"running_units":0,
         "waiting_units":0,"failed_units":0,"open_decisions":0},
         "usage":{"runs":1,"runs_with_usage":2,"runs_with_cost":0},"update_state":"unknown"}
        """.utf8)
        XCTAssertThrowsError(try decodeSystemStatus(data))
    }

    func testRejectsUnexpectedDashboardAddress() {
        let data = Data("""
        {"dashboard_url":"http://127.0.0.1:4173/?mode=live",
         "workers":{"online":0,"total":0},
         "work":{"active_graphs":0,"blocked_graphs":0,"queued_units":0,"running_units":0,
         "waiting_units":0,"failed_units":0,"open_decisions":0},
         "update_state":"unknown"}
        """.utf8)
        XCTAssertThrowsError(try decodeSystemStatus(data))
    }

    func testRejectsDashboardAddressWithFragment() {
        let data = Data("""
        {"dashboard_url":"http://127.0.0.1:8080/?mode=live#attacker",
         "workers":{"online":0,"total":0},
         "work":{"active_graphs":0,"blocked_graphs":0,"queued_units":0,"running_units":0,
         "waiting_units":0,"failed_units":0,"open_decisions":0},
         "update_state":"unknown"}
        """.utf8)
        XCTAssertThrowsError(try decodeSystemStatus(data))
    }

    func testMissingActiveGraphDoesNotCreateADeepLink() throws {
        let data = Data("""
        {"dashboard_url":"http://127.0.0.1:8080/?mode=live",
         "workers":{"online":0,"total":0},
         "work":{"active_graphs":0,"blocked_graphs":0,"queued_units":0,"running_units":0,
         "waiting_units":0,"failed_units":0,"open_decisions":0},
         "update_state":"unknown"}
        """.utf8)
        let status = try decodeSystemStatus(data)
        XCTAssertTrue(status.work.activeGraphLinks?.isEmpty ?? true)
        XCTAssertTrue(status.work.decisions?.isEmpty ?? true)
    }

    func testRejectsInvalidUpdateRevision() {
        let data = Data("""
        {"dashboard_url":"http://127.0.0.1:8080/?mode=live","workers":{"online":0,"total":0},
         "work":{"active_graphs":0,"blocked_graphs":0,"queued_units":0,"running_units":0,
         "waiting_units":0,"failed_units":0,"open_decisions":0},
         "update_state":"blocked","update_revision":"not-a-commit"}
        """.utf8)
        XCTAssertThrowsError(try decodeSystemStatus(data))
    }

    private func status(updateState: String = "idle", onlineWorkers: Int = 1, totalWorkers: Int = 1,
                        activeGraphs: Int = 0, blockedGraphs: Int = 0, queuedUnits: Int = 0,
                        openDecisions: Int = 0, dashboardAvailable: String? = "true") throws -> SystemStatus {
        let dashboardField = dashboardAvailable.map { "\"dashboard_available\":\($0)," } ?? ""
        let data = Data("""
        {"dashboard_url":"http://127.0.0.1:8080/?mode=live",\(dashboardField)
         "workers":{"online":\(onlineWorkers),"total":\(totalWorkers)},
         "work":{"active_graphs":\(activeGraphs),"blocked_graphs":\(blockedGraphs),
         "queued_units":\(queuedUnits),"running_units":0,
         "waiting_units":0,"failed_units":0,"open_decisions":\(openDecisions)},
         "update_state":"\(updateState)"}
        """.utf8)
        return try decodeSystemStatus(data)
    }

    private func status(revision: String) -> Data {
        Data("""
        {"revision":"\(revision)","dashboard_url":"http://127.0.0.1:8080/?mode=live","dashboard_available":true,
         "workers":{"online":1,"total":1},
         "work":{"active_graphs":0,"blocked_graphs":0,"queued_units":0,"running_units":0,
         "waiting_units":0,"failed_units":0,"open_decisions":0},"update_state":"idle"}
        """.utf8)
    }
}
