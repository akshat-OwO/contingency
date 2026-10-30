// Contingency-owned display transport. No input or simulator mutation APIs.
#import <Foundation/Foundation.h>
#import <CoreImage/CoreImage.h>
#import <ImageIO/ImageIO.h>
#import <IOSurface/IOSurface.h>
#import <dlfcn.h>
#import <signal.h>
#import <unistd.h>
#import <math.h>
#import <time.h>

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
// CLOCK_MONOTONIC_RAW matches Node's uv_hrtime, including host sleep.
static double nowMs(void) {
    struct timespec time;
    clock_gettime(CLOCK_MONOTONIC_RAW, &time);
    return time.tv_sec * 1000.0 + time.tv_nsec / 1000000.0;
}
static void fail(NSString *message) {
    fprintf(stderr, "%s\n", message.UTF8String);
    exit(1);
}

static CGImagePropertyOrientation orientationFor(NSString *value) {
    if ([value isEqualToString:@"portrait"]) return kCGImagePropertyOrientationUp;
    if ([value isEqualToString:@"portrait-upside-down"]) return kCGImagePropertyOrientationDown;
    if ([value isEqualToString:@"landscape-left"]) return kCGImagePropertyOrientationRight;
    if ([value isEqualToString:@"landscape-right"]) return kCGImagePropertyOrientationLeft;
    fail(@"Unknown integrated display orientation");
    return kCGImagePropertyOrientationUp;
}

int main(int argc, char **argv) {
    @autoreleasepool {
        if (argc != 5) fail(@"Usage: framebuffer <developer-dir> <simulator-uuid> <display-port-uuid> <orientation>");
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
        NSString *displayUUID = @(argv[3]);
        __block NSString *requestedDisplay = displayUUID;
        __block CGImagePropertyOrientation requestedOrientation = orientationFor(@(argv[4]));
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
            char stop[128];
            while (fgets(stop, sizeof(stop), stdin)) {
                if (strcmp(stop, "stop\n") == 0) break;
                if (strncmp(stop, "orientation ", 12) == 0) {
                    NSString *value = [@(stop + 12) stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
                    CGImagePropertyOrientation next = orientationFor(value);
                    [lock lock]; requestedOrientation = next; [lock unlock];
                }
                if (strncmp(stop, "display ", 8) == 0) {
                    NSString *value = [@(stop + 8) stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
                    NSUUID *next = [[NSUUID alloc] initWithUUIDString:value];
                    if (!next) break;
                    [lock lock]; requestedDisplay = next.UUIDString; [lock unlock];
                }
            }
            stopped = 1; // EOF also releases a parent-owned helper.
        });
        uint64_t sequence = 0;
        while (!stopped) {
            @autoreleasepool {
                [lock lock]; NSString *nextDisplay = requestedDisplay; [lock unlock];
                if (![displayUUID isEqualToString:nextDisplay]) {
                    id replacement = nil;
                    for (id port in [io ioPorts]) {
                        if ([[port uuid].UUIDString isEqualToString:nextDisplay]) replacement = [port descriptor];
                    }
                    if (!replacement || ![replacement respondsToSelector:registration]) fail(@"Active integrated display unavailable");
                    @try {
                        [screen unregisterScreenCallbacksWithUUID:token];
                        dispatch_sync(callbacks, ^{});
                        screen = replacement;
                        [screen registerScreenCallbacksWithUUID:token callbackQueue:callbacks frameCallback:^{
                            [lock lock]; sourceSequence++; presentedMs = nowMs(); [lock unlock];
                        } surfacesChangedCallback:^(id primary, id masked) {} propertiesChangedCallback:^(id properties) {}];
                        displayUUID = nextDisplay;
                    } @catch (NSException *exception) { fail(@"Active integrated display rebind failed"); }
                }
                double sampledMs = nowMs();
                [lock lock]; uint64_t source = sourceSequence; double presented = presentedMs; [lock unlock];
                @try {
                    IOSurfaceRef surface = (__bridge IOSurfaceRef)[screen framebufferSurface];
                    if (!surface) fail(@"Selected display lost its framebuffer");
                    [lock lock]; CGImagePropertyOrientation orientation = requestedOrientation; [lock unlock];
                    CIImage *image = [[CIImage imageWithIOSurface:surface] imageByApplyingOrientation:orientation];
                    CGFloat scale = MIN(1.0, 720.0 / image.extent.size.width);
                    image = [image imageByApplyingTransform:CGAffineTransformMakeScale(scale, scale)];
                    image = [image imageByCroppingToRect:CGRectMake(0, 0, floor(image.extent.size.width), floor(image.extent.size.height))];
                    NSData *jpeg = [images JPEGRepresentationOfImage:image colorSpace:color options:@{(__bridge NSString *)kCGImageDestinationLossyCompressionQuality: @0.65}];
                    if (!jpeg) fail(@"JPEG encoding failed");
                    NSDictionary *packet = @{@"displayPort": displayUUID, @"sequence": @(++sequence), @"sourceSequence": @(source),
                        @"sampledMs": @(sampledMs), @"presentedMs": @(presented), @"startMs": @(startMs),
                        @"encodedMs": @(nowMs()),
                        @"width": @(image.extent.size.width), @"height": @(image.extent.size.height),
                        @"jpeg": [jpeg base64EncodedStringWithOptions:0]};
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
