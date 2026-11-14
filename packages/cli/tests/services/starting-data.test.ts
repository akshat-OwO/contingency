import { expect, it } from "@effect/vitest";
import { Effect, Scope } from "effect";

import { restartAndroidTargetApp } from "../../src/services/android-preparation.ts";
import type { AndroidRunInput } from "../../src/services/android-run-contract.ts";
import {
  clearAppDataDecision,
  relayedDecisionAllowed,
} from "../../src/services/native-app-run.ts";

const request = (
  scope: Scope.Scope,
  startingData?: "keep" | "clear"
): AndroidRunInput => ({
  device: {
    api: 36,
    avd: "fixture",
    fingerprint: "fixture-build",
    host: "local",
    serial: "emulator-5554",
  },
  environment: {
    androidVersion: "16",
    appBuild: "2",
    appId: "dev.fixture",
    permissions: [
      { decision: "grant", permission: "android.permission.CAMERA" },
    ],
    startingState: "fresh home",
  },
  platform: "android",
  requiredCapabilities: ["semantic-actions", "screenshots"],
  scope,
  setup:
    startingData === undefined
      ? {
          activity: "dev.fixture/.Home",
          conditions: [],
          kind: "restart-activity",
        }
      : {
          activity: "dev.fixture/.Home",
          conditions: [],
          kind: "restart-activity",
          startingData,
        },
  targetApp: "dev.fixture",
  taught: {
    capabilities: ["semantic-actions", "screenshots"],
    environment: {
      androidVersion: "16",
      appBuild: "2",
      appId: "dev.fixture",
      startingState: "fresh home",
    },
    platform: "android",
  },
});

/** An emulator that answers identity, pm, and am as a real one would. */
const device = (pmClear = "Success") => {
  const mutations: string[] = [];
  const run = (args: readonly string[]) =>
    Effect.sync(() => {
      const command = args.join(" ");
      if (command === "get-state") {
        return "device";
      }
      if (command === "shell getprop ro.build.fingerprint") {
        return "fixture-build";
      }
      if (command === "shell getprop ro.build.version.sdk") {
        return "36";
      }
      if (command === "shell getprop ro.kernel.qemu") {
        return "1";
      }
      if (command === "emu avd name") {
        return "fixture\nOK";
      }
      if (command === "shell dumpsys package dev.fixture") {
        return "Packages:\n  User 0: installed=true\n    android.permission.CAMERA: granted=true\n";
      }
      mutations.push(command);
      if (command.startsWith("shell pm clear")) {
        return pmClear;
      }
      if (command.startsWith("shell am start")) {
        return "Starting: Intent\nStatus: ok\n";
      }
      return "";
    });
  return { mutations, run };
};

it.effect(
  "clears only the Target App's data, before permissions and launch",
  () =>
    Effect.gen(function* clearOrder() {
      const input = request(yield* Scope.Scope, "clear");
      const { mutations, run } = device();
      yield* restartAndroidTargetApp(input, run);
      expect(mutations).toEqual([
        "shell am force-stop --user 0 dev.fixture",
        "shell pm clear --user 0 dev.fixture",
        "shell pm grant --user 0 dev.fixture android.permission.CAMERA",
        "shell pm set-permission-flags --user 0 dev.fixture android.permission.CAMERA user-set user-fixed",
        "shell am start --user 0 -W -n 'dev.fixture/.Home'",
      ]);
    }).pipe(Effect.scoped)
);

for (const startingData of ["keep", undefined] as const) {
  it.effect(
    `keeps app data when Starting Data is ${startingData ?? "absent"}`,
    () =>
      Effect.gen(function* keepData() {
        const input = request(yield* Scope.Scope, startingData);
        const { mutations, run } = device();
        yield* restartAndroidTargetApp(input, run);
        expect(mutations.some((command) => command.includes("pm clear"))).toBe(
          false
        );
        expect(mutations.at(-1)).toMatch(/^shell am start/u);
      }).pipe(Effect.scoped)
  );
}

it.effect("stops before launching when pm clear does not succeed", () =>
  Effect.gen(function* clearFails() {
    const input = request(yield* Scope.Scope, "clear");
    const { mutations, run } = device("Failed");
    const error = yield* Effect.flip(restartAndroidTargetApp(input, run));
    expect(error.code).toBe("preparation_failed");
    expect(mutations.some((command) => command.includes("am start"))).toBe(
      false
    );
  }).pipe(Effect.scoped)
);

it("asks before clearing only during Teaching with Clear Starting Data", () => {
  const clear = { startingData: "clear" as const };
  expect(
    clearAppDataDecision(
      { setup: clear, targetApp: "dev.fixture", teaching: true },
      "run-1"
    ).map(({ kind, runId, targetApp }) => ({ kind, runId, targetApp }))
  ).toEqual([
    { kind: "clear-app-data", runId: "run-1", targetApp: "dev.fixture" },
  ]);
  // A Dry Run or Run applies its saved Flow's Starting Data without asking.
  expect(
    clearAppDataDecision({ setup: clear, targetApp: "dev.fixture" }, "run-1")
  ).toEqual([]);
  expect(
    clearAppDataDecision(
      { setup: {}, targetApp: "dev.fixture", teaching: true },
      "run-1"
    )
  ).toEqual([]);
});

/** A pending preparation decision of one kind. */
const decision = (id: string, kind: "clear-app-data" | "app-installation") => ({
  differences: [],
  id,
  kind,
  runId: "run-1",
  targetApp: "dev.fixture",
});

it("lets an agent relay only a Clear Starting Data answer", () => {
  const state = {
    pending: [
      decision("clear", "clear-app-data"),
      decision("install", "app-installation"),
    ],
  };
  expect(relayedDecisionAllowed(state, "clear")).toBe(true);
  expect(relayedDecisionAllowed(state, "install")).toBe(false);
  expect(relayedDecisionAllowed(state, "missing")).toBe(false);
});
