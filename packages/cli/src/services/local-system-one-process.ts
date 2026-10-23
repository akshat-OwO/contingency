import { execFile } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import net from "node:net";
import { promisify } from "node:util";

import { Effect, Schedule, Schema } from "effect";

import type { LocalSystemOneServer } from "./local-system-one-lifecycle.ts";
import {
  localSystemOneError,
  LocalSystemOneError,
} from "./local-system-one.ts";

const execute = promisify(execFile);
export const localSystemOneOutput = (
  command: string,
  args: readonly string[]
) =>
  Effect.tryPromise({
    catch: localSystemOneError,
    try: async (signal) => {
      const result = await execute(command, args, { signal });
      return result.stdout.trim();
    },
  });

export const processIdentity = (pid: number) =>
  localSystemOneOutput("ps", ["-p", String(pid), "-o", "lstart="]).pipe(
    Effect.orElseSucceed(() => "")
  );
export const processAlive = (pid: number, identity: string) =>
  Effect.gen(function* verifyIdentity() {
    if ((yield* processIdentity(pid)) !== identity) {
      return false;
    }
    const stat = yield* localSystemOneOutput("ps", [
      "-p",
      String(pid),
      "-o",
      "stat=",
    ]).pipe(Effect.orElseSucceed(() => "Z"));
    return stat !== "" && !stat.startsWith("Z");
  });
export const supervisorAlive = (server: LocalSystemOneServer) =>
  Effect.gen(function* supervisorIdentity() {
    if (!(yield* processAlive(server.pid, server.startIdentity))) {
      return false;
    }
    const args = yield* localSystemOneOutput("ps", [
      "-p",
      String(server.pid),
      "-o",
      "args=",
    ]);
    return args.includes("system-one __supervise");
  });

export const unusedLocalPort = Effect.tryPromise({
  catch: localSystemOneError,
  try: async (signal) => {
    const server = net.createServer();
    try {
      const listening = once(server, "listening", { signal });
      server.listen(0, "127.0.0.1");
      await listening;
      return Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Int }))(
        server.address()
      ).port;
    } finally {
      if (server.listening) {
        const closed = once(server, "close");
        server.close();
        await closed;
      }
    }
  },
});

const portClosed = (port: number) =>
  Effect.callback<boolean, LocalSystemOneError>((resume) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resume(Effect.succeed(false));
    });
    socket.once("error", (error) => {
      socket.destroy();
      resume(
        "code" in error && error.code === "ECONNREFUSED"
          ? Effect.succeed(true)
          : Effect.fail(localSystemOneError(error))
      );
    });
    return Effect.sync(() => {
      socket.destroy();
    });
  });

/** Check both identities before signalling either PID or process group. */
export const stopLocalSystemOneProcesses = (server: LocalSystemOneServer) =>
  Effect.gen(function* stopProcesses() {
    const supervisor = yield* supervisorAlive(server);
    const kev = yield* processAlive(server.kevPid, server.kevStartIdentity);
    if (kev) {
      const args = yield* localSystemOneOutput("ps", [
        "-p",
        String(server.kevPid),
        "-o",
        "args=",
      ]);
      if (!args.includes("/kev/.venv/bin/python -m kev.serve")) {
        return yield* new LocalSystemOneError({
          message: `Refusing to stop PID ${server.kevPid}: process command is not Kev.`,
        });
      }
    }
    if (supervisor) {
      yield* Effect.try({
        catch: localSystemOneError,
        try: () => process.kill(server.pid, "SIGTERM"),
      });
    }
    // Stop the verified group even if its supervisor died without cleanup.
    if (kev) {
      yield* Effect.try({
        catch: localSystemOneError,
        try: () => {
          try {
            process.kill(-server.kevPid, "SIGKILL");
          } catch (error) {
            if (
              !(
                error instanceof Error &&
                "code" in error &&
                error.code === "ESRCH"
              )
            ) {
              throw error;
            }
          }
        },
      });
    }
    yield* Effect.gen(function* stopped() {
      const alive =
        (yield* supervisorAlive(server)) ||
        (yield* processAlive(server.kevPid, server.kevStartIdentity));
      if (
        alive ||
        !(yield* portClosed(server.port)) ||
        !(yield* portClosed(server.kevPort))
      ) {
        return yield* new LocalSystemOneError({
          message: "Local System One processes or ports have not stopped.",
        });
      }
    }).pipe(
      Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 100 })
    );
  });

/** Fail closed when pressure cannot be read: auto-start is optional. */
export const localSystemOneMemoryPressure = Effect.gen(
  function* memoryPressure() {
    if (process.platform === "darwin") {
      const level = yield* localSystemOneOutput("sysctl", [
        "-n",
        "kern.memorystatus_vm_pressure_level",
      ]);
      return Number(level) !== 1;
    }
    const contents = yield* Effect.tryPromise({
      catch: localSystemOneError,
      try: () => readFile("/proc/meminfo", "utf-8"),
    });
    const available = Number(
      /MemAvailable:\s+(?<available>\d+)/u.exec(contents)?.groups?.[
        "available"
      ] ?? 0
    );
    const pressure = yield* Effect.tryPromise({
      catch: localSystemOneError,
      try: () => readFile("/proc/pressure/memory", "utf-8"),
    });
    const stalled = Number(
      /some avg10=(?<stalled>[\d.]+)/u.exec(pressure)?.groups?.["stalled"] ??
        100
    );
    return available < 4 * 1024 * 1024 || stalled >= 10;
  }
).pipe(Effect.orElseSucceed(() => true));
