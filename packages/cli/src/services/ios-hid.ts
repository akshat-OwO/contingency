import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

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
    Effect.ignore,
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
              Effect.ignore,
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
}

export interface IosHidHost {
  readonly command: typeof iosCommand;
  readonly helper: typeof verifyIosHidRelease;
  readonly spawn: (
    helper: string,
    args: readonly string[]
  ) => ChildProcessWithoutNullStreams;
}
const iosHidHost: IosHidHost = {
  command: iosCommand,
  helper: verifyIosHidRelease,
  spawn: (helper, args) => spawn(helper, [...args], { stdio: "pipe" }),
};

const unavailable = () =>
  new Error("The simulator input helper is unavailable. Nothing was sent.");

/** One session's input helper, owned by its scope. */
export const makeIosHid = (
  udid: () => string | null,
  scope: Scope.Scope,
  host: IosHidHost = iosHidHost
) =>
  Effect.gen(function* acquireIosHid() {
    let child: ChildProcessWithoutNullStreams | undefined;
    let closed = false;
    yield* Scope.addFinalizer(
      scope,
      Effect.promise(async () => {
        closed = true;
        const owned = child;
        child = undefined;
        if (owned !== undefined && owned.exitCode === null) {
          owned.stdin.end();
          owned.kill("SIGTERM");
          await awaitExit(owned);
        }
      })
    );
    const start = Effect.gen(function* startHelper() {
      if (child !== undefined && child.exitCode === null) {
        return child;
      }
      const selected = udid();
      if (closed || selected === null) {
        return yield* Effect.fail(unavailable());
      }
      const helper = yield* host.helper().pipe(Effect.mapError(unavailable));
      const developer = yield* host
        .command("xcode-select", ["-p"])
        .pipe(Effect.mapError(unavailable));
      const started = host.spawn(helper, [developer.trim(), selected]);
      started.stdin.on("error", () => {
        // A helper that exits mid-write fails that forward through its callback.
      });
      started.stderr.resume();
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
      });
      if (!ready) {
        started.kill("SIGTERM");
        return yield* Effect.fail(unavailable());
      }
      started.stdout.resume();
      child = started;
      return started;
    });
    const writer = makeIosHidWriter(
      (lines) =>
        Effect.gen(function* writeToSimulator() {
          const helper = yield* start;
          yield* Effect.callback<true, Error>((resume) => {
            helper.stdin.write(lines, (cause) =>
              resume(cause ? Effect.fail(unavailable()) : Effect.succeed(true))
            );
          });
        }),
      scope
    );
    return {
      forward: writer.forward,
    } satisfies IosHid;
  });
