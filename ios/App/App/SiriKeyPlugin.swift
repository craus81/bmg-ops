import Capacitor
import Foundation

/// JavaScript bridge for the Siri key (src/lib/siri-bridge.ts): the web app
/// mints a key after sign-in and hands it here for the Keychain, and clears it
/// on sign-out. Registered in MainViewController.
@objc(SiriKeyPlugin)
public class SiriKeyPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SiriKeyPlugin"
    public let jsName = "SiriKey"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "saveKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "keyStatus", returnType: CAPPluginReturnPromise),
    ]

    @objc func saveKey(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty,
              let keyId = call.getString("keyId"),
              let userId = call.getString("userId") else {
            call.reject("key, keyId and userId are required")
            return
        }
        if SiriKeyStore.save(SiriKeyStore.StoredKey(key: key, keyId: keyId, userId: userId)) {
            call.resolve()
        } else {
            call.reject("Could not save the Siri key to the Keychain")
        }
    }

    @objc func clearKey(_ call: CAPPluginCall) {
        SiriKeyStore.clear()
        call.resolve()
    }

    /// Never returns the key itself: JavaScript only needs to know whose it is.
    @objc func keyStatus(_ call: CAPPluginCall) {
        guard let stored = SiriKeyStore.load() else {
            call.resolve(["hasKey": false])
            return
        }
        call.resolve(["hasKey": true, "keyId": stored.keyId, "userId": stored.userId])
    }
}
