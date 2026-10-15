import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";

import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Schema, Scope, Stream } from "effect";

import {
  AndroidStreamPacket,
  androidWindowVisibility,
} from "../../src/services/android-stream-contract.ts";
import { acquireAndroidStream } from "../../src/services/android-stream.ts";

const device = {
  api: 36,
  avd: "Pixel_9",
  fingerprint: "fixture",
  host: "local",
  serial: "emulator-5586",
} as const;
const frame = (key: boolean) =>
  ({
    _tag: "frame",
    data: "AAAAAWdCQB4=",
    height: 100,
    key,
    timestamp: 1,
    width: 50,
  }) as const;
const parse = Schema.decodeUnknownSync(
  Schema.fromJsonString(AndroidStreamPacket)
);

it.effect("binds credentials to one session and revokes them on release", () =>
  Effect.scoped(
    Effect.gen(function* sessionCredentials() {
      const scope = yield* Scope.make();
      const first = yield* acquireAndroidStream("agent-first", device, scope);
      const second = yield* acquireAndroidStream("agent-second", device, scope);
      expect(first.authorized()).toBe(false);
      expect(first.authorized("wrong")).toBe(false);
      expect(first.authorized(first.access.token)).toBe(true);
      expect(first.authorized(second.access.token)).toBe(false);
      expect(first.access.path).toBe("/android/stream/agent-first");
      yield* Scope.close(scope, Exit.void);
      expect(first.authorized(first.access.token)).toBe(false);
    })
  )
);

it.effect(
  "joins on a keyframe, reports worker loss, and releases the owned process",
  () =>
    Effect.scoped(
      Effect.gen(function* streamLifecycle() {
        const scope = yield* Scope.make();
        const started = yield* Deferred.make<true>();
        const decoded = yield* Deferred.make<true>();
        const child = new ChildProcess();
        const output = new PassThrough();
        child.stdout = output;
        let stopped = false;
        child.kill = () => {
          stopped = true;
          Object.defineProperty(child, "exitCode", { value: 0 });
          child.emit("close", 0, null);
          return true;
        };
        let cleanupAttempts = 0;
        const stream = yield* acquireAndroidStream(
          "agent-stream",
          device,
          scope,
          () => {
            Deferred.doneUnsafe(started, Effect.succeed(true));
            return child;
          },
          () =>
            Effect.suspend(() => {
              cleanupAttempts += 1;
              return cleanupAttempts === 1
                ? Effect.fail(new Error("fixture cleanup failure"))
                : Effect.void;
            })
        );
        const received: AndroidStreamPacket[] = [];
        const viewer = yield* Stream.runForEach(stream.frames, (bytes) =>
          Effect.gen(function* receive() {
            const packet = parse(Buffer.from(bytes).toString("utf-8").trim());
            received.push(packet);
            if (packet._tag === "frame") {
              yield* Deferred.succeed(decoded, true);
            }
          })
        ).pipe(Effect.forkChild);
        yield* Deferred.await(started).pipe(Effect.timeout("30 seconds"));
        yield* Effect.sync(() => {
          output.write(
            `${JSON.stringify(frame(false))}\n${JSON.stringify(frame(true))}\n`
          );
        });
        yield* Deferred.await(decoded).pipe(Effect.timeout("30 seconds"));
        expect(received.filter((packet) => packet._tag === "frame")).toEqual([
          frame(true),
        ]);
        yield* Scope.close(scope, Exit.void);
        yield* Fiber.join(viewer);
        expect(stopped).toBe(true);
        expect(cleanupAttempts).toBe(2);
        expect(received.at(-1)).toEqual({ _tag: "state", state: "lost" });
      })
    )
);

const windows = (focusedFlags: string, otherFlags = "SECURE") => `
  mCurrentFocus=Window{abc u0 dev.fixture/.Main}
  Window #0 Window{other u0 other/.Main}:
    mAttrs={ fl=${otherFlags}\n    }
  Window #1 Window{abc u0 dev.fixture/.Main}:
    mAttrs={ fl=${focusedFlags}\n    }
  `;

it("recognizes secure flags after other flags and ignores unfocused windows", () => {
  expect(
    androidWindowVisibility(
      windows("LAYOUT_IN_SCREEN SECURE HARDWARE_ACCELERATED")
    )
  ).toBe("secure");
  expect(
    androidWindowVisibility(windows("LAYOUT_IN_SCREEN HARDWARE_ACCELERATED"))
  ).toBe("visible");
  expect(androidWindowVisibility(windows("0x2000"))).toBe("secure");
  expect(androidWindowVisibility(windows("0x100"))).toBe("visible");
  expect(androidWindowVisibility("mCurrentFocus=null")).toBe("unknown");
  expect(androidWindowVisibility(windows(""))).toBe("unknown");
});
