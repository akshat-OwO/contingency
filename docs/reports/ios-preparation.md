# iOS discovery and Session Simulator preparation

Initial implementation evidence for [issue 547](https://github.com/akshat-OwO/contingency/issues/547), recorded on 2026-10-27 in worktree `/Users/akshat/.t3/worktrees/contingency/t3-f5dd01d3`, branch `t3/f5dd01d3`. [ADR 0066](../adr/0066-ios-simulator-is-the-next-platform-runtime.md) defines the contract. Fresh-simulator evidence below covers PR #558 on `ios/session-simulator`. iOS remains unavailable through MCP until its Support Matrix passes.

## Implemented behavior

`IosPlatform` supplies typed native-app discovery, preparation, environment comparison, Run Environment Permission decisions, and Cleanup. `IosSimctl` separates host inventory from device commands and allows deterministic service tests. Discovery checks macOS, full Xcode, available runtimes, and iOS 26 through 27 before device commands. Explicit physical-device and iPad selections fail. Installed application bundles are read from the selected simulator's bundle containers without booting it.

Preparation copies the authorized `.app` into a private directory and validates its bundle identifier and `CFBundleVersion`. It creates a fresh simulator with the selected simulator's device type and runtime, records its identifier and process owner before boot, and installs the copied bundle. The fresh simulator has no inherited app data, keychain, or privacy decisions. Preparation selects stock agent-device 0.21.25 in its own state directory. `prepare ios-runner` builds and warms XCTest with CLI progress forwarded to stderr. Private Variables remain refused.

Scoped release closes the owned runner, stops its daemon, deletes the Session Simulator, and removes its record and temporary state. Cleanup failures retain the record and daemon state for retry. Both web and MCP startup scavenge recorded Session Simulators using the existing Agent Session process-liveness check, including its rule that `EPERM` means alive. Cleanup never selects devices by name. Runtime, bundle, and build differences require Run Environment Permission; explicit device type selection needs no additional permission.

## Changed files

- `packages/cli/src/services/ios-contract.ts`, `ios-discovery.ts`, and `ios-simctl.ts` define selection, host checks, and installed bundle discovery.
- `packages/cli/src/services/ios-preparation.ts`, `ios-runner.ts`, and `ios-session-resources.ts` own disposable sessions and cleanup.
- `packages/cli/src/services/ios-environment.ts`, `ios-platform.ts`, and `native-app-platform-services.ts` supply the typed native-app capabilities.
- `packages/cli/src/services/agent-session-resources.ts` exports the shared owner-liveness check.
- `packages/cli/src/cmds/mcp.ts` and `web.ts` run Session Simulator Cleanup at startup.
- `packages/cli/tests/services/ios.test.ts` covers the service contracts.
- `packages/cli/scripts/verify-ios-preparation.ts` drives the exclusive live proof.
- `docs/reports/ios-preparation.md` records this implementation and evidence.

## Verification commands

These commands run from the repository root:

```sh
nub exec turbo run quality:fix
nub exec turbo run quality
nub run --cwd packages/cli check-types
nub exec --cwd packages/cli tsc --ignoreConfig --noEmit --strict --module nodenext --target es2024 --skipLibCheck --allowImportingTsExtensions --esModuleInterop --noUncheckedIndexedAccess --exactOptionalPropertyTypes --types node scripts/verify-ios-preparation.ts
nub exec --cwd packages/cli vitest run tests/services/ios.test.ts tests/services/agent-session-resources.test.ts tests/services/native-app.test.ts tests/services/native-app-teaching-capture.test.ts tests/services/android-discovery.test.ts tests/services/android-run.test.ts tests/services/android-runtime.test.ts tests/routes/mcp-device-workspace.test.ts
nub exec turbo run build --filter=@contingencyhq/cli --force
```

The earlier eight-file suite passed 90 tests. The fresh-simulator review passed 50 tests in four files with the following command:

```sh
nub exec --cwd packages/cli vitest run tests/services/ios.test.ts tests/services/agent-session-resources.test.ts tests/services/native-app.test.ts tests/routes/mcp-device-workspace.test.ts
```

Tests cover each prerequisite refusal with no device commands, physical-device and iPad refusals, supported-version boundaries, selection identity, copied build validation, environment permissions, success and failure finalizers, cancellation during boot, record-write failure, retained cleanup state, and actual child-process SIGKILL followed by dead-owner scavenging. The SIGKILL test waits for process events and spares a live owner's record. Simulator operations in these tests use the injected service.

The production MCP contract proof uses the [verify-contingency skill](../../.agents/skills/verify-contingency/SKILL.md). The isolated instance was launched with:

```sh
nub .agents/skills/verify-contingency/bin/control-contingency launch
```

The remaining commands used `CONTINGENCY_VERIFY_DIR=/var/folders/yv/c82gq2pd5vl1h1z28h8bv3p00000gn/T/contingency-verify-1793117783677-11008`:

```sh
nub .agents/skills/verify-contingency/bin/control-contingency doctor
CONTINGENCY_MCP_INTERFACE=native nub .agents/skills/verify-contingency/bin/control-contingency mcp start
nub .agents/skills/verify-contingency/bin/device-mcp-proof.mjs
nub .agents/skills/verify-contingency/bin/control-contingency cleanup
```

Doctor reports `ok: true`. The contract receipt reports `status: passed`, catalog size 98,474 bytes, and device tool size 9,996 bytes. Both iOS calls return the unchanged typed `ios_support_matrix_unproven` failure. The receipt and command journal remain under `.cursor/skills/verify-contingency/artifacts/device-mcp/`.

## Clone isolation

A live isolation proof found that booting a `simctl clone` writes into its source simulator's data directory while the source remains Shutdown. Creating and deleting an unbooted clone changed no source files. A plain clone boot changed 83 files, and full preparation changed 589. Changes included widget and chrono timelines, News caches, MobileAsset staging, PRBPosterExtension snapshots, and Safari `db-shm` files.

The clone retained five absolute symlinks into the source: the Shortcuts ToolKit sqlite, MobileAsset lock files, and a Photos PreviewWellImage. The source UDID also remained in LaunchServices csstore, Spotlight indexes, `launchd_bootstrap.plist`, and trace files. Rewriting all five symlinks to point into the clone still changed 102 source files after boot.

Session Simulators therefore use `simctl create <name> <deviceType> <runtime>`. Production preparation only reads the selected simulator's identity and installed app bundle. It never boots, clones, or changes that simulator.

## Live preparation proof and remaining gaps

The fresh-simulator implementation passed on iOS 26.5 with iPhone 17 Pro and iOS 27.1 with iPhone Duo. iPhone Duo was the only iPhone device type supported by the installed 27.1 runtime. Both runs verified fresh Target App data, an unchanged template digest after success, failure, and SIGKILL, and startup reclamation of only the recorded Session Simulator.

The fixture was built from the repository root with:

```sh
sh packages/cli/prototypes/ios/build.sh /tmp/contingency-558-build.7PwzDP
```

The proof commands ran from `packages/cli`:

```sh
nub scripts/verify-ios-preparation.ts /tmp/contingency-558-build.7PwzDP/StreamFixture.app
nub scripts/verify-ios-preparation.ts /tmp/contingency-558-build.7PwzDP/StreamFixture.app com.apple.CoreSimulator.SimDeviceType.iPhone-Duo com.apple.CoreSimulator.SimRuntime.iOS-27-1
```

The passing results were:

- iOS 26.5: template SHA-256 `555c89e8aea67a9568caef4fa6674345c38baa53d0459d862785206b61213b81`, session `44666C4F-411C-4256-B62D-B1BDC0FB69CD`, and SIGKILL session `BD14BC9B-93A3-4652-851E-169A7BC10796`.
- iOS 27.1: template `73043F95-7508-427B-951F-706214C7D736`, template SHA-256 `a4a802a8db527145b0d084fffc49a38085cd055698729a1c780363f6d3a324df`, session `0822A6C4-2544-4FBA-AE41-E34DF84EFDC4`, and SIGKILL owner PID 92528 with session `3FEBA3C4-D282-49D9-95AA-E77D58854A93`.

Both runs printed `PASS: template hash <digest> unchanged after success, failure and SIGKILL; startup reclaimed only the recorded Session Simulator`. The child prints `Detected unsettled top-level await` when SIGKILLed by design. These live proofs were supplied by the parent agent and were not rerun during the implementation review.

No UI, stream, or Support Matrix pass is claimed. Private Variables remain refused. The proof script creates and populates its own disposable template before hashing it, and refuses to boot a simulator when another is booted.

## Cleanup

Both live runs removed their disposable templates and Session Simulators and stopped their owned daemons. No Contingency simulators remained. The earlier production contract proof's web server, MCP broker and server, browser driver, and owned Chromium exited, and ports 65206, 65338, and 65339 closed. The T3-owned agent-device daemon and other agents' simulators were preserved.
