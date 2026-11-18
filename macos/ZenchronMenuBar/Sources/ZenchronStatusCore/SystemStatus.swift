import Foundation

public struct SystemStatus: Decodable, Equatable {
    public struct Workers: Decodable, Equatable {
        public let online: Int
        public let total: Int
    }

    public struct Work: Decodable, Equatable {
        public let activeGraphs: Int
        public let blockedGraphs: Int
        public let queuedUnits: Int
        public let runningUnits: Int
        public let waitingUnits: Int
        public let failedUnits: Int
        public let openDecisions: Int

        enum CodingKeys: String, CodingKey {
            case activeGraphs = "active_graphs"
            case blockedGraphs = "blocked_graphs"
            case queuedUnits = "queued_units"
            case runningUnits = "running_units"
            case waitingUnits = "waiting_units"
            case failedUnits = "failed_units"
            case openDecisions = "open_decisions"
        }
    }

    public let revision: String?
    public let dashboardURL: URL
    public let workers: Workers
    public let work: Work
    public let updateState: String

    enum CodingKeys: String, CodingKey {
        case revision, workers, work
        case dashboardURL = "dashboard_url"
        case updateState = "update_state"
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        revision = try values.decodeIfPresent(String.self, forKey: .revision)
        dashboardURL = try values.decode(URL.self, forKey: .dashboardURL)
        workers = try values.decode(Workers.self, forKey: .workers)
        work = try values.decode(Work.self, forKey: .work)
        updateState = try values.decode(String.self, forKey: .updateState)
        guard dashboardURL.scheme == "http", dashboardURL.host == "127.0.0.1",
              dashboardURL.port == 8080, dashboardURL.path == "/", dashboardURL.query == "mode=live" else {
            throw DecodingError.dataCorruptedError(forKey: .dashboardURL, in: values,
                debugDescription: "status returned a non-canonical dashboard address")
        }
        let validUpdateStates = ["idle", "checking", "building", "verifying", "waiting_for_runs", "activating",
            "active", "failed", "blocked", "unknown"]
        guard workers.online >= 0, workers.total >= workers.online,
              work.activeGraphs >= 0, work.blockedGraphs >= 0, work.queuedUnits >= 0,
              work.runningUnits >= 0, work.waitingUnits >= 0, work.failedUnits >= 0,
              work.openDecisions >= 0, validUpdateStates.contains(updateState) else {
            throw DecodingError.dataCorruptedError(forKey: .updateState, in: values,
                debugDescription: "status contains invalid counts or update state")
        }
    }
}

public func decodeSystemStatus(_ data: Data) throws -> SystemStatus {
    try JSONDecoder().decode(SystemStatus.self, from: data)
}
