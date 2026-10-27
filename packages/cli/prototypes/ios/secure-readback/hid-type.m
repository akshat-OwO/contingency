// Research-only Simulator keyboard input. Reads the value from stdin and never prints it.
// CoreSimulator and SimulatorKit symbols are private; each is checked at runtime.
#import <Foundation/Foundation.h>
#import <dlfcn.h>
#import <unistd.h>

typedef void *(*KeyboardMessageFunction)(uint32_t usage, uint32_t operation);

enum { IndigoKeyDown = 1, IndigoKeyUp = 2 };
enum { HIDUsageLeftShift = 0xE1 };

@interface NSObject (SimulatorHID)
+ (id)sharedServiceContextForDeveloperDir:(NSString *)dir error:(NSError **)error;
- (id)defaultDeviceSetWithError:(NSError **)error;
- (NSArray *)availableDevices;
- (NSUUID *)UDID;
- (NSUInteger)state;
- (instancetype)initWithDevice:(id)device error:(NSError **)error;
- (void)sendWithMessage:(void *)message freeWhenDone:(BOOL)freeWhenDone completionQueue:(dispatch_queue_t)queue completion:(void (^)(NSError *))completion;
@end

static void fail(NSString *message) {
    fprintf(stderr, "%s\n", message.UTF8String);
    exit(1);
}

// USB HID keyboard usages for letters and digits. Uppercase letters use Left Shift.
static BOOL usageForCharacter(unichar c, uint32_t *usage, BOOL *shifted) {
    *shifted = NO;
    if (c >= 'a' && c <= 'z') { *usage = 4 + (c - 'a'); return YES; }
    if (c >= 'A' && c <= 'Z') { *usage = 4 + (c - 'A'); *shifted = YES; return YES; }
    if (c >= '1' && c <= '9') { *usage = 30 + (c - '1'); return YES; }
    if (c == '0') { *usage = 39; return YES; }
    return NO;
}

static void sendEvent(id client, KeyboardMessageFunction makeMessage, uint32_t usage, uint32_t operation, dispatch_queue_t queue) {
    void *message = makeMessage(usage, operation);
    if (!message) fail(@"Keyboard message unavailable");
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    __block NSError *failure = nil;
    [client sendWithMessage:message freeWhenDone:YES completionQueue:queue completion:^(NSError *error) {
        failure = error;
        dispatch_semaphore_signal(done);
    }];
    if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC)) != 0) fail(@"Keyboard event timed out");
    if (failure) fail([NSString stringWithFormat:@"Keyboard event failed with code %ld", (long)failure.code]);
    usleep(30000);
}

int main(int argc, char **argv) {
    @autoreleasepool {
        if (argc != 3) fail(@"Usage: hid-type <developer-dir> <simulator-uuid> < value");
        NSString *developer = @(argv[1]);
        if (!dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW | RTLD_GLOBAL)) fail(@"CoreSimulator unavailable");
        // SimulatorKit ships beside the developer directory, in Xcode.app/Contents/SharedFrameworks.
        NSString *contents = [developer stringByDeletingLastPathComponent];
        NSString *kit = [contents stringByAppendingPathComponent:@"SharedFrameworks/SimulatorKit.framework/SimulatorKit"];
        if (!dlopen(kit.fileSystemRepresentation, RTLD_NOW | RTLD_GLOBAL)) fail(@"SimulatorKit unavailable");
        KeyboardMessageFunction makeMessage = dlsym(RTLD_DEFAULT, "IndigoHIDMessageForKeyboardArbitrary");
        if (!makeMessage) fail(@"Keyboard HID symbol unavailable");

        NSData *input = [[NSFileHandle fileHandleWithStandardInput] readDataToEndOfFile];
        NSString *text = [[NSString alloc] initWithData:input encoding:NSUTF8StringEncoding];
        if (!text.length) fail(@"Empty input");
        for (NSUInteger i = 0; i < text.length; i++) {
            uint32_t usage;
            BOOL shifted;
            if (!usageForCharacter([text characterAtIndex:i], &usage, &shifted)) {
                fail([NSString stringWithFormat:@"Unsupported character at index %lu", (unsigned long)i]);
            }
        }

        NSError *error = nil;
        id context = [NSClassFromString(@"SimServiceContext") sharedServiceContextForDeveloperDir:developer error:&error];
        if (!context) fail(@"SimServiceContext unavailable");
        id set = [context defaultDeviceSetWithError:&error];
        id device = nil;
        for (id candidate in [set availableDevices]) {
            if ([[candidate UDID].UUIDString isEqualToString:@(argv[2])]) device = candidate;
        }
        if (!device || [device state] != 3) fail(@"Selected simulator must already be booted");
        id client = [[NSClassFromString(@"_TtC12SimulatorKit24SimDeviceLegacyHIDClient") alloc] initWithDevice:device error:&error];
        if (!client) fail(@"HID client unavailable");

        dispatch_queue_t queue = dispatch_queue_create("dev.contingency.secure-readback.hid", DISPATCH_QUEUE_SERIAL);
        NSUInteger events = 0;
        for (NSUInteger i = 0; i < text.length; i++) {
            uint32_t usage;
            BOOL shifted;
            usageForCharacter([text characterAtIndex:i], &usage, &shifted);
            if (shifted) {
                sendEvent(client, makeMessage, HIDUsageLeftShift, IndigoKeyDown, queue);
                events++;
            }
            sendEvent(client, makeMessage, usage, IndigoKeyDown, queue);
            sendEvent(client, makeMessage, usage, IndigoKeyUp, queue);
            events += 2;
            if (shifted) {
                sendEvent(client, makeMessage, HIDUsageLeftShift, IndigoKeyUp, queue);
                events++;
            }
        }
        printf("{\"characters\":%lu,\"keyEvents\":%lu}\n", (unsigned long)text.length, (unsigned long)events);
    }
    return 0;
}
