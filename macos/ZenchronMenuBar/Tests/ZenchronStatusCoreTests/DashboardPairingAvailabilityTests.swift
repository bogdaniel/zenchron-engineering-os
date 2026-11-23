import XCTest
@testable import ZenchronStatusCore

final class DashboardPairingAvailabilityTests: XCTestCase {
    func testLocalWorkspaceDoesNotOfferDashboardGrantPairing() {
        let body = Data(#"{"authenticated":true,"local":true,"login":"Local workspace"}"#.utf8)
        XCTAssertEqual(dashboardPairingAvailability(statusCode: 200, sessionData: body), .localWorkspace)
    }

    func testConfiguredOAuthWithoutBrowserSessionRequestsSignIn() {
        XCTAssertEqual(dashboardPairingAvailability(statusCode: 401, sessionData: Data()), .signInRequired)
    }

    func testAuthenticatedGitHubSessionAllowsPairing() {
        let body = Data(#"{"authenticated":true,"local":false,"login":"engineer"}"#.utf8)
        XCTAssertEqual(dashboardPairingAvailability(statusCode: 200, sessionData: body), .available)
    }

    func testUnexpectedSessionResponseDoesNotAssumePairingIsAvailable() {
        XCTAssertEqual(dashboardPairingAvailability(statusCode: 503, sessionData: Data()), .unknown)
        XCTAssertEqual(dashboardPairingAvailability(statusCode: 200, sessionData: Data("{}".utf8)), .unknown)
    }
}
