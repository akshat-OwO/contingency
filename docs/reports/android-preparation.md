# Experimental Android preparation and environment permission

Issue #469 adds `PlatformRuntimeFactory.android.createRun` for the replacement experimental brief. It retains the internal attach-only `start` factory from #468. Downstream Run integration must use `createRun`; `start` is a runtime adapter primitive and establishes no Run freshness or environment permission. This change does not expose Android Workspace or MCP tools, complete #457, or qualify the full ADR 0058 contract.

## Run lifecycle

`createRun` copies the taught requirements and selected declarations, validates supported capabilities, and performs read-only device and app preflight. It requires the explicitly selected local API 36 emulator serial, AVD, fingerprint, Android release, Target App, and versionCode. The taught Android release is historical; the selected release must match device readback. Web history and unsupported capabilities fail before setup.

Every taught-environment difference remains in Run state. Android release, app build, or app identity differences create a `run-environment-permission` decision naming this Run and Target App. Starting-state description differences are retained without waiving setup. Decisions have unique IDs and cannot be reused across Runs. Refusal permanently blocks the Run. Grants never modify saved Teaching or verification metadata. `state()` returns a copy and retains the original decision declarations after resolution.

`prepare` accepts no input until all decisions resolve. It rechecks the selected environment and obtains the existing per-serial runtime lock before mutation. The only supported setup is `restart-activity`: force-stop the Target App, start the declared in-package activity, capture a fresh observation, and require every declared semantic condition to belong to an uncovered, non-private Target App node. Current foreground state alone is insufficient. A failed setup or condition cannot recover into ready state. The supported Settings proof establishes navigation state without clearing app data; flows requiring data reset or another setup procedure fail as unsupported.

An optional app installation creates a separate checksum-bound decision. The adapter copies the APK into its private owned directory, verifies its bytes, and reads its package and versionCode with Android build-tools 36.0.0 `aapt` before `adb install -r`. The installed versionCode is independently checked afterward. `ANDROID_HOME` or `ANDROID_SDK_ROOT` must identify those build tools. Installation persists after the Run. No downgrade, unrelated-package installation, device provisioning, snapshot restore, or destructive reset route is exposed.

The protocol can persist a typed optional `preparation` alongside existing Android requirements. Existing metadata remains readable. The caller supplies selected setup explicitly, while Run state retains both it and the taught requirements for inspection. Workspace learning and selection of these declarations belong to #470.

## Input and evidence

The Run exposes observe, dispatch, Back, recovery, and owned close. It exposes no raw runtime handle, launch route, shell command, or private Variable resolver. Activations require a caller-declared reversible role/name allowlist. Undeclared activations fail; Confirmation for irreversible or high-impact operations remains unsupported. Public ASCII fill retains the runtime's editable, non-password, app-owned checks. Callers must never resolve a private Variable through it.

Foreground ownership, device identity, pinned helper, SDK session, and selected app build are checked before and after stock input. An unexpected or ambiguous app pauses execution. Explicit recovery rechecks the same selected environment and produces a fresh observation without redoing setup or replaying input. The retained evidence includes preparation, all differences, named decisions, grants, refusals, pauses, fresh observation IDs, and cleanup. Screenshot pixels and node contents are excluded from the public Run-state journal.

These are experimental host checks. They do not claim atomic device-side authorization, synchronized screenshot/snapshot capture, the web Execution Boundary, or stronger retries than unmodified agent-device 0.21.25. Cross-app approval and necessary-system-dialog authorization remain unsupported.

## Proof

The sanitized [live receipt](android-preparation-evidence.json) records the explicitly authorized Pixel_9 at `emulator-5554`. It proves the production `createRun` entry point, changed taught-build permission and refusal, failed starting-condition refusal, declared fresh Settings activity, outside-app setup refusal, unexpected-app pause, same-device fresh recovery, and owned close. The changed-build case compares taught versionCode 35 with installed versionCode 36; it does not install another build. Raw screenshots remain local and are deleted by runtime cleanup.

The [verification recipe](../../.cursor/skills/verify-contingency/features/workspace.md#android-preparation) records the runner, selection requirements, command journal, persisted reread, and owned cleanup. Service tests separately cover decision isolation, declaration mutation, selected-build drift after grant, missing capabilities, web/Android separation, and undeclared activation refusal. APK installation authorization has service coverage; actual APK installation/update remains unqualified by this receipt. Snapshot baselines are unsupported, so no compatible-baseline success is claimed. No physical device or second emulator was driven. The proof-owned helper was removed, the selected emulator stopped, and the independent device-name readback remained unchanged. Owned browser verification processes and isolated state were removed; sanitized artifacts survived cleanup.

#470 must render these decisions and connect Android Teaching and Runs. #471 owns the checkout fixture and actual changed-build matrix. The browser `task-proof.mjs` production drive passed with zero blockers across task continuity, environment restoration, private input, Confirmation, Takeover, fresh Dry Run outcomes, verification/rejection, persisted summaries, and Cleanup resumption. It remains separate from Android qualification.

Validation passed `nub exec turbo run quality`, `nub exec turbo run check-types`, `nub exec --cwd packages/cli vitest run` with 520 tests, and `nub exec turbo run build --filter=@contingencyhq/cli --force`.
