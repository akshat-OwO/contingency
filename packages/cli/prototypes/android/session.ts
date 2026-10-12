import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect } from "effect";

import { makeDriver, ProbeError } from "./driver.ts";
import { adb, socketTransport } from "./transport.ts";
import type { Journal } from "./transport.ts";

interface StartupTimer {
  handle: ReturnType<typeof setTimeout> | undefined;
}

const helperPackage = "dev.contingency.probe";
const packagePattern = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u;

/** Own only the helper process and this dynamically allocated ADB forward. */
export const withSession = <A, E>(input: {
  readonly serial: string;
  readonly journal?: Journal | undefined;
  readonly target: string;
  readonly secret: (variable: string) => Effect.Effect<string, ProbeError>;
  readonly use: (driver: ReturnType<typeof makeDriver>) => Effect.Effect<A, E>;
}) =>
  Effect.scoped(
    Effect.gen(function* session() {
      const command = (args: readonly string[]) =>
        adb(input.serial, args, input.journal);
      if (!input.serial || !packagePattern.test(input.target)) {
        return yield* Effect.fail(
          new ProbeError("explicit_environment_required")
        );
      }
      const lockPath = path.join(
        tmpdir(),
        `contingency-android-probe-${createHash("sha256").update(input.serial).digest("hex")}.lock`
      );
      yield* Effect.acquireRelease(
        Effect.tryPromise({
          catch: () => new ProbeError("device_session_locked"),
          try: () => mkdir(lockPath, { mode: 0o700 }),
        }),
        () =>
          Effect.tryPromise({
            catch: () => new ProbeError("lock_cleanup_failed"),
            try: () => rmdir(lockPath),
          }).pipe(Effect.orDie)
      );
      yield* command(["get-state"]);
      const installed = yield* command([
        "shell",
        "pm path dev.contingency.probe || true",
      ]);
      if (!installed.startsWith("package:")) {
        return yield* Effect.fail(new ProbeError("helper_missing"));
      }
      const existing = yield* command([
        "shell",
        "pidof dev.contingency.probe || true",
      ]);
      if (existing) {
        return yield* Effect.fail(new ProbeError("helper_already_running"));
      }
      const token = randomBytes(32).toString("hex");
      yield* Effect.acquireRelease(
        Effect.tryPromise({
          catch: () => new ProbeError("helper_start_failed"),
          try: (signal) =>
            (() => {
              const { promise, resolve, reject } =
                Promise.withResolvers<ReturnType<typeof spawn>>();
              const startupCommand = [
                "adb",
                "-s",
                input.serial,
                "shell",
                "am",
                "instrument",
                "-w",
                "-r",
                "-e",
                "token",
                "<ephemeral-token>",
                "-e",
                "target",
                input.target,
                `${helperPackage}/.Probe`,
              ];
              const child = spawn(
                "adb",
                [
                  "-s",
                  input.serial,
                  "shell",
                  "am",
                  "instrument",
                  "-w",
                  "-r",
                  "-e",
                  "token",
                  token,
                  "-e",
                  "target",
                  input.target,
                  `${helperPackage}/.Probe`,
                ],
                { signal }
              );
              let output = "";
              let settled = false;
              const timer: StartupTimer = { handle: undefined };
              const failed = () => {
                if (settled) {
                  return;
                }
                settled = true;
                clearTimeout(timer.handle);
                input.journal?.({ command: startupCommand, outcome: "failed" });
                child.kill();
                reject(new ProbeError("helper_start_failed"));
              };
              timer.handle = setTimeout(failed, 30_000);
              child.stderr?.resume();
              child.stdout?.on("data", (chunk: Buffer) => {
                output = `${output}${chunk.toString("utf-8")}`.slice(-4096);
                if (
                  !settled &&
                  output.includes("INSTRUMENTATION_STATUS: ready=true")
                ) {
                  settled = true;
                  clearTimeout(timer.handle);
                  input.journal?.({
                    command: startupCommand,
                    outcome: "success",
                  });
                  resolve(child);
                }
              });
              child.once("error", failed);
              child.once("exit", failed);
              return promise;
            })(),
        }).pipe(
          Effect.onError(() =>
            command(["shell", "am", "force-stop", helperPackage]).pipe(
              Effect.ignore
            )
          )
        ),
        (child) =>
          command(["shell", "am", "force-stop", helperPackage]).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                child.kill();
              })
            ),
            Effect.ignore
          )
      );
      const port = yield* Effect.acquireRelease(
        command(["forward", "tcp:0", "tcp:8765"]),
        (allocated) =>
          command(["forward", "--remove", `tcp:${allocated}`]).pipe(
            Effect.ignore
          )
      );
      if (!/^\d+$/u.test(port)) {
        return yield* Effect.fail(new ProbeError("forward_invalid"));
      }
      const driver = makeDriver({
        ...input,
        transport: socketTransport({
          journal: input.journal,
          port: Number(port),
          serial: input.serial,
          token,
        }),
      });
      yield* Effect.acquireRelease(Effect.succeed(driver), (owned) =>
        owned.close.pipe(Effect.ignore)
      );
      yield* driver.connect;
      return yield* input.use(driver);
    })
  );
