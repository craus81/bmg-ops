import UIKit
import Capacitor

/// Apps built with the iOS 27 SDK must use the scene life cycle (the iPhone Duo
/// simulator refuses to launch the app otherwise). Info.plist's
/// UIApplicationSceneManifest points here and at Main.storyboard, so UIKit
/// still builds the window and MainViewController; this class only hands the
/// links that now arrive on the scene (instead of AppDelegate) to Capacitor,
/// so deep links and universal links keep working.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        // Launched cold by a link: the link arrives here rather than in
        // openURLContexts / continue.
        if let context = connectionOptions.urlContexts.first {
            openURL(context)
        }
        if let activity = connectionOptions.userActivities.first {
            continueActivity(activity)
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        if let context = URLContexts.first {
            openURL(context)
        }
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        continueActivity(userActivity)
    }

    private func openURL(_ context: UIOpenURLContext) {
        var options: [UIApplication.OpenURLOptionsKey: Any] = [:]
        options[.sourceApplication] = context.options.sourceApplication
        options[.annotation] = context.options.annotation
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: context.url, options: options)
    }

    private func continueActivity(_ activity: NSUserActivity) {
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, continue: activity, restorationHandler: { _ in })
    }
}
