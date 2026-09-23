import Foundation
import Security

/// This iPhone's FleetSuite Siri key, kept in the Keychain so the Siri intent
/// can read it while the app isn't running. The web app puts it here after
/// sign-in (SiriKeyPlugin, src/lib/siri-bridge.ts) and removes it on sign-out.
/// "ThisDeviceOnly" keeps it out of iCloud Keychain and off any other phone a
/// backup is restored to: a new phone mints its own key.
enum SiriKeyStore {
    struct StoredKey: Codable {
        let key: String
        let keyId: String
        let userId: String
    }

    private static var query: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.bmgfleet.fleetsuite.siri",
            kSecAttrAccount as String: "siri-key",
        ]
    }

    static func load() -> StoredKey? {
        var lookup = query
        lookup[kSecReturnData as String] = true
        lookup[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(lookup as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return try? JSONDecoder().decode(StoredKey.self, from: data)
    }

    static func save(_ stored: StoredKey) -> Bool {
        guard let data = try? JSONEncoder().encode(stored) else { return false }
        clear()
        var item = query
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(item as CFDictionary, nil) == errSecSuccess
    }

    static func clear() {
        _ = SecItemDelete(query as CFDictionary)
    }
}
