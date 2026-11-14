import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";

import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Schema, Scope, Stream } from "effect";

import {
  AndroidStreamPacket,
  androidVisibilityState,
  androidWindowVisibility,
} from "../../src/services/android-stream-contract.ts";
import type { AndroidRecorderPacket } from "../../src/services/android-stream.ts";
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
/** Packets as the worker writes them, one JSON line each. */
const lines = (packets: readonly AndroidStreamPacket[]) =>
  packets.map((packet) => `${JSON.stringify(packet)}\n`).join("");
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
        const received: AndroidRecorderPacket[] = [];
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

it("hides frames for unknown visibility without reporting the stream lost", () => {
  expect(androidVisibilityState("unknown")).toBe("connecting");
  expect(androidVisibilityState("visible")).toBe("connecting");
  expect(androidVisibilityState("secure")).toBe("secure");
});

it.effect(
  "keeps a viewer connected while visibility is unknown and resumes at a keyframe",
  () =>
    Effect.scoped(
      Effect.gen(function* unknownVisibility() {
        const scope = yield* Scope.make();
        const started = yield* Deferred.make<true>();
        const resumed = yield* Deferred.make<true>();
        const child = new ChildProcess();
        const output = new PassThrough();
        child.stdout = output;
        child.kill = () => {
          Object.defineProperty(child, "exitCode", { value: 0 });
          child.emit("close", 0, null);
          return true;
        };
        const stream = yield* acquireAndroidStream(
          "agent-unknown",
          device,
          scope,
          () => {
            Deferred.doneUnsafe(started, Effect.succeed(true));
            return child;
          },
          () => Effect.void
        );
        const received: AndroidRecorderPacket[] = [];
        const viewer = yield* Stream.runForEach(stream.frames, (bytes) =>
          Effect.gen(function* receive() {
            const packet = parse(Buffer.from(bytes).toString("utf-8").trim());
            received.push(packet);
            if (
              packet._tag === "frame" &&
              received.filter((item) => item._tag === "frame").length === 2
            ) {
              yield* Deferred.succeed(resumed, true);
            }
          })
        ).pipe(Effect.forkChild);
        yield* Deferred.await(started).pipe(Effect.timeout("30 seconds"));
        const unknown = {
          _tag: "state",
          state: androidVisibilityState("unknown"),
        } as const;
        yield* Effect.sync(() => {
          output.write(
            [frame(true), unknown, frame(false), frame(true)]
              .map((packet) => `${JSON.stringify(packet)}\n`)
              .join("")
          );
        });
        yield* Deferred.await(resumed).pipe(Effect.timeout("30 seconds"));
        expect(received.slice(1)).toEqual([frame(true), unknown, frame(true)]);
        yield* Scope.close(scope, Exit.void);
        yield* Fiber.join(viewer);
      })
    )
);

it.live(
  "keeps a worker running for the recorder without a viewer and restarts it when lost",
  () =>
    Effect.scoped(
      Effect.gen(function* recorderHold() {
        const scope = yield* Scope.make();
        const firstLaunch = yield* Deferred.make<PassThrough>();
        const secondLaunch = yield* Deferred.make<PassThrough>();
        const launches = [firstLaunch, secondLaunch];
        const children: ChildProcess[] = [];
        const stream = yield* acquireAndroidStream(
          "agent-recorder",
          device,
          scope,
          () => {
            const child = new ChildProcess();
            const output = new PassThrough();
            child.stdout = output;
            child.kill = () => {
              Object.defineProperty(child, "exitCode", { value: 0 });
              child.emit("close", 0, null);
              return true;
            };
            const launch = launches[children.length];
            children.push(child);
            if (launch !== undefined) {
              Deferred.doneUnsafe(launch, Effect.succeed(output));
            }
            return child;
          },
          () => Effect.void
        );
        const received: AndroidRecorderPacket[] = [];
        const firstFrame = yield* Deferred.make<true>();
        const lastFrame = yield* Deferred.make<true>();
        const seen = [firstFrame, undefined, lastFrame];
        const recorder = yield* Stream.runForEach(stream.packets, (packet) =>
          Effect.sync(() => {
            received.push(packet);
            const frames = received.filter((item) => item._tag === "frame");
            const reached = seen[frames.length - 1];
            if (packet._tag === "frame" && reached !== undefined) {
              Deferred.doneUnsafe(reached, Effect.succeed(true));
            }
          })
        ).pipe(Effect.forkChild);
        const connecting = { _tag: "state", state: "connecting" } as const;
        // No viewer is connected: the recorder alone starts the worker.
        const first = yield* Deferred.await(firstLaunch).pipe(
          Effect.timeout("30 seconds")
        );
        first.write(
          `${JSON.stringify(connecting)}\n${JSON.stringify(frame(true))}\n`
        );
        yield* Deferred.await(firstFrame).pipe(Effect.timeout("30 seconds"));
        // The worker dies; the recorder is told, and a new one starts.
        children[0]?.emit("close", 1, null);
        const second = yield* Deferred.await(secondLaunch).pipe(
          Effect.timeout("30 seconds")
        );
        second.write(
          `${JSON.stringify(connecting)}\n${JSON.stringify(frame(false))}\n${JSON.stringify(frame(true))}\n`
        );
        yield* Deferred.await(lastFrame).pipe(Effect.timeout("30 seconds"));
        // A recorder takes every packet, deltas included, and never the
        // viewer's synthetic join state.
        expect(received).toEqual([
          connecting,
          frame(true),
          { _tag: "state", state: "lost" },
          connecting,
          frame(false),
          frame(true),
        ]);
        yield* Scope.close(scope, Exit.void);
        yield* Fiber.join(recorder);
      })
    )
);

it.effect(
  "gives a recorder that joins a running stream the screen from its last keyframe",
  () =>
    Effect.scoped(
      Effect.gen(function* joinRunning() {
        const scope = yield* Scope.make();
        const started = yield* Deferred.make<PassThrough>();
        const child = new ChildProcess();
        const output = new PassThrough();
        child.stdout = output;
        child.kill = () => {
          Object.defineProperty(child, "exitCode", { value: 0 });
          child.emit("close", 0, null);
          return true;
        };
        const stream = yield* acquireAndroidStream(
          "agent-join",
          device,
          scope,
          () => {
            Deferred.doneUnsafe(started, Effect.succeed(output));
            return child;
          },
          () => Effect.void
        );
        const delta = yield* Deferred.make<true>();
        const viewer = yield* Stream.runForEach(stream.frames, (bytes) => {
          const packet = parse(Buffer.from(bytes).toString("utf-8").trim());
          return packet._tag === "frame" && !packet.key
            ? Deferred.succeed(delta, true)
            : Effect.void;
        }).pipe(Effect.forkChild);
        const connecting = { _tag: "state", state: "connecting" } as const;
        const later = { ...frame(false), timestamp: 3 };
        (yield* Deferred.await(started).pipe(
          Effect.timeout("30 seconds")
        )).write(
          [connecting, frame(false), frame(true), later]
            .map((packet) => `${JSON.stringify(packet)}\n`)
            .join("")
        );
        yield* Deferred.await(delta).pipe(Effect.timeout("30 seconds"));
        // The recorder joins after the worker sent its keyframe and a delta.
        const joined = yield* stream.packets.pipe(
          Stream.take(3),
          Stream.runCollect
        );
        expect([...joined]).toEqual([connecting, frame(true), later]);
        yield* Scope.close(scope, Exit.void);
        yield* Fiber.join(viewer);
      })
    )
);

it.effect(
  "keeps every state for a recorder that falls behind and marks the frames it missed",
  () =>
    Effect.scoped(
      Effect.gen(function* fallBehind() {
        const scope = yield* Scope.make();
        const started = yield* Deferred.make<PassThrough>();
        const child = new ChildProcess();
        const output = new PassThrough();
        child.stdout = output;
        child.kill = () => {
          Object.defineProperty(child, "exitCode", { value: 0 });
          child.emit("close", 0, null);
          return true;
        };
        const stream = yield* acquireAndroidStream(
          "agent-behind",
          device,
          scope,
          () => {
            Deferred.doneUnsafe(started, Effect.succeed(output));
            return child;
          },
          () => Effect.void
        );
        const gate = yield* Deferred.make<true>();
        const blocked = yield* Deferred.make<true>();
        const drained = yield* Deferred.make<true>();
        const received: AndroidRecorderPacket[] = [];
        const resumed = { ...frame(true), timestamp: 999 };
        const recorder = yield* stream.packets.pipe(
          Stream.tap(() =>
            received.length === 0
              ? Deferred.succeed(blocked, true).pipe(
                  Effect.andThen(Deferred.await(gate))
                )
              : Effect.void
          ),
          Stream.tap((packet) =>
            Effect.sync(() => {
              received.push(packet);
              if (packet._tag === "state" && packet.state === "secure") {
                Deferred.doneUnsafe(drained, Effect.succeed(true));
              }
            })
          ),
          Stream.takeUntil(
            (packet) => packet._tag === "frame" && packet.timestamp === 999
          ),
          Stream.runDrain,
          Effect.forkChild
        );
        const worker = yield* Deferred.await(started).pipe(
          Effect.timeout("30 seconds")
        );
        const connecting = { _tag: "state", state: "connecting" } as const;
        const secure = { _tag: "state", state: "secure" } as const;
        worker.write(`${JSON.stringify(connecting)}\n`);
        // The recorder is stuck on its first packet while the worker sends
        // more frames than it may fall behind by, then a state.
        yield* Deferred.await(blocked).pipe(Effect.timeout("30 seconds"));
        worker.write(
          lines([
            frame(true),
            ...Array.from({ length: 300 }, () => frame(false)),
            secure,
          ])
        );
        yield* Deferred.succeed(gate, true);
        // Once it caught up, a delta is still missed, and the stream resumes
        // at the next keyframe.
        yield* Deferred.await(drained).pipe(Effect.timeout("30 seconds"));
        worker.write(lines([frame(false), resumed]));
        yield* Fiber.join(recorder).pipe(Effect.timeout("30 seconds"));
        expect(
          received.filter((packet) => packet._tag === "frame").length
        ).toBeLessThan(300);
        // The missed frames are marked just before the keyframe after them.
        expect(received.slice(-2)).toEqual([{ _tag: "skipped" }, resumed]);
        yield* Scope.close(scope, Exit.void);
      })
    )
);
