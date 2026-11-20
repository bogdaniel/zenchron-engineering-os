public enum LaunchAtLoginStatus: Equatable {
    case enabled
    case requiresApproval
    case notRegistered
    case notFound
}

public struct LaunchAtLoginMenuState: Equatable {
    public let title: String
    public let isEnabled: Bool
    public let isChecked: Bool

    public init(status: LaunchAtLoginStatus) {
        switch status {
        case .enabled:
            title = "Launch at Login"
            isEnabled = true
            isChecked = true
        case .requiresApproval:
            title = "Approve Launch at Login…"
            isEnabled = true
            isChecked = false
        case .notRegistered:
            title = "Launch at Login"
            isEnabled = true
            isChecked = false
        case .notFound:
            title = "Enable Launch at Login…"
            isEnabled = true
            isChecked = false
        }
    }
}
