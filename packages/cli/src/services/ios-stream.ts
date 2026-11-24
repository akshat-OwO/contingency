import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import {
  Cause,
  Deferred,
  Effect,
  Option,
  Queue,
  Schema,
  Scope,
  Stream,
  Semaphore,
} from "effect";
import { Atom, AtomRegistry } from "effect/reactivity";

import { spawnPiped, superviseChild } from "./child-process.ts";
import type { ChildProcessFailure, SupervisedChild } from "./child-process.ts";
import { recordFailure } from "./failure-reference.ts";
import type { IosDevice } from "./ios-contract.ts";
import { verifyIosFramebufferRelease } from "./ios-framebuffer-release.ts";
import { iosRuntimeError } from "./ios-runtime.ts";
import { iosCommand } from "./ios-simctl.ts";
import {
  IosFramebufferPacket,
  makeIosStreamIntegrity,
} from "./ios-stream-integrity.ts";
import type { IosStreamGap } from "./ios-stream-integrity.ts";

interface CaptureSize {
  readonly width: number;
  readonly height: number;
}
const integratedDisplay = (inventory: string, capture?: CaptureSize) => {
  const screens = inventory
    .split(/\n\s*\(\d+\) [^\r\n]+:\n/u)
    .filter((part) => /Screen Type: Integrated\n/u.test(part));
  const ports = inventory
    .split(/(?:^|\n)Port:\n/u)
    .filter(
      (port) =>
        /Port Identifier: com\.apple\.framebuffer\.display\n/u.test(port) &&
        /Display class: 0\n/u.test(port) &&
        /Power state: On\n/u.test(port)
    );
  if (
    (inventory.match(/Screen Type: Integrated/gu) ?? []).length === 1 &&
    screens.length === 1 &&
    ports.length === 1
  ) {
    return /IOSurface port:/u.test(ports[0] ?? "")
      ? { port: ports[0] ?? "", screen: screens[0] ?? "" }
      : null;
  }
  if (!capture) {
    return null;
  }
  // A foldable can power both panels. Bind only a unique panel matching the
  // validated Target App screenshot, independent of its current orientation.
  const matches = (width: number, height: number) =>
    (width === capture.width && height === capture.height) ||
    (width === capture.height && height === capture.width);
  const matchingScreens = screens.filter((screen) => {
    const size = /Pixel Size: \{(?<width>\d+), (?<height>\d+)\}/u.exec(screen);
    const scale = Number(
      /Preferred UI Scale: (?<scale>[\d.]+)/u.exec(screen)?.groups?.scale
    );
    const width = Number(size?.groups?.width);
    const height = Number(size?.groups?.height);
    return (
      matches(width, height) ||
      (scale > 0 &&
        matches(Math.round(width / scale), Math.round(height / scale)))
    );
  });
  if (matchingScreens.length !== 1) {
    return null;
  }
  const screen = matchingScreens[0] ?? "";
  const size = /Pixel Size: \{(?<width>\d+), (?<height>\d+)\}/u.exec(screen);
  const matchingPorts = ports.filter((port) => {
    const width = /Default width: (?<width>\d+)/u.exec(port)?.groups?.width;
    const height = /Default height: (?<height>\d+)/u.exec(port)?.groups?.height;
    return (
      /IOSurface port:/u.test(port) &&
      width === size?.groups?.width &&
      height === size?.groups?.height
    );
  });
  return matchingPorts.length === 1
    ? { port: matchingPorts[0] ?? "", screen }
    : null;
};

/** Refuse ambiguity unless the Target App capture identifies one integrated panel. */
export const activeIosDisplay = (
  inventory: string,
  capture?: CaptureSize
): string | null => {
  const display = integratedDisplay(inventory, capture);
  return (
    /UUID: (?<id>[A-Fa-f\d-]{36})/u.exec(display?.port ?? "")?.groups?.id ??
    null
  );
};

export const iosDisplayOrientation = (
  inventory: string,
  capture?: CaptureSize
) => {
  const screen = integratedDisplay(inventory, capture)?.screen;
  const orientation = /UI Orientation: (?<value>[^\r\n]+)/u
    .exec(screen ?? "")
    ?.groups?.value?.trim();
  switch (orientation) {
    case "Portrait": {
      return "portrait" as const;
    }
    case "Portrait Upside Down": {
      return "portrait-upside-down" as const;
    }
    case "Landscape Left": {
      return "landscape-left" as const;
    }
    case "Landscape Right": {
      return "landscape-right" as const;
    }
    default: {
      return null;
    }
  }
};

export interface IosStreamHost {
  readonly command: typeof iosCommand;
  readonly helper: typeof verifyIosFramebufferRelease;
  readonly spawn: (
    helper: string,
    args: readonly string[]
  ) => ChildProcessWithoutNullStreams;
}
const iosStreamHost: IosStreamHost = {
  command: iosCommand,
  helper: verifyIosFramebufferRelease,
  spawn: spawnPiped,
};

export const acquireIosStream = (
  sessionId: string,
  device: () => IosDevice | null,
  scope: Scope.Scope,
  /** Names the helper's recorded failure when it exited on its own. */
  onFault: (
    code: "capture_incomplete",
    failureReference?: string
  ) => Effect.Effect<void>,
  captureSize?: () => CaptureSize | undefined,
  host: IosStreamHost = iosStreamHost
) =>
  Effect.gen(function* acquireIosMirror() {
    // Node callbacks log through this fiber's loggers, not the defaults.
    const logWith = Effect.runSyncWith(yield* Effect.context<never>());
    const lock = Semaphore.makeUnsafe(1);
    const integrity = makeIosStreamIntegrity();
    const registry = AtomRegistry.make();
    const transport = Atom.make<
      "connecting" | "live" | "lost" | "closed" | "restarting"
    >("connecting").pipe(Atom.keepAlive);
    registry.get(transport);
    const displayBinding = Atom.make<string | null>(null).pipe(Atom.keepAlive);
    registry.get(displayBinding);
    const orientationBinding = Atom.make<
      ReturnType<typeof iosDisplayOrientation>
    >(null).pipe(Atom.keepAlive);
    registry.get(orientationBinding);
    const boundDevice = Atom.make<IosDevice | null>(null).pipe(Atom.keepAlive);
    registry.get(boundDevice);
    const captureBinding = Atom.make<CaptureSize | null>(null).pipe(
      Atom.keepAlive
    );
    registry.get(captureBinding);
    const currentCaptureSize = () => {
      const current = captureSize?.();
      if (current) {
        registry.set(captureBinding, current);
      }
      // A foreground refusal clears the observation, not the established panel binding.
      return current ?? registry.get(captureBinding) ?? undefined;
    };
    const secret = randomBytes(32).toString("base64url");

    let ready = yield* Deferred.make<
      boolean,
      ReturnType<typeof iosRuntimeError>
    >();
    // The helper prints `ready` once CoreSimulator has resolved the device and
    // display. A cold Mac can take minutes to get there, so startup has its own
    // deadline, separate from the wait for the first frame.
    let launched = yield* Deferred.make<
      boolean,
      ReturnType<typeof iosRuntimeError>
    >();
    const viewers = new Set<(bytes: Uint8Array | null) => void>();
    let worker: SupervisedChild<ChildProcessWithoutNullStreams> | undefined;
    let revoked = false;
    let closing = false;
    let generation = "";
    let requestedDisplay: string | null = null;
    let silence: ReturnType<typeof setTimeout> | undefined;
    const publish = (
      value:
        | { readonly _tag: "state"; readonly state: "transport_lost" }
        | {
            readonly _tag: "jpeg";
            readonly data: string;
            readonly height: number;
            readonly width: number;
            readonly timestamp: number;
          }
    ) => {
      const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
      for (const receive of viewers) {
        receive(bytes);
      }
    };
    const failed = (
      code = "capture_incomplete" as const,
      reason: IosStreamGap = "helper-exited",
      failure?: ChildProcessFailure
    ) => {
      if (revoked || ["lost", "restarting"].includes(registry.get(transport))) {
        return;
      }
      const failureReference =
        failure === undefined
          ? undefined
          : logWith(
              recordFailure(Cause.fail(failure), "ios_framebuffer_failed")
            );
      registry.set(transport, "lost");
      logWith(
        Effect.logWarning("iOS framebuffer transport lost", {
          reason,
          sessionId,
        })
      );
      Effect.runFork(
        onFault(code, failureReference).pipe(Effect.forkIn(scope))
      );
      clearTimeout(silence);
      Deferred.doneUnsafe(
        launched,
        Effect.fail(iosRuntimeError("capture_incomplete"))
      );
      Deferred.doneUnsafe(
        ready,
        Effect.fail(iosRuntimeError("capture_incomplete"))
      );
      Effect.runSync(integrity.fail(reason));
      publish({ _tag: "state", state: "transport_lost" });
      for (const receive of viewers) {
        receive(null);
      }
      viewers.clear();
    };
    const releaseLocked = lock.withPermits(1)(
      Effect.gen(function* releaseIosMirror() {
        if (revoked) {
          return;
        }
        revoked = true;
        registry.set(transport, "closed");
        clearTimeout(silence);
        yield* integrity.stop();
        for (const receive of viewers) {
          receive(null);
        }
        viewers.clear();
        if (worker) {
          const owned = worker;
          owned.process.stdin.end("stop\n");
          yield* owned.stop();
        }
      })
    );
    const close = Effect.suspend(() => {
      // A pending start holds the lock while it waits for the helper, so
      // cancel its waits before queueing for the lock to stop the worker.
      closing = true;
      Deferred.doneUnsafe(
        launched,
        Effect.fail(iosRuntimeError("runtime_closed"))
      );
      Deferred.doneUnsafe(
        ready,
        Effect.fail(iosRuntimeError("runtime_closed"))
      );
      return releaseLocked;
    });
    yield* Scope.addFinalizer(scope, close);
    const start = () =>
      lock.withPermits(1)(
        Effect.gen(function* startIosMirror() {
          if (revoked || closing) {
            return yield* Effect.fail(iosRuntimeError("runtime_closed"));
          }
          if (["lost", "restarting"].includes(registry.get(transport))) {
            return yield* Effect.fail(iosRuntimeError("capture_incomplete"));
          }
          if (!worker) {
            const selected = registry.get(boundDevice) ?? device();
            if (!selected) {
              return yield* Effect.fail(
                iosRuntimeError("preparation_required")
              );
            }
            registry.set(boundDevice, structuredClone(selected));
            const helper = yield* host.helper();
            const inventory = yield* host
              .command("xcrun", ["simctl", "io", selected.udid, "enumerate"])
              .pipe(
                Effect.mapError(() => iosRuntimeError("capture_incomplete"))
              );
            const display = activeIosDisplay(inventory, currentCaptureSize());
            const orientation = iosDisplayOrientation(
              inventory,
              captureSize?.()
            );
            if (!display || !orientation) {
              return yield* Effect.fail(iosRuntimeError("capture_incomplete"));
            }
            registry.set(orientationBinding, orientation);
            const developer = yield* host
              .command("xcode-select", ["-p"])
              .pipe(Effect.mapError(() => iosRuntimeError("runtime_failed")));
            registry.set(displayBinding, display);
            requestedDisplay = null;
            generation = randomUUID();
            yield* integrity.generation(generation);
            // Close may have run during the awaits above. From here to
            // `launched = announced` nothing yields, so a later close sees
            // this helper's deferred.
            if (closing) {
              return yield* Effect.fail(iosRuntimeError("runtime_closed"));
            }
            const announced = Deferred.makeUnsafe<
              boolean,
              ReturnType<typeof iosRuntimeError>
            >();
            launched = announced;
            // Set as the helper exits, before its `close` reaches this module.
            let exitFailure: ChildProcessFailure | undefined;
            const framebuffer = yield* superviseChild(
              "ios-framebuffer",
              () =>
                host.spawn(helper, [
                  developer,
                  selected.udid,
                  display,
                  orientation,
                ]),
              {
                onExit: (_exit, failure) =>
                  Effect.sync(() => {
                    exitFailure = Option.getOrUndefined(failure);
                  }),
              }
            ).pipe(
              Scope.provide(scope),
              Effect.catchTag("ChildProcessFailure", (failure) =>
                recordFailure(
                  Cause.fail(failure),
                  "ios_framebuffer_failed"
                ).pipe(
                  Effect.flatMap((failureReference) =>
                    Effect.fail({
                      ...iosRuntimeError("capture_incomplete"),
                      failureReference,
                    })
                  )
                )
              )
            );
            const child = framebuffer.process;
            worker = framebuffer;
            const childFailed = (
              reason: IosStreamGap = "helper-exited",
              failure?: ChildProcessFailure
            ) => {
              if (worker === framebuffer) {
                failed("capture_incomplete", reason, failure);
              }
            };
            let helperFailure: string | undefined;
            let diagnostics = "";
            child.stderr.setEncoding("utf-8");
            child.stderr.on("data", (chunk: string) => {
              // A pipe can split a line across chunks; keep the partial tail.
              const lines = (diagnostics + chunk).split("\n");
              // The shipped helper's lines are short; drop an unbounded tail.
              diagnostics = (lines.pop() ?? "").slice(-1024);
              if (lines.includes("ready")) {
                Deferred.doneUnsafe(announced, Effect.succeed(true));
              }
              // The shipped helper emits fixed diagnostics, never capture data.
              // Retain only a known message, never arbitrary subprocess stderr.
              for (const message of [
                "Selected display lost its framebuffer",
                "JPEG encoding failed",
                "Framebuffer capture failed",
                "Active integrated display unavailable",
                "Active integrated display rebind failed",
              ]) {
                if (lines.includes(message)) {
                  helperFailure = message;
                }
              }
            });
            child.stdin.on("error", () => childFailed());
            child.once("error", () => childFailed());
            child.once("close", (exitCode, signal) => {
              if (worker === framebuffer) {
                logWith(
                  Effect.logWarning("iOS framebuffer helper closed", {
                    exitCode,
                    // A known helper sentence, as a code the log can keep.
                    helperFailure: helperFailure
                      ?.toLowerCase()
                      .replaceAll(" ", "_"),
                    sessionId,
                    signal,
                  })
                );
              }
              childFailed("helper-exited", exitFailure);
            });
            let pending = "";
            const decode = Schema.decodeUnknownOption(
              Schema.fromJsonString(IosFramebufferPacket)
            );
            child.stdout.setEncoding("utf-8");
            child.stdout.on("data", (chunk: string) => {
              if (
                worker !== framebuffer ||
                revoked ||
                ["lost", "restarting"].includes(registry.get(transport))
              ) {
                return;
              }
              pending += chunk;
              if (pending.length > 4 * 1024 * 1024) {
                childFailed();
                framebuffer.kill("SIGTERM");
                return;
              }
              let newline = pending.indexOf("\n");
              while (newline !== -1) {
                const packet = decode(pending.slice(0, newline));
                pending = pending.slice(newline + 1);
                if (packet._tag === "None") {
                  childFailed("invalid-packet");
                  framebuffer.kill("SIGTERM");
                  return;
                }
                if (packet.value.displayPort !== registry.get(displayBinding)) {
                  if (packet.value.displayPort !== requestedDisplay) {
                    childFailed("display-mismatch");
                    framebuffer.kill("SIGTERM");
                    return;
                  }
                  registry.set(displayBinding, requestedDisplay);
                  requestedDisplay = null;
                }
                if (
                  !Effect.runSync(integrity.accept(generation, packet.value))
                ) {
                  childFailed(integrity.failure() ?? "invalid-packet");
                  framebuffer.kill("SIGTERM");
                  return;
                }
                // A frame proves startup even if stderr's `ready` is still in flight.
                Deferred.doneUnsafe(announced, Effect.succeed(true));
                clearTimeout(silence);
                silence = setTimeout(() => {
                  childFailed("stream-silence");
                  framebuffer.kill("SIGTERM");
                }, 10_000);
                silence.unref();
                if (requestedDisplay !== null) {
                  newline = pending.indexOf("\n");
                  continue;
                }
                publish({
                  _tag: "jpeg",
                  data: packet.value.jpeg,
                  height: packet.value.height,
                  timestamp: packet.value.sampledMs,
                  width: packet.value.width,
                });
                registry.set(transport, "live");
                Deferred.doneUnsafe(ready, Effect.succeed(true));
                newline = pending.indexOf("\n");
              }
            });
            child.stdin.write("start\n");
            yield* Effect.whileLoop({
              body: () =>
                Effect.gen(function* checkBoundDisplay() {
                  yield* Effect.sleep("1 second");
                  if (
                    worker !== framebuffer ||
                    revoked ||
                    registry.get(transport) !== "live"
                  ) {
                    return;
                  }
                  const current = yield* Effect.result(
                    host.command("xcrun", [
                      "simctl",
                      "io",
                      selected.udid,
                      "enumerate",
                    ])
                  );
                  // Enumeration can finish after recovery has retired this helper.
                  if (
                    worker !== framebuffer ||
                    revoked ||
                    registry.get(transport) !== "live"
                  ) {
                    return;
                  }
                  const active =
                    current._tag === "Success"
                      ? activeIosDisplay(current.success, currentCaptureSize())
                      : null;
                  const currentOrientation =
                    current._tag === "Success"
                      ? iosDisplayOrientation(
                          current.success,
                          currentCaptureSize()
                        )
                      : null;
                  if (!active || !currentOrientation) {
                    childFailed("display-unavailable");
                    framebuffer.kill("SIGTERM");
                  } else if (active !== registry.get(displayBinding)) {
                    requestedDisplay = active;
                    ready = Deferred.makeUnsafe<
                      boolean,
                      ReturnType<typeof iosRuntimeError>
                    >();
                    registry.set(transport, "connecting");
                    child.stdin.write(`display ${active}\n`);
                  }
                  if (
                    currentOrientation &&
                    currentOrientation !== registry.get(orientationBinding)
                  ) {
                    registry.set(orientationBinding, currentOrientation);
                    child.stdin.write(`orientation ${currentOrientation}\n`);
                  }
                }),
              step: () => {
                // No accumulator: each iteration observes the session atoms.
              },
              while: () => worker === framebuffer && !revoked,
            }).pipe(Effect.forkIn(scope));
          }
          // A hang guard for a helper stuck in startup, not a tuned estimate:
          // cold hosted runners have taken over two minutes to print `ready`.
          yield* Deferred.await(launched).pipe(
            Effect.timeoutOrElse({
              duration: "5 minutes",
              orElse: () => Effect.fail(iosRuntimeError("capture_incomplete")),
            })
          );
          // The first frame follows `ready` quickly once the helper is up.
          yield* Effect.whileLoop({
            body: () => Deferred.await(ready),
            step: () => {
              // Completion is observed through the transport atom.
            },
            while: () => registry.get(transport) === "connecting",
          }).pipe(
            Effect.timeoutOrElse({
              duration: "30 seconds",
              orElse: () => Effect.fail(iosRuntimeError("capture_incomplete")),
            })
          );
          const selected = registry.get(boundDevice);
          if (!selected || registry.get(transport) !== "live") {
            return yield* Effect.fail(iosRuntimeError("capture_incomplete"));
          }
          const inventory = yield* host
            .command("xcrun", ["simctl", "io", selected.udid, "enumerate"])
            .pipe(Effect.mapError(() => iosRuntimeError("capture_incomplete")));
          const active = activeIosDisplay(inventory, currentCaptureSize());
          if (active !== registry.get(displayBinding)) {
            if (active === null) {
              failed("capture_incomplete");
              worker?.kill("SIGTERM");
            }
            return yield* Effect.fail(iosRuntimeError("capture_incomplete"));
          }
        })
      );
    return {
      access: {
        path: `/ios/stream/${encodeURIComponent(sessionId)}`,
        token: secret,
      },
      authorized: (token?: string) =>
        !revoked &&
        token !== undefined &&
        Buffer.byteLength(token) === Buffer.byteLength(secret) &&
        timingSafeEqual(Buffer.from(token), Buffer.from(secret)),
      begin: () =>
        start().pipe(
          Effect.andThen(
            Effect.suspend(() =>
              integrity.start(Number(process.hrtime.bigint()) / 1_000_000)
            )
          )
        ),
      close: () => close,
      end: integrity.stop,
      frames: Stream.callback<Uint8Array>(
        (queue) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              const receive = (bytes: Uint8Array | null) => {
                if (bytes === null) {
                  Queue.endUnsafe(queue);
                  viewers.delete(receive);
                } else if (!Queue.offerUnsafe(queue, bytes)) {
                  Queue.endUnsafe(queue);
                  viewers.delete(receive);
                  failed("capture_incomplete", "slow-consumer");
                  worker?.kill("SIGTERM");
                }
              };
              viewers.add(receive);
              return receive;
            }),
            (receive) =>
              Effect.sync(() => {
                viewers.delete(receive);
              })
          ).pipe(
            Effect.andThen(start()),
            Effect.catchCause(() =>
              Effect.sync(() => {
                Queue.endUnsafe(queue);
              })
            )
          ),
        { bufferSize: 8, strategy: "dropping" }
      ),
      integrity: integrity.snapshot,
      recover: () =>
        lock
          .withPermits(1)(
            Effect.gen(function* reconnectIosMirror() {
              registry.set(transport, "restarting");
              if (worker) {
                const owned = worker;
                yield* owned.stop();
                worker = undefined;
              }
              ready = Deferred.makeUnsafe<
                boolean,
                ReturnType<typeof iosRuntimeError>
              >();
              registry.set(transport, "connecting");
            })
          )
          .pipe(Effect.andThen(start())),
      start,
    };
  });
export type IosDeviceStream = Effect.Success<
  ReturnType<typeof acquireIosStream>
>;
