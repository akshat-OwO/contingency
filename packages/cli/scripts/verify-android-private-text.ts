import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { NodeRuntime } from "@effect/platform-node";
import { Clock, Effect, Fiber, Redacted, Schedule, Scope } from "effect";

import {
  androidHelperRelease,
  androidPrivateTextRelease,
} from "../src/services/android-runtime-contract.ts";
import type {
  AndroidObservation,
  AndroidPlatformRuntime,
  AndroidRuntimeStartInput,
} from "../src/services/android-runtime-contract.ts";
import { makeAndroidRuntimeFactory } from "../src/services/android-runtime.ts";

const execute = promisify(execFile);
const serial = process.env.CONTINGENCY_ANDROID_SERIAL;
const avd = process.env.CONTINGENCY_ANDROID_AVD;
const fingerprint = process.env.CONTINGENCY_ANDROID_FINGERPRINT;
const helperGrant = process.env.CONTINGENCY_ANDROID_HELPER_GRANT;
const privateGrant = process.env.CONTINGENCY_ANDROID_PRIVATE_TEXT_GRANT;
const evidenceDirectory = process.env.CONTINGENCY_ANDROID_EVIDENCE_DIRECTORY;
const grants = new Set(["install", "replace", "none"]);
const journal: {
  readonly command: string;
  readonly outcome: "success" | "failed";
}[] = [];

const audit = <A, E>(command: string, effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.onExit((exit) =>
      Effect.sync(() => {
        journal.push({
          command,
          outcome: exit._tag === "Success" ? "success" : "failed",
        });
      })
    )
  );

/** Proof tooling only; output is searched, never retained. */
const adb = (args: readonly string[]) =>
  Effect.tryPromise(async () => {
    const { stdout } = await execute("adb", ["-s", serial ?? "", ...args], {
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout.trim();
  });

const summary = (observation: AndroidObservation) => ({
  backendSessionId: observation.backendSessionId,
  generation: observation.generation,
  id: observation.id,
  nodeCount: observation.nodes.length,
  screenshotSha256: createHash("sha256")
    .update(Buffer.from(observation.screenshot.image, "base64"))
    .digest("hex"),
});

const find = (
  observation: AndroidObservation,
  predicate: (node: AndroidObservation["nodes"][number]) => boolean,
  description: string
) => {
  const node = observation.nodes.find(
    (candidate) => !candidate.covered && predicate(candidate)
  );
  return node === undefined
    ? Effect.fail(new Error(`Observation has no ${description}.`))
    : Effect.succeed(node);
};

/** Files under owned runtime directories, read while the runtime is open. */
const scanFiles = (roots: readonly string[], value: string) =>
  Effect.tryPromise(async () => {
    const listed = await Promise.all(
      roots.map((root) =>
        readdir(root, { recursive: true, withFileTypes: true })
      )
    );
    const files = listed
      .flat()
      .flatMap((entry) =>
        entry.isFile() ? [path.join(entry.parentPath, entry.name)] : []
      );
    const contents = await Promise.all(files.map((file) => readFile(file)));
    return {
      contained: contents.some((content) => content.includes(value)),
      files: files.length,
    };
  });

const ownedRuntimeDirectories = (since: number) =>
  Effect.tryPromise(async () => {
    const entries = await readdir(tmpdir());
    const candidates = entries.flatMap((entry) =>
      entry.startsWith("contingency-android-runtime-")
        ? [path.join(tmpdir(), entry)]
        : []
    );
    const created = await Promise.all(
      candidates.map(async (target) => {
        const status = await stat(target);
        return { created: status.birthtimeMs, target };
      })
    );
    return created.flatMap((entry) =>
      entry.created >= since ? [entry.target] : []
    );
  });

const grant = <Sha extends string>(
  operation: string | undefined,
  selected: string,
  sha256: Sha
) =>
  operation === "install" || operation === "replace"
    ? { operation, serial: selected, sha256 }
    : undefined;

/** UI Automator dump between helper turns locates a control for an external change. */
const tapText = (text: string) =>
  Effect.gen(function* externalTap() {
    yield* adb(["shell", "uiautomator", "dump", "/sdcard/contingency-490.xml"]);
    const xml = yield* adb(["shell", "cat", "/sdcard/contingency-490.xml"]);
    yield* adb(["shell", "rm", "-f", "/sdcard/contingency-490.xml"]);
    const escaped = text.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
    const match = new RegExp(
      `text="${escaped}"[^>]*?bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`,
      "u"
    ).exec(xml);
    if (match === null) {
      return yield* Effect.fail(new Error(`No on-screen control "${text}".`));
    }
    const [left, top, right, bottom] = match.slice(1).map(Number);
    yield* adb([
      "shell",
      "input",
      "tap",
      String(Math.round(((left ?? 0) + (right ?? 0)) / 2)),
      String(Math.round(((top ?? 0) + (bottom ?? 0)) / 2)),
    ]);
  });

const deviceState = Effect.all({
  defaultInputMethod: adb([
    "shell",
    "settings",
    "get",
    "secure",
    "default_input_method",
  ]),
  enabledInputMethods: adb([
    "shell",
    "settings",
    "get",
    "secure",
    "enabled_input_methods",
  ]),
  forwards: Effect.tryPromise(async () => {
    const { stdout } = await execute("adb", ["forward", "--list"]);
    return stdout
      .split("\n")
      .filter((line) => line.startsWith(`${serial ?? ""} `))
      .toSorted();
  }),
  savedNetworks: adb(["shell", "cmd", "wifi", "list-networks"]),
});

Effect.scoped(
  Effect.gen(function* verifyPrivateText() {
    const selected = [serial, avd, fingerprint, evidenceDirectory].every(
      Boolean
    );
    const granted = [helperGrant, privateGrant].every((value) =>
      grants.has(value ?? "")
    );
    if (
      !selected ||
      !granted ||
      !serial ||
      !avd ||
      !fingerprint ||
      !evidenceDirectory
    ) {
      return yield* Effect.fail(
        new Error(
          "Supply the explicitly selected serial, AVD, fingerprint, evidence directory, and both helper grants using CONTINGENCY_ANDROID_* variables."
        )
      );
    }
    const startedAt = yield* Clock.currentTimeMillis;
    const before = yield* deviceState;
    const privateTextInstalledBefore =
      (yield* adb([
        "shell",
        `pm path ${androidPrivateTextRelease.packageName} || true`,
      ])) !== "";
    if (privateGrant === "install" && !privateTextInstalledBefore) {
      // Removes the proof-installed helper even when the proof fails.
      yield* Effect.addFinalizer(() =>
        adb([
          "shell",
          `pm path ${androidPrivateTextRelease.packageName} >/dev/null && pm uninstall ${androidPrivateTextRelease.packageName} || true`,
        ]).pipe(Effect.ignore)
      );
    }
    yield* adb([
      "shell",
      "am",
      "start",
      "-W",
      "-a",
      "android.settings.WIFI_SETTINGS",
    ]);
    const startup: AndroidRuntimeStartInput = {
      device: { api: 36, avd, fingerprint, host: "local", serial },
      installationGrant: grant(
        helperGrant,
        serial,
        androidHelperRelease.sha256
      ),
      platform: "android",
      privateTextGrant: grant(
        privateGrant,
        serial,
        androidPrivateTextRelease.sha256
      ),
      requiredCapabilities: [
        "semantic-actions",
        "screenshots",
        "private-input",
      ],
      scope: yield* Scope.Scope,
      targetApp: "com.android.settings",
    };
    const factory = makeAndroidRuntimeFactory();
    // Baseline: without private-input, agent-device keeps its persistent capture session.
    const baselineObserveTimingsMs = yield* Effect.scoped(
      Effect.gen(function* baseline() {
        const persistent = yield* audit(
          "start baseline runtime without private-input",
          factory.start({
            ...startup,
            privateTextGrant: undefined,
            requiredCapabilities: ["semantic-actions", "screenshots"],
            scope: yield* Scope.Scope,
          })
        );
        const timings: number[] = [];
        for (let index = 0; index < 4; index += 1) {
          const start = yield* Clock.currentTimeMillis;
          yield* audit("observe baseline", persistent.observe());
          timings.push((yield* Clock.currentTimeMillis) - start);
        }
        yield* audit("close baseline runtime", persistent.close());
        return timings;
      })
    );
    const installationRefusal =
      privateGrant === "install"
        ? (yield* Effect.flip(
            factory.start({ ...startup, privateTextGrant: undefined })
          )).code
        : null;
    const runtime: AndroidPlatformRuntime = yield* audit(
      "start runtime with private-input",
      factory.start(startup)
    );
    const observeTimings: number[] = [];
    const observe = (command: string) =>
      Effect.gen(function* timedObserve() {
        const start = yield* Clock.currentTimeMillis;
        const observation = yield* audit(command, runtime.observe());
        observeTimings.push((yield* Clock.currentTimeMillis) - start);
        return observation;
      });
    const activate = (observation: AndroidObservation, name: RegExp) =>
      Effect.gen(function* activateNamed() {
        const node = yield* find(
          observation,
          (candidate) => name.test(candidate.name),
          `control named ${name.source}`
        );
        yield* audit(
          `activate ${name.source}`,
          runtime.dispatch(observation.id, {
            target: node.target,
            type: "activate",
          })
        );
      });

    // Open the reversible Add network dialog with a password field. The
    // security dropdown is a PopupWindow, which ownership checks refuse, so
    // setup selects it from outside the runtime.
    yield* activate(yield* observe("observe Wi-Fi settings"), /^Add network$/u);
    yield* tapText("None");
    yield* tapText("WPA/WPA2-Personal");

    // Sentinel: generated here, entered once, then searched for everywhere.
    const sentinel = `ctg${randomBytes(12).toString("hex")}`;
    const resolutions: string[] = [];
    const variable = (name: string) => ({
      value: Effect.sync(() => {
        resolutions.push(name);
        return Redacted.make(sentinel);
      }),
      variable: name,
    });
    const deviceEpoch = yield* adb(["shell", "date", "+%s"]);
    const bound = yield* observe("observe password field");
    const password = yield* find(
      bound,
      (node) => node.password && node.editable,
      "editable password field"
    );
    const processSamples = {
      device: 0,
      deviceContained: false,
      helperSeen: 0,
      host: 0,
      hostContained: false,
    };
    const sampler = yield* Effect.forkChild(
      Effect.gen(function* sampleProcesses() {
        const device = yield* adb(["shell", "ps", "-A", "-o", "ARGS"]);
        processSamples.device += 1;
        processSamples.deviceContained ||= device.includes(sentinel);
        if (device.includes(androidPrivateTextRelease.packageName)) {
          processSamples.helperSeen += 1;
        }
        const { stdout } = yield* Effect.tryPromise(() =>
          execute("ps", ["-axo", "args"], { maxBuffer: 16 * 1024 * 1024 })
        );
        processSamples.host += 1;
        processSamples.hostContained ||= stdout.includes(sentinel);
      }).pipe(Effect.repeat(Schedule.spaced("50 millis")))
    );
    const filled = yield* audit(
      "enter private sentinel",
      runtime.enterPrivate(bound.id, {
        target: password.target,
        ...variable("proof.wifiPassword"),
      })
    );
    yield* Fiber.interrupt(sampler);
    const afterFill = yield* observe("observe after private fill");

    // Agent-device keeps its session across the helper's turn.
    yield* activate(afterFill, /^Advanced options$/u);
    const afterSemantic = yield* observe("observe after semantic action");
    const sessionPreserved =
      bound.backendSessionId === afterFill.backendSessionId &&
      afterFill.backendSessionId === afterSemantic.backendSessionId &&
      runtime.backendSessionId === afterSemantic.backendSessionId;

    const observationsContained = [bound, afterFill, afterSemantic].some(
      (observation) => JSON.stringify(observation).includes(sentinel)
    );
    const logcat = yield* adb(["logcat", "-d", "-T", `${deviceEpoch}.0`]);
    const logcatContained = logcat.includes(sentinel);
    const runtimeDirectories = yield* ownedRuntimeDirectories(startedAt);
    const hostDiagnostics = yield* scanFiles(runtimeDirectories, sentinel);

    // Refusals: none may resolve the Variable or send input.
    const refusalResolutions = resolutions.length;
    const stale = yield* Effect.flip(
      runtime.enterPrivate(bound.id, {
        target: password.target,
        ...variable("proof.stale"),
      })
    );
    const mismatchObservation = yield* audit(
      "recover before field change",
      runtime.recover()
    );
    const mismatchTarget = yield* find(
      mismatchObservation,
      (node) => node.password && node.editable,
      "password field before change"
    );
    // Change security to None outside Contingency: the bound field disappears.
    yield* tapText("WPA/WPA2-Personal");
    yield* tapText("None");
    const fieldMismatch = yield* Effect.flip(
      runtime.enterPrivate(mismatchObservation.id, {
        target: mismatchTarget.target,
        ...variable("proof.mismatch"),
      })
    );
    const foregroundObservation = yield* audit(
      "recover before foreground change",
      runtime.recover()
    );
    const ssid = yield* find(
      foregroundObservation,
      (node) => node.editable,
      "editable field before foreground change"
    );
    yield* adb([
      "shell",
      "am",
      "start",
      "-W",
      "-a",
      "android.intent.action.MAIN",
      "-c",
      "android.intent.category.HOME",
    ]);
    const foreground = yield* Effect.flip(
      runtime.enterPrivate(foregroundObservation.id, {
        target: ssid.target,
        ...variable("proof.foreground"),
      })
    );
    const refusalsResolved = resolutions.length - refusalResolutions;

    // Return to Settings and close the dialog without saving.
    yield* adb([
      "shell",
      "am",
      "start",
      "-W",
      "-a",
      "android.settings.WIFI_SETTINGS",
    ]);
    const returned = yield* audit(
      "recover after foreground change",
      runtime.recover()
    );
    const cancel = returned.nodes.find((node) => /^Cancel$/u.test(node.name));
    if (cancel !== undefined) {
      yield* audit(
        "cancel Add network",
        runtime.dispatch(returned.id, {
          target: cancel.target,
          type: "activate",
        })
      );
    }
    const finalDiagnostics = yield* scanFiles(runtimeDirectories, sentinel);
    yield* audit("close runtime", runtime.close());
    const closed = runtime.state();

    const privateHelperUninstalled =
      privateGrant === "install" && !privateTextInstalledBefore
        ? (yield* adb(["uninstall", androidPrivateTextRelease.packageName])) ===
          "Success"
        : null;
    const after = yield* deviceState;
    const helperProcess = yield* adb([
      "shell",
      `pidof ${androidPrivateTextRelease.packageName} || true`,
    ]);
    const receipt = {
      cleanup: {
        forwardsUnchanged:
          JSON.stringify(before.forwards) === JSON.stringify(after.forwards),
        imeUnchanged:
          before.defaultInputMethod === after.defaultInputMethod &&
          before.enabledInputMethods === after.enabledInputMethods,
        privateHelperProcess: helperProcess,
        privateHelperUninstalled,
        runtimeState: closed,
        savedNetworksUnchanged: before.savedNetworks === after.savedNetworks,
      },
      device: { api: 36, avd, serial },
      helper: androidPrivateTextRelease,
      installationRefusal,
      journal,
      observations: {
        afterFill: summary(afterFill),
        afterSemantic: summary(afterSemantic),
        bound: summary(bound),
      },
      observeTimingsMs: {
        baseline: baselineObserveTimingsMs,
        privateInput: observeTimings,
      },
      privateFill: filled,
      refusals: {
        fieldMismatch: fieldMismatch.code,
        foreground: foreground.code,
        resolvedValues: refusalsResolved,
        stale: stale.code,
      },
      sentinel: {
        hostDiagnostics: {
          containedAfterFill: hostDiagnostics.contained,
          containedBeforeClose: finalDiagnostics.contained,
          directories: runtimeDirectories.length,
          files: finalDiagnostics.files,
        },
        logcatContained,
        observationsContained,
        processList: processSamples,
        tracesAndTimeline:
          "Not produced: Android Teaching capture is unsupported, and private Variables are not wired into Workspace or Runs.",
      },
      sessionPreserved,
    };
    const serialized = JSON.stringify(receipt, null, 2);
    if (serialized.includes(sentinel)) {
      return yield* Effect.fail(
        new Error("Receipt would contain the sentinel.")
      );
    }
    yield* Effect.tryPromise(async () => {
      await mkdir(evidenceDirectory, { recursive: true });
      await writeFile(
        path.join(evidenceDirectory, "private-text-receipt.json"),
        `${serialized}\n`
      );
    });
    const evidence = yield* scanFiles([evidenceDirectory], sentinel);
    yield* Effect.sync(() => {
      process.stdout.write(
        `${JSON.stringify({ evidenceContained: evidence.contained, receipt: path.join(evidenceDirectory, "private-text-receipt.json") })}\n`
      );
    });
  })
).pipe(NodeRuntime.runMain);
