import { execFile } from "node:child_process";
import { watch, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

import { NodeRuntime } from "@effect/platform-node";
import { Effect, Scope } from "effect";

import { makeAndroidRuntimeFactory } from "../src/services/android-runtime.ts";

const execute = promisify(execFile);
const serial = process.env.CONTINGENCY_ANDROID_SERIAL;
const avd = process.env.CONTINGENCY_ANDROID_AVD;
const fingerprint = process.env.CONTINGENCY_ANDROID_FINGERPRINT;
const directory = process.env.CONTINGENCY_ANDROID_EVIDENCE_DIRECTORY;
Effect.scoped(
  Effect.gen(function* proof() {
    if (!serial || !avd || !fingerprint || !directory) {
      return yield* Effect.fail(new Error("Explicit proof selection required"));
    }
    const runtime = yield* makeAndroidRuntimeFactory().start({
      device: { api: 36, avd, fingerprint, host: "local", serial },
      platform: "android",
      requiredCapabilities: ["semantic-actions", "screenshots"],
      scope: yield* Scope.Scope,
      targetApp: "com.android.settings",
    });
    const before = yield* runtime.observe();
    yield* Effect.tryPromise(() =>
      execute("adb", ["-s", serial, "emu", "kill"])
    );
    const failure = yield* Effect.flip(runtime.observe());
    const paused = runtime.state();
    const recoveryWhileDisconnected = yield* Effect.flip(runtime.recover());
    yield* Effect.tryPromise(async (signal) => {
      const events = watch(directory, { signal });
      try {
        const firstEvent = events.next();
        await writeFile(
          `${directory}/disconnect-paused.json`,
          JSON.stringify(
            {
              beforeId: before.id,
              device: runtime.device,
              failure,
              paused,
              recoveryWhileDisconnected,
            },
            null,
            2
          )
        );
        const first = await firstEvent;
        if (first.value?.filename === "recovery-ready") {
          return;
        }
        for await (const event of events) {
          if (event.filename === "recovery-ready") {
            return;
          }
        }
        throw new Error("Recovery signal watcher closed before recovery.");
      } finally {
        await events.return();
      }
    });
    const after = yield* runtime.recover();
    if (after.id === before.id) {
      return yield* Effect.fail(
        new Error("Recovered observation reused identity")
      );
    }
    yield* runtime.close();
    yield* Effect.tryPromise(() =>
      writeFile(
        `${directory}/disconnect-recovered.json`,
        JSON.stringify(
          {
            afterId: after.id,
            beforeId: before.id,
            capture: after.capture,
            cleanup: runtime.state(),
            device: after.device,
          },
          null,
          2
        )
      )
    );
  })
).pipe(NodeRuntime.runMain);
