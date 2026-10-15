import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";

import { Effect, Queue, Schema, Scope, Semaphore, Stream } from "effect";
import { Atom, AtomRegistry } from "effect/reactivity";

import type { AndroidDeviceSelection } from "./android-runtime-contract.ts";
import {
  AndroidStreamPacket,
  androidStreamRelease,
} from "./android-stream-contract.ts";
import { awaitExit } from "./ffmpeg.ts";

export interface AndroidStreamAccess {
  readonly token: string;
  readonly path: string;
}
export interface AndroidDeviceStream {
  readonly access: AndroidStreamAccess;
  readonly authorized: (token?: string) => boolean;
  readonly frames: Stream.Stream<Uint8Array>;
}

const lost: AndroidStreamPacket = { _tag: "state", state: "lost" };
const connecting: AndroidStreamPacket = { _tag: "state", state: "connecting" };
const encode = (packet: AndroidStreamPacket) =>
  Buffer.from(`${JSON.stringify(packet)}\n`);
const decode = Schema.decodeUnknownOption(
  Schema.fromJsonString(AndroidStreamPacket)
);
const execute = promisify(execFile);

/** Reap only this generation's forward and working files, even after SIGKILL. */
const cleanupTransport = (device: AndroidDeviceSelection, scid: string) =>
  Effect.gen(function* cleanupOwnedTransport() {
    const adb = (args: readonly string[]) =>
      Effect.tryPromise({
        catch: () => new Error("Android stream cleanup failed"),
        try: () =>
          execute("adb", ["-s", device.serial, ...args], {
            maxBuffer: 1024 * 1024,
            timeout: 10_000,
          }),
      });
    const target = `localabstract:scrcpy_${scid}`;
    const listed = yield* adb(["forward", "--list"]);
    for (const line of listed.stdout.trim().split(/\r?\n/u)) {
      const [serial, port, remote] = line.split(/\s+/u);
      if (
        serial === device.serial &&
        remote === target &&
        port?.startsWith("tcp:")
      ) {
        yield* adb(["forward", "--remove", port]);
      }
    }
    yield* adb([
      "shell",
      "rm",
      "-f",
      `/data/local/tmp/serve-emu-scrcpy-${scid}.jar`,
      `/data/local/tmp/serve-emu-scrcpy-server-v4.0.jar-${androidStreamRelease.sha256.slice(0, 24)}.${scid}.tmp`,
    ]);
  });

/** One display-only hub transport per session, with no listening hub port. */
export const acquireAndroidStream = (
  sessionId: string,
  device: AndroidDeviceSelection,
  scope: Scope.Scope,
  launch: (scid: string) => ChildProcess = (scid) =>
    spawn(
      process.execPath,
      [
        path.basename(import.meta.dirname) === "dist"
          ? path.join(import.meta.dirname, "android-stream-worker.js")
          : path.resolve(import.meta.dirname, "../android-stream-worker.ts"),
      ],
      {
        env: {
          ...process.env,
          CONTINGENCY_STREAM_SCID: scid,
          CONTINGENCY_STREAM_SERIAL: device.serial,
        },
        stdio: ["ignore", "pipe", "ignore"],
      }
    ),
  cleanup: (scid: string) => Effect.Effect<void, Error> = (scid) =>
    cleanupTransport(device, scid)
) =>
  Effect.gen(function* acquireStream() {
    const registry = AtomRegistry.make();
    const closed = Atom.make(false).pipe(Atom.keepAlive);
    const status = Atom.make<AndroidStreamPacket>(connecting).pipe(
      Atom.keepAlive
    );
    const lock = Semaphore.makeUnsafe(1);
    const secret = randomBytes(32).toString("base64url");
    const clients = new Set<(packet: AndroidStreamPacket) => void>();
    const pendingCleanup = new Set<string>();
    let worker: ChildProcess | undefined;
    let cleaning: Promise<void> = Promise.resolve();
    const broadcast = (packet: AndroidStreamPacket) => {
      if (packet._tag === "state") {
        registry.set(status, packet);
      }
      for (const receive of clients) {
        receive(packet);
      }
    };
    const stop = Effect.gen(function* releaseStream() {
      registry.set(closed, true);
      broadcast(lost);
      clients.clear();
      if (worker) {
        const owned = worker;
        owned.kill("SIGTERM");
        yield* Effect.promise(() => awaitExit(owned));
        if (
          owned.exitCode !== 0 &&
          // NodeRuntime reports interrupted fibers as 130 for either signal.
          owned.exitCode !== 130 &&
          owned.exitCode !== 143 &&
          owned.signalCode !== "SIGTERM"
        ) {
          yield* Effect.logError(
            "Android stream cleanup failed; inspect the owned stream process."
          );
        }
      }
      yield* Effect.promise(() => cleaning);
      yield* Effect.forEach(
        [...pendingCleanup],
        (scid) =>
          cleanup(scid).pipe(
            Effect.tap(() => Effect.sync(() => pendingCleanup.delete(scid))),
            Effect.orDie
          ),
        { discard: true }
      );
      // The closed atom remains readable by already issued capabilities. The
      // unobserved registry is collected with this session, and owns no timers.
    });
    yield* Scope.addFinalizer(scope, stop);
    const start = lock.withPermits(1)(
      Effect.promise(() => cleaning).pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (registry.get(closed) || worker) {
              return;
            }
            const scid = randomInt(0x80_00_00_00).toString(16).padStart(8, "0");
            const child = launch(scid);
            pendingCleanup.add(scid);
            worker = child;
            let pending = "";
            let settled = false;
            const ended = () => {
              if (settled) {
                return;
              }
              settled = true;
              broadcast(lost);
              // Retain the process until it has actually closed, including startup failure.
            };
            child.once("error", ended);
            child.once("close", () => {
              ended();
              cleaning = Effect.runPromise(
                cleanup(scid).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => pendingCleanup.delete(scid))
                  ),
                  Effect.catchCause(() =>
                    Effect.logError(
                      "Android stream cleanup failed; session release will retry.",
                      { scid, serial: device.serial }
                    )
                  ),
                  Effect.andThen(
                    Effect.sync(() => {
                      if (worker === child) {
                        worker = undefined;
                      }
                    })
                  )
                )
              );
            });
            child.stdout?.setEncoding("utf-8");
            child.stdout?.on("data", (chunk: string) => {
              pending += chunk;
              if (pending.length > 4 * 1024 * 1024) {
                ended();
                child.kill("SIGTERM");
                return;
              }
              let newline = pending.indexOf("\n");
              while (newline !== -1) {
                const line = pending.slice(0, newline);
                pending = pending.slice(newline + 1);
                const packet = decode(line);
                if (packet._tag === "None") {
                  ended();
                  child.kill("SIGTERM");
                  return;
                }
                broadcast(packet.value);
                newline = pending.indexOf("\n");
              }
            });
          })
        )
      )
    );
    const frames = Stream.callback<Uint8Array>(
      (queue) =>
        Effect.gen(function* viewStream() {
          if (registry.get(closed)) {
            Queue.offerUnsafe(queue, encode(lost));
            Queue.endUnsafe(queue);
            return;
          }
          let keyRequired = true;
          const receive = (packet: AndroidStreamPacket) => {
            if (packet._tag === "frame") {
              if (keyRequired && !packet.key) {
                return;
              }
              keyRequired = false;
            } else {
              keyRequired = true;
            }
            if (!Queue.offerUnsafe(queue, encode(packet))) {
              // Dropping H.264 deltas silently corrupts decoding. Close a slow viewer.
              Queue.endUnsafe(queue);
              clients.delete(receive);
            }
            if (packet._tag === "state" && packet.state === "lost") {
              Queue.endUnsafe(queue);
              clients.delete(receive);
            }
          };
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              clients.add(receive);
              const current = registry.get(status);
              receive(
                current._tag === "state" && current.state === "secure"
                  ? current
                  : connecting
              );
            }),
            () =>
              Effect.sync(() => {
                clients.delete(receive);
              })
          );
          yield* start;
        }),
      { bufferSize: 8, strategy: "dropping" }
    );
    return {
      access: {
        path: `/android/stream/${encodeURIComponent(sessionId)}`,
        token: secret,
      },
      authorized: (token?: string) =>
        !registry.get(closed) &&
        token !== undefined &&
        Buffer.byteLength(token) === Buffer.byteLength(secret) &&
        timingSafeEqual(Buffer.from(token), Buffer.from(secret)),
      frames,
    } satisfies AndroidDeviceStream;
  });
