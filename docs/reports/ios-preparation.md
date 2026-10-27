# iOS discovery and Session Simulator preparation

Implementation evidence for [issue 547](https://github.com/akshat-OwO/contingency/issues/547), recorded on 2026-10-27 in worktree `/Users/akshat/.t3/worktrees/contingency/t3-f5dd01d3`, branch `t3/f5dd01d3`. [ADR 0066](../adr/0066-ios-simulator-is-the-next-platform-runtime.md) defines the contract. iOS remains unavailable through MCP until its Support Matrix passes.

## Implemented behavior

`IosPlatform` supplies typed native-app discovery, preparation, environment comparison, Run Environment Permission decisions, and Cleanup. `IosSimctl` separates host inventory from device commands and allows deterministic service tests. Discovery checks macOS, full Xcode, available runtimes, and iOS 26 through 27 before device commands. Explicit physical-device and iPad selections fail. Installed application bundles are read from the selected simulator's bundle containers without booting it.

Preparation copies the authorized `.app` into a private directory and validates its bundle identifier and `CFBundleVersion`. It clones the selected simulator, records the clone and process owner before boot, and changes only the clone. It uninstalls the inherited Target App before installing the copied bundle, resets keychain and privacy decisions, and selects stock agent-device 0.21.25 in its own state directory. `prepare ios-runner` builds and warms XCTest with CLI progress forwarded to stderr. Private Variables remain refused.

Scoped release closes the owned runner, stops its daemon, deletes the clone, and removes its record and temporary state. Cleanup failures retain the record and daemon state for retry. Both web and MCP startup scavenge recorded clones using the existing Agent Session process-liveness check, including its rule that `EPERM` means alive. Cleanup never selects devices by name. Runtime, bundle, and build differences require Run Environment Permission; explicit device type selection needs no additional permission.

## Changed files

- `packages/cli/src/services/ios-contract.ts`, `ios-discovery.ts`, and `ios-simctl.ts` define selection, host checks, and installed bundle discovery.
- `packages/cli/src/services/ios-preparation.ts`, `ios-runner.ts`, and `ios-session-resources.ts` own disposable sessions and cleanup.
- `packages/cli/src/services/ios-environment.ts`, `ios-platform.ts`, and `native-app-platform-services.ts` supply the typed native-app capabilities.
- `packages/cli/src/services/agent-session-resources.ts` exports the shared owner-liveness check.
- `packages/cli/src/cmds/mcp.ts` and `web.ts` run clone Cleanup at startup.
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

The affected suite passes 90 tests in eight files. Tests cover each prerequisite refusal with no device commands, physical-device and iPad refusals, supported-version boundaries, selection identity, copied build validation, environment permissions, success and failure finalizers, cancellation during boot, record-write failure, retained cleanup state, and actual child-process SIGKILL followed by dead-owner scavenging. The SIGKILL test waits for process events and spares a live owner's record. Simulator operations in these tests use the injected service.

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

## Partial live proof and remaining gaps

The host initially had no booted simulators, 72% available memory, and 1,625 MB of used swap. The disposable fixture and proof commands were:

```sh
sh packages/cli/prototypes/ios/build.sh /tmp/contingency-547-build.3K0hU3
nub packages/cli/scripts/verify-ios-preparation.ts /tmp/contingency-547-build.3K0hU3/StreamFixture.app
```

The first attempt created template `B89A1A76-6B42-4DBF-9E01-B2E9182DEEBF` and clone `66FAF62D-AD47-477A-A5C6-F72460D39ABE` on iOS 26.5. It installed the fixture on the template, granted camera privacy permission, and wrote a template-only app-data marker. Preparation successfully copied the installed bundle and opened the fixture in the clone. Independent container readback confirmed that the marker did not reach the clone's fresh Target App data.

Teardown exposed an invalid `--session` flag on `agent-device daemon stop`. The implementation now omits that flag for daemon commands and retains records and state on teardown failure. The failed attempt's owned daemon, PID 7710 on port 64423, was stopped after checking its executable and start time. Its diagnostic directory was removed. The template, clone, and temporary state were deleted.

The next invocation stopped before simulator creation because another agent had booted `contingency-secure-readback-smoke`, UUID `C15D6FDB-F6E6-4796-9D1E-12A0165CE400`. No further simulator proof ran. The complete unchanged-template digest checks, live failure cleanup, final runner build and teardown, and live SIGKILL reclamation remain unverified on the final revision. The final service tests cover these lifecycle paths with an injected simulator service; the owner-liveness SIGKILL test uses a real process. iOS 27 live preparation also remains unverified. No UI, stream, or Support Matrix pass is claimed.

The proof script creates its own template, refuses to boot a clone when another simulator is booted, hashes the selected simulator's data, and checks success, failure, and SIGKILL reclamation. It is available for a later exclusive simulator run.

## Cleanup

The live proof's owner process and daemon exited; the owned daemon port closed. The created template and clone no longer exist. The build and temporary proof directories were removed after verification. The production proof's web server, MCP broker and server, browser driver, and owned Chromium exited, and ports 65206, 65338, and 65339 closed. The T3-owned agent-device 0.21.31 daemon and other agents' simulators were preserved. No branch was pushed and no PR was opened.
