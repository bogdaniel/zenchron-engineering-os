import Foundation
import XCTest
@testable import ZenchronStatusCore

final class SystemStatusTests: XCTestCase {
    func testStatusRefreshCadenceKeepsClosedIconCurrentWithoutBusyPolling() {
        XCTAssertEqual(SystemStatus.refreshInterval(menuVisible: true, connected: true), 15)
        XCTAssertEqual(SystemStatus.refreshInterval(menuVisible: true, connected: false), 30)
        XCTAssertEqual(SystemStatus.refreshInterval(menuVisible: false, connected: true), 30)
        XCTAssertEqual(SystemStatus.refreshInterval(menuVisible: false, connected: false), 30)
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
}
