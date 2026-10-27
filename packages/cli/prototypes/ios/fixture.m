// Public, disposable motion fixture. Install only on a spike-owned simulator.
#import <UIKit/UIKit.h>

@interface App : UIResponder <UIApplicationDelegate>
@end
@implementation App
@end

@interface Fixture : UIResponder <UIWindowSceneDelegate>
@property(nonatomic, strong) UIWindow *window;
@property(nonatomic, strong) UILabel *label;
@property(nonatomic, strong) UIView *square;
@property(nonatomic, strong) CADisplayLink *clock;
@property(nonatomic) NSUInteger frame;
@end
@implementation Fixture
- (void)scene:(UIScene *)scene willConnectToSession:(UISceneSession *)session options:(UISceneConnectionOptions *)options {
    self.window = [[UIWindow alloc] initWithWindowScene:(UIWindowScene *)scene];
    UIViewController *controller = [UIViewController new];
    controller.view.backgroundColor = UIColor.whiteColor;
    self.label = [[UILabel alloc] initWithFrame:CGRectMake(20, 80, 400, 100)];
    self.label.textColor = UIColor.blackColor;
    self.label.numberOfLines = 2;
    [controller.view addSubview:self.label];
    self.square = [[UIView alloc] initWithFrame:CGRectMake(20, 240, 80, 80)];
    self.square.backgroundColor = UIColor.blueColor;
    [controller.view addSubview:self.square];
    self.window.rootViewController = controller;
    [self.window makeKeyAndVisible];
    self.clock = [CADisplayLink displayLinkWithTarget:self selector:@selector(tick:)];
    [self.clock addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
}
- (void)tick:(CADisplayLink *)clock {
    self.frame++;
    self.label.text = [NSString stringWithFormat:@"Contingency stream fixture\nFrame %lu", (unsigned long)self.frame];
    self.square.frame = CGRectMake(20 + self.frame % 220, 240, 80, 80);
}
@end
int main(int argc, char **argv) {
    @autoreleasepool { return UIApplicationMain(argc, argv, nil, NSStringFromClass(App.class)); }
}
