import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { NodeRuntime } from "@effect/platform-node";
import { Effect, Scope } from "effect";

import type { AndroidRunInput } from "../src/services/android-run-contract.ts";
import type { AndroidObservation } from "../src/services/android-runtime-contract.ts";
import { makeAndroidRuntimeFactory } from "../src/services/android-runtime.ts";

const execute = promisify(execFile);
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
  id: observation.id,
  ownership: observation.ownership,
  screenshotSha256: createHash("sha256")
    .update(Buffer.from(observation.screenshot.image, "base64"))
    .digest("hex"),
});
const check = (condition: boolean, message: string) =>
  condition ? Effect.void : Effect.fail(new Error(message));

Effect.scoped(
  Effect.gen(function* proof() {
    const serial = process.env.CONTINGENCY_ANDROID_SERIAL;
    const avd = process.env.CONTINGENCY_ANDROID_AVD;
    const fingerprint = process.env.CONTINGENCY_ANDROID_FINGERPRINT;
    const evidenceDirectory =
      process.env.CONTINGENCY_ANDROID_EVIDENCE_DIRECTORY;
    if (!serial || avd !== "Pixel_9" || !fingerprint || !evidenceDirectory) {
      return yield* Effect.fail(
        new Error(
          "Supply explicitly selected Pixel_9 serial, fingerprint, and isolated evidence directory."
        )
      );
    }
    const adb = (args: readonly string[]) =>
      Effect.tryPromise(async (signal) => {
        const result = await execute("adb", ["-s", serial, ...args], {
          signal,
          timeout: 30_000,
        });
        return result.stdout.trim();
      });
    const input: AndroidRunInput = {
      device: { api: 36, avd, fingerprint, host: "local", serial },
      environment: {
        androidVersion: "16",
        appBuild: "36",
        appId: "com.android.settings",
        startingState: "fresh About emulated device activity",
      },
      platform: "android",
      requiredCapabilities: ["semantic-actions", "screenshots"],
      scope: yield* Scope.Scope,
      setup: {
        activity: "com.android.settings/.Settings$MyDeviceInfoActivity",
        conditions: [{ name: "Device name", role: "text" }],
        kind: "restart-activity",
      },
      targetApp: "com.android.settings",
      taught: {
        capabilities: ["semantic-actions", "screenshots"],
        environment: {
          androidVersion: "16",
          appBuild: "35",
          appId: "com.android.settings",
          startingState: "fresh About emulated device activity",
        },
        platform: "android",
      },
    };
    const factory = makeAndroidRuntimeFactory();
    const history = JSON.stringify(input.taught);
    const refused = yield* audit(
      "create changed-build Run",
      factory.createRun(input)
    );
    yield* audit(
      "refuse changed-build permission",
      refused.decide(refused.state().pending[0]?.id ?? "", false)
    );
    const permissionRefusal = yield* audit(
      "attempt preparation after refusal",
      Effect.flip(refused.prepare())
    );
    yield* check(
      permissionRefusal.code === "preparation_required",
      "Refused Run allowed preparation."
    );
    const failed = yield* factory.createRun({
      ...input,
      setup: {
        ...input.setup,
        conditions: [
          { name: "Missing public fixture condition", role: "text" },
        ],
      },
    });
    yield* failed.decide(failed.state().pending[0]?.id ?? "", true);
    const startingRefusal = yield* audit(
      "fail fresh starting condition",
      Effect.flip(failed.prepare())
    );
    yield* check(
      startingRefusal.code === "starting_condition_failed",
      "Missing starting condition did not block input."
    );
    const run = yield* audit(
      "create selected prepared Run",
      factory.createRun(input)
    );
    yield* audit(
      "grant changed-build permission",
      run.decide(run.state().pending[0]?.id ?? "", true)
    );
    const before = yield* audit(
      "establish fresh declared activity",
      run.prepare()
    );
    yield* audit(
      "simulate unexpected foreground transition",
      adb([
        "shell",
        "am",
        "start",
        "-W",
        "-a",
        "android.intent.action.MAIN",
        "-c",
        "android.intent.category.HOME",
      ])
    );
    const ownershipRefusal = yield* audit(
      "observe unexpected app and pause",
      Effect.flip(run.observe())
    );
    yield* check(
      ownershipRefusal.code === "ownership_unknown" &&
        run.state().phase === "paused",
      "Unexpected app did not pause."
    );
    yield* audit(
      "return selected Target App without replay",
      adb(["shell", "am", "start", "-W", "-n", `'${input.setup.activity}'`])
    );
    const recovered = yield* audit(
      "recover same device with fresh observation",
      run.recover()
    );
    yield* check(recovered.id !== before.id, "Recovery reused observation.");
    yield* check(
      JSON.stringify(input.taught) === history,
      "Taught history changed."
    );
    const outsideAppRefusal = yield* audit(
      "refuse declared outside-app launch",
      Effect.flip(
        factory.createRun({
          ...input,
          setup: {
            ...input.setup,
            activity: "com.android.launcher3/.Launcher",
          },
        })
      )
    );
    yield* check(
      outsideAppRefusal.code === "preparation_failed",
      "Outside-app setup was accepted."
    );
    yield* audit("close owned Run", run.close());
    yield* failed.close();
    yield* refused.close();
    const receipt = {
      entryPoint: "Contingency PlatformRuntimeFactory.android.createRun",
      feature: "android-preparation",
      journal,
      limitations: [
        "No Android Workspace or MCP tool surface yet; #470 owns rendering and mirrored Teaching",
        "No physical-device, snapshot-baseline, APK update, or destructive-reset live proof",
        "Host checks are experimental; no atomic device authority or stock retry guarantee",
      ],
      observations: { before: summary(before), recovered: summary(recovered) },
      refusals: {
        outsideAppRefusal,
        ownershipRefusal,
        permissionRefusal,
        startingRefusal,
      },
      runs: {
        failed: failed.state(),
        prepared: run.state(),
        refused: refused.state(),
      },
    };
    yield* Effect.tryPromise(async () => {
      await mkdir(evidenceDirectory, { recursive: true });
      const filename = path.join(evidenceDirectory, "preparation-receipt.json");
      await writeFile(filename, JSON.stringify(receipt, null, 2));
      const reread: unknown = JSON.parse(await readFile(filename, "utf-8"));
      if (JSON.stringify(reread) !== JSON.stringify(receipt)) {
        throw new Error("Persisted receipt reread differs.");
      }
    });
  })
).pipe(NodeRuntime.runMain);
