import { execFile } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Effect, Schema } from "effect";

import { iosError } from "./ios-contract.ts";
import { decodeIosJson } from "./ios-simctl.ts";

const execute = promisify(execFile);
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
  return Effect.tryPromise({
    catch: () => iosError("preparation_failed"),
    try: async (signal) => {
      const running = execute(
        process.execPath,
        [
          path.join(packageRoot, "bin/agent-device.mjs"),
          ...iosRunnerArguments(directory, udid, args),
        ],
        { env, maxBuffer: 16 * 1024 * 1024, signal, timeout: 300_000 }
      );
      running.child.stderr?.on("data", (chunk: Buffer) =>
        process.stderr.write(chunk)
      );
      running.child.stdout?.on("data", (chunk: Buffer) =>
        process.stderr.write(chunk)
      );
      await running;
    },
  });
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
      catch: () => iosError("preparation_failed"),
      try: () => readFile(path.join(packageRoot, "package.json"), "utf-8"),
    });
    yield* decodeIosJson(
      Schema.Struct({ version: Schema.Literal("0.21.25") }),
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
