import UIKit
import Capacitor
import AuthenticationServices
import FirebaseCore
import FirebaseMessaging

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Firebase only when a real config ships in the bundle — the committed
        // placeholder (empty GOOGLE_APP_ID) keeps builds green until the
        // Firebase console files land; without it push degrades to raw APNs.
        if let path = Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist"),
           let options = FirebaseOptions(contentsOfFile: path), !options.googleAppID.isEmpty {
            FirebaseApp.configure(options: options)
        }
        return true
    }

    // Without these two forwards the Capacitor push plugin never fires its
    // 'registration'/'registrationError' events on iOS — enabling
    // notifications hung for 10s and silently stayed off.
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        guard FirebaseApp.app() != nil else {
            NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
            return
        }
        Messaging.messaging().apnsToken = deviceToken
        Messaging.messaging().token { token, error in
            if let token {
                NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: token)
            } else {
                NotificationCenter.default.post(
                    name: .capacitorDidFailToRegisterForRemoteNotifications,
                    object: error ?? NSError(domain: "app.munni.push", code: -1)
                )
            }
        }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }

    // §5 quick actions: reuse the munni:// deep-link path the webview
    // already parses (deepLinkToPath accepts munni:// in both channels)
    func application(_ application: UIApplication, performActionFor shortcutItem: UIApplicationShortcutItem, completionHandler: @escaping (Bool) -> Void) {
        if let url = URL(string: "munni://\(shortcutItem.type)") {
            _ = ApplicationDelegateProxy.shared.application(application, open: url, options: [:])
            completionHandler(true)
            return
        }
        completionHandler(false)
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}

// MARK: - the platform auth session (docs/native-auth-popupless.md, NA1)
//
// Sign-in runs in ASWebAuthenticationSession: the system sheet shares
// Safari's cookies, and the callback scheme is handed straight back to
// JS — no "Open in munni?" question at the end of the flow, which every
// Safari-redirect login is structurally bound to. One consent alert at
// the start is the sanctioned price (prefersEphemeralWebBrowserSession
// stays false so the Logto cookie survives and later logins are instant).
@objc(AuthSessionPlugin)
public class AuthSessionPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AuthSessionPlugin"
    public let jsName = "AuthSession"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise)
    ]
    private var session: ASWebAuthenticationSession?
    private var presenter: AuthSessionPresenter?

    @objc func start(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"), let url = URL(string: urlString) else {
            call.reject("url is required")
            return
        }
        let scheme = call.getString("callbackScheme")
        DispatchQueue.main.async {
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: scheme) { callbackURL, error in
                self.session = nil
                if let error = error {
                    let nsError = error as NSError
                    if nsError.domain == ASWebAuthenticationSessionErrorDomain,
                       nsError.code == ASWebAuthenticationSessionError.canceledLogin.rawValue {
                        call.resolve(["url": NSNull(), "cancelled": true])
                        return
                    }
                    call.reject(error.localizedDescription)
                    return
                }
                call.resolve(["url": callbackURL?.absoluteString ?? NSNull()])
            }
            session.prefersEphemeralWebBrowserSession = false
            let presenter = AuthSessionPresenter(window: self.bridge?.viewController?.view.window)
            self.presenter = presenter
            session.presentationContextProvider = presenter
            self.session = session
            if !session.start() {
                self.session = nil
                call.reject("the auth session could not start")
            }
        }
    }

    // Ends a session whose page can no longer finish. A bank app hands its
    // https return to Safari, never to the sheet it left, so the consent
    // completes there and reaches the app on its scheme while this sheet
    // sits on "returning…" for ever (user ss 2026-10-03). Cancelling runs
    // the completion handler above with canceledLogin, which resolves the
    // pending start as cancelled.
    @objc func cancel(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.session?.cancel()
            self.session = nil
            call.resolve()
        }
    }
}

private class AuthSessionPresenter: NSObject, ASWebAuthenticationPresentationContextProviding {
    private let window: UIWindow?
    init(window: UIWindow?) { self.window = window }
    // GlitchTip 15 (2026-10-05): the view's window is nil for a moment after the
    // app comes back, and a fresh unattached anchor made the session refuse to
    // start (error 3). The key window of the moment the session asks is the
    // anchor; the captured window is the fallback, an empty anchor the last.
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let key = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
            .first { $0.isKeyWindow }
        return key ?? window ?? ASPresentationAnchor()
    }
}

// Main.storyboard names this controller so the plugin is registered on the
// bridge (the pattern Capacitor documents for a plugin that lives in the app)
class MunniViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(AuthSessionPlugin())
    }
}
