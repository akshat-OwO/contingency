import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import type { NativeInput } from "@contingency/protocol";
import { Effect, Scope, Semaphore } from "effect";

import { awaitExit } from "./ffmpeg.ts";
import { verifyIosHidRelease } from "./ios-framebuffer-release.ts";
import { iosCommand } from "./ios-simctl.ts";

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

/** How far one browser wheel notch drags, as a fraction of the screen. */
const NOTCH_FRACTION = 0.1;
const WHEEL_NOTCH = 100;

/**
 * Forwarded Input as helper commands, in order. A wheel turned down drags the
 * content up, as a finger would; a key the simulator has no usage for sends
 * nothing.
 */
export const iosHidCommands = (inputs: readonly NativeInput[]): string[] =>
  inputs.flatMap((input) => {
    if (input._tag === "touch") {
      return [`touch ${input.action} ${input.x} ${input.y}`];
    }
    if (input._tag === "scroll") {
      const dx = (-input.deltaX / WHEEL_NOTCH) * NOTCH_FRACTION;
      const dy = (-input.deltaY / WHEEL_NOTCH) * NOTCH_FRACTION;
      return dx === 0 && dy === 0
        ? []
        : [`scroll ${input.x} ${input.y} ${dx} ${dy}`];
    }
    const usage = iosKeyUsage(input.code);
    return usage === undefined ? [] : [`key ${input.action} ${usage}`];
  });

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
    const lock = Semaphore.makeUnsafe(1);
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
    return {
      forward: (inputs) =>
        lock.withPermits(1)(
          Effect.gen(function* forwardToSimulator() {
            const commands = iosHidCommands(inputs);
            if (commands.length === 0) {
              return;
            }
            const helper = yield* start;
            yield* Effect.callback<true, Error>((resume) => {
              helper.stdin.write(
                commands.map((command) => `${command}\n`).join(""),
                (cause) =>
                  resume(
                    cause ? Effect.fail(unavailable()) : Effect.succeed(true)
                  )
              );
            });
          })
        ),
    } satisfies IosHid;
  });
