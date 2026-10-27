# iOS private text through stock agent-device

Stock agent-device 0.21.25 **fails the sentinel test** in [ADR 0061](../adr/0061-android-private-text-uses-a-contingency-owned-helper.md). Its XCTest activity output persists part of a secure field's input in the session runner log, daemon log, and Xcode result diagnostics. Its successful daemon response also returns the complete input as `data.text`. Contingency must refuse iOS private Variables until a Contingency-owned text path passes the same test, as [ADR 0066](../adr/0066-ios-simulator-is-the-next-platform-runtime.md) requires.

This resolves the research question in [issue 546](https://github.com/akshat-OwO/contingency/issues/546), part of [tracker 542](https://github.com/akshat-OwO/contingency/issues/542). It does not enable iOS support or change the shipped CLI. The [sanitized evidence](ios-private-text-evidence.json) records hashes, counts, process ownership, commands, and cleanup. It contains no sentinel bytes or leaked fragments.

## Input path in the pinned package

All source inspection and execution used `packages/cli/dist/node_modules/agent-device`, whose package version is 0.21.25. The T3-owned 0.21.31 installation under `~/.t3/tools` was neither invoked nor signalled. Device-panel tools were not used because their launcher would select that separate installation.

The relevant files below are relative to the pinned package's `dist/` directory. The JavaScript is bundled and minified, so symbols and payload fields are more useful than line numbers.

1. `src/agent-device-client.js` sends daemon requests over a local TCP socket as newline-delimited JSON, or through HTTP JSON-RPC. The local request carries `token`, `command`, `session`, `positionals`, `flags`, and `meta`. Normal CLI `fill <target> <text>` and `type <text>` put text in CLI arguments. The proof instead sent the same stock daemon request over its owned socket, with text read from a 0600 file. It never put the sentinel in any process's arguments.
2. The fill handler resolves the observed reference and dispatches `fillPoint` or `fillRef`. `src/touch-runtime2.js` returns text in the fill result. `src/type-text-runtime.js` joins the type positionals, calls `operations.typeText`, and also returns `text` in its result. These response echoes are independent of the field's secure flag.
3. `src/interactor.js`, `createAppleInteractor`, maps fill to a runner command with `command: "type"`, the field's resolved `x` and `y`, `text`, `delayMs`, `textEntryMode: "replace"`, and `appBundleId`. Type uses the same command with append mode and no field coordinates. Node does not launch a per-value `simctl` or `xcodebuild` command.
4. `src/runner-client.js` starts the runner with `xcodebuild test-without-building`, an environment `.xctestrun` file, the simulator UUID, and a derived-data path. `src/runner-startup-transport.js` serializes the command with `JSON.stringify` and sends an authenticated HTTP `POST http://127.0.0.1:<runner-port>/command`. The text is in the body, not the URL or build arguments. The simulator path uses Node `fetch`, not curl. The value is plaintext in loopback memory and traffic.
5. `apple/runner/AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+Transport.swift` receives with `NWConnection`, checks framing and listener authentication, decodes `Command` with `JSONDecoder`, and queues execution. `RunnerTests+CommandExecution.swift` dispatches `.type` to `executeTypeCommand`. `RunnerTests+TextTyping.swift` clears for replacement, types a warmup character, then the remainder. The observed route calls `XCUIElement.typeText`. Other routes can use `app.typeText` or synthesized first-responder input. None of those alternatives was proven private here.
6. XCTest writes a `Type '…' into ... SecureTextField` activity containing a prefix of the remaining text. Secure display does not suppress that activity. Runner stdout and stderr go to the session `runner.log`. On teardown the daemon log also contains the fragment. Xcode keeps the same output in the run's `.xcresult/Staging/1_Test/Diagnostics/` files, even with `-collect-test-diagnostics never`.

The runner's `RunnerTests+CommandJournal.swift` stores lifecycle entries in an in-memory dictionary capped at 64 entries. The transport code does not itself write request bodies to disk. This source finding does not establish that every OS or third-party diagnostic collector suppresses HTTP bodies. No packet capture was started.

## Live proof and readback

The proof used an agent-created iPhone 17 Pro simulator running iOS 26.5, macOS 27.0.1, and Xcode 27.1, build 27A9275. It used the cached stock runner build and launched a fresh runner instance for its own simulator. A cold runner compilation was not repeated. iOS 27.1 and other secure widgets were not driven.

The previous attempt's `build.sh` and `fixture.m` were reviewed and reused. They build a public UIKit app with a native `UITextField`, `secureTextEntry = YES`, and accessibility identifier `private-password`. The app never logs or exports its text. On `editingChanged`, it hashes the actual `UITextField.text` and writes only SHA-256, length, and the secure flag to `Documents/readback.json`. That receipt is independent of agent-device's response echo.

A fresh random 40-character hexadecimal sentinel was generated for each run. The last completed sentinel run's hash and length are in the evidence. The fill succeeded, and the fixture's hash and length matched exactly. SHA-256 equality checks content, rather than accepting a successful input acknowledgement or equal lengths.

The post-fill agent-device snapshot identified a `SecureTextField` and returned 40 mask characters. This is **fixture-assisted exact readback**, not generic secure-field readback through XCTest. In `RunnerTests+TextEntry.swift`, `editableTextValue` explicitly returns `nil` for `.secureTextField`. Its verification code therefore cannot compare the actual secret through accessibility. Contingency must return `input_unverified` or an equivalent uncertain outcome for widgets whose actual content cannot be read independently. A mask of the right length cannot satisfy the production contract.

The audit first searched for the complete value as UTF-8, UTF-16LE, and base64. It also searched every contiguous UTF-8 fragment of at least eight characters. That second search matters: replacement peels the first character, and XCTest truncates the remaining activity text. A whole-value-only search incorrectly makes the runner log look clean. Evidence records only the longest matching fragment's source offset and length.

## Results by channel

| Channel | Observed result |
| --- | --- |
| Host and child-process arguments | No full value or eight-character fragment in sampled process arguments during fill. Samples included the live xcodebuild runner. This covers the socket-fed daemon path; ordinary CLI text positionals remain unsuitable for secrets. Sampling cannot prove absence between samples. |
| Agent-device session and daemon logs | **Leak.** Both `state/sessions/ios546/runner.log` and `state/daemon.log` contain an 18-character fragment beginning at sentinel offset 1. |
| Daemon response | **Leak.** Successful fill returns the entire sentinel in `data.text`. The audit temporarily captured that response to locate the leak, then deleted it. This file was audit-created, not an agent-device-created response archive. |
| Other daemon state and request diagnostics | No additional full-value or fragment matches in the owned state directory. The runner and daemon logs above are the exceptions. No daemon heap dump was taken. |
| xcodebuild and XCTest output | **Leak.** XCTest's `typeText` activity contains the 18-character fragment, even though the target is secure. |
| Host unified log stream and persisted `log show` | No full-value or fragment matches in the captured window. This is an observation for this run, not an OS logging guarantee. |
| Simulator unified log stream and persisted `log show` | No full-value or fragment matches in the captured window. |
| Runner HTTP body persistence | The body contains the secret in memory. No separate persisted HTTP request-body dump was found in audited files. Source inspection found no transport body logger. Side effects of executing the request do persist text in XCTest output. Unrelated collectors and packet recording were not audited. |
| Xcode diagnostic files | **Leak.** The owned `.xcresult` staging `Session-…log` and `StandardOutputAndStandardError.txt` contain the same 18-character fragment. |
| Simulator log and diagnostic directories | No full-value or fragment matches outside the Xcode result diagnostics. |
| Host user and system crash reports | No full-value or fragment matches in readable files under `~/Library/Logs/DiagnosticReports` and `/Library/Logs/DiagnosticReports`. No crash was deliberately induced. |
| Contingency diagnostics | No Contingency runtime was launched, so this spike produced no Contingency Trace, Teaching Recording, or Run diagnostics. Existing project and home diagnostic roots were checked when present. This is **unverified for production**, not a production privacy pass. |
| Fixture data | No full-value or fragment matches. The readback file contains only hash, length, and secure flag. |

Both `.xcresult` console and action export attempts failed with `root ID is missing, please check Info.plist`. The stock long-running runner's result bundle remained incomplete when the session closed. The audit scanned the raw staging diagnostics instead and found the leak there. It does not claim complete decoding of compressed or unfinished result objects.

## Production path

Keep stock agent-device for observation and public actions. Private Variables must bypass its command handlers, result echoes, and `XCUIElement.typeText` activity generation. Redacting only Node logs cannot remove text already written by XCTest and Xcode.

A Contingency-owned XCTest helper is the candidate for arbitrary apps, following the lifecycle in [the Android production service](../../packages/cli/src/services/android-private-text.ts):

1. Bind one Session Simulator, Target App bundle, current foreground window, observation identity, and exactly one secure editable field. Revalidate after binding and before input. Resolve the private Variable only after bind succeeds.
2. Receive a bounded request over an authenticated ephemeral loopback socket. Launch arguments and `.xctestrun` configuration carry only protocol and ephemeral authentication metadata. Keep request bodies, responses, errors, and diagnostics free of text. Do not use the pasteboard or `simctl` text arguments.
3. Use an input mechanism whose XCTest activities have been disabled or avoided and whose complete logging behavior has passed a fresh sentinel test. Lower-level synthesized text entry is a candidate, not an established solution. Using ordinary `typeText` inside another helper would reproduce this leak.
4. Compare actual field content internally and return only `verified`, a refusal with `inputSent: false`, or `input_unverified` with an uncertain input outcome. UIKit in-app cooperation can do exact comparison for an instrumented Target App. The tested stock XCTest secure-field snapshot cannot. Arbitrary third-party app support remains blocked until exact readback is solved; do not weaken it to masked length equality.
5. Serialize helper access with stock runner input. Recheck foreground ownership, never retry an uncertain fill, close the socket, stop the owned helper, remove transient authentication material, and prove cleanup before releasing the session lock.

An authenticated in-app helper would be small for this fixture, but would prove only an app modified to accept private input. It would not answer arbitrary-app readback or XCTest logging. No private input helper was prototyped for that reason. The retained prototype is only a public audit fixture and a reproducible audit script, outside the shipped CLI. Neither a helper nor this iOS runtime is production-ready.

## Commands and scope

Run from the repository root. The audit script records the expanded nonsecret commands and exit codes in the JSON receipt. It creates its own simulator and state directory, uses only the pinned package, samples process arguments, captures logs, and removes owned state and captures in `finally`.

```sh
gh issue view 546
python3 packages/cli/prototypes/ios/private-text/audit.py /tmp/ios546-final-evidence.json
nub exec turbo run quality
```

The script's device setup is equivalent to these commands, with `$WORK` a private temporary directory and `$UDID` the newly created identifier:

```sh
sysctl vm.swapusage
memory_pressure
sh packages/cli/prototypes/ios/private-text/build.sh "$WORK"
xcrun simctl create contingency-ios-private-text-546 \
	com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro \
	com.apple.CoreSimulator.SimRuntime.iOS-26-5
xcrun simctl boot "$UDID"
xcrun simctl bootstatus "$UDID" -b
xcrun simctl install "$UDID" "$WORK/PrivateTextFixture.app"
AGENT_DEVICE_STATE_DIR="$WORK/state" AGENT_DEVICE_HOME="$WORK/home" \
	AGENT_DEVICE_IOS_RUNNER_DETACH=0 TMPDIR="$WORK/tmp" \
	nub packages/cli/dist/node_modules/agent-device/bin/agent-device.mjs \
	open dev.contingency.private-text-spike --platform ios --udid "$UDID" \
	--session ios546 --json --debug
```

Every later agent-device command uses the same isolated environment. The private fill is a socket request constructed in Python, not a shell command. Its shape is `{token, command: "fill", session: "ios546", positionals: [ref, value], flags: {debug: true}, meta: {requestId}}`. The token comes from the owned `state/daemon.json`; the value comes from the temporary 0600 file. Neither is printed. Public observations use `snapshot -i --session ios546 --json`. Readback uses `xcrun simctl get_app_container "$UDID" dev.contingency.private-text-spike data`, then reads `Documents/readback.json` directly.

The logging and cleanup commands are recorded individually in the evidence:

```sh
ps -axo pid=,ppid=,lstart=,args=
/usr/bin/log stream --style ndjson --level debug
xcrun simctl spawn "$UDID" log stream --style ndjson --level debug
/usr/bin/log show --start "$START" --end "$END" --style ndjson --info --debug
xcrun simctl spawn "$UDID" log show --start "$START" --end "$END" \
	--style ndjson --info --debug
xcrun xcresulttool get log --path "$OWNED_RESULT" --type console
xcrun xcresulttool get log --path "$OWNED_RESULT" --type action
nub packages/cli/dist/node_modules/agent-device/bin/agent-device.mjs close --session ios546 --json
nub packages/cli/dist/node_modules/agent-device/bin/agent-device.mjs daemon stop --clean --json
xcrun simctl shutdown "$UDID"
xcrun simctl delete "$UDID"
```

`$START` and `$END` include UTC offsets. Log streams stop by signalling only their recorded process groups and awaiting exit. The audit removes only result bundles whose staging diagnostics identify its exact simulator UUID. It preserves the shared runner build cache and other simulators. The final harness setup rerun timed out in `simctl bootstatus` after 180 seconds, before any private input. Its simulator log query also timed out during evidence collection. Shutdown, deletion, and temporary cleanup succeeded. Two earlier sentinel runs completed, with the same pinned driver and unchanged fixture. The last script edits tighten temporary-file creation and failure cleanup; the evidence distinguishes the successful audit source hashes from the retained script hashes. This setup failure does not provide another fill proof.

The report and fixture do not change user-facing or MCP-visible behavior, so no production Workspace/MCP journey was launched. Those paths remain part of the later iOS Support Matrix proof.

## Validation and cleanup

`nub exec turbo run quality` passed with zero warnings or errors. The fixture built and completed two real secure-field fills; no shipped CLI or sibling stream prototype file changed. The final diff was reviewed.

All three agent-created simulators were shut down and deleted, including the setup that timed out. Both owned daemons and xcodebuild runners exited, all four daemon and runner ports closed, and both pairs of log streams exited. Sensitive captures, response files, fixture containers, owned Xcode result bundles, and temporary authentication files were removed. No audit temporary directory remains. The shared runner build cache, user simulators, and T3-owned daemon were preserved.
