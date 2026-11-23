import Foundation

public enum StatusCredential: Equatable {
    case dashboardGrant(String)
    case managedInstallation(String)
}

public enum StatusClientError: Error {
    case pairingRequired
    case localCredentialRejected
    case administratorRequired
    case accessPolicyUnavailable
    case localInstallationUnavailable
    case invalidPairingCredential
    case unexpectedStatus(Int)
}

public func selectStatusCredential(dashboardGrant: String?,
                                   localInstallation: () throws -> String) throws -> StatusCredential {
    if let dashboardGrant { return .dashboardGrant(dashboardGrant) }
    return .managedInstallation(try localInstallation())
}

public func persistStatusGrant(_ input: String, save: (String) throws -> Void) throws {
    let credential = input.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !credential.isEmpty, credential.count <= 256 else {
        throw StatusClientError.invalidPairingCredential
    }
    try save(credential)
}

public struct CompanionStatusClient {
    public static let endpoint = URL(string: "http://127.0.0.1:8080/api/v1/system/status")!

    private let credential: () throws -> StatusCredential
    private let send: (URLRequest) async throws -> (Data, Int)

    public init(credential: @escaping () throws -> StatusCredential,
                send: @escaping (URLRequest) async throws -> (Data, Int)) {
        self.credential = credential
        self.send = send
    }

    public func refresh() async throws -> SystemStatus {
        let credential = try credential()
        var request = URLRequest(url: Self.endpoint, timeoutInterval: 3)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        switch credential {
        case .dashboardGrant(let value):
            request.setValue(value, forHTTPHeaderField: "X-Zenchron-Status-Grant")
        case .managedInstallation(let value):
            request.setValue(value, forHTTPHeaderField: "X-Zenchron-Local-Status-Token")
        }

        let (data, status) = try await send(request)
        switch status {
        case 200:
            return try decodeSystemStatus(data)
        case 401:
            switch credential {
            case .dashboardGrant:
                throw StatusClientError.pairingRequired
            case .managedInstallation:
                throw StatusClientError.localCredentialRejected
            }
        case 403:
            throw StatusClientError.administratorRequired
        case 503:
            throw StatusClientError.accessPolicyUnavailable
        default:
            throw StatusClientError.unexpectedStatus(status)
        }
    }
}
