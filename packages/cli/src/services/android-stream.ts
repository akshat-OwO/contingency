import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";

import type { NativeInput } from "@contingency/protocol";
import {
  Deferred,
  Effect,
  Queue,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect";
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
  /**
   * Every packet the worker sends, for the session's recorder, starting with
   * the frames since the last keyframe. While it is consumed the worker runs
   * without a viewer, and a worker that is lost is
   * started again, so the packets go on after a `lost` state. A consumer
   * that falls behind misses frames until the next keyframe, never a frame
   * a later one depends on, and never a state; a `skipped` packet marks
   * where frames were first missed, and the next frame after it is a
   * keyframe. It ends when the session's stream is released.
   */
  readonly packets: Stream.Stream<AndroidRecorderPacket>;
  /**
   * Sends Forwarded Input to the device through the stream's control socket,
   * in order. It fails when no viewer has started the stream.
   */
  readonly forward: (
    inputs: readonly NativeInput[]
  ) => Effect.Effect<void, Error>;
}

const lost: AndroidStreamPacket = { _tag: "state", state: "lost" };
const connecting: AndroidStreamPacket = { _tag: "state", state: "connecting" };
const encode = (packet: AndroidStreamPacket) =>
  Buffer.from(`${JSON.stringify(packet)}\n`);
const decode = Schema.decodeUnknownOption(
  Schema.fromJsonString(AndroidStreamPacket)
);
const execute = promisify(execFile);
/** A packet for the session's recorder. */
export type AndroidRecorderPacket =
  | AndroidStreamPacket
  /** Frames were missed from here; the next frame is a keyframe. */
  | { readonly _tag: "skipped" };
const skipped: AndroidRecorderPacket = { _tag: "skipped" };
/** How long a recorder waits before starting a lost worker again. */
const RESTART_DELAY = "1 second";
/** Packets a recorder may fall behind by before it misses frames. */
const RECORDER_BUFFER = 256;
/**
 * The most the frames since the last keyframe may hold before they are no
 * longer kept for a recorder that joins.
 */
const MAX_GROUP_BYTES = 8 * 1024 * 1024;

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

/**
 * One hub transport per session, with no listening hub port. It shows the
 * device and carries the user's Forwarded Input; nothing else reaches it.
 */
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
        stdio: ["pipe", "pipe", "ignore"],
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
    /** Settles once the current worker has closed and been cleaned up. */
    let exited: Deferred.Deferred<true> | undefined;
    /** Whether the current worker has sent a packet of its own yet. */
    let live = false;
    /**
     * The frames since the last keyframe, so a recorder that joins can start
     * from the screen as it is. The encoder sends a keyframe only every 60
     * frames, which an idle screen takes 30 seconds to reach.
     */
    let group: Extract<AndroidStreamPacket, { readonly _tag: "frame" }>[] = [];
    let groupBytes = 0;
    let cleaning: Promise<void> = Promise.resolve();
    const broadcast = (packet: AndroidStreamPacket) => {
      if (packet._tag === "state") {
        registry.set(status, packet);
        // The worker resumes at a keyframe after any state.
        group = [];
        groupBytes = 0;
      } else if (packet.key) {
        group = [packet];
        groupBytes = packet.data.length;
      } else if (group.length > 0) {
        groupBytes += packet.data.length;
        if (groupBytes > MAX_GROUP_BYTES) {
          group = [];
          groupBytes = 0;
        } else {
          group.push(packet);
        }
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
            // A worker that exits mid-write fails that forward; it must not
            // throw on the parent.
            child.stdin?.on("error", () => {
              // Reported through the write callback.
            });
            pendingCleanup.add(scid);
            worker = child;
            live = false;
            const workerExited = Deferred.makeUnsafe<true>();
            exited = workerExited;
            let pending = "";
            let settled = false;
            const ended = () => {
              if (settled) {
                return;
              }
              settled = true;
              live = false;
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
                      Deferred.doneUnsafe(workerExited, Effect.succeed(true));
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
                live = !settled;
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
    // Unbounded: `receive` bounds the frames it lets in, never the states.
    const packets = Stream.callback<AndroidRecorderPacket>((queue) =>
      Effect.gen(function* recordStream() {
        if (registry.get(closed)) {
          Queue.endUnsafe(queue);
          return;
        }
        let missed = false;
        const receive = (packet: AndroidStreamPacket) => {
          if (registry.get(closed)) {
            Queue.endUnsafe(queue);
            return;
          }
          // States are few and small, and the recorder's Hidden Intervals
          // and losses rest on them, so only frames are ever dropped.
          if (packet._tag === "state") {
            Queue.offerUnsafe(queue, packet);
            return;
          }
          if (missed && !packet.key) {
            return;
          }
          if (Queue.sizeUnsafe(queue) >= RECORDER_BUFFER) {
            // A missed frame breaks the deltas after it; resume at a key.
            // Say so at once, so a Stop before that key still knows.
            if (!missed) {
              Queue.offerUnsafe(queue, skipped);
            }
            missed = true;
            return;
          }
          missed = false;
          Queue.offerUnsafe(queue, packet);
        };
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            clients.add(receive);
            // A worker already running has told viewers its state; tell
            // this consumer too, so it knows the stream is live, then give
            // it the screen from the last keyframe on.
            const current = registry.get(status);
            if (live && current._tag === "state") {
              receive(current);
              for (const frame of group) {
                receive(frame);
              }
            }
          }),
          () =>
            Effect.sync(() => {
              clients.delete(receive);
            })
        );
        // Keep a worker running for as long as this is consumed.
        yield* Effect.gen(function* holdWorker() {
          yield* start;
          if (registry.get(closed)) {
            Queue.endUnsafe(queue);
            return yield* Effect.interrupt;
          }
          const current = exited;
          if (current !== undefined) {
            yield* Deferred.await(current);
          }
          yield* Effect.sleep(RESTART_DELAY);
        }).pipe(Effect.forever, Effect.forkScoped);
      })
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
      forward: (inputs) =>
        Effect.suspend(() => {
          const input = worker?.stdin;
          if (
            registry.get(closed) ||
            input === undefined ||
            input === null ||
            !input.writable
          ) {
            return Effect.fail(
              new Error("The device stream is not live. Nothing was sent.")
            );
          }
          return Effect.callback<true, Error>((resume) => {
            input.write(
              inputs.map((value) => `${JSON.stringify(value)}\n`).join(""),
              (cause) =>
                resume(
                  cause
                    ? Effect.fail(new Error("The device stream closed."))
                    : Effect.succeed(true)
                )
            );
          }).pipe(Effect.asVoid);
        }),
      frames,
      packets,
    } satisfies AndroidDeviceStream;
  });
