# Experimental Android checkout proof

Issue #471 adds an Expo checkout fixture and proves the experimental emulator journey through live Workspace and MCP. It follows the [experimental scope](android-experimental-scope.md). Passing this journey does not close #457 and does not prove the full [ADR 0058](../adr/0058-android-is-the-next-platform-runtime.md) contract.

## Fixture and builds

The [fixture](../../.cursor/skills/verify-contingency/fixtures/android-checkout/README.md) is one Expo SDK 57 app, `dev.contingency.checkout`, built three times from one lockfile. Every input is public. The shopper name is ordinary text, and checkout is a mock with no payment.

| Variant | appBuild | SHA-256 (2026-10-13 build) | Outcome |
| --- | --- | --- | --- |
| working | 1 | `d60ccb9283c654f958e881603c7516e1b33ae745fb23f83548a7cbd128a765d6` | `Order confirmed` |
| changed | 2 | `224251481a50f38a42d2c071cefe33367fe63f76b7386ebc9a682ca658b4d92c` | Changed catalog, `Order confirmed` |
| broken | 3 | `a5efcf22768210aba5476231ab84f67bb3ca1936bfdb6a33365e584c922bfe11` | `Checkout failed` |

The builds used JDK 17.0.20.1, Node 24.16.0, and nub 0.9.0, with lockfile SHA-256 `ac602918fa96…`. The build procedure is reproducible, but its bytes are not: two builds of identical source produced different Hermes bundles, so the APK hashes differed. A hash therefore identifies one build, not a source revision. The build script records each identity in `builds.json`, and the proof refuses an APK whose hash has changed since then. After the proof, two lint-disable comments were added to `shop.js`; they do not change behavior.

## Product change

The Workspace start form accepted one reversible action, but a checkout needs four: Sign in, Add Anvil to cart, Open cart, and Place mock order. `Reversible actions` is now a list with one `role: name` per line. A malformed line rejects the form rather than dropping a control. The runtime contract, which already accepted a list, is unchanged.

## Live proof

The live run used a headless Pixel_9 API 36 emulator at `emulator-5554` on 2026-10-13 and the stock pinned helper, which was already installed. The [sanitized receipt](android-checkout-evidence.json) has no blockers. Raw keyframes and screenshots stayed in isolated state and were purged.

- **Teaching:** A Workspace user recorded five ordered actions with before and after keyframes, plus two Instructions in recorded order. The Timeline ran from `started` to `stopped`.
- **Learning and Dry Run:** The saved skill is stamped `platform: android` and `appBuild: 1`. Preparation restarted the activity and observed the sign-in screen without a carried-over session. The Dry Run passed, and the explicit `Verify flow` choice purged the Recording.
- **Changed build:** A Run against build 2 showed one `appBuild` difference. Refusal ended that Run. A separate allowed Run completed checkout as `working`, and the taught build stayed 1.
- **Broken build:** A `working` claim backed only by dispatched input was stored as `inconclusive`. An evidence-backed report was stored as `not-working`.
- **Refusals:** Stale observations, non-ASCII text, and coordinate taps were refused before input.
- **Ownership and capture:** A foreign app paused an agent-held Run, and `Recover same emulator` resumed it with a fresh observation. During Teaching, the mirror ended the recording as `failed`, and learning from it was refused.
- **Restart and disconnect:** After an MCP restart, all four Summaries reread correctly. Killing the emulator paused the Run with `device_disconnected`. Recovery was refused while the device was absent and succeeded on the same serial after a cold boot.
- **Cleanup:** The proof uninstalled only the fixture it had installed. No helper process or owned forward remained, and no device lock directory remained.

`android-workspace-proof.mjs` (Settings) also passed with the new form field: teaching, takeover, verification, later Run, and restart. The combined browser task proof passed with no blockers.

Live proof found one limitation. During agent control, the Workspace mirror does not capture from the device, so a disconnect surfaces only when the agent next observes. This matches the documented authority split.

## Experimental milestone matrix

This matrix covers #457's experimental emulator milestone. "Live" means the product entry point on the emulator. "Tests" means deterministic service tests from #469 and #470.

| Criterion | Status | Evidence |
| --- | --- | --- |
| Opt-in, experimental, pinned backend, refuse unsupported requirements | Live | MCP opt-in flag, experimental Workspace label, coordinate and private-text refusals |
| Explicit selection, identity binding, helper consent, disconnect pause, same-device recovery | Live, except helper installation | Disconnect stage. The helper was preinstalled; consent-bound installation was proved in #473 |
| Declared fresh starting state with install authorization; failed preparation blocks | Live | Fresh sign-in check after each preparation; install guarded by `CONTINGENCY_ANDROID_FIXTURE_INSTALL`. The failed starting-condition refusal is from #474 |
| Taught differences and Run-scoped Run Environment Permission | Live | Changed build refused and allowed in separate Runs; taught build unchanged |
| Selected-device mirrored Teaching with semantic, non-secret input | Live | Workspace Teaching of the checkout |
| Start-to-Stop intervals, ordered actions, before and after observations; incomplete Teaching needs a new recording | Live | Timeline order; capture-loss recording refused for learning |
| Host checks and ownership pause; no secret, coordinate, cross-app, or system-dialog authority | Live | `ownership_unknown` pause and refusals |
| Learn, fresh Dry Run, explicit verification, idempotent Cleanup, exclusive Takeover | Live | Checkout Dry Run and purge; Takeover from the Settings proof rerun on this branch |
| React Native checkout, changed-build success, broken-outcome detection | Live | This report |
| Browser compatibility, owned cleanup, matrix | Live | Combined task proof; cleanup receipt; this table |

## Deferred full-contract matrix

These remain unmet and are not claimed by this proof.

| ADR 0058 requirement | Status |
| --- | --- |
| Private login with a secret Variable | Deferred; the fixture uses a public name |
| Physical-device proof | Deferred; no physical device was selected |
| Multiple-device binding | Deferred |
| Necessary system dialogs and cross-app permission | Deferred; outside apps only pause |
| Secure windows | Deferred; ordinary snapshots do not qualify secure-window handling |
| Observation-bound coordinates and full device-side dispatch guarantees | Deferred |
| Broad emulator and API support | Deferred; Pixel_9 API 36 only |
