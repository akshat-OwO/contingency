# Android production driver handoff

This handoff describes the full-contract, conditional helper-fork path for issue 457. The revised proposal in [ADR 0060](../adr/0060-use-stock-agent-device-for-an-experimental-android-runtime.md) starts with [experimental Android using stock agent-device](android-experimental-scope.md), including Teaching and verification with non-secret inputs. This document is not authorization to begin a fork. Its preparation, capture, verification, and Cleanup requirements apply to the experiment too; private-input and stronger device-dispatch capabilities remain staged. The [upstream extension path](android-upstream-extension-investigation.md) remains an alternative for those later requirements. Read the [backend comparison](android-backend-comparison.md) and its evidence limits first.

## Runtime interfaces

`PlatformRuntimeService` already exposes platform identity, capabilities, `observe`, observation-bound `dispatch`, `invalidate`, and idempotent `close`. Keep those common operations. `PlatformRuntimeFactory` is currently a `Context.Service<BrowserRuntimeFactoryService>` whose `platform` is literally `web`. Its startup requires browser viewport and navigation policy and returns `BrowserPlatformRuntime`, including `browser` and `browserSessionId`. Generalize the factory to a discriminated startup request and result. Keep the browser extension typed, and add a private Android extension. Do not fabricate a browser session ID or browser URL for Android.

The Android startup request must carry the selected host, exact serial, expected device identity, Target App package and build, helper installation grant, required capabilities, preparation procedure or emulator baseline, and Run Environment Permission. The Android extension must expose typed app launch, Back, authorized system-dialog interaction, device environment, and capture integrity. Keep platform-specific operations out of the generic action union until their common meaning is established.

`PlatformObservation.nodes` currently has only `target`, `role`, and `name`. Add typed Android evidence for display and window identity, package ownership, bounds, focus, editable and password state, capture mode, missing roots, truncation, and screenshot identity. Keep full raw observations local. `PlatformAction.fill` currently takes raw `text`. Add a private-input operation that accepts a Variable reference and resolves its value only inside the service. Never expose private text in command records or generic error messages.

`PlatformRuntimeError` currently collapses errors to `observation_stale` or `runtime_failed`. Extend the error contract to distinguish missing capability, incompatible helper, device mismatch or disconnect, denied or ambiguous ownership, incomplete capture, and dispatch outcome unknown. A cancellation is not evidence that no action occurred. Preserve browser error behavior while callers migrate.

`agent-session.ts` still accesses `runtime.browser` and `runtime.browserSessionId`, and routes Workspace input and streams through browser services. Branch on the typed runtime result at those callers. Keep browser Teaching, saved Emulation, Runs, verification, and Cleanup covered by their existing tests and Workspace recipes. This evaluation changes none of those paths.

## Helper capabilities and dispatch

1. Fork the pinned capture modules with MIT notices and a recorded source revision. Use a distinct Contingency package and instrumentation runner. Keep the target app unmodified.
2. Add a bounded, versioned handshake with session identity, selected-device facts, request correlation, and explicit capability negotiation. Authenticate every helper request with an ephemeral session credential. Protect host configuration with mode 0600 and device-loopback forwarding with exclusive ownership.
3. Require semantic observation, screenshots, observation-bound coordinates, private input, and complete window ownership evidence for journeys that need them. Refuse startup when any required capability is unavailable. API support or an APK's minimum SDK is not a capability guarantee.
4. Serialize observation, authority, dispatch, and close in an Effect service with Effect Atom state. Consume the observation before Variable resolution or device dispatch. Check the helper session, display, focused window, authorized package, target uniqueness, and fresh semantic fingerprint on the device too.
5. Resolve duplicate IDs with observation-local node identity and a fingerprint, never the first matching ID. Keep meaningful public labels. Reject missing or ambiguous semantic targets. Bind coordinate fallback to screenshot identity, display extent, window ownership, and the consumed observation. Never silently translate stale coordinates onto a new screen.
6. Use `AccessibilityNodeInfo.ACTION_SET_TEXT` over the authenticated socket for capable fields. Verify internally without exporting the value. Do not call `UiObject2.setText`, ADB `input text`, clipboard transport, or the stock IME broadcast for private Variables. A field without safe input or observable confirmation requires explicit refusal or an inconclusive result. A future authenticated IME needs separate capability and lifecycle proof.
7. Permit a necessary system dialog only when its owner, window, requesting Target App, and triggering action are established. A permission-controller package allowlist alone is insufficient. Ambiguous windows pause input. Additional-app authority lasts only for the current Run. App permission never replaces Confirmation.

## Failure and recovery

All driver failures invalidate outstanding observations and pause further dispatch. Distinguish a proven pre-dispatch refusal from an action that may have reached the device. Do not replay either automatically. Recovery revalidates the same selected serial and device identity, helper identity and capabilities, app ownership, starting conditions when required, and a fresh observation. It never selects another device.

Scope finalizers close only the owned connection, forward, helper process, stream, and lock. Make close idempotent. A persisted recovery record must identify the serial, helper build, owned forward, process, and previous IME if changed. Inspect liveness before removing orphaned resources. Do not force-stop a helper owned by another session or uninstall a preexisting package. Preserve failed cleanup evidence and offer explicit recovery.

## Signing, installation, and supported versions

The evaluation ran only Pixel_9, Android API 36, arm64. The prototype declares API 30 minimum; agent-device's APK declares API 23 minimum and target 36. Neither declaration establishes a production support matrix. Start production qualification on API 36 and add API levels and physical OEM builds only after separate proof.

Ship a reproducible helper build with pinned JDK, SDK, build tools, dependencies, source revision, protocol version, APK hash, and stable signing certificate. Verify the installed package's version and signing identity before adoption or upgrade. Obtain explicit installation or replacement authority on the selected device. Android's signing rules require a compatible certificate for an update. The upstream committed debug key is not a production signing policy.

Preserve agent-device's MIT license and copyright for the helper fork. For mirroring, inventory expo-device-hub's MIT package, bundled serve-emu's Apache-2.0 package, scrcpy server, codecs, and native dependencies with their shipped notices and platform artifacts. Verify hashes and installation permissions for downloaded binaries. Do not add an unpinned runtime download or require the user's T3 installation.

## Workspace streams and evidence

Use a supervised stream process selected by explicit host and serial. Bind the hub to loopback and expose only an authenticated, allowlisted Contingency proxy. Authenticate HTTP and WebSocket upgrades, validate Origin, bound messages and queues, and keep credentials out of URLs and diagnostics. A remote host must use an authenticated tunnel scoped to that host. Workspace receives frames through Contingency, not a raw hub endpoint.

Route pointer, keyboard, navigation, and private Variable input through the same authority and lifecycle service as agent actions. Deny input during agent ownership unless Takeover explicitly transfers control. Do not let a stream control socket bypass ownership or Confirmation. Disable hub-side action recording and replay. Its `SessionRecorder` starts with recording enabled, which cannot define Contingency's Teaching interval.

At Start recording, establish an acknowledged capture boundary before admitting recorded input. Tag frames and actions with monotonic sequence and capture times. Capture before and after each forwarded action. At Stop, stop all retained sources, drain only that interval, and record the terminal acknowledgement. Prove that frames before Start and after Stop never enter Teaching artifacts. Detect disconnect, dropped required frames, missing roots, and mismatched display geometry. Capture loss ends Teaching as incomplete and prevents a passing Dry Run until resolved.

Redact supplied Variable values from node text, values, descriptions, hints, semantic events, diagnostics, and errors before agent-readable projection. Retain useful public labels such as Login, Cart, and Checkout. Match secret substitutions inside larger strings and track affected fields, including transformed display values where known. Password flags alone cannot cover ordinary fields or reflected text. Keep raw trees, media, and full diagnostics sensitive and local. Purge them through existing verification Cleanup. Do not claim pixel redaction or target-app log sanitization.

## Required production proof

The following prerequisites remain required, with independent receipts:

- An authorized second device for concurrent serial and host routing, disconnect without device switching, and independent cleanup.
- A selected physical serial with accepted ADB trust, installation authority, OEM and API identity, and a declared setup or reset procedure. Test scrcpy transport separately from emulator gRPC.
- A prepared target that triggers OS permissions, an authorized overlay fixture with controlled focus and occlusion, and an IME matrix. Prove necessary-dialog classification and refusal of unrelated system UI.
- A prepared `FLAG_SECURE` target and an observable safe alternative outcome. Prove capture refusal or obscuration remains inconclusive, without bypassing the restriction.
- A Workspace stream adapter with authenticated proxy, capture acknowledgements, and input authority. Prove Start-to-Stop timing, Takeover, capture loss, cleanup, and backpressure. T3 Device panel visibility is insufficient.
- The React Native checkout fixture, baseline restoration, private login, learned Flow Skill, Dry Run verification, changed successful build, and deliberately broken build. Follow verify-contingency isolation, command journals, persisted readback, and sensitive-media cleanup.

Do not advertise Android support or close issue 457 until that complete journey and its failure paths pass. Acceptance of the driver decision only unblocks implementation.
