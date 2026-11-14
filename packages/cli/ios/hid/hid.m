// Contingency-owned Forwarded Input transport for one booted iOS Simulator.
// It injects the user's Workspace pointer and key input through SimulatorKit's
// private Indigo HID client, the path Simulator.app itself uses. No other
// simulator mutation API is reachable. Xcode changes can break it, so the iOS
// Support Matrix pins the Xcode versions it is proven on.
//
// Input: one command per stdin line, applied in order.
//   touch <down|move|up> <x> <y>   x and y are fractions of the screen
//   key <down|up> <usage>          a USB HID keyboard-page usage
// Output: "ready <width> <height>" once, then nothing unless a command fails.
#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <dlfcn.h>
#import <unistd.h>
#import <signal.h>
#import <stdio.h>
#import <stdlib.h>
#import <string.h>
#import <math.h>

@interface NSObject (SimulatorHID)
+ (id)sharedServiceContextForDeveloperDir:(NSString *)dir error:(NSError **)error;
- (id)defaultDeviceSetWithError:(NSError **)error;
- (NSArray *)availableDevices;
- (NSUUID *)UDID;
- (NSUInteger)state;
- (id)deviceType;
- (CGSize)mainScreenSize;
- (float)mainScreenScale;
- (instancetype)initWithDevice:(id)device error:(NSError **)error;
- (void)sendWithMessage:(void *)message
           freeWhenDone:(BOOL)free
        completionQueue:(dispatch_queue_t)queue
             completion:(void (^)(NSError *))completion;
@end

typedef void *(*MouseMessage)(CGPoint *point, CGPoint *second, uint32_t target,
                              NSEventType type, uint64_t edge, CGSize size);
typedef void *(*KeyMessage)(uint32_t usage, uint32_t operation);

// The touch digitizer of the simulator's main screen.
static const uint32_t mainScreenTarget = 0x32;

__attribute__((noreturn)) static void fail(NSString *message) {
    fprintf(stderr, "%s\n", message.UTF8String);
    exit(1);
}

int main(int argc, char **argv) {
    @autoreleasepool {
        if (argc != 3) fail(@"Usage: hid <developer-dir> <simulator-uuid>");
        signal(SIGPIPE, SIG_IGN);
        NSString *developer = @(argv[1]);
        if (!dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW | RTLD_GLOBAL))
            fail(@"CoreSimulator unavailable");
        NSString *kit = [[developer stringByDeletingLastPathComponent]
            stringByAppendingPathComponent:@"SharedFrameworks/SimulatorKit.framework/SimulatorKit"];
        void *simulatorKit = dlopen(kit.fileSystemRepresentation, RTLD_NOW | RTLD_GLOBAL);
        if (!simulatorKit) fail(@"SimulatorKit unavailable");
        MouseMessage mouse = (MouseMessage)dlsym(simulatorKit, "IndigoHIDMessageForMouseNSEvent");
        KeyMessage key = (KeyMessage)dlsym(simulatorKit, "IndigoHIDMessageForKeyboardArbitrary");
        Class clientClass = NSClassFromString(@"SimulatorKit.SimDeviceLegacyHIDClient");
        if (!mouse || !key || !clientClass) fail(@"SimulatorKit HID entry points unavailable");

        NSError *error = nil;
        id context = [NSClassFromString(@"SimServiceContext") sharedServiceContextForDeveloperDir:developer error:&error];
        id set = [context defaultDeviceSetWithError:&error];
        id device = nil;
        for (id candidate in [set availableDevices]) {
            if ([[candidate UDID].UUIDString isEqualToString:@(argv[2])]) device = candidate;
        }
        if (!device || [device state] != 3) fail(@"Selected simulator must already be booted");
        id type = [device deviceType];
        if (![type respondsToSelector:@selector(mainScreenSize)] || ![type respondsToSelector:@selector(mainScreenScale)])
            fail(@"Selected simulator reports no screen size");
        CGSize pixels = [type mainScreenSize];
        float scale = [type mainScreenScale];
        if (pixels.width <= 0 || pixels.height <= 0 || scale <= 0) fail(@"Selected simulator reports no screen size");
        // Indigo divides the point by the size, so points and size share one unit.
        CGSize screen = CGSizeMake(pixels.width / scale, pixels.height / scale);
        id client = [[clientClass alloc] initWithDevice:device error:&error];
        if (!client) fail(@"Could not open the simulator HID client");

        dispatch_queue_t queue = dispatch_queue_create("contingency.ios.hid", DISPATCH_QUEUE_SERIAL);
        __block BOOL failed = NO;
        void (^send)(void *) = ^(void *message) {
            if (!message) return;
            dispatch_semaphore_t sent = dispatch_semaphore_create(0);
            [client sendWithMessage:message freeWhenDone:YES completionQueue:queue completion:^(NSError *sendError) {
                if (sendError) failed = YES;
                dispatch_semaphore_signal(sent);
            }];
            dispatch_semaphore_wait(sent, DISPATCH_TIME_FOREVER);
        };
        printf("ready %.0f %.0f\n", screen.width, screen.height);
        fflush(stdout);

        char line[256];
        while (fgets(line, sizeof line, stdin)) {
            char kind[8] = {0};
            char action[8] = {0};
            double x = 0;
            double y = 0;
            unsigned int usage = 0;
            if (sscanf(line, "touch %7s %lf %lf", action, &x, &y) == 3) {
                if (x < 0 || x > 1 || y < 0 || y > 1) fail(@"Touch point outside the screen");
                NSEventType eventType;
                if (strcmp(action, "down") == 0) eventType = NSEventTypeLeftMouseDown;
                else if (strcmp(action, "move") == 0) eventType = NSEventTypeLeftMouseDragged;
                else if (strcmp(action, "up") == 0) eventType = NSEventTypeLeftMouseUp;
                else fail(@"Unknown touch action");
                CGPoint point = CGPointMake(x * screen.width, y * screen.height);
                // Indigo drops a drag sent within 16 ms of the previous one, so
                // Contingency spaces drags before they reach the helper.
                send(mouse(&point, NULL, mainScreenTarget, eventType, 0, screen));
            } else if (sscanf(line, "key %7s %u", action, &usage) == 2) {
                uint32_t operation;
                if (strcmp(action, "down") == 0) operation = 1;
                else if (strcmp(action, "up") == 0) operation = 2;
                else fail(@"Unknown key action");
                if (usage == 0 || usage > 0xff) fail(@"Unknown key usage");
                send(key(usage, operation));
            } else if (sscanf(line, "%7s", kind) == 1) {
                fail(@"Unknown input command");
            }
            if (failed) fail(@"The simulator refused input");
        }
    }
    return 0;
}
