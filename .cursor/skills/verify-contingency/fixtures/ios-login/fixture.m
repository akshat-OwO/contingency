// Public-only simulator fixture for the iOS Workspace journey.
#import <UIKit/UIKit.h>
#import <UserNotifications/UserNotifications.h>
@interface App : UIResponder <UIApplicationDelegate>
@end
@implementation App
@end
@interface Fixture : UIResponder <UIWindowSceneDelegate>
@property(nonatomic, strong) UIWindow *window;
@property(nonatomic, strong) UITextField *name;
@property(nonatomic, copy) NSString *login;
@end
@implementation Fixture
- (UIButton *)button:(NSString *)title action:(SEL)action {
    UIButton *button = [UIButton buttonWithType:UIButtonTypeSystem];
    [button setTitle:title forState:UIControlStateNormal];
    [button addTarget:self action:action forControlEvents:UIControlEventTouchUpInside];
    return button;
}
- (UILabel *)label:(NSString *)text {
    UILabel *label = [UILabel new]; label.text = text; label.textColor = UIColor.labelColor; return label;
}
- (void)show:(NSArray<UIView *> *)views {
    UIViewController *controller = [UIViewController new];
    controller.view.backgroundColor = UIColor.systemBackgroundColor;
    UIStackView *stack = [[UIStackView alloc] initWithArrangedSubviews:views];
    stack.axis = UILayoutConstraintAxisVertical; stack.spacing = 20; stack.translatesAutoresizingMaskIntoConstraints = NO;
    [controller.view addSubview:stack];
    [NSLayoutConstraint activateConstraints:@[
        [stack.leadingAnchor constraintEqualToAnchor:controller.view.safeAreaLayoutGuide.leadingAnchor constant:24],
        [stack.trailingAnchor constraintEqualToAnchor:controller.view.safeAreaLayoutGuide.trailingAnchor constant:-24],
        [stack.topAnchor constraintEqualToAnchor:controller.view.safeAreaLayoutGuide.topAnchor constant:32]
    ]];
    self.window.rootViewController = controller;
}
- (void)signIn {
    self.login = self.name.text.length ? self.name.text : @"Public shopper";
    [self account];
}
- (void)account {
    [self show:@[[self label:[@"Signed in as " stringByAppendingString:self.login]],
        [self button:@"Open account" action:@selector(details)],
        [self button:@"Request notifications permission" action:@selector(permission)],
        [self button:@"Open device settings" action:@selector(settings)]]];
}
- (void)details {
    [self show:@[[self label:@"Account details"], [self button:@"Return to account" action:@selector(account)]]];
}
- (void)permission { [UNUserNotificationCenter.currentNotificationCenter requestAuthorizationWithOptions:UNAuthorizationOptionAlert completionHandler:^(BOOL granted, NSError *error) {}]; }
- (void)settings { [UIApplication.sharedApplication openURL:[NSURL URLWithString:UIApplicationOpenSettingsURLString] options:@{} completionHandler:nil]; }
- (void)scene:(UIScene *)scene willConnectToSession:(UISceneSession *)session options:(UISceneConnectionOptions *)options {
    self.window = [[UIWindow alloc] initWithWindowScene:(UIWindowScene *)scene];
    self.name = [UITextField new]; self.name.placeholder = @"Login name"; self.name.accessibilityLabel = @"Login name";
    self.name.borderStyle = UITextBorderStyleRoundedRect; self.name.autocorrectionType = UITextAutocorrectionTypeNo;
    [self show:@[[self label:@"Public login fixture"], self.name, [self button:@"Sign in" action:@selector(signIn)]]];
    [self.window makeKeyAndVisible];
}
@end
int main(int argc, char **argv) { @autoreleasepool { return UIApplicationMain(argc, argv, nil, NSStringFromClass(App.class)); } }
