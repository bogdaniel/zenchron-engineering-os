import Foundation

public struct SystemStatus: Decodable, Equatable {
    public static let canonicalDashboardURL = URL(string: "http://127.0.0.1:8080/?mode=live")!
    private static let visibleRefreshInterval: TimeInterval = 15
    private static let backgroundRefreshInterval: TimeInterval = 30

    public static func refreshInterval(menuVisible: Bool, connected: Bool) -> TimeInterval {
        menuVisible && connected ? visibleRefreshInterval : backgroundRefreshInterval
    }

    public enum Indicator: Equatable {
        case connected
        case active
        case actionRequired
        case updating
        case degraded

        public var systemSymbolName: String {
            switch self {
            case .connected: "checkmark.circle"
            case .active: "bolt.circle"
            case .actionRequired: "exclamationmark.circle"
            case .updating: "arrow.triangle.2.circlepath.circle"
            case .degraded: "exclamationmark.triangle"
            }
        }

        public var description: String {
            switch self {
            case .connected: "connected · idle"
            case .active: "active work"
            case .actionRequired: "action required"
            case .updating: "updating"
            case .degraded: "degraded"
            }
        }
    }

    public struct Workers: Decodable, Equatable {
        public struct Provider: Decodable, Equatable {
            public let id: String
            public let readyWorkers: Int
            public let reportedWorkers: Int

            enum CodingKeys: String, CodingKey {
                case id
                case readyWorkers = "ready_workers"
                case reportedWorkers = "reported_workers"
            }
        }

        public let online: Int
        public let total: Int
        public let providers: [Provider]?
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

    public struct Usage: Decodable, Equatable {
        public let runs: Int
        public let runsWithUsage: Int
        public let inputTokens: Int64?
        public let outputTokens: Int64?
        public let runsWithCost: Int
        public let costUSD: Double?

        enum CodingKeys: String, CodingKey {
            case runs
            case runsWithUsage = "runs_with_usage"
            case inputTokens = "input_tokens"
            case outputTokens = "output_tokens"
            case runsWithCost = "runs_with_cost"
            case costUSD = "cost_usd"
        }
    }

    public let revision: String?
    public let dashboardURL: URL
    public let dashboardAvailable: Bool?
    public let workers: Workers
    public let work: Work
    public let usage: Usage?
    public let updateState: String
    public let updateRevision: String?
    public let updateProgress: String?
    public let updateReason: String?

    public var indicator: Indicator {
        switch updateState {
        case "checking", "building", "verifying", "waiting_for_runs", "activating": return .updating
        case "failed", "blocked", "unavailable", "unknown": return .degraded
        default: break
        }
        if dashboardAvailable != true { return .degraded }
        if workers.online < workers.total { return .degraded }
        if work.openDecisions > 0 || work.failedUnits > 0 || work.blockedGraphs > 0 { return .actionRequired }
        if work.activeGraphs > 0 || work.queuedUnits > 0 || work.runningUnits > 0 { return .active }
        return .connected
    }

    enum CodingKeys: String, CodingKey {
        case revision, workers, work
        case usage
        case dashboardURL = "dashboard_url"
        case dashboardAvailable = "dashboard_available"
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
        guard rawDashboardURL == Self.canonicalDashboardURL.absoluteString else {
            throw DecodingError.dataCorruptedError(forKey: .dashboardURL, in: values,
                debugDescription: "status returned a non-canonical dashboard address")
        }
        dashboardURL = Self.canonicalDashboardURL
        dashboardAvailable = try values.decodeIfPresent(Bool.self, forKey: .dashboardAvailable)
        workers = try values.decode(Workers.self, forKey: .workers)
        work = try values.decode(Work.self, forKey: .work)
        usage = try values.decodeIfPresent(Usage.self, forKey: .usage)
        updateState = try values.decode(String.self, forKey: .updateState)
        updateRevision = try values.decodeIfPresent(String.self, forKey: .updateRevision)
        updateProgress = try values.decodeIfPresent(String.self, forKey: .updateProgress)
        updateReason = try values.decodeIfPresent(String.self, forKey: .updateReason)
        let validUpdateStates = ["idle", "checking", "building", "verifying", "waiting_for_runs", "activating",
            "active", "failed", "blocked", "unavailable", "unknown"]
        guard workers.online >= 0, workers.total >= workers.online,
              workers.providers?.allSatisfy({ !$0.id.isEmpty && $0.id.count <= 64 &&
                  $0.readyWorkers >= 0 && $0.reportedWorkers > 0 && $0.readyWorkers <= $0.reportedWorkers }) ?? true,
              work.activeGraphs >= 0, work.blockedGraphs >= 0, work.queuedUnits >= 0,
              work.runningUnits >= 0, work.waitingUnits >= 0, work.failedUnits >= 0,
              work.openDecisions >= 0, validUpdateStates.contains(updateState),
              usage.map({ $0.runs >= 0 && $0.runsWithUsage >= 0 && $0.runsWithUsage <= $0.runs &&
                  $0.runsWithCost >= 0 && $0.runsWithCost <= $0.runs &&
                  ($0.inputTokens.map { $0 >= 0 } ?? true) && ($0.outputTokens.map { $0 >= 0 } ?? true) &&
                  ($0.costUSD.map { $0 >= 0 && $0.isFinite } ?? true) }) ?? true,
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
