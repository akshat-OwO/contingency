# iOS framebuffer stream spike

Research for [issue 545](https://github.com/akshat-OwO/contingency/issues/545). Read the [decision and evidence limits](../../../../docs/reports/ios-stream.md) before reusing this code.

`framebuffer.m` holds one CoreSimulator connection and samples one explicitly selected IOSurface at a target 30 fps. It scales JPEGs to 720 pixels wide. `stream.ts` is an Effect-scoped, authenticated loopback proxy. Its parent sends `start` and `stop` on stdin. The HTTP viewer cannot start capture or send simulator input.

The helper uses private selectors. It runs with the active Xcode's CoreSimulator and has no Screen Recording TCC requirement in the measured environment. It is not a supported runtime or a production Teaching recorder.

## Run the mirror

Run these commands from the repository root on an Apple Silicon Mac with Xcode 27.1 and the iOS 26.5 runtime. Create your own simulator. Never substitute an existing simulator's UUID.

```sh
SPIKE=$(mktemp -d /tmp/contingency-ios-stream.XXXXXX)
sh packages/cli/prototypes/ios/build.sh "$SPIKE"
SIM=$(xcrun simctl create contingency-ios-stream-spike \
	com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro \
	com.apple.CoreSimulator.SimRuntime.iOS-26-5)
trap 'xcrun simctl shutdown "$SIM"; xcrun simctl delete "$SIM"' EXIT
xcrun simctl boot "$SIM"
xcrun simctl bootstatus "$SIM" -b
xcrun simctl install "$SIM" "$SPIKE/StreamFixture.app"
xcrun simctl launch "$SIM" dev.contingency.stream-spike
xcrun simctl io "$SIM" enumerate
```

Set `DISPLAY` to the **Port UUID** of the integrated `com.apple.framebuffer.display` port with an IOSurface. Do not use the screen's separate Unique ID. On iPhone Duo, choose the port for the screen that actually contains the fixture. The helper refuses an unknown port instead of selecting another screen.

Set `IOS_STREAM_TOKEN` in your environment to a random credential. Enter that same value into the viewer's password field. Keep it out of command arguments, screenshots, and logs.

```sh
export IOS_STREAM_TOKEN
DISPLAY=<display-port-uuid>
nub packages/cli/prototypes/ios/stream.ts \
	"$SPIKE/framebuffer" "$(xcode-select -p)" "$SIM" "$DISPLAY"
```

The proxy prints its PID, helper PID, and ephemeral port. Open `http://127.0.0.1:<port>/`, enter the credential, and choose **Connect**. The viewer waits for its owner. In the owning terminal, type `start` and press Enter. The moving blue square and frame counter appear. Type `stop` and press Enter to close the capture gate, listener, and helper. SIGINT, SIGTERM, and stdin EOF also stop the proxy. The shell trap deletes only the simulator you created when that shell exits. Remove your temporary build directory afterward.

Only `GET /frames` returns pixels. It requires the credential in the `Authorization` header. Query parameters, foreign Host or Origin headers, upgrades, and other methods are refused. `GET /` serves the public viewer shell with no device data.

## Measure without opening a browser

`measure.py` owns a process group, probes the proxy, connects before Start, captures a 12-second benchmark, sends Stop, and checks helper exit and port closure. Its credential is generated internally and is never written. The output contains timing, frame digests, process samples, and resource IDs, with no pixels. Review it before sharing.

```sh
python3 packages/cli/prototypes/ios/measure.py \
	"$SPIKE/framebuffer" "$(xcode-select -p)" "$SIM" "$DISPLAY" \
	"$SPIKE/measurement.json"
```

Packet timestamps use the helper's host monotonic clock in milliseconds. `sequence` counts sampled output frames. `sourceSequence` counts compositor callbacks after Start. Samples intentionally skip some callbacks. `presentedMs = 0` means no callback has arrived yet. This is not an upstream source frame ID or a guarantee that every compositor frame was captured.

The fixture is public test content. Its install and launch commands are measurement setup, outside session authority. The prototype has no input endpoint. Production input must pass through the Agent Session's authority and observation binding.

## Build isolation

The shipped CLI has explicit entry points under `src/`, and its package includes `dist/`, not `prototypes/`. No shipped module imports this directory. The existing CLI TypeScript include excludes prototypes. Root quality checks still lint and format `stream.ts` and the documentation. To type-check the prototype separately, run from `packages/cli`:

```sh
nub exec tsc --ignoreConfig --noEmit --strict --module nodenext \
	--target es2024 --skipLibCheck --types node prototypes/ios/stream.ts
```
