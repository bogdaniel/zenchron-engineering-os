import Foundation

@main
struct StatusSelfCheck {
    static func main() throws {
        let valid = Data("""
        {"dashboard_url":"http://127.0.0.1:8080/?mode=live","workers":{"online":1,"total":2},
         "work":{"active_graphs":1,"blocked_graphs":0,"queued_units":2,"running_units":1,
         "waiting_units":1,"failed_units":0,"open_decisions":1},"update_state":"active"}
        """.utf8)
        let status = try decodeSystemStatus(valid)
        assert(status.workers.online == 1 && status.work.queuedUnits == 2 && status.updateState == "active")

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
