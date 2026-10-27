// Research-only in-process comparator, loaded at launch with DYLD_INSERT_LIBRARIES.
// It hashes the focused secure UITextField and writes only a verdict, hash, and length.
// It never writes field text. The expectation file holds a SHA-256 and length, not the value.
#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <CommonCrypto/CommonDigest.h>
#import <fcntl.h>
#import <sys/stat.h>
#import <signal.h>
#import <unistd.h>

static NSString *outputDirectory;
static NSString *expectationPath;
static dispatch_source_t verifySource;

static NSString *hexDigest(NSData *data) {
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
    NSMutableString *hex = [NSMutableString string];
    for (NSUInteger i = 0; i < sizeof(digest); i++) [hex appendFormat:@"%02x", digest[i]];
    return hex;
}

static void writePrivateFile(NSString *name, NSDictionary *object) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:object options:NSJSONWritingSortedKeys error:nil];
    NSString *path = [outputDirectory stringByAppendingPathComponent:name];
    int fd = open(path.fileSystemRepresentation, O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (fd < 0) return;
    fchmod(fd, 0600);
    write(fd, data.bytes, data.length);
    close(fd);
}

static UIView *firstResponderIn(UIView *view) {
    if (view.isFirstResponder) return view;
    for (UIView *child in view.subviews) {
        UIView *found = firstResponderIn(child);
        if (found) return found;
    }
    return nil;
}

static UITextField *focusedSecureField(void) {
    for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
        if (![scene isKindOfClass:UIWindowScene.class]) continue;
        for (UIWindow *window in ((UIWindowScene *)scene).windows) {
            UIView *responder = firstResponderIn(window);
            if (responder) return [responder isKindOfClass:UITextField.class] && ((UITextField *)responder).secureTextEntry ? (UITextField *)responder : nil;
        }
    }
    return nil;
}

static void verify(void) {
    NSData *expectationData = [NSData dataWithContentsOfFile:expectationPath];
    NSDictionary *expected = [NSJSONSerialization JSONObjectWithData:expectationData options:0 error:nil];
    NSString *expectedSha = expected[@"sha256"];
    NSUInteger expectedLength = [expected[@"length"] unsignedIntegerValue];
    UITextField *field = focusedSecureField();
    NSDictionary *verdict;
    if (!field) {
        verdict = @{@"verdict": @"unverified", @"reason": @"no_focused_secure_text_field"};
    } else {
        NSString *text = field.text ?: @"";
        NSString *sha = hexDigest([text dataUsingEncoding:NSUTF8StringEncoding]);
        BOOL exact = [sha isEqualToString:expectedSha] && text.length == expectedLength;
        verdict = @{
            @"verdict": exact ? @"verified" : @"unverified",
            @"reason": exact ? @"exact_match" : @"sha256_or_length_mismatch",
            @"fieldClass": NSStringFromClass(field.class),
            @"fieldLength": @(text.length),
            @"fieldSha256": sha,
            @"expectedLength": @(expectedLength),
            @"expectedSha256": expectedSha ?: @""
        };
    }
    writePrivateFile(@"verdict.json", verdict);
}

__attribute__((constructor)) static void readbackStart(void) {
    const char *output = getenv("CONTINGENCY_READBACK_OUT_DIR");
    const char *expectation = getenv("CONTINGENCY_READBACK_EXPECTATION");
    if (!output || !expectation) return;
    outputDirectory = @(output);
    expectationPath = @(expectation);
    [NSNotificationCenter.defaultCenter addObserverForName:UITextFieldTextDidBeginEditingNotification object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) {
        UITextField *field = note.object;
        if ([field isKindOfClass:UITextField.class] && field.secureTextEntry) {
            writePrivateFile(@"ready.json", @{@"secure": @YES, @"fieldClass": NSStringFromClass(field.class)});
        }
    }];
    signal(SIGUSR1, SIG_IGN);
    verifySource = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, SIGUSR1, 0, dispatch_get_main_queue());
    dispatch_source_set_event_handler(verifySource, ^{ verify(); });
    dispatch_resume(verifySource);
}
