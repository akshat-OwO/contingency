import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { NodeRuntime } from "@effect/platform-node";
import { Effect, Schedule } from "effect";
import { startScrcpy } from "expo-device-hub/vendor/serve-emu/dist/scrcpy.js";

import {
  androidStreamRelease,
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
    const stream = yield* Effect.acquireRelease(
      io(() =>
        startScrcpy(
          {
            bitRate: 2_000_000,
            keyFrameInterval: 1,
            maxFps: 30,
            maxSize: 1280,
            repeatFrameMs: 500,
            serial,
            signal: controller.signal,
          },
          { ensureServer: () => Promise.resolve(jar), randomScid: () => scid }
        )
      ),
      (owned) => io(() => owned.close()).pipe(Effect.orDie)
    );
    // No control-socket writes, input API, SessionRecorder, installation API, or replay.
    let visibility: "visible" | "secure" | "unknown" | undefined;
    let keyRequired = true;
    let configuration = Buffer.alloc(0);
    let { width } = stream.meta;
    let { height } = stream.meta;
    const inspect = Effect.tryPromise({
      catch: () => new Error("Android window visibility unavailable"),
      try: (signal) =>
        execute("adb", ["-s", serial, "shell", "dumpsys", "window"], {
          maxBuffer: 4 * 1024 * 1024,
          signal,
          timeout: 10_000,
        }),
    }).pipe(
      Effect.flatMap(({ stdout }) =>
        Effect.gen(function* updateVisibility() {
          const next = androidWindowVisibility(stdout);
          if (next !== visibility) {
            keyRequired = true;
            visibility = next;
            const states = {
              secure: "secure",
              unknown: "lost",
              visible: "connecting",
            } as const;
            yield* send({ _tag: "state", state: states[next] });
          }
        })
      )
    );
    yield* inspect;
    yield* inspect.pipe(
      Effect.catchCause(() =>
        Effect.gen(function* hideUnknownWindow() {
          visibility = "unknown";
          keyRequired = true;
          yield* send({ _tag: "state", state: "lost" });
        })
      ),
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
