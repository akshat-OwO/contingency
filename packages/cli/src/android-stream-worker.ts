import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

import { NativeInput } from "@contingency/protocol";
import { NodeRuntime } from "@effect/platform-node";
import { Effect, Result, Schedule, Schema } from "effect";
import { startGrpcSession } from "expo-device-hub/vendor/serve-emu/dist/grpc-session.js";
import {
  startScrcpy,
  startScrcpyControl,
} from "expo-device-hub/vendor/serve-emu/dist/scrcpy.js";

import {
  makeAndroidControlGestures,
  androidControlPackets,
} from "./services/android-control.ts";
import {
  androidStreamRelease,
  androidVisibilityState,
  androidWindowVisibility,
} from "./services/android-stream-contract.ts";
import type { AndroidStreamPacket } from "./services/android-stream-contract.ts";

const execute = promisify(execFile);
const io = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    catch: () => new Error("Android stream unavailable"),
    try: operation,
  });
const send = (packet: AndroidStreamPacket) =>
  Effect.callback<true, Error>((resume) => {
    // oxlint-disable-next-line promise/prefer-await-to-callbacks -- Writable callback is the backpressure acknowledgement.
    process.stdout.write(`${JSON.stringify(packet)}\n`, (error) =>
      resume(error ? Effect.fail(error) : Effect.succeed(true))
    );
  });

Effect.scoped(
  Effect.gen(function* streamSelectedDevice() {
    const serial = process.env.CONTINGENCY_STREAM_SERIAL;
    const scid = process.env.CONTINGENCY_STREAM_SCID;
    const jar = path.resolve(
      path.basename(import.meta.dirname) === "dist"
        ? import.meta.dirname
        : path.resolve(import.meta.dirname, ".."),
      "android/stream/scrcpy-server-v4.0"
    );
    if (
      !serial ||
      !scid ||
      !/^[0-7][\da-f]{7}$/u.test(scid) ||
      createHash("sha256")
        .update(yield* io(() => readFile(jar)))
        .digest("hex") !== androidStreamRelease.sha256
    ) {
      return yield* Effect.fail(new Error("Android stream package invalid"));
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    // Interrupt acquisition as well as the running pump, before scope finalizers.
    process.on("SIGTERM", abort);
    process.on("SIGINT", abort);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        process.off("SIGTERM", abort);
        process.off("SIGINT", abort);
        controller.abort();
      })
    );
    const scrcpyServer = {
      ensureServer: () => Promise.resolve(jar),
      randomScid: () => scid,
    };
    /**
     * A display stream and where its input goes. An emulator's screen is read
     * over its own gRPC and encoded on this host with low-delay settings,
     * which avoids the emulator's slow in-guest encoder; input then goes
     * through that stream's gesture queue. A physical device, or an emulator
     * whose gRPC or host encoder is unavailable, streams through scrcpy and
     * takes control packets directly.
     */
    interface DisplayStream {
      readonly meta: { readonly width: number; readonly height: number };
      readonly readFrame: Awaited<ReturnType<typeof startScrcpy>>["readFrame"];
      readonly send: (
        input: NativeInput,
        screen: { readonly width: number; readonly height: number }
      ) => void;
      readonly close: () => Promise<void>;
    }
    const scrcpyStream = io(async (): Promise<DisplayStream> => {
      const owned = await startScrcpy(
        {
          bitRate: 2_000_000,
          keyFrameInterval: 1,
          maxFps: 30,
          maxSize: 1280,
          repeatFrameMs: 500,
          serial,
          signal: controller.signal,
        },
        scrcpyServer
      );
      return {
        close: () => owned.close(),
        meta: owned.meta,
        readFrame: () => owned.readFrame(),
        send: (input, screen) => {
          for (const packet of androidControlPackets(input, screen)) {
            owned.controlSocket.write(packet);
          }
        },
      };
    });
    const emulatorStream = io(async (): Promise<DisplayStream> => {
      const owned = await startGrpcSession(
        {
          bitRate: 8_000_000,
          encoder: "software",
          grpcImageMode: "mmap",
          inputSource: "scrcpy",
          keyFrameInterval: 1,
          maxFps: 60,
          maxSize: 1280,
          repeatFrameMs: 500,
          serial,
          signal: controller.signal,
        },
        {
          startScrcpyControl: (options) =>
            startScrcpyControl(options, scrcpyServer),
        }
      );
      const gestures = makeAndroidControlGestures();
      return {
        close: () => owned.close(),
        meta: owned.meta,
        readFrame: () => owned.readFrame(),
        send: (input, screen) => {
          for (const gesture of gestures(input)) {
            // The queue keeps order. A rejected or dropped gesture is not
            // retried, and a closed queue ends the stream through its own
            // failure.
            void (async () => {
              try {
                await owned.controls.enqueue(gesture, screen).completion;
              } catch {
                // Nothing was sent for this gesture.
              }
            })();
          }
        },
      };
    });
    const stream = yield* Effect.acquireRelease(
      /^emulator-\d+$/u.test(serial)
        ? emulatorStream.pipe(
            Effect.result,
            Effect.flatMap((started) =>
              Result.isSuccess(started)
                ? Effect.succeed(started.success)
                : scrcpyStream
            )
          )
        : scrcpyStream,
      (owned) => io(() => owned.close()).pipe(Effect.orDie)
    );
    // Forwarded Input is the only input the stream sends. No SessionRecorder,
    // installation API, or replay is reachable.
    let visibility: "visible" | "secure" | "unknown" | undefined;
    let keyRequired = true;
    let configuration = Buffer.alloc(0);
    let { width } = stream.meta;
    let { height } = stream.meta;
    const decodeInput = Schema.decodeUnknownOption(
      Schema.fromJsonString(NativeInput)
    );
    const lines = createInterface({ input: process.stdin });
    yield* Effect.addFinalizer(() => Effect.sync(() => lines.close()));
    // Each line is one input, written in order at the current frame size.
    lines.on("line", (line) => {
      const input = decodeInput(line);
      // The parent validated the input; a line that does not decode is dropped.
      if (input._tag === "None") {
        return;
      }
      stream.send(input.value, { height, width });
    });
    const inspect = Effect.tryPromise({
      catch: () => new Error("Android window visibility unavailable"),
      try: (signal) =>
        execute("adb", ["-s", serial, "shell", "dumpsys", "window"], {
          maxBuffer: 4 * 1024 * 1024,
          signal,
          timeout: 10_000,
        }),
    }).pipe(
      Effect.map(({ stdout }) => androidWindowVisibility(stdout)),
      // A failed read leaves visibility unknown, which hides frames like any
      // other unknown window. The stream itself is still running, so viewers
      // stay connected and the next read can show frames again.
      Effect.orElseSucceed(() => "unknown" as const),
      Effect.flatMap((next) =>
        Effect.gen(function* updateVisibility() {
          if (next !== visibility) {
            keyRequired = true;
            visibility = next;
            yield* send({ _tag: "state", state: androidVisibilityState(next) });
          }
        })
      )
    );
    yield* inspect;
    yield* inspect.pipe(
      Effect.repeat(Schedule.spaced("1 second")),
      Effect.forkScoped
    );
    yield* Effect.forever(
      Effect.gen(function* deliverFrame() {
        const packet = yield* io(() => stream.readFrame());
        if (packet === null) {
          return yield* Effect.fail(new Error("Android stream ended"));
        }
        if (packet.type === "session") {
          ({ width, height } = packet);
          keyRequired = true;
          return;
        }
        if (packet.isConfig) {
          configuration = Buffer.from(packet.data);
          return;
        }
        if (visibility !== "visible" || (keyRequired && !packet.isKey)) {
          return;
        }
        keyRequired = false;
        const data = packet.isKey
          ? Buffer.concat([configuration, packet.data])
          : Buffer.from(packet.data);
        if (data.length > 2 * 1024 * 1024) {
          return yield* Effect.fail(new Error("Android frame exceeds limit"));
        }
        yield* send({
          _tag: "frame",
          data: data.toString("base64"),
          height,
          key: packet.isKey,
          timestamp: Number(packet.pts),
          width,
        });
      })
    );
  })
).pipe(
  Effect.catchCause(() => send({ _tag: "state", state: "lost" })),
  NodeRuntime.runMain
);
