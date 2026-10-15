import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { NodeRuntime } from "@effect/platform-node";
import { Effect, Scope } from "effect";

import { androidHelperRelease } from "../src/services/android-runtime-contract.ts";
import type {
  AndroidObservation,
  AndroidRuntimeStartInput,
} from "../src/services/android-runtime-contract.ts";
import { makeAndroidRuntimeFactory } from "../src/services/android-runtime.ts";

const execute = promisify(execFile);
const serial = process.env.CONTINGENCY_ANDROID_SERIAL;
const avd = process.env.CONTINGENCY_ANDROID_AVD;
const fingerprint = process.env.CONTINGENCY_ANDROID_FINGERPRINT;
const grant = process.env.CONTINGENCY_ANDROID_HELPER_GRANT;
const evidenceDirectory = process.env.CONTINGENCY_ANDROID_EVIDENCE_DIRECTORY;
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

const summary = (observation: AndroidObservation) => ({
  backendSessionId: observation.backendSessionId,
  capture: observation.capture,
  device: observation.device,
  generation: observation.generation,
  id: observation.id,
  nodeCount: observation.nodes.length,
  ownership: observation.ownership,
  screenshotSha256: createHash("sha256")
    .update(Buffer.from(observation.screenshot.image, "base64"))
    .digest("hex"),
});

Effect.scoped(
  Effect.gen(function* verifyRuntime() {
    if (
      !serial ||
      !avd ||
      !fingerprint ||
      !evidenceDirectory ||
      (grant !== "install" && grant !== "replace" && grant !== "none")
    ) {
      return yield* Effect.fail(
        new Error(
          "Supply the explicitly selected serial, AVD, fingerprint, evidence directory, and helper grant using CONTINGENCY_ANDROID_* variables."
        )
      );
    }
    const startup: AndroidRuntimeStartInput = {
      device: { api: 36, avd, fingerprint, host: "local", serial },
      installationGrant:
        grant === "none"
          ? undefined
          : { operation: grant, serial, sha256: androidHelperRelease.sha256 },
      platform: "android",
      requiredCapabilities: ["semantic-actions", "screenshots"],
      scope: yield* Scope.Scope,
      targetApp: "com.android.settings",
    };
    const factory = makeAndroidRuntimeFactory();
    const installationRefusal =
      grant === "install"
        ? yield* Effect.flip(
            factory.start({ ...startup, installationGrant: undefined })
          )
        : null;
    const capabilityRefusal = yield* Effect.flip(
      factory.start({
        ...startup,
        requiredCapabilities: ["coordinate-actions"],
      })
    );
    const owned = yield* audit(
      "start selected Android runtime",
      factory.start(startup)
    );
    const runtime = {
      ...owned,
      close: () => audit("close owned runtime", owned.close()),
      dispatch: (...args: Parameters<typeof owned.dispatch>) =>
        audit(`dispatch ${args[1].type}`, owned.dispatch(...args)),
      observe: () => audit("observe selected device", owned.observe()),
      recover: () =>
        audit("explicitly recover selected device", owned.recover()),
    };
    const before = yield* audit(
      "observe before semantic action",
      runtime.observe()
    );
    const search = before.nodes.find(
      (node) => /^Device name$/iu.test(node.name) && !node.covered
    );
    if (search === undefined) {
      return yield* Effect.fail(
        new Error(
          "Prepared Settings screen has no public Device name semantic target."
        )
      );
    }
    yield* runtime.dispatch(before.id, {
      target: search.target,
      type: "activate",
    });
    const after = yield* runtime.observe();
    const staleRefusal = yield* Effect.flip(
      runtime.dispatch(before.id, { target: search.target, type: "activate" })
    );
    const recovered = yield* runtime.recover();
    const field = recovered.nodes.find(
      (node) => node.editable && !node.password && !node.covered
    );
    if (field === undefined) {
      return yield* Effect.fail(
        new Error(
          "Settings Device name dialog has no supported non-private editable target."
        )
      );
    }
    const text = "Contingency runtime proof";
    yield* runtime.dispatch(recovered.id, {
      target: field.target,
      text,
      type: "fill",
    });
    const readback = yield* runtime.observe();
    if (!readback.nodes.some((node) => node.name.includes(text))) {
      return yield* Effect.fail(
        new Error("Non-secret input was not observed independently.")
      );
    }
    const coordinateRefusal = yield* Effect.flip(
      runtime.dispatch(readback.id, { type: "coordinate", x: 1, y: 1 })
    );
    const recoveredAgain = yield* runtime.recover();
    const cancel = recoveredAgain.nodes.find((node) =>
      /^Cancel$/iu.test(node.name)
    );
    if (cancel === undefined) {
      return yield* Effect.fail(
        new Error("Device name dialog has no Cancel target.")
      );
    }
    yield* runtime.dispatch(recoveredAgain.id, {
      target: cancel.target,
      type: "activate",
    });
    const back = yield* runtime.observe();
    const helperFault =
      grant === "install"
        ? yield* Effect.gen(function* removeOwnedHelper() {
            yield* Effect.tryPromise(() =>
              execute("adb", [
                "-s",
                serial,
                "uninstall",
                androidHelperRelease.packageName,
              ])
            );
            const refusal = yield* Effect.flip(runtime.observe());
            if (refusal.code !== "helper_incompatible") {
              return yield* Effect.fail(
                new Error("Missing helper did not pause execution.")
              );
            }
            const pausedState = runtime.state();
            const apk = path.resolve(
              path.dirname(fileURLToPath(import.meta.resolve("agent-device"))),
              "../../android/snapshot-helper/dist/agent-device-android-snapshot-helper-0.21.25.apk"
            );
            yield* Effect.tryPromise(() =>
              execute("adb", ["-s", serial, "install", apk])
            );
            const fresh = yield* runtime.recover();
            return { observation: summary(fresh), pausedState, refusal };
          })
        : null;
    yield* runtime.close();
    yield* runtime.close();
    const closedRefusal = yield* Effect.flip(runtime.recover());
    const cleanup = runtime.state();
    const command = async (args: readonly string[]) => {
      const result = await execute("adb", ["-s", serial, ...args]);
      return result.stdout.trim();
    };
    const forwardList = yield* Effect.tryPromise(() =>
      command(["forward", "--list"])
    );
    const helperPid = yield* Effect.tryPromise(() =>
      command(["shell", `pidof ${androidHelperRelease.packageName} || true`])
    );
    yield* Effect.tryPromise(async () => {
      await mkdir(evidenceDirectory, { recursive: true });
      await writeFile(
        path.join(evidenceDirectory, "runtime-receipt.json"),
        JSON.stringify(
          {
            cleanup: { ...cleanup, forwardList, helperPid },
            entryPoint: "Contingency PlatformRuntimeFactory Android extension",
            helper: androidHelperRelease,
            helperFault,
            journal,
            limitations: [
              "No physical-device or multiple-device coverage",
              "No secure-window or necessary-system-dialog qualification",
              "No Android Workspace Teaching integration",
            ],
            observations: {
              after: summary(after),
              back: summary(back),
              before: summary(before),
              readback: summary(readback),
              recovered: summary(recovered),
            },
            ordinaryTextObserved: true,
            refusals: {
              capabilityRefusal,
              closedRefusal,
              coordinateRefusal,
              installationRefusal,
              staleRefusal,
            },
          },
          null,
          2
        )
      );
    });
  })
).pipe(NodeRuntime.runMain);
