import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Effect, Option, Schema } from "effect";

import { androidHelperRelease } from "./android-runtime-contract.ts";
import { runChild } from "./child-process.ts";
import type { Recognized } from "./child-process.ts";
import { iosFailure } from "./ios-contract.ts";
import { decodeIosJson } from "./ios-simctl.ts";

/** agent-device's `--json` refusal: its code and, when it gives one, why. */
const AgentDeviceRefusal = Schema.fromJsonString(
  Schema.Struct({
    error: Schema.Struct({
      code: Schema.String,
      details: Schema.optional(
        Schema.Struct({ reason: Schema.optional(Schema.String) })
      ),
    }),
    success: Schema.Literal(false),
  })
);
const decodeRefusal = Schema.decodeUnknownOption(AgentDeviceRefusal);

/** The codes agent-device printed, never its message. */
export const recognizeAgentDevice = ({
  stdout,
}: {
  readonly stdout?: string | undefined;
}): Recognized =>
  Option.match(decodeRefusal((stdout ?? "").trim()), {
    onNone: () => ({}),
    onSome: ({ error }) => ({
      code: error.code,
      reason: error.details?.reason,
    }),
  });
/** daemon is process-scoped; --session is invalid for that command. */
export const iosRunnerArguments = (
  directory: string,
  udid: string,
  args: readonly string[]
) => [
  ...args,
  "--state-dir",
  directory,
  ...(args[0] === "daemon" ? [] : ["--session", `contingency-ios-${udid}`]),
];
const runnerCommand = (
  directory: string,
  udid: string,
  args: readonly string[]
) => {
  const packageRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.resolve("agent-device"))),
    "../.."
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("AGENT_DEVICE_")
    )
  );
  // Its output stays with the supervision module: the log keeps its codes,
  // a failure keeps its tail for the Failure Reference.
  return runChild({
    args: [
      path.join(packageRoot, "bin/agent-device.mjs"),
      ...iosRunnerArguments(directory, udid, args),
      "--json",
    ],
    child: "agent-device",
    command: process.execPath,
    env,
    recognize: recognizeAgentDevice,
    timeoutMs: 300_000,
  }).pipe(
    Effect.asVoid,
    Effect.mapError((failure) => iosFailure("preparation_failed", failure))
  );
};
/** Stop only the daemon in this session's private state directory. */
export const stopIosRunner = (directory: string, udid: string) =>
  Effect.gen(function* stopOwnedRunner() {
    const exists = yield* Effect.promise(async () => {
      try {
        await access(path.join(directory, "daemon.json"));
        return true;
      } catch (error) {
        if (
          Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }))(error)
        ) {
          return false;
        }
        throw error;
      }
    });
    if (exists) {
      yield* Effect.result(runnerCommand(directory, udid, ["close"]));
      yield* runnerCommand(directory, udid, ["daemon", "stop"]);
    }
  });
/** Every runner uses a private daemon state directory, never the host's active daemon. */
export const openIosRunner = (
  udid: string,
  bundleId: string,
  directory: string
) =>
  Effect.gen(function* selectRunner() {
    const packageRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.resolve("agent-device"))),
      "../.."
    );
    const manifest = yield* Effect.tryPromise({
      catch: (cause) => iosFailure("preparation_failed", cause),
      try: () => readFile(path.join(packageRoot, "package.json"), "utf-8"),
    });
    yield* decodeIosJson(
      Schema.Struct({ version: Schema.Literal(androidHelperRelease.version) }),
      manifest
    );
    // Scoped release closes this runner and leaves the selected simulator running.
    yield* Effect.logInfo(
      "Preparing the iOS XCTest runner. The first selection builds it with Xcode."
    );
    yield* runnerCommand(directory, udid, [
      "open",
      bundleId,
      "--platform",
      "ios",
      "--udid",
      udid,
    ]);
    yield* runnerCommand(directory, udid, [
      "prepare",
      "ios-runner",
      "--platform",
      "ios",
      "--udid",
      udid,
    ]);
    yield* Effect.logInfo("The iOS XCTest runner is ready.");
  });
