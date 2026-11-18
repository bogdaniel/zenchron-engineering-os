import Foundation
import XCTest
@testable import ZenchronStatusCore

final class SystemStatusTests: XCTestCase {
    func testDecodesRecordedStatusAndCanonicalDashboardURL() throws {
        let data = Data("""
        {"revision":"abc123","dashboard_url":"http://127.0.0.1:8080/?mode=live",
         "workers":{"online":1,"total":2},
         "work":{"active_graphs":1,"active_graph":{"graph_id":"graph-7","objective_id":"objective-2",
         "objective_title":"Ship the dashboard"},"blocked_graphs":0,"queued_units":2,"running_units":1,
         "waiting_units":1,"failed_units":0,"open_decisions":1},
         "update_state":"active"}
        """.utf8)
        let status = try decodeSystemStatus(data)
        XCTAssertEqual(status.workers.online, 1)
        XCTAssertEqual(status.work.queuedUnits, 2)
        XCTAssertEqual(status.updateState, "active")
        XCTAssertEqual(status.dashboardURL.absoluteString, "http://127.0.0.1:8080/?mode=live")
        XCTAssertEqual(status.activeWorkURL?.absoluteString,
            "http://127.0.0.1:8080/?mode=live&objective=objective-2&tab=plan&graph_id=graph-7#objectives")
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

    func testMissingActiveGraphDoesNotCreateADeepLink() throws {
        let data = Data("""
        {"dashboard_url":"http://127.0.0.1:8080/?mode=live",
         "workers":{"online":0,"total":0},
         "work":{"active_graphs":0,"blocked_graphs":0,"queued_units":0,"running_units":0,
         "waiting_units":0,"failed_units":0,"open_decisions":0},
         "update_state":"unknown"}
        """.utf8)
        XCTAssertNil(try decodeSystemStatus(data).activeWorkURL)
    }
}
