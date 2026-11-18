import Foundation

@main
struct StatusSelfCheck {
    static func main() throws {
        let valid = Data("""
        {"dashboard_url":"http://127.0.0.1:8080/?mode=live","workers":{"online":1,"total":2},
         "work":{"active_graphs":1,"active_graph":{"graph_id":"graph-7","objective_id":"objective-2",
         "objective_title":"Ship the dashboard"},"active_graph_links":[{"graph_id":"graph-7",
         "objective_id":"objective-2","objective_title":"Ship the dashboard"}],"decisions":[{"id":"decision-4",
         "graph_id":"graph-7","objective_id":"objective-2","objective_title":"Ship the dashboard",
         "from":"reviewer"}],"blocked_graphs":0,"queued_units":2,"running_units":1,
         "waiting_units":1,"failed_units":0,"open_decisions":1},"update_state":"blocked",
         "update_revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","update_reason":"active runs must finish"}
        """.utf8)
        let status = try decodeSystemStatus(valid)
        assert(status.workers.online == 1 && status.work.queuedUnits == 2 && status.updateState == "blocked")
        assert(status.updateRevision == String(repeating: "a", count: 40) && status.updateReason == "active runs must finish")
        assert(status.work.activeGraphLinks?.first.flatMap(status.activeWorkURL(for:))?.absoluteString ==
            "http://127.0.0.1:8080/?mode=live&objective=objective-2&tab=plan&graph_id=graph-7#objectives")
        assert(status.work.decisions?.first.flatMap(status.decisionURL(for:))?.absoluteString ==
            "http://127.0.0.1:8080/?mode=live&objective=objective-2&tab=plan&graph_id=graph-7&decision=decision-4#objectives")

        let wrongHost = Data("""
        {"dashboard_url":"http://127.0.0.1:4173/?mode=live","workers":{"online":0,"total":0},
         "work":{"active_graphs":0,"blocked_graphs":0,"queued_units":0,"running_units":0,
         "waiting_units":0,"failed_units":0,"open_decisions":0},"update_state":"unknown"}
        """.utf8)
        do {
            _ = try decodeSystemStatus(wrongHost)
            fatalError("non-canonical dashboard address was accepted")
        } catch is DecodingError {}
    }
}
