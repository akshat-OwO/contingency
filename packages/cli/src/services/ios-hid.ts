import type { NativeInput } from "@contingency/protocol";
import { Cause, Clock, Effect, Fiber, Option, Scope, Semaphore } from "effect";

import { spawnPiped, superviseChild } from "./child-process.ts";
import type {
  ChildLike,
  ChildProcessFailure,
  SupervisedChild,
} from "./child-process.ts";
import { recordFailure } from "./failure-reference.ts";
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

/** The helper as its protocol sees it; `child-process.ts` owns the rest. */
export interface IosHidProcess extends ChildLike {
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
  spawn: spawnPiped,
};

/**
 * How long the HID helper may take to print its ready line before startup
 * gives up, retires the process, and releases the startup permit for retry.
 */
export const IOS_HID_READY_TIMEOUT_MILLIS = 15_000;

/**
 * The helper could not take input. When it failed unexpectedly, the reference
 * names its recorded exit and stderr (ADR 0089).
 */
export class IosHidUnavailableError extends Error {
  readonly failureReference: string | undefined;

  constructor(failureReference?: string) {
    super("The simulator input helper is unavailable. Nothing was sent.");
    this.name = "IosHidUnavailableError";
    this.failureReference = failureReference;
  }
}

const unavailable = () => new IosHidUnavailableError();

/** Records the helper's own failure, and answers with its reference. */
const helperFailed = (failure: ChildProcessFailure) =>
  recordFailure(Cause.fail(failure), "ios_hid_failed").pipe(
    Effect.flatMap((reference) =>
      Effect.fail(new IosHidUnavailableError(reference))
    )
  );

type IosHidHelper = SupervisedChild<IosHidProcess>;

/** Ends the helper's input, then stops it. */
const stopHelper = (owned: IosHidHelper) =>
  Effect.sync(() => {
    if (owned.running()) {
      owned.process.stdin.end();
    }
  }).pipe(Effect.andThen(owned.stop()), Effect.asVoid);

/** One session's input helper, owned by its scope. */
export const makeIosHid = (
  udid: () => string | null,
  scope: Scope.Scope,
  host: IosHidHost = iosHidHost
): Effect.Effect<IosHid> =>
  Effect.gen(function* acquireIosHid() {
    let child: IosHidHelper | undefined;
    let closed = false;
    const startLock = Semaphore.makeUnsafe(1);
    // Each helper's own finalizer, added as it starts, stops it and waits
    // for it to exit; this one only refuses new helpers.
    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => {
        closed = true;
        child = undefined;
      })
    );
    const start = startLock.withPermits(1)(
      Effect.gen(function* startHelper() {
        if (child !== undefined && child.running()) {
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
        const started = yield* superviseChild("ios-hid", () =>
          host.spawn(helper, [developer.trim(), selected])
        ).pipe(
          Scope.provide(scope),
          Effect.catchTag("ChildProcessFailure", helperFailed)
        );
        const owned = started.process;
        owned.once("close", () => {
          if (child === started) {
            child = undefined;
          }
        });
        owned.stdin.on("error", () => {
          // A helper that exits mid-write fails that forward through its callback.
        });
        let retired = false;
        const retire = Effect.suspend(() => {
          if (retired || !started.running()) {
            return Effect.void;
          }
          retired = true;
          return stopHelper(started).pipe(Effect.forkIn(scope), Effect.asVoid);
        });
        const ready = yield* Effect.callback<boolean>((resume) => {
          let output = "";
          const onData = (chunk: Buffer) => {
            output += chunk.toString("utf-8");
            if (output.includes("\n")) {
              owned.stdout.off("data", onData);
              resume(Effect.succeed(output.startsWith("ready ")));
            }
          };
          // A helper that exited before this wait began has no close left.
          if (!started.running()) {
            resume(Effect.succeed(false));
          }
          owned.stdout.on("data", onData);
          owned.once("close", () => resume(Effect.succeed(false)));
          owned.once("error", () => resume(Effect.succeed(false)));
          return Effect.sync(() => {
            owned.stdout.off("data", onData);
          }).pipe(Effect.andThen(retire));
        }).pipe(
          Effect.timeoutOrElse({
            duration: IOS_HID_READY_TIMEOUT_MILLIS,
            orElse: () => Effect.succeed(false),
          })
        );
        if (!ready || closed || !started.running()) {
          // A helper that exited before it was ready failed on its own.
          if (!closed && !started.running()) {
            const failure = started.failure(yield* started.stop());
            if (Option.isSome(failure)) {
              return yield* helperFailed(failure.value);
            }
          }
          yield* retire;
          return yield* Effect.fail(unavailable());
        }
        owned.stdout.resume();
        child = started;
        return started;
      })
    );
    const writer = makeIosHidWriter(
      (lines) =>
        Effect.gen(function* writeToSimulator() {
          const helper = yield* start;
          yield* Effect.callback<true, Error>((resume) => {
            helper.process.stdin.write(lines, (cause) =>
              resume(cause ? Effect.fail(unavailable()) : Effect.succeed(true))
            );
          }).pipe(
            Effect.tapError(() => {
              if (child === helper) {
                child = undefined;
              }
              return stopHelper(helper).pipe(Effect.forkIn(scope));
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
