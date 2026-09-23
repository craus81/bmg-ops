import UIKit
import Capacitor

/// Capacitor's bridge view controller plus this app's own native plugins.
/// Main.storyboard uses this class instead of CAPBridgeViewController.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(SiriKeyPlugin())
    }
}
