# iOS secure entry and exact readback

Live proof for [issue 549](https://github.com/akshat-OwO/contingency/issues/549), part of [tracker 542](https://github.com/akshat-OwO/contingency/issues/542). The leading candidate, Simulator HID keyboard entry with an in-process comparator loaded at launch, passed exact positive and wrong-value checks on a public fixture for both a UIKit secure field and a SwiftUI `SecureField`, on iOS 26.5 and iOS 27.1. It is still a prototype. Contingency keeps refusing private Variables on iOS under [ADR 0066](../adr/0066-ios-simulator-is-the-next-platform-runtime.md) until the one unexplained input drop below is explained and an arbitrary-app test passes.

## Recommendation

Keep the HID-plus-comparator path as the leading candidate for a Contingency-owned private text helper, and do not enable iOS private Variables yet. The candidate is the only one tested that delivered the secret without XCTest `typeText` and verified exact content inside the app, with no value in sampled process arguments, helper output, or any scanned channel. One 27.1 UIKit positive attempt typed 32 characters that never reached the field, so verification must stay fail-closed and no typed secret may be retried automatically.

## Candidates

| Rank | Candidate | Result |
| --- | --- | --- |
| 1 | Simulator HID keyboard events, plus a comparator loaded at launch with `DYLD_INSERT_LIBRARIES` | **Live pass with one unexplained drop.** Exact readback on both fields and both runtimes, and wrong values rejected. See [results](#live-results). |
| 2 | Cooperating app hook | Not run. Would require app changes; the same comparator logic applies. |
| 3 | Private XCTest synthesis and snapshots | Not rerun. The prior [stock XCTest run](ios-private-text.md) leaked fragments into XCTest diagnostics. |
| 4 | Host or simulator accessibility | Not run. A returned string is not assumed to be the underlying content. |
| 5 | Simulator pasteboard | Not run. Leaves the value on the shared pasteboard; rejected for private fills. |
| 6 | Stock agent-device and XCTest `typeText` | Rejected in the [earlier proof](ios-private-text.md). |

## Mechanism

**Entry.** `packages/cli/prototypes/ios/secure-readback/hid-type.m` loads CoreSimulator and SimulatorKit from the active Xcode, finds the booted simulator by UUID, and sends one HID key-down and key-up per character through `_TtC12SimulatorKit24SimDeviceLegacyHIDClient` using `IndigoHIDMessageForKeyboardArbitrary`. Uppercase letters use Left Shift. The value arrives on stdin only. The helper prints character and event counts, never the value. Unsupported characters are refused by index.

**Readback.** `readback.m` is loaded into the fixture with `SIMCTL_CHILD_DYLD_INSERT_LIBRARIES` at launch. It shows a `ready` file when a secure text field begins editing. On `SIGUSR1` from the host, it finds the first responder, computes SHA-256 over the field's UTF-8 text, and compares the digest and UTF-16 length with an expectation file that holds only a hash and length. It writes `verdict.json` at mode 0600 with `verified` or `unverified`, a reason, and the field's hash and length. It never writes field text.

**Fixture.** `packages/cli/prototypes/ios/private-text/secure-fields.swift` has a UIKit secure `UITextField` and a SwiftUI `SecureField` in a hosted view. `FIXTURE_FOCUS` selects the field that becomes first responder at launch. The fixture adopts UIKit scene lifecycle, because iOS 27.1 aborts a window-based app without it (`EXC_BREAKPOINT` in `UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`).

**Driver.** `packages/cli/prototypes/ios/secure-readback/run.py` creates one disposable simulator per runtime, installs the fixture, and runs four cases per simulator: UIKit and SwiftUI, each as a positive case and a wrong-value case. The wrong case types the value with its last character changed against an expectation of the real value. It samples host process arguments, captures host and simulator unified logs, scans the fixture container, simulator data, CoreSimulator logs, and recent diagnostic reports, then deletes the simulator and its work directory. The value is generated at random per run and never placed in argv or environment.

## Live results

Final run: Xcode 27.1 (27A9275), macOS 27.0.1, iPhone 17 Pro on iOS 26.5, iPhone Duo on iOS 27.1 (the only iPhone type 27.1 supports here). Values were 32 mixed-case alphanumeric characters.

| Runtime | Field | Positive case | Wrong-value case |
| --- | --- | --- | --- |
| 26.5 | UIKit | `verified`, exact match (length 32) | `unverified`, `sha256_or_length_mismatch` |
| 26.5 | SwiftUI | `verified`, exact match (length 32) | `unverified`, `sha256_or_length_mismatch` |
| 27.1 | UIKit | `verified`, exact match (length 32) | `unverified`, `sha256_or_length_mismatch` |
| 27.1 | SwiftUI | `verified`, exact match (length 32) | `unverified`, `sha256_or_length_mismatch` |

In every wrong-value case, the field held the wrong value that was typed (`fieldMatchesTyped: true`), so the rejection came from the comparison, not from a failed entry.

### Unexplained drop

The first full run on iOS 27.1 UIKit positive returned `unverified` with field length 0. The helper had sent 96 key events and exited 0, and the field never received text. The same case passed in the rerun, and seven isolated launches on a fresh Duo, each typed the same way, all verified. The cause is unknown. Candidates include a timing race between focus and the first HID event, or focus on a different scene or screen on the Duo. The driver did not retry, so the single failed run's verdict stood. This is the main reason the candidate is not a pass. The failing run's own channel scans, saved before the rerun, also had no leak hits.

### Per-channel results

No channel contained the full value, a UTF-16 or base64 encoding, or any 8-character UTF-8 window of the value or its wrong variant, across both rerun and first-run scans.

| Channel | Result |
| --- | --- |
| Host process arguments (sampled every 50 ms during entry) | No match. |
| Helper stdout and stderr | No match. The helper prints counts only. |
| Host unified log, live stream and persisted `log show` for the run window | No match. |
| Simulator unified log, live stream and persisted `log show` for the run window | No match. |
| Fixture container (`Documents`, caches, `tmp`) | No match. |
| Simulator data directory | No match in about 9,600 to 10,000 files per simulator. |
| CoreSimulator logs for the simulator | No match. |
| Host and system diagnostic reports changed since start | No match. |
| Work directory (`ready`, `verdict`, expectation) | No match. The expectation file holds only a hash and length. |

## Limits

- **Not arbitrary-app proof.** Only the public fixture was tested. Custom controls, web views, other secure widgets, and apps that reject injection are untested.
- **Unexplained drop.** One 27.1 UIKit positive attempt typed 32 characters that never reached the field. The cause is open; see above.
- **Scanning is bounded.** Full value checks cover UTF-8, UTF-16LE, and base64. Fragment checks cover UTF-8 8-character windows only. Unified log scans cover only each run's window.
- **Private symbols.** HID and CoreSimulator symbols are private and checked at runtime; they can change between Xcode releases.
- **Auto-focus.** The fixture focuses its field from an environment variable, not by a user tap. Real focus behavior in a user app is untested.
- **Scope.** Physical devices, keyboard layouts, and symbol characters are untested. The helper refuses symbols by design.

## ADR 0066 fit

ADR 0066 says the Target App is installed fresh, requires private Variables to pass the sentinel test, and does not decide whether runtime injection satisfies its boundary. This approach does not change the app build: the comparator is a dynamic library loaded into a disposable Session Simulator's launch of a fresh install. But it does change the running process, so it needs an explicit ADR decision before any production use. Changing the app build would be the alternative, and it would not work for apps Contingency does not build.

## Maintenance cost

- **Per Xcode release:** re-run the driver on each supported runtime. The full matrix took about six minutes per run here. Re-check the HID message symbol, the Swift class name for the HID client, and `SimServiceContext`. The comparator uses only public UIKit APIs, so its churn should be low.
- **Fixture churn:** iOS 27 showed a scene-lifecycle requirement that a window-based app would fail on. Each new major release may add requirements that the fixture and any comparator hook must meet.
- **Device coverage:** iOS 27.1 offers only iPhone Duo in this Xcode, so the Support Matrix cell for 27.1 must name that device type.

## Commands

From the repository root, on a host with no booted simulator:

```sh
python3 packages/cli/prototypes/ios/secure-readback/run.py /tmp/secure-readback-receipt.json
```

The driver builds with `packages/cli/prototypes/ios/secure-readback/build.sh` into a private directory. Its receipt holds hashes, lengths, verdicts, counts, and cleanup results, never the value.

## Evidence

[Sanitized evidence](ios-secure-readback-evidence.json) records the final run's cases and the earlier run's failed case. It contains hashes, lengths, verdicts, counts, and cleanup status only.
