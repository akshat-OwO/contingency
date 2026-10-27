// Public audit fixture. Never exports the secure field's value.
#import <UIKit/UIKit.h>
#import <CommonCrypto/CommonDigest.h>

@interface App : UIResponder <UIApplicationDelegate>
@property(nonatomic, strong) UIWindow *window;
@property(nonatomic, strong) UITextField *field;
@end
@implementation App
- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)options {
    self.window = [[UIWindow alloc] initWithFrame:UIScreen.mainScreen.bounds];
    UIViewController *controller = [UIViewController new];
    controller.view.backgroundColor = UIColor.whiteColor;
    self.field = [[UITextField alloc] initWithFrame:CGRectMake(24, 180, 340, 60)];
    self.field.secureTextEntry = YES;
    self.field.accessibilityIdentifier = @"private-password";
    self.field.accessibilityLabel = @"Private password";
    self.field.placeholder = @"Private password";
    self.field.borderStyle = UITextBorderStyleRoundedRect;
    self.field.autocorrectionType = UITextAutocorrectionTypeNo;
    self.field.spellCheckingType = UITextSpellCheckingTypeNo;
    self.field.textContentType = UITextContentTypePassword;
    [self.field addTarget:self action:@selector(changed:) forControlEvents:UIControlEventEditingChanged];
    [controller.view addSubview:self.field];
    self.window.rootViewController = controller;
    [self.window makeKeyAndVisible];
    return YES;
}
- (void)changed:(UITextField *)field {
    NSData *bytes = [field.text dataUsingEncoding:NSUTF8StringEncoding];
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256(bytes.bytes, (CC_LONG)bytes.length, digest);
    NSMutableString *hex = [NSMutableString new];
    for (NSUInteger i = 0; i < sizeof(digest); i++) [hex appendFormat:@"%02x", digest[i]];
    NSDictionary *receipt = @{@"sha256": hex, @"length": @(field.text.length), @"secure": @(field.secureTextEntry)};
    NSURL *documents = [[NSFileManager defaultManager] URLsForDirectory:NSDocumentDirectory inDomains:NSUserDomainMask].firstObject;
    NSData *json = [NSJSONSerialization dataWithJSONObject:receipt options:0 error:nil];
    [json writeToURL:[documents URLByAppendingPathComponent:@"readback.json"] atomically:YES];
}
@end
int main(int argc, char **argv) {
    @autoreleasepool { return UIApplicationMain(argc, argv, nil, NSStringFromClass(App.class)); }
}
