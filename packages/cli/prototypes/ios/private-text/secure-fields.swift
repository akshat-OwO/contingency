// Public readback fixture: one UIKit secure UITextField and one SwiftUI SecureField.
// FIXTURE_FOCUS selects which field becomes first responder at launch.
import SwiftUI
import UIKit

final class FocusRequest: ObservableObject {
    @Published var swiftUISecureFieldFocused = false
}

struct SwiftUISecureForm: View {
    @ObservedObject var request: FocusRequest
    @State private var password = ""
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("SwiftUI")
            SecureField("SwiftUI password", text: $password)
                .textFieldStyle(.roundedBorder)
                .focused($focused)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .accessibilityIdentifier("swiftui-password")
        }
        .padding(24)
        .onChange(of: request.swiftUISecureFieldFocused) { _, value in
            focused = value
        }
    }
}

final class FixtureViewController: UIViewController {
    private let request = FocusRequest()
    private let uikitField = UITextField(frame: CGRect(x: 24, y: 160, width: 340, height: 50))

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .white
        uikitField.isSecureTextEntry = true
        uikitField.borderStyle = .roundedRect
        uikitField.placeholder = "UIKit password"
        uikitField.accessibilityIdentifier = "uikit-password"
        uikitField.autocorrectionType = .no
        uikitField.spellCheckingType = .no
        uikitField.autocapitalizationType = .none
        uikitField.textContentType = .password
        view.addSubview(uikitField)

        let host = UIHostingController(rootView: SwiftUISecureForm(request: request))
        addChild(host)
        host.view.frame = CGRect(x: 0, y: 260, width: view.bounds.width, height: 200)
        host.view.autoresizingMask = [.flexibleWidth]
        view.addSubview(host.view)
        host.didMove(toParent: self)

        let target = ProcessInfo.processInfo.environment["FIXTURE_FOCUS"]
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            guard let self else { return }
            if target == "uikit" { self.uikitField.becomeFirstResponder() }
            if target == "swiftui" { self.request.swiftUISecureFieldFocused = true }
        }
    }
}

@main
final class FixtureAppDelegate: UIResponder, UIApplicationDelegate {
    // iOS 27 rejects window-based apps without scene lifecycle adoption.
    func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        UISceneConfiguration(name: "Default", sessionRole: connectingSceneSession.role)
    }
}

final class FixtureSceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = FixtureViewController()
        window.makeKeyAndVisible()
        self.window = window
    }
}
