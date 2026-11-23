import Foundation

public func managedLaunchAgentURL(homeDirectory: URL) -> URL {
    homeDirectory.appendingPathComponent("Library/LaunchAgents/com.bogdaniel.zenchron-engineering-os.plist")
}

public func loadManagedInstallationCredential(homeDirectory: URL) throws -> String {
    let launchAgentURL = managedLaunchAgentURL(homeDirectory: homeDirectory)
    let data: Data
    do {
        data = try Data(contentsOf: launchAgentURL)
    } catch {
        throw StatusClientError.localInstallationUnavailable
    }
    return try readManagedInstallationCredential(fromLaunchAgent: data)
}

public func readManagedInstallationCredential(fromLaunchAgent data: Data) throws -> String {
    guard let propertyList = try? PropertyListSerialization.propertyList(from: data, options: [], format: nil),
          let launchAgent = propertyList as? [String: Any],
          let environment = launchAgent["EnvironmentVariables"] as? [String: String],
          let token = environment["ZENCHRON_LOCAL_STATUS_TOKEN"], !token.isEmpty else {
        throw StatusClientError.localInstallationUnavailable
    }
    return token
}
