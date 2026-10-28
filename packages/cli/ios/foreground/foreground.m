// Read-only foreground authority for the exact Session Simulator that spawns this process.
#import <Foundation/Foundation.h>
#import <dlfcn.h>
#import <objc/message.h>
#import <unistd.h>

static NSDictionary *owner(void) {
    Class element = NSClassFromString(@"AXElement");
    SEL primary = NSSelectorFromString(@"primaryApp");
    SEL bundle = NSSelectorFromString(@"bundleId");
    SEL pid = NSSelectorFromString(@"pid");
    if (![element respondsToSelector:primary]) return nil;
    id app = ((id (*)(id, SEL))objc_msgSend)(element, primary);
    if (![app respondsToSelector:bundle] || ![app respondsToSelector:pid]) return nil;
    id identifier = ((id (*)(id, SEL))objc_msgSend)(app, bundle);
    int process = ((int (*)(id, SEL))objc_msgSend)(app, pid);
    if (![identifier isKindOfClass:NSString.class] || ![identifier length] || process <= 0) return nil;
    return @{@"bundleId": identifier, @"pid": @(process)};
}

int main(void) {
    @autoreleasepool {
        // simctl cancellation must not leave a guest blocked in a private AX call.
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 4 * NSEC_PER_SEC),
                       dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{ _exit(1); });
        @try {
            NSString *udid = NSProcessInfo.processInfo.environment[@"SIMULATOR_UDID"];
            if (!udid.length || !dlopen("/System/Library/PrivateFrameworks/AXRuntime.framework/AXRuntime", RTLD_NOW)) return 1;
            bool (*enabled)(void) = dlsym(RTLD_DEFAULT, "_AXSAutomationEnabled");
            if (!enabled || !enabled()) return 1;
            NSDictionary *first = owner();
            NSDictionary *second = owner();
            if (!first || ![first isEqual:second]) return 1;
            NSData *data = [NSJSONSerialization dataWithJSONObject:@{
                @"version": @1, @"udid": udid, @"owner": second
            } options:0 error:nil];
            if (!data) return 1;
            return fwrite(data.bytes, 1, data.length, stdout) == data.length ? 0 : 1;
        } @catch (NSException *exception) {
            // No native diagnostics: every unavailable or ambiguous result fails closed.
            return 1;
        }
    }
}
