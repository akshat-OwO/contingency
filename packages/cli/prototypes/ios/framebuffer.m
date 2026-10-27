// Research-only CoreSimulator transport. No input or simulator mutation APIs.
#import <Foundation/Foundation.h>
#import <CoreImage/CoreImage.h>
#import <IOSurface/IOSurface.h>
#import <dlfcn.h>
#import <signal.h>
#import <unistd.h>

// Private selectors, checked at runtime. Xcode changes can break this helper.
@interface NSObject (SimulatorCapture)
+ (id)sharedServiceContextForDeveloperDir:(NSString *)dir error:(NSError **)error;
- (id)defaultDeviceSetWithError:(NSError **)error;
- (NSArray *)availableDevices;
- (NSUUID *)UDID;
- (NSUInteger)state;
- (id)io;
- (NSArray *)ioPorts;
- (id)descriptor;
- (NSUUID *)uuid;
- (id)framebufferSurface;
- (void)registerScreenCallbacksWithUUID:(NSUUID *)token
                        callbackQueue:(dispatch_queue_t)queue
                        frameCallback:(void (^)(void))frame
              surfacesChangedCallback:(void (^)(id, id))surfaces
            propertiesChangedCallback:(void (^)(id))properties;
- (void)unregisterScreenCallbacksWithUUID:(NSUUID *)token;
@end

static volatile sig_atomic_t stopped = 0;
static void stopCapture(int signalNumber) { stopped = 1; }
static double nowMs(void) { return NSProcessInfo.processInfo.systemUptime * 1000; }
static void fail(NSString *message) {
    fprintf(stderr, "%s\n", message.UTF8String);
    exit(1);
}

int main(int argc, char **argv) {
    @autoreleasepool {
        if (argc != 4) fail(@"Usage: framebuffer <developer-dir> <simulator-uuid> <display-port-uuid>");
        signal(SIGTERM, stopCapture);
        signal(SIGINT, stopCapture);
        signal(SIGPIPE, stopCapture);
        NSString *developer = @(argv[1]);
        if (!dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW | RTLD_GLOBAL))
            fail(@"CoreSimulator unavailable");
        NSError *error = nil;
        id context = [NSClassFromString(@"SimServiceContext") sharedServiceContextForDeveloperDir:developer error:&error];
        id set = [context defaultDeviceSetWithError:&error];
        id device = nil;
        for (id candidate in [set availableDevices]) {
            if ([[candidate UDID].UUIDString isEqualToString:@(argv[2])]) device = candidate;
        }
        if (!device || [device state] != 3) fail(@"Selected simulator must already be booted");
        id io = [device io];
        id screen = nil;
        for (id port in [io ioPorts]) {
            if ([[port uuid].UUIDString isEqualToString:@(argv[3])]) screen = [port descriptor];
        }
        SEL registration = @selector(registerScreenCallbacksWithUUID:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:);
        if (!screen || ![screen respondsToSelector:registration]) fail(@"Selected display has no capture callbacks");
        NSUUID *token = NSUUID.UUID;
        dispatch_queue_t callbacks = dispatch_queue_create("contingency.ios.frames", DISPATCH_QUEUE_SERIAL);
        NSLock *lock = [NSLock new];
        __block uint64_t sourceSequence = 0;
        __block double presentedMs = 0;
        CIContext *images = [CIContext contextWithOptions:@{kCIContextCacheIntermediates: @NO}];
        CGColorSpaceRef color = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
        // Contingency sends Start on stdin. Resolve identity without subscribing first.
        char command[32];
        fprintf(stderr, "ready\n");
        if (!fgets(command, sizeof(command), stdin) || strcmp(command, "start\n") != 0) return 2;
        double startMs = nowMs();
        @try {
            [screen registerScreenCallbacksWithUUID:token callbackQueue:callbacks frameCallback:^{
                [lock lock]; sourceSequence++; presentedMs = nowMs(); [lock unlock];
            } surfacesChangedCallback:^(id primary, id masked) {
                // Read the current surface for each sample, including after a replacement.
            } propertiesChangedCallback:^(id properties) {}];
        } @catch (NSException *exception) { fail(@"Capture callback registration failed"); }
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
            char stop[32];
            while (fgets(stop, sizeof(stop), stdin)) {
                if (strcmp(stop, "stop\n") == 0) break;
            }
            stopped = 1; // EOF also releases a parent-owned helper.
        });
        uint64_t sequence = 0;
        while (!stopped) {
            @autoreleasepool {
                double sampledMs = nowMs();
                [lock lock]; uint64_t source = sourceSequence; double presented = presentedMs; [lock unlock];
                @try {
                    IOSurfaceRef surface = (__bridge IOSurfaceRef)[screen framebufferSurface];
                    if (!surface) fail(@"Selected display lost its framebuffer");
                    CIImage *image = [CIImage imageWithIOSurface:surface];
                    CGFloat scale = MIN(1.0, 720.0 / image.extent.size.width);
                    image = [image imageByApplyingTransform:CGAffineTransformMakeScale(scale, scale)];
                    NSData *jpeg = [images JPEGRepresentationOfImage:image colorSpace:color options:@{(__bridge NSString *)kCGImageDestinationLossyCompressionQuality: @0.65}];
                    if (!jpeg) fail(@"JPEG encoding failed");
                    NSDictionary *packet = @{@"sequence": @(++sequence), @"sourceSequence": @(source),
                        @"sampledMs": @(sampledMs), @"presentedMs": @(presented), @"startMs": @(startMs),
                        @"encodedMs": @(nowMs()), @"jpeg": [jpeg base64EncodedStringWithOptions:0]};
                    NSData *line = [NSJSONSerialization dataWithJSONObject:packet options:0 error:&error];
                    if (stopped || !line) break;
                    fwrite(line.bytes, 1, line.length, stdout); fputc('\n', stdout); fflush(stdout);
                } @catch (NSException *exception) { fail(@"Framebuffer capture failed"); }
                // Prototype sampling cadence, never a test synchronization primitive.
                double remaining = 1000.0 / 30.0 - (nowMs() - sampledMs);
                if (remaining > 0) usleep((useconds_t)(remaining * 1000));
            }
        }
        @try { [screen unregisterScreenCallbacksWithUUID:token]; }
        @catch (NSException *exception) { fprintf(stderr, "callback cleanup failed\n"); return 1; }
        dispatch_sync(callbacks, ^{});
        CGColorSpaceRelease(color);
        fprintf(stderr, "stopped frames=%llu\n", (unsigned long long)sequence);
    }
    return 0;
}
