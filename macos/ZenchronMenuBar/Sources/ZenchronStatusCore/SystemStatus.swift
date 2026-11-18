import Foundation

public struct SystemStatus: Decodable, Equatable {
    private static let canonicalDashboardURL = "http://127.0.0.1:8080/?mode=live"

    public struct Workers: Decodable, Equatable {
        public let online: Int
        public let total: Int
    }

    public struct Work: Decodable, Equatable {
        public struct ActiveGraph: Decodable, Equatable {
            public let graphID: String
            public let objectiveID: String
            public let objectiveTitle: String

            enum CodingKeys: String, CodingKey {
                case graphID = "graph_id"
                case objectiveID = "objective_id"
                case objectiveTitle = "objective_title"
            }
        }

        public struct Decision: Decodable, Equatable {
            public let id: String
            public let graphID: String
            public let objectiveID: String
            public let objectiveTitle: String
            public let from: String

            enum CodingKeys: String, CodingKey {
                case id, from
                case graphID = "graph_id"
                case objectiveID = "objective_id"
                case objectiveTitle = "objective_title"
            }
        }

        public let activeGraphs: Int
        public let activeGraph: ActiveGraph?
        public let activeGraphLinks: [ActiveGraph]?
        public let decisions: [Decision]?
        public let blockedGraphs: Int
        public let queuedUnits: Int
        public let runningUnits: Int
        public let waitingUnits: Int
        public let failedUnits: Int
        public let openDecisions: Int

        enum CodingKeys: String, CodingKey {
            case activeGraphs = "active_graphs"
            case activeGraph = "active_graph"
            case activeGraphLinks = "active_graph_links"
            case decisions
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
    public let updateRevision: String?
    public let updateProgress: String?
    public let updateReason: String?

    enum CodingKeys: String, CodingKey {
        case revision, workers, work
        case dashboardURL = "dashboard_url"
        case updateState = "update_state"
        case updateRevision = "update_revision"
        case updateProgress = "update_progress"
        case updateReason = "update_reason"
    }

    public func activeWorkURL(for graph: Work.ActiveGraph) -> URL? {
        dashboardURL(for: [
            URLQueryItem(name: "objective", value: graph.objectiveID),
            URLQueryItem(name: "tab", value: "plan"),
            URLQueryItem(name: "graph_id", value: graph.graphID),
        ])
    }

    public func decisionURL(for decision: Work.Decision) -> URL? {
        dashboardURL(for: [
            URLQueryItem(name: "objective", value: decision.objectiveID),
            URLQueryItem(name: "tab", value: "plan"),
            URLQueryItem(name: "graph_id", value: decision.graphID),
            URLQueryItem(name: "decision", value: decision.id),
        ])
    }

    private func dashboardURL(for selection: [URLQueryItem]) -> URL? {
        guard var components = URLComponents(url: dashboardURL, resolvingAgainstBaseURL: false) else { return nil }
        let deepLinkParameters = ["mode", "objective", "tab", "graph_id", "decision"]
        var queryItems = (components.queryItems ?? []).filter { !deepLinkParameters.contains($0.name) }
        queryItems.append(contentsOf: [
            URLQueryItem(name: "mode", value: "live"),
        ])
        queryItems.append(contentsOf: selection)
        components.queryItems = queryItems
        components.fragment = "objectives"
        return components.url
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        revision = try values.decodeIfPresent(String.self, forKey: .revision)
        let rawDashboardURL = try values.decode(String.self, forKey: .dashboardURL)
        guard rawDashboardURL == Self.canonicalDashboardURL, let parsedDashboardURL = URL(string: rawDashboardURL) else {
            throw DecodingError.dataCorruptedError(forKey: .dashboardURL, in: values,
                debugDescription: "status returned a non-canonical dashboard address")
        }
        dashboardURL = parsedDashboardURL
        workers = try values.decode(Workers.self, forKey: .workers)
        work = try values.decode(Work.self, forKey: .work)
        updateState = try values.decode(String.self, forKey: .updateState)
        updateRevision = try values.decodeIfPresent(String.self, forKey: .updateRevision)
        updateProgress = try values.decodeIfPresent(String.self, forKey: .updateProgress)
        updateReason = try values.decodeIfPresent(String.self, forKey: .updateReason)
        let validUpdateStates = ["idle", "checking", "building", "verifying", "waiting_for_runs", "activating",
            "active", "failed", "blocked", "unavailable", "unknown"]
        guard workers.online >= 0, workers.total >= workers.online,
              work.activeGraphs >= 0, work.blockedGraphs >= 0, work.queuedUnits >= 0,
              work.runningUnits >= 0, work.waitingUnits >= 0, work.failedUnits >= 0,
              work.openDecisions >= 0, validUpdateStates.contains(updateState),
              updateRevision.map({ $0.count == 40 && $0.allSatisfy(\.isHexDigit) }) ?? true,
              updateProgress.map({ $0.count <= 500 }) ?? true,
              updateReason.map({ $0.count <= 500 }) ?? true else {
            throw DecodingError.dataCorruptedError(forKey: .updateState, in: values,
                debugDescription: "status contains invalid counts or update state")
        }
    }
}

public func decodeSystemStatus(_ data: Data) throws -> SystemStatus {
    try JSONDecoder().decode(SystemStatus.self, from: data)
}
