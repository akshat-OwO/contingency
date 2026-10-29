# iOS Simulator Workspace stream backend

For [issue 545](https://github.com/akshat-OwO/contingency/issues/545), build a Contingency-owned CoreSimulator IOSurface helper behind the authenticated Workspace loopback proxy. Keep capture intervals and input authority in Contingency, and treat the private API dependency as an explicit Xcode compatibility obligation.

This is a fourth candidate, added because none of the three requested candidates proved a usable, permission-free live stream. The [prototype](../../packages/cli/prototypes/ios/README.md) streams a moving public fixture at about 27 fps. It does not add iOS to the shipped CLI, complete #548, or qualify the ADR 0066 Support Matrix.

## Decision criteria and environment

The spike required at least 20 changing frames per second, observable transport loss, parent-owned Start and Stop, and complete resource cleanup. The target cadence was 30 fps at 720 pixels wide. These are spike acceptance criteria, not a new product performance promise.

Measurements ran on 2026-10-27 on an Apple M5 Mac with 24 GiB RAM, macOS 27.0.1, and Xcode 27.1 build 27A9275. The installed packages inspected were expo-device-hub 0.15.3 and agent-device 0.21.25 under `packages/cli/dist/node_modules/`. The T3 Device service runs different versions and did not discover the newly created device. Its `device_open` returned "No device ... Call device_list for current ids." No existing device or T3 Device stream was opened or changed. The spike used the explicitly authorized `simctl` creation, boot, install, launch, shutdown, and deletion commands instead.

Only two spike-created devices ran, sequentially: an iPhone Duo on iOS 27.1 and an iPhone 17 Pro on iOS 26.5. Creating iPhone 17 Pro on 27.1 returned `Incompatible device`; it did not create a device. The public fixture uses CADisplayLink to move a square and update a visible frame counter. It contains no user data.

Read [ADR 0066](../adr/0066-ios-simulator-is-the-next-platform-runtime.md), [ADR 0060's mirroring decision](../adr/0060-use-stock-agent-device-for-an-experimental-android-runtime.md#mirroring-is-a-separate-decision), and the [Android stream report](android-stream.md) together. Streaming remains separate from the semantic driver. Contingency owns credentials, session binding, input authorization, and evidence intervals even when a backend supplies pixels.

## Candidate comparison

| Candidate | Live result | Decision |
| --- | --- | --- |
| `simctl io screenshot`, sequential JPEG polling | 2.68 fps; 368 ms median command completion | Reject as the interactive mirror. Keep for occasional observation keyframes. |
| `simctl io screenshot`, sequential PNG polling | 2.54 fps; 385 ms median command completion | Reject as the interactive mirror. |
| `simctl io recordVideo`, H.264 file | 360 frames in 5.985 s after Stop; no readable live file | Reject as the mirror. Consider only a separately bounded recording artifact. |
| ScreenCaptureKit on the host Simulator window | Screen Recording preflight false; no capture attempted | Reject as the default backend for this milestone. A human TCC grant and a correctly identified host window would be prerequisites. |
| agent-device recording or screenshots | Source inspection shows wrappers around the same `simctl` paths | Reject as a distinct streaming backend. Keep stock agent-device for the semantic driver. |
| Direct CoreSimulator IOSurface helper | 26.98 fps on 27.1; 26.70 fps on 26.5; browser decoded 27.0 fps | Recommend, with the production conditions below. |
| serve-sim `SimCapture` AVCC, from expo-device-hub 0.19.0 ([#579](https://github.com/akshat-OwO/contingency/issues/579)) | 59.90 fps on 26.5; 1,030 decoded frames, all distinct | Reject for now. Frames carry no sequence, source counter or timestamp, so loss is silent. |

### Screenshot polling

The 30-frame benchmarks used an explicit `--display=primary` and a real output file. JPEG command completion had a 416 ms p95, with an average 84,960 bytes per frame. PNG had a 433 ms p95 and 124,564 bytes per frame. Child-process CPU time divided by benchmark elapsed time was 24.24% for JPEG and 23.35% for PNG. These numbers exclude the CoreSimulator service and guest processes.

Polling needs no additional binary, signing identity, or Screen Recording permission. Contingency can issue the first command after Start, stop issuing commands at Stop, and discard late results. It can number successful samples and detect command failures. It cannot detect changes between screenshots or identify a lost compositor frame. Parallel screenshot processes were not benchmarked. Adding concurrency would not establish an ordered, complete frame source.

The initial default-display benchmark captured the inactive iPhone Duo display and was discarded. It also exposed an Xcode 27.1 discrepancy: `screenshot ... -` created a file named `-`, with zero stdout bytes, despite the installed help advertising stdout. The spike removed that file. A production screenshot path must use a real owned file and explicit display selection.

### `simctl recordVideo`

The settled, booted simulator recorded the active primary display to H.264. Before Stop, the output file was zero bytes and ffprobe returned `moov atom not found`. After SIGINT and finalization, ffprobe decoded 360 frames at approximately 60 fps. SIGINT-to-exit took 75.88 ms. This proves file recording, not interactive delivery.

The recorder process sample was 0.0% CPU and 15,344 KiB RSS. Encoding work can run in CoreSimulator services, so that sample is not the recording's total CPU or memory cost. No process-tree accounting was performed. No extra shipping binary, signing identity, or TCC grant was needed.

A preliminary TCP URL probe returned `NSURLErrorDomain -3000`, underlying OSStatus `-12143`. The historical `--type=fmp4` flag returned exit 117, `unrecognized option`. The TCP probe overlapped initial boot and was not repeated after boot completed, so it is not a blanket claim about every URL transport. The settled file benchmark and unsupported fragmented-output flag are sufficient to reject the tested path as a live mirror.

Contingency could spawn this recorder at Start, await its `Recording started` marker, signal it at Stop, and reject frames outside its own interval. Neither recorder spawn nor the marker proves that the first evidence frame coincides with Start. File duration and decoded frame count cannot reveal every upstream frame loss, and no live heartbeat exists on this tested output path.

### ScreenCaptureKit

A CoreGraphics preflight returned false. The spike did not call `CGRequestScreenCaptureAccess`, enumerate shareable screen content, or start an SCStream. No human permission prompt was triggered. Apple's [ScreenCaptureKit documentation](https://developer.apple.com/documentation/screencapturekit) requires screen recording permission before capture. CPU, memory, latency, and achieved frame rate remain unmeasured for this candidate.

A small Swift helper could select a window, request a frame cadence, consume timestamped sample buffers, encode frames, and report callback or queue gaps. Contingency would still gate output at Start and Stop and own the helper's lifetime. A production helper would need stable code identity for permission decisions and a distribution and signing plan. This spike did not test Developer ID signing, notarization, or TCC behavior after updates.

Window capture also introduces a host-window identity contract. It must bind the exact selected simulator display, crop host chrome correctly, and handle window replacement, resizing, occlusion, minimization, and window closure. Xcode 27's host presentation must be discovered rather than hard-coded to a `Simulator.app` title. Those behaviors were not tested. ScreenCaptureKit is a public API fallback worth revisiting if private CoreSimulator compatibility becomes too costly, but it has not passed this spike's live proof.

### agent-device 0.21.25

Inspection of `platform-runtime-screen-recording-apple-transport.js`, `platform-runtime-screen-recording-apple-simulator-host.js`, `simctl-facade.js`, `runtime4.js`, and `interactor.js` found:

- Simulator recording starts `xcrun simctl io <id> recordVideo <path>`. The wrapper tracks process identity and owns termination and finalization.
- Recording startup waits for an output file. The resulting artifact is collected and finalized after stopping. There is no exposed incremental frame subscription for Workspace.
- Preferred simulator screenshots call `simctl io screenshot`. The path includes retries and can fall back to the XCTest runner.

Source hashes are in the evidence file. The agent-device command path was not run as a separate benchmark, so no wrapper latency or CPU overhead is claimed. Its packaging and runner costs already belong to the semantic driver. Using its recording lifecycle as Teaching's authority would add a second interval owner without supplying live loss telemetry. A private upstream recorder API is also a less stable integration point than a narrow transport Contingency owns.

### serve-sim through expo-device-hub 0.19.0

[Issue 579](https://github.com/akshat-OwO/contingency/issues/579) asked whether expo-device-hub 0.19.0's serve-sim could replace the shipped helper in `packages/cli/ios/framebuffer/`. It cannot yet. serve-sim meets the interval, slow-consumer and permission criteria and outperforms the helper on cadence. It does not meet the loss-detection criterion. Contingency keeps the helper and its build and hash pinning, still pins expo-device-hub 0.15.3, and ADR 0066 is unchanged.

The check ran on 2026-10-29 on the same host, macOS 27.0.1 and Xcode 27.1 build 27A9275. Both backends ran sequentially against one spike-created iPhone 17 Pro on iOS 26.5, `35E9731F-BB63-4705-AAD5-285ADE1A4394`, showing the public moving fixture. The helper was built from `packages/cli/ios/framebuffer/framebuffer.m`, with the same flags as `build-ios-framebuffer.ts`. serve-sim was loaded in Node 24.22.2 from a fresh extraction of the registry tarball, whose sha512 integrity matched the registry. The harness loaded only the `SimCapture` class from `vendor/serve-sim/dist/native/serve-sim-native.node`. It started no HTTP server, hub, HID client or exec route.

| Measurement | Contingency helper | serve-sim `SimCapture`, AVCC |
| --- | --- | --- |
| Delivered cadence, 12 s | 26.51 and 25.21 fps; 318 of 318 JPEGs distinct | 59.90 fps; 1,030 of 1,030 decoded H.264 frames distinct |
| Output size | 720 × 1566 JPEG, 50 KB base64 mean | 1206 × 2622 H.264, 748 bytes mean per frame for this fixture |
| Start to first frame | 40.0 and 16.2 ms | `start()` 161.8 ms, then subscribe to first keyframe 830.0 ms |
| Latency inside the backend | Sample to encode 4.0 / 4.9 ms; callback to encode 13.0 / 20.1 ms, median / p95 | Not observable: frames carry no capture or encode timestamp. Inter-arrival 16.7 / 16.9 ms, median / p95 |
| Frames before Start | 0 bytes in 300 ms before `start` | 0 callbacks in 300 ms before `start()`, and 0 after `start()` before subscribing |
| Frames after Stop | 0 after `stop`; exit 0 in 6.5 and 11.4 ms | 0 in 1 s after unsubscribing, and 0 after `stop()` |
| Loss and gap detection | Output `sequence` contiguous. A 3 s reader stall shows as a 2,870 ms `sampledMs` gap and a 172-callback `sourceSequence` jump | None. A subscriber taking 500 ms per frame got 10 frames in 6 s, with no counter, gap marker or error |
| Slow consumer | Pipe backpressure blocks the helper at 0.5% CPU and 41.25 MiB. `ios-stream.ts` disconnects a viewer whose queue fills | Bounded per subscriber: one pending frame. The fast subscriber kept 59.98 fps, maximum gap 17.8 ms. RSS grew 1.4 MiB |
| CPU, one core | 10.9–16.0% while streaming | 6.9–14.0% while streaming, including Node and the harness |
| Memory | 40.9–41.3 MiB RSS | 92.6–99.0 MiB RSS for the Node process. Node alone was 45.2 MiB; loading the addon added 30.7 MiB |
| Screen Recording | No prompt; preflight false | No prompt; preflight false; no TCC ScreenCapture log entry |
| Shipped binary | Built and ad hoc signed per host, arm64 or x64, with source and binary SHA-256 | Prebuilt arm64-only addon and a 12 MB LiveKitWebRTC framework, ad hoc signed. No native source in the package |

Both CPU columns are per-process samples and exclude CoreSimulator and the guest. The serve-sim numbers include the Node runtime, because the addon runs in-process. serve-sim encoded at its native panel size and 60 fps, the hub defaults. The helper samples at 30 fps and scales to 720 pixels wide. The cadence and size columns therefore compare defaults, not equal work.

Source inspection of `serve-sim` 0.1.48, with its Swift sources, and the expo-device-hub 0.19.0 vendor copy found:

- **The hub vendors a fork, not serve-sim 0.1.48.** Its `NOTICE` calls it an Expo fork. Its addon is a different binary, `ea974bc5…` against `733e286a…`, arm64 only rather than universal, and has a wider constructor: `SimCapture(udid, mjpegFps, mjpegQuality, maxDimension, h264Fps, h264Bitrate, screenId)`. The package publishes no Swift source for it, so the 0.1.48 sources describe the fork only by inference. The addon is not a public export; Contingency would load it by path, as the Android worker does with `vendor/serve-emu/dist/scrcpy.js`.
- **Start and Stop for one UDID.** `new SimCapture(udid, …)` binds one simulator. `start()` registers CoreSimulator frame callbacks on the IOSurface and adds a 60 Hz poll and a 5 fps idle floor. `subscribe(codec, onFrame)` adds a per-subscriber encoder and returns an unsubscribe function. `stop()` drops every consumer. The addon dynamically loads private CoreSimulator, SimulatorKit and CoreDevice frameworks.
- **Wire format.** Every AVCC chunk is a 4-byte big-endian length, a tag and a payload. Tag 1 is the avcC description, 2 an IDR keyframe, 3 a delta and 4 a JPEG seed. The HTTP route `/stream.avcc` writes the cached latest JPEG as a seed before any H.264, so its first image can predate the request. Input travels on a separate WebSocket, `/ws`, as one type byte and a JSON body.
- **Loss.** The capture engine and each subscriber hold `AsyncStream` buffers with `bufferingNewest(1)`. They replace frames under backpressure by design and record nothing. Without a counter or timestamp, Contingency cannot distinguish a stalled subscriber, a dropped source frame and a static screen above the 5 fps idle floor.
- **Authentication.** serve-sim's middleware serves an unauthenticated preview page that embeds a per-process bearer token, and `POST /exec` and an exec WebSocket run host shell commands with that token. The hub CLI binds `127.0.0.1` by default and has `--require-token`, `--single-device <udid>` and CORS and frame-ancestor allowlists, but it also serves device boot, create, remove and shutdown routes. Adopting the HTTP path would need T3's approach: a supervised loopback child behind a route allowlist that never forwards `/exec`, the exec WebSocket, `/grid/api` or `/api/devices`. Loading `SimCapture` in a Contingency-owned worker avoids every route.
- **Android.** `startScrcpy`'s signature, scrcpy version 4.0 and the frame reader are unchanged between 0.15.3 and 0.19.0. The only change filters server arguments that equal scrcpy's defaults. An upgrade would not require Android code changes, but none was made.

Adopting serve-sim needs, at minimum, a per-frame capture timestamp and a source or drop counter from the native layer, x64 coverage or a decision to drop it, and published source for the vendored addon. Contingency must not patch it. Revisit when upstream ships those. A worker that loads `SimCapture` and maps it onto `ios-stream-integrity.ts` would then keep Contingency's Start and Stop gate, its credentials and its integrity manifest. The slow-consumer bound and lower CPU already favour that design.

No Android or iOS Workspace proof ran, because no product code changed. The spike simulator was shut down and deleted by exact UDID. The cleanup audit found no harness, helper or fixture process and no new listening port, and the executed package extraction was removed. Raw results are in `/tmp/ss579-evidence/` on the measuring host and were not committed.

## Prototype evidence

The sanitized [evidence receipt](ios-stream-evidence.json) contains metric aggregates, process samples, resource IDs, refusal results, and cleanup checks. It excludes credentials, screenshots, pixel payloads, user simulator inventory, and user paths.

The helper loads the installed CoreSimulator framework, resolves the exact booted device and display port, registers frame callbacks only after its parent sends Start, and samples the current IOSurface. It emits independent JPEG frames with output sequence, callback count, and monotonic sample, callback, and encode timestamps. The prototype uses JPEG for a small proof; it makes no claim that JPEG is the final production codec.

| Measurement | iOS 27.1, iPhone Duo | iOS 26.5, iPhone 17 Pro |
| --- | --- | --- |
| Frames in approximately 12 seconds | 325, all distinct JPEG digests | 320, all distinct JPEG digests |
| Output cadence | 26.977 fps | 26.704 fps |
| Start write to first received packet | 23.433 ms | 66.226 ms |
| Sample to JPEG completion, median / p95 | 5.762 / 7.138 ms | 4.209 / 5.794 ms |
| Latest callback to JPEG completion, median / p95 | 12.880 / 21.208 ms | 11.619 / 20.829 ms |
| Output sequence gaps | 0 | 0 |
| Callback count at last sample | 722 | 720 |
| Helper sampled CPU | 13.0–16.3% | 9.9–11.9% |
| Helper sampled RSS | 41.05–41.22 MiB | 35.81–36.00 MiB |
| Stop write to owner exit | 39.256 ms | 38.920 ms |

CPU samples are percentages of one core. RSS is process-resident memory, not private memory. The 26.5 proxy process sampled 0.7–1.3% CPU and 110.22–139.17 MiB RSS. The 27.1 harness accidentally sampled the `nub` launcher instead of the Node proxy, so its proxy memory is unmeasured. CoreSimulator, GPU allocations, the guest, and browser are additional costs. A 12-second run does not establish steady-state memory or exclude a leak.

Callback-to-encode age is not glass-to-glass latency. The pixel surface and callback timestamp are read separately. No synchronized in-app clock or input-to-display measurement was performed. The browser proof validates JPEG decoding and delivery cadence, not a photon latency bound.

A headless Chrome viewer on 27.1 decoded 180 frames at 27.0 fps with zero output sequence gaps. Its canvas was 720 × 1048. After Stop it drained to 184 decoded frames and EOF. Those extra decoded frames were already delivered before Stop. The HTTP benchmark received zero frames in its drain after sending Stop on both runtimes, but production must still distinguish capture time, delivery time, and decode time.

The final 26.5 revision refused missing and wrong credentials with 401. Device query overrides, input routes, foreign Host and Origin headers, upgrades, and POST returned 404. An authenticated connection received no bytes during the 300 ms pre-Start observation. Both normal runs exited with code 0, reaped the helper, and closed their ports. A separate SIGKILL probe of the owned helper made the proxy exit with code 1 and close its port in 37.02 ms. That fault probe happened just after Start, not midway through a long recording.

### Loss detection and interval ownership

`sequence` exposes missing output packets. `sourceSequence` exposes how many compositor callbacks occurred between samples. The intentional 60-to-30 fps sampling is distinct from a lost output packet. Callback count is not Apple's upstream frame identifier and cannot prove that every source frame reached the callback. A static display may have no callbacks while repeated sampled JPEGs remain valid. Killing the helper is detectable through child exit and transport EOF.

The proxy is a separate interval owner from the backend. It has no HTTP Start or Stop endpoint. The parent sends those commands on stdin. Before Start, the helper resolves identity but does not subscribe or read pixels. At Stop, the proxy closes its delivery gate before asking the helper to stop and drains no late data into viewers. Scoped finalizers reap the child, with a 10-second SIGKILL fallback, and close connections and the listener. Helper stdin EOF also terminates capture if the parent disappears.

Production Teaching must create its evidence subscription at the user-pressed Start, stamp the first accepted sample, close that subscription at Stop, and reject late packets by its own interval and generation. A setup mirror may run separately, but its frames must never be retained as Teaching evidence. Stream silence, process exit, sequence gaps, source resets, and viewer backpressure must produce an explicit integrity outcome. The prototype disconnects slow viewers above a 1 MiB output queue, but has no production gap manifest or stream-loss UI.

## Packaging and implementation conditions

The helper is a small Objective-C executable linked to public image frameworks and dynamically connected to the installed private CoreSimulator API. The measured arm64 executable was linker-signed ad hoc, with no TeamIdentifier or entitlements, and ran without a Screen Recording prompt. There is no simulator-installed transport agent and no runtime download. It does not require agent-device's XCTest runner to obtain pixels.

The private selector names were checked against Meta's MIT-licensed [CoreSimulator declarations and framebuffer implementation](https://github.com/facebook/idb/blob/36ba98251ba558bca2cc706da503b9ba5095c21d/FBSimulatorControl/Framebuffer/FramebufferSurface.swift). [SimKit's framebuffer implementation](https://github.com/subdiox/SimKit/blob/74c895ea4b696ad51cf18f7204ab6fb79dde8915/Sources/Display/SimulatorFramebuffer.swift) was also inspected. This prototype implements the narrow transport directly rather than adding either dependency or their input APIs. Apple's [IOSurface documentation](https://developer.apple.com/documentation/iosurface) describes the underlying shared framebuffer object. Private CoreSimulator selectors have no Apple compatibility promise.

Before #548 ships this backend:

1. Package and hash-check a Contingency-owned helper for supported host architectures. Only local arm64 ad hoc execution was tested here. While iOS stays unlisted, #548 may build and run the helper ad hoc signed. Developer ID signing, notarization, and a clean-host proof are exit criteria for #550, before iOS is listed.
2. Bind the exact selected simulator and active integrated display from preparation. The iPhone Duo has two populated integrated surfaces. The default `simctl` display selected an inactive one. Never choose by largest surface or silently fall back to another display. Prove display replacement and orientation changes.
3. Keep the authenticated proxy's existing session credential, Host, Origin, generation, revocation, and bounded-queue contracts. Reuse the Android service's architecture, not its backend or unrestricted hub routes. The prototype rejects all Origin headers; production must admit its validated Workspace origin.
4. Add an explicit transport state and integrity manifest. Prove mid-recording loss, helper restart, slow consumers, source replacement, static screens, and Stop races. Do not infer complete source capture from contiguous output sequence numbers.
5. Prove surface consistency during composition and rotation, long-run CPU and memory, macOS and Xcode compatibility, and the actual embedded Workspace viewer. Test the complete Teaching interval and input authority through #548, then qualify both #550 Support Matrix cells.

These are implementation obligations for the follow-on runtime, not claims established by this research. No pointer or keyboard routing was added. All production input must go through Agent Session authority and its observation binding.

## Commands, verification, and cleanup

The prototype README gives the complete build and run procedure. The measured commands used these owned UUIDs and ports, retained in the sanitized receipt for cleanup auditing:

```sh
gh issue view 545
gh issue view 542
vm_stat
sysctl vm.swapusage
memory_pressure
xcodebuild -version
xcrun simctl list runtimes
sh packages/cli/prototypes/ios/build.sh /tmp/contingency-ios-545
xcrun simctl create contingency-ios-stream-545 \
	com.apple.CoreSimulator.SimDeviceType.iPhone-Duo \
	com.apple.CoreSimulator.SimRuntime.iOS-27-1
xcrun simctl boot 237B283E-6FAF-466C-A4E5-0FBDEDF10973
xcrun simctl bootstatus 237B283E-6FAF-466C-A4E5-0FBDEDF10973 -b
xcrun simctl install 237B283E-6FAF-466C-A4E5-0FBDEDF10973 /tmp/contingency-ios-545/StreamFixture.app
xcrun simctl launch 237B283E-6FAF-466C-A4E5-0FBDEDF10973 dev.contingency.stream-spike
xcrun simctl io 237B283E-6FAF-466C-A4E5-0FBDEDF10973 enumerate
python3 /tmp/contingency-ios-545/proxy-measure.py
python3 /tmp/contingency-ios-545/candidates.py
nub /tmp/contingency-ios-545/browser.mjs
xcrun simctl shutdown 237B283E-6FAF-466C-A4E5-0FBDEDF10973
xcrun simctl delete 237B283E-6FAF-466C-A4E5-0FBDEDF10973
xcrun simctl create contingency-ios-stream-545-26 \
	com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro \
	com.apple.CoreSimulator.SimRuntime.iOS-26-5
xcrun simctl boot D94E8E4B-E5DD-4FAA-BAC4-6803F845BE20
xcrun simctl bootstatus D94E8E4B-E5DD-4FAA-BAC4-6803F845BE20 -b
xcrun simctl install D94E8E4B-E5DD-4FAA-BAC4-6803F845BE20 /tmp/contingency-ios-545/StreamFixture.app
xcrun simctl launch D94E8E4B-E5DD-4FAA-BAC4-6803F845BE20 dev.contingency.stream-spike
python3 packages/cli/prototypes/ios/measure.py \
	/tmp/contingency-ios-545/framebuffer /Applications/Xcode.app/Contents/Developer \
	D94E8E4B-E5DD-4FAA-BAC4-6803F845BE20 6F99B74C-356F-474A-A462-5133D48C537B \
	/tmp/contingency-ios-545/proxy-26.5.json
python3 /tmp/contingency-ios-545/loss.py
xcrun simctl shutdown D94E8E4B-E5DD-4FAA-BAC4-6803F845BE20
xcrun simctl delete D94E8E4B-E5DD-4FAA-BAC4-6803F845BE20
```

The local 27.1 harness preceded the checked-in `measure.py`; the latter fixes launcher process sampling and adds Host, Origin, method, and upgrade probes. `compare.py` preserves the screenshot and video benchmark with simulator and output-directory arguments. Its capture primitives were:

```sh
xcrun simctl io <owned-uuid> screenshot --display=primary --type=jpeg <owned-file.jpeg>
xcrun simctl io <owned-uuid> screenshot --display=primary --type=png <owned-file.png>
xcrun simctl io <owned-uuid> recordVideo --codec=h264 --display=primary --force <owned-file.mp4>
ffprobe -v error -count_frames -show_entries stream=width,height,avg_frame_rate,nb_read_frames,duration -of json <owned-file.mp4>
ps -p <owned-pids> -o pid=,ppid=,%cpu=,rss=,etime=
```

The no-prompt permission preflight was `xcrun swift /tmp/contingency-ios-545/tcc.swift`, containing `import CoreGraphics` and `print(CGPreflightScreenCaptureAccess())`. Source inspection, permission preflight, live backend capture, and browser decode are separate evidence categories. The browser smoke used a fresh headless Chrome profile, connected through the viewer form, waited for 180 decoded frames, captured a local screenshot, sent parent Stop, and closed the browser context. No embedded production Workspace or MCP path changed, and neither was launched. The verify-contingency production journey therefore remains a #548 verification requirement.

Memory checks ran before boot and during capture. Available memory began at 72%, reached 44% during the second runtime's work, and recovered to 58% after simulator deletion. Swap used stayed at 1,641 MiB throughout. Capture and browser proofs ran sequentially. No further device or browser runs were launched after the final cleanup.

Repository quality and separate prototype TypeScript checks passed. The prototype stays outside CLI build entry points, package files, and production TypeScript includes; no shipping configuration changed. Final cleanup confirmed both owned UUIDs absent, both simulator process trees and fixture processes gone, all owned helpers, harnesses, and browser processes exited, and every recorded listener port closed. Shared CoreSimulator and T3 services were preserved. The resource ledger and exact cleanup observations are in the evidence receipt.
