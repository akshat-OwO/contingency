// Widget corpus for native observation coverage. Each screen exposes one family
// of UIKit primitives that real apps use, and every interaction writes the
// `Last action:` label so a capture or proof can read its outcome.
#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>
@interface App : UIResponder <UIApplicationDelegate>
@end
@implementation App
@end
@interface Corpus : UIResponder <UIWindowSceneDelegate, UITableViewDataSource, UITableViewDelegate, UISearchBarDelegate>
@property(nonatomic, strong) UIWindow *window;
@property(nonatomic, strong) NSMutableArray<UILabel *> *outcomes;
@end
@implementation Corpus
- (void)record:(NSString *)action {
    for (UILabel *label in self.outcomes) { label.text = [@"Last action: " stringByAppendingString:action]; }
}
- (UILabel *)outcome {
    UILabel *label = [UILabel new]; label.text = @"Last action: none"; label.textColor = UIColor.labelColor;
    [self.outcomes addObject:label]; return label;
}
- (UIButton *)button:(NSString *)title action:(SEL)action {
    UIButton *button = [UIButton buttonWithType:UIButtonTypeSystem];
    [button setTitle:title forState:UIControlStateNormal];
    [button addTarget:self action:action forControlEvents:UIControlEventTouchUpInside];
    return button;
}
- (UIViewController *)stackScreen:(NSString *)title views:(NSArray<UIView *> *)views {
    UIViewController *controller = [UIViewController new];
    controller.title = title; controller.view.backgroundColor = UIColor.systemBackgroundColor;
    UIScrollView *scroll = [UIScrollView new]; scroll.translatesAutoresizingMaskIntoConstraints = NO;
    UIStackView *stack = [[UIStackView alloc] initWithArrangedSubviews:views];
    stack.axis = UILayoutConstraintAxisVertical; stack.spacing = 16; stack.translatesAutoresizingMaskIntoConstraints = NO;
    [controller.view addSubview:scroll]; [scroll addSubview:stack];
    UILayoutGuide *safe = controller.view.safeAreaLayoutGuide;
    [NSLayoutConstraint activateConstraints:@[
        [scroll.leadingAnchor constraintEqualToAnchor:safe.leadingAnchor], [scroll.trailingAnchor constraintEqualToAnchor:safe.trailingAnchor],
        [scroll.topAnchor constraintEqualToAnchor:safe.topAnchor], [scroll.bottomAnchor constraintEqualToAnchor:safe.bottomAnchor],
        [stack.leadingAnchor constraintEqualToAnchor:scroll.contentLayoutGuide.leadingAnchor constant:20],
        [stack.trailingAnchor constraintEqualToAnchor:scroll.contentLayoutGuide.trailingAnchor constant:-20],
        [stack.topAnchor constraintEqualToAnchor:scroll.contentLayoutGuide.topAnchor constant:16],
        [stack.bottomAnchor constraintEqualToAnchor:scroll.contentLayoutGuide.bottomAnchor constant:-16],
        [stack.widthAnchor constraintEqualToAnchor:scroll.frameLayoutGuide.widthAnchor constant:-40]
    ]];
    return controller;
}
// Controls: the UIControl family.
- (void)switched:(UISwitch *)control { [self record:control.on ? @"Notifications on" : @"Notifications off"]; }
- (void)segmented:(UISegmentedControl *)control { [self record:[@"Size " stringByAppendingString:[control titleForSegmentAtIndex:control.selectedSegmentIndex]]]; }
- (void)slid:(UISlider *)control { [self record:[NSString stringWithFormat:@"Volume %.0f", control.value]]; }
- (void)stepped:(UIStepper *)control { [self record:[NSString stringWithFormat:@"Quantity %.0f", control.value]]; }
- (void)iconTapped { [self record:@"Favorite"]; }
- (void)plainTapped { [self record:@"Continue"]; }
- (void)dated { [self record:@"Delivery date"]; }
- (void)alert {
    UIAlertController *alert = [UIAlertController alertControllerWithTitle:@"Remove item?" message:@"This removes the item from the cart." preferredStyle:UIAlertControllerStyleAlert];
    [alert addAction:[UIAlertAction actionWithTitle:@"Cancel" style:UIAlertActionStyleCancel handler:^(UIAlertAction *a) { [self record:@"Alert cancel"]; }]];
    [alert addAction:[UIAlertAction actionWithTitle:@"Remove" style:UIAlertActionStyleDestructive handler:^(UIAlertAction *a) { [self record:@"Alert remove"]; }]];
    [self.window.rootViewController presentViewController:alert animated:NO completion:nil];
}
- (void)actionSheet {
    UIAlertController *sheet = [UIAlertController alertControllerWithTitle:@"Share order" message:nil preferredStyle:UIAlertControllerStyleActionSheet];
    [sheet addAction:[UIAlertAction actionWithTitle:@"Copy link" style:UIAlertActionStyleDefault handler:^(UIAlertAction *a) { [self record:@"Sheet copy"]; }]];
    [sheet addAction:[UIAlertAction actionWithTitle:@"Cancel" style:UIAlertActionStyleCancel handler:^(UIAlertAction *a) { [self record:@"Sheet cancel"]; }]];
    [self.window.rootViewController presentViewController:sheet animated:NO completion:nil];
}
- (void)modal {
    UIViewController *modal = [self stackScreen:@"Promo" views:@[[self button:@"Close promo" action:@selector(closeModal)]]];
    UINavigationController *navigation = [[UINavigationController alloc] initWithRootViewController:modal];
    [self.window.rootViewController presentViewController:navigation animated:NO completion:nil];
}
- (void)closeModal { [self.window.rootViewController dismissViewControllerAnimated:NO completion:^{ [self record:@"Promo closed"]; }]; }
- (UIViewController *)controls {
    UISwitch *toggle = [UISwitch new]; toggle.accessibilityLabel = @"Notifications";
    [toggle addTarget:self action:@selector(switched:) forControlEvents:UIControlEventValueChanged];
    UISegmentedControl *segments = [[UISegmentedControl alloc] initWithItems:@[@"Small", @"Medium", @"Large"]];
    segments.accessibilityLabel = @"Size"; [segments addTarget:self action:@selector(segmented:) forControlEvents:UIControlEventValueChanged];
    UISlider *slider = [UISlider new]; slider.minimumValue = 0; slider.maximumValue = 10; slider.value = 5; slider.accessibilityLabel = @"Volume";
    [slider addTarget:self action:@selector(slid:) forControlEvents:UIControlEventValueChanged];
    UIStepper *stepper = [UIStepper new]; stepper.accessibilityLabel = @"Quantity";
    [stepper addTarget:self action:@selector(stepped:) forControlEvents:UIControlEventValueChanged];
    UIButton *icon = [UIButton buttonWithType:UIButtonTypeSystem];
    [icon setImage:[UIImage systemImageNamed:@"heart"] forState:UIControlStateNormal]; icon.accessibilityLabel = @"Favorite";
    [icon addTarget:self action:@selector(iconTapped) forControlEvents:UIControlEventTouchUpInside];
    UIButton *filled = [UIButton buttonWithConfiguration:UIButtonConfiguration.filledButtonConfiguration primaryAction:nil];
    [filled setTitle:@"Continue" forState:UIControlStateNormal]; [filled addTarget:self action:@selector(plainTapped) forControlEvents:UIControlEventTouchUpInside];
    UIButton *disabled = [self button:@"Unavailable" action:@selector(plainTapped)]; disabled.enabled = NO;
    UIDatePicker *date = [UIDatePicker new]; date.datePickerMode = UIDatePickerModeDate; date.preferredDatePickerStyle = UIDatePickerStyleCompact;
    date.accessibilityLabel = @"Delivery date"; [date addTarget:self action:@selector(dated) forControlEvents:UIControlEventValueChanged];
    UITextField *email = [UITextField new]; email.placeholder = @"Email"; email.accessibilityLabel = @"Email"; email.keyboardType = UIKeyboardTypeEmailAddress;
    email.borderStyle = UITextBorderStyleRoundedRect; email.autocorrectionType = UITextAutocorrectionTypeNo;
    UITextField *code = [UITextField new]; code.placeholder = @"Postal code"; code.accessibilityLabel = @"Postal code"; code.keyboardType = UIKeyboardTypeNumberPad;
    code.borderStyle = UITextBorderStyleRoundedRect;
    UITextField *secret = [UITextField new]; secret.placeholder = @"Card PIN"; secret.accessibilityLabel = @"Card PIN"; secret.secureTextEntry = YES;
    secret.borderStyle = UITextBorderStyleRoundedRect;
    UITextView *notes = [UITextView new]; notes.accessibilityLabel = @"Delivery notes"; notes.font = [UIFont preferredFontForTextStyle:UIFontTextStyleBody];
    notes.layer.borderWidth = 1; notes.layer.borderColor = UIColor.separatorColor.CGColor; [notes.heightAnchor constraintEqualToConstant:80].active = YES;
    UISearchBar *search = [UISearchBar new]; search.placeholder = @"Search products"; search.accessibilityLabel = @"Search products"; search.delegate = self;
    return [self stackScreen:@"Controls" views:@[[self outcome],
        [self button:@"Show alert" action:@selector(alert)], [self button:@"Show action sheet" action:@selector(actionSheet)], [self button:@"Show promo" action:@selector(modal)],
        toggle, segments, slider, stepper, icon, filled, disabled, date, email, code, secret, notes, search]];
}
- (void)searchBarSearchButtonClicked:(UISearchBar *)bar { [self record:[@"Search " stringByAppendingString:bar.text ?: @""]]; }
// List: table cells, accessories, sections, and off-screen rows.
- (NSInteger)numberOfSectionsInTableView:(UITableView *)table { return 2; }
- (NSString *)tableView:(UITableView *)table titleForHeaderInSection:(NSInteger)section { return section == 0 ? @"Pinned" : @"All products"; }
- (NSInteger)tableView:(UITableView *)table numberOfRowsInSection:(NSInteger)section { return section == 0 ? 2 : 60; }
- (UITableViewCell *)tableView:(UITableView *)table cellForRowAtIndexPath:(NSIndexPath *)path {
    UITableViewCell *cell = [table dequeueReusableCellWithIdentifier:@"row"] ?: [[UITableViewCell alloc] initWithStyle:UITableViewCellStyleSubtitle reuseIdentifier:@"row"];
    cell.textLabel.text = path.section == 0 ? (path.row == 0 ? @"Anvil" : @"Rocket skates") : [NSString stringWithFormat:@"Product %ld", (long)path.row + 1];
    cell.detailTextLabel.text = [NSString stringWithFormat:@"$%ld.00", (long)(path.row + 1) * 7];
    cell.accessoryType = path.section == 0 ? UITableViewCellAccessoryDisclosureIndicator : UITableViewCellAccessoryNone;
    return cell;
}
- (void)tableView:(UITableView *)table didSelectRowAtIndexPath:(NSIndexPath *)path {
    [table deselectRowAtIndexPath:path animated:NO];
    [self record:[@"Row " stringByAppendingString:[table cellForRowAtIndexPath:path].textLabel.text]];
}
- (UISwipeActionsConfiguration *)tableView:(UITableView *)table trailingSwipeActionsConfigurationForRowAtIndexPath:(NSIndexPath *)path {
    return [UISwipeActionsConfiguration configurationWithActions:@[[UIContextualAction contextualActionWithStyle:UIContextualActionStyleDestructive title:@"Delete" handler:^(UIContextualAction *a, UIView *v, void (^done)(BOOL)) { [self record:@"Swipe delete"]; done(YES); }]]];
}
- (UIViewController *)list {
    UIViewController *controller = [UIViewController new]; controller.title = @"List";
    UITableView *table = [[UITableView alloc] initWithFrame:CGRectZero style:UITableViewStyleInsetGrouped];
    table.dataSource = self; table.delegate = self; table.translatesAutoresizingMaskIntoConstraints = NO;
    UILabel *outcome = [self outcome]; outcome.translatesAutoresizingMaskIntoConstraints = NO;
    [controller.view addSubview:outcome]; [controller.view addSubview:table]; controller.view.backgroundColor = UIColor.systemBackgroundColor;
    UILayoutGuide *safe = controller.view.safeAreaLayoutGuide;
    [NSLayoutConstraint activateConstraints:@[
        [outcome.topAnchor constraintEqualToAnchor:safe.topAnchor constant:8], [outcome.leadingAnchor constraintEqualToAnchor:safe.leadingAnchor constant:20],
        [table.topAnchor constraintEqualToAnchor:outcome.bottomAnchor constant:8], [table.leadingAnchor constraintEqualToAnchor:safe.leadingAnchor],
        [table.trailingAnchor constraintEqualToAnchor:safe.trailingAnchor], [table.bottomAnchor constraintEqualToAnchor:safe.bottomAnchor]
    ]];
    controller.navigationItem.rightBarButtonItem = [[UIBarButtonItem alloc] initWithTitle:@"Edit" style:UIBarButtonItemStylePlain target:self action:@selector(barEdit)];
    return controller;
}
- (void)barEdit { [self record:@"Bar Edit"]; }
// Web: WKWebView content inside a native app.
- (UIViewController *)web {
    UIViewController *controller = [UIViewController new]; controller.title = @"Web";
    WKWebView *view = [WKWebView new]; controller.view = view;
    [view loadHTMLString:@"<html><head><meta name=viewport content='width=device-width'></head><body style='font:20px -apple-system;padding:16px'>"
        "<h1>Embedded help</h1><a href='#faq' onclick=\"document.getElementById('out').textContent='Web link'\">Shipping FAQ</a>"
        "<p><label>Coupon <input aria-label='Coupon' id=coupon></label></p>"
        "<button onclick=\"document.getElementById('out').textContent='Web apply'\">Apply coupon</button>"
        "<p id=out>Web idle</p></body></html>" baseURL:nil];
    return controller;
}
- (void)scene:(UIScene *)scene willConnectToSession:(UISceneSession *)session options:(UISceneConnectionOptions *)options {
    self.outcomes = [NSMutableArray array];
    self.window = [[UIWindow alloc] initWithWindowScene:(UIWindowScene *)scene];
    UITabBarController *tabs = [UITabBarController new];
    NSArray *screens = @[[self controls], [self list], [self web]];
    NSArray *icons = @[@"slider.horizontal.3", @"list.bullet", @"globe"];
    NSMutableArray *navigations = [NSMutableArray array];
    [screens enumerateObjectsUsingBlock:^(UIViewController *screen, NSUInteger index, BOOL *stop) {
        UINavigationController *navigation = [[UINavigationController alloc] initWithRootViewController:screen];
        navigation.tabBarItem = [[UITabBarItem alloc] initWithTitle:screen.title image:[UIImage systemImageNamed:icons[index]] tag:(NSInteger)index];
        [navigations addObject:navigation];
    }];
    tabs.viewControllers = navigations;
    self.window.rootViewController = tabs;
    [self.window makeKeyAndVisible];
}
@end
int main(int argc, char **argv) { @autoreleasepool { return UIApplicationMain(argc, argv, nil, NSStringFromClass(App.class)); } }
