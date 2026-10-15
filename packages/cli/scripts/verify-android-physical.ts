import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { NodeRuntime } from "@effect/platform-node";
import {
  Cause,
  Clock,
  Deferred,
  Effect,
  Fiber,
  Queue,
  Redacted,
  Schedule,
  Scope,
} from "effect";

import type {
  AndroidRun,
  AndroidRunInput,
} from "../src/services/android-run-contract.ts";
import {
  androidHelperRelease,
  androidPrivateTextRelease,
} from "../src/services/android-runtime-contract.ts";
import type {
  AndroidDeviceSelection,
  AndroidObservation,
  AndroidRuntimeStartInput,
} from "../src/services/android-runtime-contract.ts";
import { makeAndroidRuntimeFactory } from "../src/services/android-runtime.ts";
import { platformRuntimeError } from "../src/services/platform-runtime-error.ts";
import type { PlatformRuntimeError } from "../src/services/platform-runtime.ts";

const execute = promisify(execFile);
const serial = process.env.CONTINGENCY_ANDROID_SERIAL;
const fingerprint = process.env.CONTINGENCY_ANDROID_FINGERPRINT;
const model = process.env.CONTINGENCY_ANDROID_MODEL;
const avd = process.env.CONTINGENCY_ANDROID_AVD;
const directory = process.env.CONTINGENCY_ANDROID_EVIDENCE_DIRECTORY;
const apk = process.env.CONTINGENCY_ANDROID_FIXTURE_APK;
const targetApp = "dev.contingency.physicalfixture";
const journal: string[] = [];
const check = (condition: boolean, message: string) => {
  if (!condition) {
    journal.push(message);
  }
  return condition ? Effect.void : Effect.fail(new Error(message));
};
const adb = (args: readonly string[]) =>
  Effect.tryPromise({
    catch: () => platformRuntimeError("runtime_failed"),
    try: async (signal) => {
      const { stdout } = await execute("adb", ["-s", serial ?? "", ...args], {
        maxBuffer: 64 * 1024 * 1024,
        signal,
        timeout: 30_000,
      });
      return stdout.trim();
    },
  });
const deviceState = Effect.all({
  enabledIme: adb([
    "shell",
    "settings",
    "get",
    "secure",
    "enabled_input_methods",
  ]),
  forwards: Effect.tryPromise({
    catch: () => platformRuntimeError("runtime_failed"),
    try: async () => {
      const { stdout } = await execute("adb", ["forward", "--list"]);
      return stdout
        .split("\n")
        .filter((line) => line.startsWith(`${serial} `))
        .toSorted();
    },
  }),
  ime: adb(["shell", "settings", "get", "secure", "default_input_method"]),
  packages: adb(["shell", "pm", "list", "packages"]).pipe(
    Effect.map((value) =>
      createHash("sha256")
        .update(value.split("\n").toSorted().join("\n"))
        .digest("hex")
    )
  ),
});
const audit = <A, E>(name: string, effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        journal.push(name);
      })
    )
  );
const field = (observation: AndroidObservation) =>
  observation.nodes.find(
    (node) => node.editable && node.password && !node.covered
  );
const named = (observation: AndroidObservation, name: string) =>
  observation.nodes.find((node) => node.name === name && !node.covered);
const requireField = (observation: AndroidObservation) => {
  const node = field(observation);
  if (node === undefined) {
    journal.push("No password field.");
    return Effect.fail(new Error("No password field."));
  }
  return Effect.succeed(node);
};
const requireNamed = (observation: AndroidObservation, name: string) => {
  const node = named(observation, name);
  return node === undefined
    ? Effect.fail(new Error("Required fixture control missing."))
    : Effect.succeed(node);
};
const retainObservation = (
  widget: string,
  stage: string,
  observation: AndroidObservation
) =>
  Effect.tryPromise({
    catch: () => new Error("Could not retain fixture observation."),
    try: async () => {
      const destination = directory ?? "";
      await mkdir(destination, { recursive: true });
      const { image, ...screenshot } = observation.screenshot;
      await writeFile(
        path.join(destination, `${widget}-${stage}.json`),
        `${JSON.stringify({ ...observation, screenshot }, null, 2)}\n`
      );
      await writeFile(
        path.join(destination, `${widget}-${stage}.png`),
        Buffer.from(image, "base64")
      );
    },
  });
const scanDiagnostics = (since: number, sentinel: string) =>
  Effect.tryPromise({
    catch: () => new Error("Could not inspect owned host diagnostics."),
    try: async () => {
      const entriesAtRoot = await readdir(tmpdir());
      const directories = entriesAtRoot.filter((name) =>
        name.startsWith("contingency-android-runtime-")
      );
      const candidates = await Promise.all(
        directories.map(async (name) => {
          const root = path.join(tmpdir(), name);
          const status = await stat(root);
          return status.birthtimeMs >= since ? root : null;
        })
      );
      const entries = await Promise.all(
        candidates
          .filter((root) => root !== null)
          .map((root) =>
            readdir(root, { recursive: true, withFileTypes: true })
          )
      );
      const files = entries
        .flat()
        .flatMap((entry) =>
          entry.isFile() ? [path.join(entry.parentPath, entry.name)] : []
        );
      const contents = await Promise.all(files.map((file) => readFile(file)));
      return {
        contained: contents.some((content) => content.includes(sentinel)),
        files: files.length,
      };
    },
  });

const proveDisconnect = (run: AndroidRun) =>
  Effect.scoped(
    Effect.gen(function* disconnect() {
      const changes = yield* Queue.unbounded<boolean, Error>();
      const exited = yield* Deferred.make<undefined>();
      const child = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const process = spawn("adb", ["track-devices"], {
            stdio: ["ignore", "pipe", "ignore"],
          });
          let buffered = "";
          process.stdout.on("data", (chunk: Buffer) => {
            buffered += chunk.toString("utf-8");
            while (buffered.length >= 4) {
              const header = buffered.slice(0, 4);
              if (!/^[0-9a-f]{4}$/iu.test(header)) {
                Queue.failCauseUnsafe(
                  changes,
                  Cause.fail(new Error("Invalid ADB device frame."))
                );
                return;
              }
              const length = Number.parseInt(header, 16);
              if (buffered.length < length + 4) {
                return;
              }
              const devices = buffered.slice(4, length + 4);
              buffered = buffered.slice(length + 4);
              Queue.offerUnsafe(
                changes,
                devices.split("\n").some((line) => line === `${serial}\tdevice`)
              );
            }
          });
          process.once("error", () =>
            Queue.failCauseUnsafe(
              changes,
              Cause.fail(new Error("Device tracker failed."))
            )
          );
          process.once("close", () => {
            Deferred.doneUnsafe(exited, Effect.undefined);
            Queue.failCauseUnsafe(
              changes,
              Cause.fail(new Error("Device tracker closed."))
            );
          });
          return process;
        }),
        (owned) =>
          Effect.sync(() => {
            owned.kill();
          }).pipe(
            Effect.andThen(Deferred.await(exited)),
            Effect.timeout("10 seconds"),
            Effect.orDie
          )
      );
      const waitFor = (connected: boolean) =>
        Effect.gen(function* connectionEvent() {
          while ((yield* Queue.take(changes)) !== connected) {
            // Wait on device events, never on time.
          }
        }).pipe(Effect.timeout("5 minutes"));
      yield* waitFor(true);
      const before = yield* run.observe();
      yield* Effect.sync(() => {
        process.stdout.write(
          `${JSON.stringify({ serial, stage: "ready-to-unplug", trackerPid: child.pid })}\n`
        );
      });
      yield* waitFor(false);
      const failed = yield* Effect.flip(run.observe());
      yield* check(
        failed.code === "device_disconnected" && run.state().phase === "paused",
        "Disconnect did not pause the selected Run."
      );
      const recoveryWhileDisconnected = yield* Effect.flip(run.recover());
      yield* check(
        recoveryWhileDisconnected.code === "device_disconnected",
        "Disconnected recovery must refuse without selecting another device."
      );
      yield* Effect.sync(() => {
        process.stdout.write(
          `${JSON.stringify({ serial, stage: "ready-to-reconnect" })}\n`
        );
      });
      yield* waitFor(true);
      const recovered = yield* run.recover();
      yield* check(
        recovered.device.serial === serial && recovered.id !== before.id,
        "Recovery must use the same serial and a fresh observation."
      );
      journal.push(
        "physical unplug paused; same serial recovered with fresh observation"
      );
      return {
        freshObservation: true,
        paused: true,
        recoveryWhileDisconnected: recoveryWhileDisconnected.code,
        sameSerial: true,
      };
    })
  );

/** Wait for the fixture's focus callback, including while the private helper owns UiAutomation. */
const launchFixture = (activity: string, filtered = false) =>
  Effect.scoped(
    Effect.gen(function* focusTransition() {
      const token = randomUUID();
      const epoch = yield* adb(["shell", "date", "+%s"]);
      const focused = yield* Deferred.make<undefined, PlatformRuntimeError>();
      const exited = yield* Deferred.make<undefined>();
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const child = spawn(
            "adb",
            [
              "-s",
              serial ?? "",
              "logcat",
              "-T",
              `${epoch}.0`,
              "-s",
              "ContingencyFixture:I",
              "*:S",
            ],
            { stdio: ["ignore", "pipe", "ignore"] }
          );
          journal.push(`focus watcher started: pid ${child.pid ?? "unknown"}`);
          let buffered = "";
          child.stdout.on("data", (chunk: Buffer) => {
            buffered += chunk.toString("utf-8");
            const lines = buffered.split("\n");
            buffered = lines.pop() ?? "";
            for (const line of lines) {
              if (line.includes(`${activity} focused ${token}`)) {
                Deferred.doneUnsafe(focused, Effect.undefined);
              }
            }
          });
          child.once("error", () =>
            Deferred.doneUnsafe(
              focused,
              Effect.fail(platformRuntimeError("runtime_failed"))
            )
          );
          child.once("close", () => {
            Deferred.doneUnsafe(exited, Effect.undefined);
            Deferred.doneUnsafe(
              focused,
              Effect.fail(platformRuntimeError("runtime_failed"))
            );
          });
          return child;
        }),
        (owned) =>
          Effect.sync(() => owned.kill()).pipe(
            Effect.andThen(Deferred.await(exited)),
            Effect.timeout("10 seconds"),
            Effect.tap(() =>
              Effect.sync(() => {
                journal.push(
                  `focus watcher stopped: pid ${owned.pid ?? "unknown"}`
                );
              })
            ),
            Effect.orDie
          )
      );
      yield* adb([
        "shell",
        "am",
        "start",
        "-S",
        "--user",
        "0",
        "-W",
        "-n",
        `${targetApp}/.${activity}`,
        "--es",
        "focus-token",
        token,
        ...(filtered ? ["--ez", "filter", "true"] : []),
      ]);
      yield* Deferred.await(focused).pipe(
        Effect.timeoutOrElse({
          duration: "30 seconds",
          orElse: () => Effect.fail(platformRuntimeError("runtime_failed")),
        })
      );
      const windows = yield* adb(["shell", "dumpsys", "window"]);
      const current = [...windows.matchAll(/mCurrentFocus=(?<window>[^\n]+)/gu)]
        .map((match) => match.groups?.window)
        .find((window) => window?.includes(` u0 ${targetApp}/`));
      if (
        !current?.includes(` u0 ${targetApp}/`) ||
        !current.includes(activity)
      ) {
        return yield* Effect.fail(platformRuntimeError("ownership_unknown"));
      }
      journal.push(`fixture window focused: ${activity}`);
    })
  );

const provePrivateInput = (
  startup: AndroidRuntimeStartInput,
  started: number,
  widget: "native" | "material" | "material-filtered"
) =>
  Effect.scoped(
    Effect.gen(function* privateProof() {
      const activity =
        widget === "native" ? "MainActivity" : "MaterialPasswordActivity";
      yield* launchFixture(activity, widget === "material-filtered");
      const factory = makeAndroidRuntimeFactory();
      const runtime = yield* audit(
        `start private-input runtime on ${widget} fixture`,
        factory.start({
          ...startup,
          requiredCapabilities: [
            "semantic-actions",
            "screenshots",
            "private-input",
          ],
          scope: yield* Scope.Scope,
        })
      );
      const sentinel = `ctg${randomBytes(16).toString("hex")}`;
      let resolved = 0;
      const variable = {
        value: Effect.sync(() => {
          resolved += 1;
          return Redacted.make(sentinel);
        }),
        variable: "proof.fixturePassword",
      };
      const bound = yield* runtime.observe();
      yield* retainObservation(widget, "before", bound);
      const password = yield* requireField(bound);
      const epoch = yield* adb(["shell", "date", "+%s"]);
      const samples = {
        device: 0,
        deviceContained: false,
        helperSeen: 0,
        host: 0,
        hostContained: false,
      };
      const sampler = yield* Effect.forkChild(
        Effect.gen(function* sample() {
          const deviceArgs = yield* adb(["shell", "ps", "-A", "-o", "ARGS"]);
          samples.device += 1;
          samples.deviceContained ||= deviceArgs.includes(sentinel);
          if (deviceArgs.includes(androidPrivateTextRelease.packageName)) {
            samples.helperSeen += 1;
          }
          const hostArgs = yield* Effect.tryPromise(() =>
            execute("ps", ["-axo", "args"], { maxBuffer: 16 * 1024 * 1024 })
          );
          samples.host += 1;
          samples.hostContained ||= hostArgs.stdout.includes(sentinel);
        }).pipe(Effect.repeat(Schedule.spaced("50 millis")))
      );
      const fillResult = yield* Effect.result(
        runtime.enterPrivate(bound.id, { ...variable, target: password.target })
      );
      const uncertain =
        fillResult._tag === "Failure" &&
        fillResult.failure.code === "private_input_uncertain" &&
        fillResult.failure.backendReason === "input_unverified";
      yield* check(
        widget === "material"
          ? fillResult._tag === "Success" &&
              fillResult.success.outcome === "verified"
          : uncertain,
        widget === "material"
          ? "Stock Material field must verify exact readback."
          : "Masked or filtered field must remain uncertain after input."
      );
      const fill =
        widget === "material"
          ? { outcome: "verified" as const }
          : {
              outcome: "uncertain" as const,
              reason: "input_unverified" as const,
            };
      journal.push(`${widget} private fill: ${fill.outcome}`);
      yield* check(
        resolved === 1 &&
          runtime.state().observationId === null &&
          runtime.state().phase ===
            (widget === "material" ? "ready" : "paused"),
        `${widget}: fill must consume its observation, resolve once, and preserve the expected pause state.`
      );
      yield* Fiber.interrupt(sampler);
      const filled =
        widget === "material"
          ? yield* runtime.observe()
          : yield* runtime.recover();
      const action = yield* requireNamed(filled, "Verify semantic action");
      yield* runtime.dispatch(filled.id, {
        target: action.target,
        type: "activate",
      });
      const semantic = yield* runtime.observe();
      yield* check(
        Boolean(named(semantic, "Semantic action passed")),
        `${widget}: semantic action did not produce its expected outcome.`
      );
      yield* check(
        filled.backendSessionId === bound.backendSessionId &&
          semantic.backendSessionId === bound.backendSessionId,
        `${widget}: agent-device session changed after private fill.`
      );
      const logcat = yield* adb(["logcat", "-d", "-T", `${epoch}.0`]);
      const diagnostics = yield* scanDiagnostics(started, sentinel);
      const observationsContained = [bound, filled, semantic].some(
        (observation) => JSON.stringify(observation).includes(sentinel)
      );
      yield* check(
        [
          logcat.includes(sentinel),
          diagnostics.contained,
          observationsContained,
          samples.deviceContained,
          samples.hostContained,
          samples.helperSeen === 0,
        ].every((contained) => !contained),
        "Private sentinel privacy proof failed."
      );
      yield* retainObservation(widget, "after", semantic);
      const stale = yield* Effect.flip(
        runtime.enterPrivate(bound.id, { ...variable, target: password.target })
      );
      const ordinaryObservation = yield* runtime.recover();
      const ordinary = yield* requireNamed(
        ordinaryObservation,
        "Public fixture field"
      );
      const ordinaryRefusal = yield* Effect.flip(
        runtime.enterPrivate(ordinaryObservation.id, {
          ...variable,
          target: ordinary.target,
        })
      );
      const replaced = yield* runtime.recover();
      const replaceWindow = launchFixture("ReplacementActivity");
      yield* replaceWindow;
      const beforeBind = yield* Effect.flip(
        runtime.enterPrivate(replaced.id, {
          ...variable,
          target: (yield* requireField(replaced)).target,
        })
      );
      yield* launchFixture(activity, widget === "material-filtered");
      const afterBindObservation = yield* runtime.recover();
      const afterBind = yield* Effect.flip(
        runtime.enterPrivate(afterBindObservation.id, {
          target: (yield* requireField(afterBindObservation)).target,
          value: replaceWindow.pipe(Effect.as(Redacted.make(sentinel))),
          variable: "proof.windowChange",
        })
      );
      yield* launchFixture(activity, widget === "material-filtered");
      const mismatchObservation = yield* runtime.recover();
      const mismatchPassword = yield* requireField(mismatchObservation);
      const removal = yield* adb([
        "shell",
        "am",
        "broadcast",
        "--user",
        "0",
        "-a",
        `${targetApp}.REMOVE_PASSWORD`,
        "-p",
        targetApp,
      ]);
      yield* check(
        removal.includes("Broadcast completed: result=1"),
        `${widget}: fixture did not acknowledge field removal.`
      );
      const mismatch = yield* Effect.flip(
        runtime.enterPrivate(mismatchObservation.id, {
          ...variable,
          target: mismatchPassword.target,
        })
      );
      journal.push(
        `${widget}: removed-field helper response ${mismatch.code}/${mismatch.backendReason ?? "none"}`
      );
      const removedObservation = yield* runtime.recover();
      yield* check(
        !JSON.stringify(removedObservation).includes(sentinel),
        "Removed-field observation contained the sentinel."
      );
      yield* retainObservation(widget, "removed", removedObservation);
      yield* check(
        field(removedObservation) === undefined,
        `${widget}: fixture did not remove its password field.`
      );
      for (const [name, actual, expected] of [
        ["stale", stale.code, "observation_stale"],
        ["ordinary", ordinaryRefusal.code, "target_unsupported"],
        ["before-bind window", beforeBind.code, "target_changed"],
        ["after-bind window", afterBind.code, "target_changed"],
        ["removed field", mismatch.code, "target_changed"],
      ]) {
        yield* check(
          actual === expected,
          `${widget}: ${name} refused with ${actual}; expected ${expected}.`
        );
      }
      yield* check(
        resolved === 1,
        `${widget}: pre-fill refusals resolved the Variable.`
      );
      yield* runtime.close();
      yield* check(
        runtime.state().phase === "closed" &&
          runtime.state().failure?.code !== "cleanup_failed",
        "Runtime cleanup failed."
      );
      return {
        afterBind,
        beforeBind,
        diagnostics,
        fill,
        mismatch,
        observationsContained,
        ordinaryRefusal,
        resolved,
        samples,
        stale,
      };
    })
  );

Effect.gen(function* proveDevice() {
  yield* check(
    [serial, fingerprint, directory, apk, model ?? avd].every(Boolean),
    "Supply serial, identity, fixture APK and evidence directory."
  );
  yield* check(
    process.env.CONTINGENCY_ANDROID_FIXTURE_INSTALL === "authorized",
    "Explicitly authorize fixture and helper installation, fixture app-data clearing and permissions."
  );
  if (!serial || !fingerprint || !directory || !apk) {
    return;
  }
  const device: AndroidDeviceSelection = model
    ? { api: 36, fingerprint, host: "local", kind: "physical", model, serial }
    : { api: 36, avd: avd ?? "", fingerprint, host: "local", serial };
  const before = yield* deviceState;
  const owned: string[] = [];
  for (const packageName of [
    targetApp,
    androidHelperRelease.packageName,
    androidPrivateTextRelease.packageName,
  ]) {
    const present = yield* adb(["shell", `pm path ${packageName} || true`]);
    if (present === "") {
      owned.push(packageName);
    }
  }
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* cleanupOnExit() {
      for (const packageName of owned) {
        const cleanup = yield* Effect.result(
          Effect.gen(function* uninstallOwned() {
            const present = yield* adb([
              "shell",
              `pm path ${packageName} || true`,
            ]);
            if (present !== "") {
              yield* adb(["uninstall", packageName]);
            }
          })
        );
        if (cleanup._tag === "Failure") {
          yield* Effect.sync(() => {
            process.stderr.write(
              `${JSON.stringify({ cleanupFailed: packageName, serial })}\n`
            );
          });
        }
      }
    })
  );
  yield* check(
    owned.includes(targetApp),
    "Fixture already exists; refuse to clear or replace pre-existing fixture state."
  );
  const bytes = yield* Effect.tryPromise(() => readFile(apk));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const started = yield* Clock.currentTimeMillis;
  const factory = makeAndroidRuntimeFactory();
  const result = yield* Effect.result(
    Effect.scoped(
      Effect.gen(function* sessionProof() {
        const scope = yield* Scope.Scope;
        let startup: AndroidRuntimeStartInput = {
          device,
          platform: "android",
          requiredCapabilities: ["semantic-actions", "screenshots"],
          scope,
          targetApp,
        };
        if (owned.includes(androidHelperRelease.packageName)) {
          startup = {
            ...startup,
            installationGrant: {
              operation: "install",
              serial,
              sha256: androidHelperRelease.sha256,
            },
          };
        }
        if (owned.includes(androidPrivateTextRelease.packageName)) {
          startup = {
            ...startup,
            privateTextGrant: {
              operation: "install",
              serial,
              sha256: androidPrivateTextRelease.sha256,
            },
          };
        }
        const environment = {
          androidVersion: "16",
          appBuild: "1",
          appId: targetApp,
          permissions: [
            {
              decision: "revoke" as const,
              permission: "android.permission.POST_NOTIFICATIONS",
            },
          ],
          startingState: "fresh fixture data",
        };
        const input: AndroidRunInput = {
          ...startup,
          appInstallation: { apk, sha256 },
          environment,
          reversibleActions: [{ name: "Store fixture data", role: "button" }],
          setup: {
            activity: `${targetApp}/.MainActivity`,
            conditions: [{ name: "Fresh fixture data", role: "text" }],
            kind: model ? "clear-app-data" : "restart-activity",
          },
          taught: {
            capabilities: startup.requiredCapabilities,
            environment,
            platform: "android",
          },
        };
        const refused = yield* audit(
          "create consent-refusal Run",
          factory.createRun(input)
        );
        const refusedDecision = refused
          .state()
          .pending.find(
            (entry) =>
              entry.kind === (model ? "clear-app-data" : "app-installation")
          );
        yield* check(
          Boolean(refusedDecision),
          "Run must request explicit preparation consent."
        );
        yield* refused.decide(refusedDecision?.id ?? "", false);
        const denial = yield* Effect.flip(refused.prepare());
        yield* check(
          denial.code === "preparation_required" &&
            refused.state().phase === "refused",
          "Refusal did not block preparation."
        );
        yield* refused.close();
        const run = yield* factory.createRun(input);
        for (const decision of run.state().pending) {
          yield* run.decide(decision.id, true);
        }
        const prepared = yield* audit(
          "prepare fresh fixture with notification denial",
          run.prepare()
        );
        yield* check(
          Boolean(named(prepared, "Fresh fixture data")),
          "Starting screen proof failed."
        );
        if (model) {
          const store = yield* requireNamed(prepared, "Store fixture data");
          yield* run.dispatch(prepared.id, {
            target: store.target,
            type: "activate",
          });
          yield* check(
            Boolean(named(yield* run.observe(), "Existing fixture data")),
            "Persistent fixture marker did not change."
          );
        }
        yield* run.close();
        const { appInstallation: _installation, ...installedInput } = input;
        if (model) {
          const next = yield* factory.createRun(installedInput);
          for (const decision of next.state().pending) {
            yield* next.decide(decision.id, true);
          }
          yield* check(
            Boolean(named(yield* next.prepare(), "Fresh fixture data")),
            "Clear app-data did not remove persistent state."
          );
          yield* next.close();
        }
        const grantRun = yield* factory.createRun({
          ...installedInput,
          environment: {
            ...environment,
            permissions: [
              {
                decision: "grant",
                permission: "android.permission.POST_NOTIFICATIONS",
              },
            ],
          },
        });
        for (const decision of grantRun.state().pending) {
          yield* grantRun.decide(decision.id, true);
        }
        yield* audit("prepare with notification grant", grantRun.prepare());
        let disconnectProof = null;
        if (process.env.CONTINGENCY_ANDROID_DISCONNECT_PROOF === "manual") {
          disconnectProof = yield* proveDisconnect(grantRun);
        }
        yield* grantRun.close();

        const {
          afterBind,
          beforeBind,
          diagnostics,
          fill,
          mismatch,
          observationsContained,
          ordinaryRefusal,
          resolved,
          samples,
          stale,
        } = yield* provePrivateInput(startup, started, "native");
        const material = yield* provePrivateInput(startup, started, "material");
        const filtered = yield* provePrivateInput(
          startup,
          started,
          "material-filtered"
        );
        return {
          disconnectProof,
          filteredPrivateFill: {
            privateFill: filtered.fill,
            sentinel: {
              diagnostics: filtered.diagnostics,
              logcatContained: false,
              observationsContained: filtered.observationsContained,
              samples: filtered.samples,
            },
            sessionPreserved: true,
          },
          journal,
          preparation: {
            consentRefused: true,
            freshState: true,
            notificationDenial: true,
            notificationGrant: true,
            persistentDataCleared: Boolean(model),
          },
          privateFill: fill,
          refusals: {
            afterBind: afterBind.code,
            beforeBind: beforeBind.code,
            fieldMismatch: mismatch.code,
            ordinary: ordinaryRefusal.code,
            resolved,
            stale: stale.code,
          },
          sentinel: {
            diagnostics,
            logcatContained: false,
            observationsContained,
            samples,
          },
          sessionPreserved: true,
          verifiedPrivateFill: {
            privateFill: material.fill,
            refusals: {
              afterBind: material.afterBind.code,
              beforeBind: material.beforeBind.code,
              fieldMismatch: material.mismatch.code,
              ordinary: material.ordinaryRefusal.code,
              resolved: material.resolved,
              stale: material.stale.code,
            },
            sentinel: {
              diagnostics: material.diagnostics,
              logcatContained: false,
              observationsContained: material.observationsContained,
              samples: material.samples,
            },
            sessionPreserved: true,
            widget: "material-1.13.0-password",
          },
        };
      }).pipe(
        Effect.catchDefect(() =>
          check(false, "Unexpected proof defect; input was not retried.")
        )
      )
    )
  );
  // Only packages absent before this proof may be removed. Runtime scopes have closed first.
  for (const packageName of owned) {
    const present = yield* adb(["shell", `pm path ${packageName} || true`]);
    if (present !== "") {
      yield* adb(["uninstall", packageName]);
    }
  }
  const after = yield* deviceState;
  const helperProcess = yield* adb([
    "shell",
    `pidof ${androidPrivateTextRelease.packageName} || true`,
  ]);
  const cleanup = {
    forwardsUnchanged:
      JSON.stringify(before.forwards) === JSON.stringify(after.forwards),
    helperProcess,
    imeUnchanged:
      before.ime === after.ime && before.enabledIme === after.enabledIme,
    packagesUnchanged: before.packages === after.packages,
  };
  yield* check(
    cleanup.forwardsUnchanged &&
      cleanup.imeUnchanged &&
      cleanup.packagesUnchanged &&
      helperProcess === "",
    "Device cleanup proof failed."
  );
  yield* Effect.tryPromise(async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "receipt.json"),
      `${JSON.stringify({ cleanup, device, journal, result }, null, 2)}\n`
    );
  });
  yield* Effect.sync(() => {
    process.stdout.write(
      `${JSON.stringify({ cleanup, receipt: path.join(directory, "receipt.json"), success: result._tag === "Success" })}\n`
    );
  });
  if (result._tag === "Failure") {
    return yield* Effect.fail(
      new Error("Device proof failed; inspect the sanitized receipt.")
    );
  }
}).pipe(Effect.scoped, NodeRuntime.runMain);
