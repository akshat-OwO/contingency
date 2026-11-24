import { spawn } from "node:child_process";

import type { NativeInput } from "@contingency/protocol";
import { Clock, Effect, Fiber, Scope, Semaphore } from "effect";

import { awaitExit } from "./ffmpeg.ts";
import { verifyIosHidRelease } from "./ios-framebuffer-release.ts";
import { iosCommand } from "./ios-simctl.ts";
import { makeWheelFinger, WHEEL_RELEASE_MILLIS } from "./wheel-finger.ts";
import type { FingerInput } from "./wheel-finger.ts";

/** USB HID keyboard-page usages for the physical keys a Workspace forwards. */
const usages: ReadonlyMap<string, number> = new Map([
  ["Enter", 40],
  ["NumpadEnter", 88],
  ["Escape", 41],
  ["Backspace", 42],
  ["Tab", 43],
  ["Space", 44],
  ["Minus", 45],
  ["Equal", 46],
  ["BracketLeft", 47],
  ["BracketRight", 48],
  ["Backslash", 49],
  ["Semicolon", 51],
  ["Quote", 52],
  ["Backquote", 53],
  ["Comma", 54],
  ["Period", 55],
  ["Slash", 56],
  ["CapsLock", 57],
  ["Home", 74],
  ["PageUp", 75],
  ["Delete", 76],
  ["End", 77],
  ["PageDown", 78],
  ["ArrowRight", 79],
  ["ArrowLeft", 80],
  ["ArrowDown", 81],
  ["ArrowUp", 82],
  ["ControlLeft", 224],
  ["ShiftLeft", 225],
  ["AltLeft", 226],
  ["MetaLeft", 227],
  ["ControlRight", 228],
  ["ShiftRight", 229],
  ["AltRight", 230],
  ["MetaRight", 231],
]);

/** The usage of a physical key, or undefined when the simulator has none. */
export const iosKeyUsage = (code: string): number | undefined => {
  const letter = /^Key(?<letter>[A-Z])$/u.exec(code)?.groups?.letter;
  if (letter !== undefined) {
    return 4 + (letter.codePointAt(0) ?? 65) - 65;
  }
  const digit = /^Digit(?<digit>\d)$/u.exec(code)?.groups?.digit;
  if (digit !== undefined) {
    return digit === "0" ? 39 : 29 + Number(digit);
  }
  return usages.get(code);
};

/**
 * Forwarded Input as helper commands, in order. A key the simulator has no
 * usage for sends nothing. A wheel reaches the helper as a held finger.
 */
export const iosHidCommands = (inputs: readonly FingerInput[]): string[] =>
  inputs.flatMap((input) => {
    if (input._tag === "touch") {
      return [`touch ${input.action} ${input.x} ${input.y}`];
    }
    const usage = iosKeyUsage(input.code);
    return usage === undefined ? [] : [`key ${input.action} ${usage}`];
  });

/** Indigo drops a drag sent within 16 ms of the previous message. */
export const MOVE_SPACING_MILLIS = 17;
const isMove = (command: string) => command.startsWith("touch move ");

/**
 * Writes one session's Forwarded Input to the helper, in order and without
 * waiting on any gesture. The wheel drives a held finger that lifts once the
 * wheel is quiet. A drag is sent at most once per `MOVE_SPACING_MILLIS`, and
 * the latest position replaces one still waiting, so a fast drag or wheel
 * never builds a backlog the simulator would partly drop.
 */
export const makeIosHidWriter = <E>(
  write: (lines: string) => Effect.Effect<void, E>,
  scope: Scope.Scope
) => {
  const lock = Semaphore.makeUnsafe(1);
  const finger = makeWheelFinger();
  let lastWriteAt = Number.NEGATIVE_INFINITY;
  let waitingMove: string | undefined;
  let flushing = false;
  let releasing: Fiber.Fiber<void, never> | undefined;
  const send = (commands: readonly string[]) =>
    Effect.gen(function* sendCommands() {
      if (commands.length === 0) {
        return;
      }
      yield* write(commands.map((command) => `${command}\n`).join(""));
      lastWriteAt = yield* Clock.currentTimeMillis;
    });
  /** How long until a drag may go, from the last write. */
  const untilDue = Clock.currentTimeMillis.pipe(
    Effect.map((now) => lastWriteAt + MOVE_SPACING_MILLIS - now)
  );
  /**
   * Sends the waiting drag if it is due. A write made while the flush waited
   * for the lock restarts the spacing, so this then reports not yet.
   */
  const sendDueMove = lock.withPermits(1)(
    Effect.gen(function* sendDueMove() {
      if ((yield* untilDue) > 0) {
        return false;
      }
      const move = waitingMove;
      waitingMove = undefined;
      if (move !== undefined) {
        yield* send([move]);
      }
      return true;
    })
  );
  const flush: Effect.Effect<void> = Effect.gen(function* flushMove() {
    for (;;) {
      const wait = yield* untilDue;
      if (wait > 0) {
        yield* Effect.sleep(wait);
      }
      if (yield* sendDueMove) {
        return;
      }
    }
  }).pipe(
    // A failed write fails the next forward instead; nothing is retried.
    Effect.ignore({ log: "Debug", message: "Could not write iOS input" }),
    Effect.ensuring(Effect.sync(() => (flushing = false)))
  );
  const deliver = (inputs: readonly FingerInput[]) =>
    Effect.gen(function* deliverCommands() {
      let ready: string[] = [];
      for (const command of iosHidCommands(inputs)) {
        if (!isMove(command)) {
          // A press, release, or key goes after any drag still waiting. That
          // drag keeps its spacing, so a release or restroke right behind it
          // cannot make the simulator drop it and lose its travel.
          const move = waitingMove;
          if (move !== undefined) {
            waitingMove = undefined;
            yield* send(ready);
            ready = [];
            const wait = yield* untilDue;
            if (wait > 0) {
              yield* Effect.sleep(wait);
            }
            yield* send([move]);
          }
          ready.push(command);
        } else if (
          ready.length === 0 &&
          waitingMove === undefined &&
          (yield* Clock.currentTimeMillis) - lastWriteAt >= MOVE_SPACING_MILLIS
        ) {
          ready.push(command);
        } else {
          waitingMove = command;
        }
      }
      yield* send(ready);
      if (waitingMove !== undefined && !flushing) {
        flushing = true;
        yield* Effect.forkIn(flush, scope);
      }
    });
  return {
    forward: (inputs: readonly NativeInput[]) =>
      lock.withPermits(1)(
        Effect.gen(function* forwardInput() {
          if (releasing !== undefined) {
            yield* Fiber.interrupt(releasing);
            releasing = undefined;
          }
          yield* deliver(inputs.flatMap((input) => finger.feed(input)));
          if (finger.holding()) {
            releasing = yield* Effect.sleep(WHEEL_RELEASE_MILLIS).pipe(
              Effect.andThen(
                lock.withPermits(1)(
                  Effect.gen(function* liftFinger() {
                    releasing = undefined;
                    // Each resting move and the lift wait out the drag
                    // spacing, so none merges into the next.
                    for (const input of finger.release(performance.now())) {
                      yield* deliver([input]);
                      yield* Effect.sleep(MOVE_SPACING_MILLIS);
                    }
                  })
                )
              ),
              Effect.ignore({
                log: "Debug",
                message: "Could not lift the iOS finger",
              }),
              Effect.forkIn(scope)
            );
          }
        })
      ),
    /** Whether the wheel's finger is down. */
    holding: () => finger.holding(),
  };
};

export interface IosHid {
  /** Sends Forwarded Input to the simulator in order, starting the helper on first use. */
  readonly forward: (
    inputs: readonly NativeInput[]
  ) => Effect.Effect<void, Error>;
  /** Starts the helper in the background so the first user input has no cold start. */
  readonly warm?: () => Effect.Effect<void>;
}

export interface IosHidProcess {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly kill: (signal: NodeJS.Signals) => boolean;
  readonly once: (
    event: "close" | "error",
    listener: (...args: readonly unknown[]) => void
  ) => void;
  readonly stderr: { readonly resume: () => void };
  readonly stdin: {
    readonly end: () => void;
    readonly on: (event: "error", listener: () => void) => void;
    readonly write: (
      chunk: string,
      done: (error?: Error | null) => void
    ) => void;
  };
  readonly stdout: {
    readonly off: (event: "data", listener: (chunk: Buffer) => void) => void;
    readonly on: (event: "data", listener: (chunk: Buffer) => void) => void;
    readonly resume: () => void;
  };
}

export interface IosHidHost {
  readonly command: typeof iosCommand;
  readonly helper: typeof verifyIosHidRelease;
  readonly spawn: (helper: string, args: readonly string[]) => IosHidProcess;
}
const iosHidHost: IosHidHost = {
  command: iosCommand,
  helper: verifyIosHidRelease,
  spawn: (helper, args) => spawn(helper, [...args], { stdio: "pipe" }),
};

/**
 * How long the HID helper may take to print its ready line before startup
 * gives up, retires the process, and releases the startup permit for retry.
 */
export const IOS_HID_READY_TIMEOUT_MILLIS = 15_000;

const unavailable = () =>
  new Error("The simulator input helper is unavailable. Nothing was sent.");

const isProcessAlive = (owned: IosHidProcess) =>
  owned.exitCode === null && owned.signalCode === null;

const stopProcess = async (owned: IosHidProcess) => {
  if (isProcessAlive(owned)) {
    owned.stdin.end();
    owned.kill("SIGTERM");
    await awaitExit(owned);
  }
};

/** One session's input helper, owned by its scope. */
export const makeIosHid = (
  udid: () => string | null,
  scope: Scope.Scope,
  host: IosHidHost = iosHidHost
): Effect.Effect<IosHid> =>
  Effect.gen(function* acquireIosHid() {
    let child: IosHidProcess | undefined;
    const liveProcesses = new Set<IosHidProcess>();
    let closed = false;
    const startLock = Semaphore.makeUnsafe(1);
    yield* Scope.addFinalizer(
      scope,
      Effect.promise(async () => {
        closed = true;
        child = undefined;
        // Keep ownership of every spawned helper (including one interrupted
        // during warm-up) until its process actually exits.
        await Promise.all(Array.from(liveProcesses, stopProcess));
      })
    );
    const start = startLock.withPermits(1)(
      Effect.gen(function* startHelper() {
        if (child !== undefined && isProcessAlive(child)) {
          return child;
        }
        child = undefined;
        const selected = udid();
        if (closed || selected === null) {
          return yield* Effect.fail(unavailable());
        }
        const helper = yield* host.helper().pipe(Effect.mapError(unavailable));
        const developer = yield* host.command("xcode-select", ["-p"]).pipe(
          Effect.mapError(unavailable),
          Effect.timeoutOrElse({
            duration: IOS_HID_READY_TIMEOUT_MILLIS,
            orElse: () => Effect.fail(unavailable()),
          })
        );
        if (closed) {
          return yield* Effect.fail(unavailable());
        }
        const started = host.spawn(helper, [developer.trim(), selected]);
        liveProcesses.add(started);
        started.once("close", () => {
          liveProcesses.delete(started);
          if (child === started) {
            child = undefined;
          }
        });
        started.stdin.on("error", () => {
          // A helper that exits mid-write fails that forward through its callback.
        });
        started.stderr.resume();
        let retired = false;
        const signalTerminate = () => {
          if (!retired && isProcessAlive(started)) {
            retired = true;
            started.stdin.end();
            started.kill("SIGTERM");
          }
        };
        const ready = yield* Effect.callback<boolean>((resume) => {
          let output = "";
          const onData = (chunk: Buffer) => {
            output += chunk.toString("utf-8");
            if (output.includes("\n")) {
              started.stdout.off("data", onData);
              resume(Effect.succeed(output.startsWith("ready ")));
            }
          };
          started.stdout.on("data", onData);
          started.once("close", () => resume(Effect.succeed(false)));
          started.once("error", () => resume(Effect.succeed(false)));
          return Effect.sync(() => {
            started.stdout.off("data", onData);
            signalTerminate();
          });
        }).pipe(
          Effect.timeoutOrElse({
            duration: IOS_HID_READY_TIMEOUT_MILLIS,
            orElse: () => Effect.succeed(false),
          })
        );
        if (!ready || closed || !isProcessAlive(started)) {
          signalTerminate();
          if (isProcessAlive(started)) {
            yield* Effect.promise(() => awaitExit(started)).pipe(
              Effect.ignore({
                log: "Debug",
                message: "Could not wait for the iOS helper to exit",
              }),
              Effect.forkIn(scope)
            );
          }
          return yield* Effect.fail(unavailable());
        }
        started.stdout.resume();
        child = started;
        return started;
      })
    );
    const writer = makeIosHidWriter(
      (lines) =>
        Effect.gen(function* writeToSimulator() {
          const helper = yield* start;
          yield* Effect.callback<true, Error>((resume) => {
            helper.stdin.write(lines, (cause) =>
              resume(cause ? Effect.fail(unavailable()) : Effect.succeed(true))
            );
          }).pipe(
            Effect.tapError(() => {
              if (child === helper) {
                child = undefined;
              }
              return Effect.promise(() => stopProcess(helper)).pipe(
                Effect.ignore({
                  log: "Debug",
                  message: "Could not stop the iOS helper",
                }),
                Effect.forkIn(scope)
              );
            })
          );
        }),
      scope
    );
    return {
      forward: writer.forward,
      warm: () =>
        start.pipe(
          Effect.asVoid,
          Effect.ignore({
            log: "Debug",
            message: "Could not warm the iOS helper",
          }),
          Effect.forkIn(scope),
          Effect.asVoid
        ),
    } satisfies IosHid;
  });
