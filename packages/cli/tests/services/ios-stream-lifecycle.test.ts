import { ChildProcess } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough } from "node:stream";

import { expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Fiber, Option } from "effect";
import { TestClock } from "effect/testing";

import {
  childOutputsOf,
  spawnPiped,
} from "../../src/services/child-process.ts";
import {
  FailureReferences,
  lookupFailure,
  makeFailureReferenceStore,
} from "../../src/services/failure-reference.ts";
import { acquireIosStream } from "../../src/services/ios-stream.ts";
import type { IosStreamHost } from "../../src/services/ios-stream.ts";

const port = "11111111-1111-1111-1111-111111111111";
const inventory = `Port:\n UUID: ${port}\n Port Identifier: com.apple.framebuffer.display\n Power state: On\n Display class: 0\n IOSurface port:\nScreen Type: Integrated\nUI Orientation: Portrait\n`;
const device = () => ({
  deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
  kind: "simulator" as const,
  name: "Fixture",
  runtime: "fixture",
  runtimeVersion: "26.5",
  udid: port,
});
class Helper extends ChildProcess {
  override readonly stdin = new PassThrough();
  override readonly stdout = new PassThrough();
  override readonly stderr = new PassThrough();
  override exitCode: number | null = null;
  override signalCode: NodeJS.Signals | null = null;
  override readonly stdio: ChildProcessWithoutNullStreams["stdio"] = [
    this.stdin,
    this.stdout,
    this.stderr,
    null,
    null,
  ];
  private announced: boolean;
  private started = false;
  /** Done once the stream has attached its listeners and sent `start`. */
  readonly startSent = Deferred.makeUnsafe<boolean>();
  private sent = false;
  /** The real helper prints `ready` on stderr before it reads `start`. */
  constructor(announced = true) {
    super();
    this.announced = announced;
    if (announced) {
      this.stderr.write("ready\n");
    }
    this.stdin.on("data", (bytes: Buffer) => {
      if (bytes.toString().includes("start\n")) {
        this.started = true;
        Deferred.doneUnsafe(this.startSent, Effect.succeed(true));
        this.flush();
      }
    });
  }
  /** Finish a slow startup, as CoreSimulator does on a cold Mac. */
  announce() {
    this.announced = true;
    this.stderr.write("ready\n");
    this.flush();
  }
  private flush() {
    if (!this.announced || !this.started || this.sent) {
      return;
    }
    this.sent = true;
    this.stdout.write(
      `${JSON.stringify({
        displayPort: port,
        encodedMs: 12,
        height: 1500,
        jpeg: "/9j/",
        presentedMs: 0,
        sampledMs: 10,
        sequence: 1,
        sourceSequence: 0,
        startMs: 1,
        width: 720,
      })}\n`
    );
  }
  override kill() {
    this.exitCode = 0;
    this.emit("close", 0);
    return true;
  }
}

it.effect("ignores a retired helper's late stdin error after recovery", () =>
  Effect.gen(function* retiredHelper() {
    const helpers: Helper[] = [];
    const host: IosStreamHost = {
      command: (file) =>
        Effect.succeed(file === "xcode-select" ? "/fixture" : inventory),
      helper: () => Effect.succeed("fixture-framebuffer"),
      spawn: () => {
        const helper = new Helper();
        helpers.push(helper);
        return helper;
      },
    };
    const scope = yield* Effect.scope;
    const stream = yield* acquireIosStream(
      "session",
      device,
      scope,
      () => Effect.void,
      undefined,
      host
    );
    yield* stream.start();
    yield* stream.recover();
    helpers[0]?.stdin.emit(
      "error",
      new Error("late EPIPE from retired helper")
    );
    expect((yield* Effect.result(stream.start()))._tag).toBe("Success");
    expect(helpers).toHaveLength(2);
    helpers[0]?.stdout.write("invalid retired packet\n");
    expect((yield* Effect.result(stream.start()))._tag).toBe("Success");
    helpers[1]?.stdin.emit("error", new Error("current helper failed"));
    expect((yield* Effect.result(stream.start()))._tag).toBe("Failure");
  }).pipe(Effect.scoped)
);

it.effect(
  "a helper that crashes names a Failure Reference, and a recovery does not",
  () =>
    Effect.gen(function* crashedHelper() {
      const helpers: Helper[] = [];
      const faults: (string | undefined)[] = [];
      const faulted = yield* Deferred.make<string | undefined>();
      const host: IosStreamHost = {
        command: (file) =>
          Effect.succeed(file === "xcode-select" ? "/fixture" : inventory),
        helper: () => Effect.succeed("fixture-framebuffer"),
        spawn: () => {
          const helper = new Helper();
          helpers.push(helper);
          return helper;
        },
      };
      const scope = yield* Effect.scope;
      const stream = yield* acquireIosStream(
        "session",
        device,
        scope,
        (_code, failureReference) =>
          Effect.sync(() => {
            faults.push(failureReference);
          }).pipe(Effect.andThen(Deferred.succeed(faulted, failureReference))),
        undefined,
        host
      );
      yield* stream.start();
      // Recovery stops its helper: an owner's stop, not a fault.
      yield* stream.recover();
      yield* stream.start();
      expect(faults).toEqual([]);
      const [, crashing] = helpers;
      if (crashing === undefined) {
        return expect.unreachable("the stream restarts its helper");
      }
      // A process's stderr reaches its reader before its close does.
      yield* Effect.callback<boolean>((resume) => {
        const onData = (chunk: Buffer) => {
          if (chunk.toString("utf-8").includes("private-detail")) {
            crashing.stderr.off("data", onData);
            resume(Effect.succeed(true));
          }
        };
        crashing.stderr.on("data", onData);
        crashing.stderr.write("Framebuffer capture failed private-detail\n");
      });
      crashing.exitCode = 1;
      crashing.emit("close", 1, null);
      const reference = yield* Deferred.await(faulted).pipe(
        Effect.timeout("30 seconds")
      );
      expect(faults).toHaveLength(1);
      expect(reference).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/u);
      const cause = yield* lookupFailure(reference ?? "");
      const [helper] = Option.match(cause, {
        onNone: () => [],
        onSome: childOutputsOf,
      });
      expect(helper?.child).toBe("ios-framebuffer");
      expect(helper?.output.stderr).toContain("private-detail");
    }).pipe(
      Effect.scoped,
      Effect.provideService(FailureReferences, makeFailureReferenceStore())
    )
);

/** Writes a line to a fake helper's stderr, and waits until it has flowed. */
const writeStderr = (helper: Helper, line: string) =>
  Effect.callback<boolean>((resume) => {
    const onData = (chunk: Buffer) => {
      if (chunk.toString("utf-8").includes(line)) {
        helper.stderr.off("data", onData);
        resume(Effect.succeed(true));
      }
    };
    helper.stderr.on("data", onData);
    helper.stderr.write(`${line}\n`);
  });

it.effect(
  "a start waiting on a helper that exits before ready fails with its reference",
  () =>
    Effect.gen(function* exitsBeforeReady() {
      const spawned = yield* Deferred.make<Helper>();
      const faulted = yield* Deferred.make<string | undefined>();
      const host: IosStreamHost = {
        command: (file) =>
          Effect.succeed(file === "xcode-select" ? "/fixture" : inventory),
        helper: () => Effect.succeed("fixture-framebuffer"),
        spawn: () => {
          const helper = new Helper(false);
          Deferred.doneUnsafe(spawned, Effect.succeed(helper));
          return helper;
        },
      };
      const scope = yield* Effect.scope;
      const stream = yield* acquireIosStream(
        "session",
        device,
        scope,
        (_code, failureReference) =>
          Deferred.succeed(faulted, failureReference).pipe(Effect.asVoid),
        undefined,
        host
      );
      const starting = yield* Effect.forkChild(Effect.flip(stream.start()));
      const helper = yield* Deferred.await(spawned);
      yield* Deferred.await(helper.startSent);
      yield* writeStderr(helper, "Active integrated display unavailable");
      helper.exitCode = 1;
      helper.emit("close", 1, null);
      const failure = yield* Fiber.join(starting).pipe(
        Effect.timeout("30 seconds")
      );
      const reference = yield* Deferred.await(faulted);
      expect(reference).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/u);
      expect(failure).toMatchObject({
        code: "capture_incomplete",
        failureReference: reference,
      });
    }).pipe(
      Effect.scoped,
      Effect.provideService(FailureReferences, makeFailureReferenceStore())
    )
);

it.effect(
  "a helper whose spawn fails after it returns names one reference",
  () =>
    Effect.gen(function* spawnFails() {
      const faults: (string | undefined)[] = [];
      const host: IosStreamHost = {
        command: (file) =>
          Effect.succeed(file === "xcode-select" ? "/fixture" : inventory),
        helper: () => Effect.succeed("/nonexistent/contingency-framebuffer"),
        // Node reports a missing file as an `error` after spawn returns.
        spawn: spawnPiped,
      };
      const scope = yield* Effect.scope;
      const stream = yield* acquireIosStream(
        "session",
        device,
        scope,
        (_code, failureReference) =>
          Effect.sync(() => {
            faults.push(failureReference);
          }),
        undefined,
        host
      );
      const failure = yield* Effect.flip(stream.start()).pipe(
        Effect.timeout("30 seconds")
      );
      expect(failure).toMatchObject({ code: "capture_incomplete" });
      const reference =
        "failureReference" in failure ? failure.failureReference : undefined;
      expect(reference).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/u);
      const cause = yield* lookupFailure(reference ?? "");
      const [helper] = Option.match(cause, {
        onNone: () => [],
        onSome: childOutputsOf,
      });
      expect(helper?.child).toBe("ios-framebuffer");
      expect(
        Option.match(cause, { onNone: () => "", onSome: Cause.pretty })
      ).toContain("The ios-framebuffer process could not start.");
    }).pipe(
      Effect.scoped,
      Effect.provideService(FailureReferences, makeFailureReferenceStore())
    )
);

it.effect(
  "ignores an old display enumeration that completes after recovery",
  () =>
    Effect.gen(function* staleEnumeration() {
      const started = yield* Deferred.make<boolean>();
      const released = yield* Deferred.make<string>();
      let hold = false;
      const host: IosStreamHost = {
        command: (file) => {
          if (file === "xcode-select") {
            return Effect.succeed("/fixture");
          }
          if (hold) {
            return Deferred.succeed(started, true).pipe(
              Effect.andThen(Deferred.await(released))
            );
          }
          return Effect.succeed(inventory);
        },
        helper: () => Effect.succeed("fixture-framebuffer"),
        spawn: () => new Helper(),
      };
      const scope = yield* Effect.scope;
      const stream = yield* acquireIosStream(
        "session",
        device,
        scope,
        () => Effect.void,
        undefined,
        host
      );
      yield* stream.start();
      hold = true;
      // it.effect supplies TestClock to the stream's periodic display monitor.
      yield* TestClock.adjust("1 second");
      yield* Deferred.await(started);
      hold = false;
      yield* stream.recover();
      yield* Deferred.succeed(released, "Disconnected old display");
      // Run the pending monitor continuation and the replacement's next virtual tick.
      yield* TestClock.adjust("1 second");
      expect((yield* Effect.result(stream.start()))._tag).toBe("Success");
    }).pipe(Effect.scoped)
);

const slowHost = (helpers: Helper[]): IosStreamHost => ({
  command: (file) =>
    Effect.succeed(file === "xcode-select" ? "/fixture" : inventory),
  helper: () => Effect.succeed("fixture-framebuffer"),
  spawn: () => {
    const helper = new Helper(false);
    helpers.push(helper);
    return helper;
  },
});

it.effect("waits past the first-frame deadline for a slow helper startup", () =>
  Effect.gen(function* slowStartup() {
    const helpers: Helper[] = [];
    const scope = yield* Effect.scope;
    const stream = yield* acquireIosStream(
      "session",
      device,
      scope,
      () => Effect.void,
      undefined,
      slowHost(helpers)
    );
    const starting = yield* Effect.forkChild(Effect.result(stream.start()));
    // it.effect supplies TestClock to the stream's startup and frame deadlines.
    yield* TestClock.adjust("2 minutes");
    expect(starting.pollUnsafe()).toBeUndefined();
    helpers[0]?.announce();
    expect((yield* Fiber.join(starting))._tag).toBe("Success");
  }).pipe(Effect.scoped)
);

it.effect("fails a helper that never finishes startup", () =>
  Effect.gen(function* stuckStartup() {
    const scope = yield* Effect.scope;
    const stream = yield* acquireIosStream(
      "session",
      device,
      scope,
      () => Effect.void,
      undefined,
      slowHost([])
    );
    const starting = yield* Effect.forkChild(Effect.result(stream.start()));
    // it.effect supplies TestClock to the stream's startup deadline.
    yield* TestClock.adjust("5 minutes");
    const result = yield* Fiber.join(starting);
    expect(result._tag).toBe("Failure");
  }).pipe(Effect.scoped)
);

it.effect("close cancels a pending startup without waiting out its guard", () =>
  Effect.gen(function* closeDuringStartup() {
    const helpers: Helper[] = [];
    const scope = yield* Effect.scope;
    const stream = yield* acquireIosStream(
      "session",
      device,
      scope,
      () => Effect.void,
      undefined,
      slowHost(helpers)
    );
    const starting = yield* Effect.forkChild(Effect.result(stream.start()));
    // it.effect supplies TestClock; this tick lets start spawn the helper.
    yield* TestClock.adjust("1 second");
    yield* stream.close();
    const result = yield* Fiber.join(starting);
    expect(result._tag === "Failure" && result.failure.code).toBe(
      "runtime_closed"
    );
    expect(helpers[0]?.exitCode).toBe(0);
  }).pipe(Effect.scoped)
);

it.effect("reads a ready line split across stderr chunks", () =>
  Effect.gen(function* splitReady() {
    const helpers: Helper[] = [];
    const scope = yield* Effect.scope;
    const stream = yield* acquireIosStream(
      "session",
      device,
      scope,
      () => Effect.void,
      undefined,
      slowHost(helpers)
    );
    const starting = yield* Effect.forkChild(Effect.result(stream.start()));
    // it.effect supplies TestClock; this tick lets start spawn the helper.
    yield* TestClock.adjust("1 second");
    // No frame follows, so only stderr can end startup.
    helpers[0]?.stderr.write("rea");
    helpers[0]?.stderr.write("dy\n");
    // Past the 30-second frame deadline, well inside the startup guard.
    yield* TestClock.adjust("1 minute");
    const result = starting.pollUnsafe();
    expect(result?._tag === "Success" && result.value._tag).toBe("Failure");
  }).pipe(Effect.scoped)
);

it.effect("close during startup preparation never spawns a helper", () =>
  Effect.gen(function* closeBeforeSpawn() {
    const helpers: Helper[] = [];
    const preparing = yield* Deferred.make<boolean>();
    const released = yield* Deferred.make<string>();
    const host: IosStreamHost = {
      ...slowHost(helpers),
      command: (file) =>
        file === "xcode-select"
          ? Deferred.succeed(preparing, true).pipe(
              Effect.andThen(Deferred.await(released))
            )
          : Effect.succeed(inventory),
    };
    const scope = yield* Effect.scope;
    const stream = yield* acquireIosStream(
      "session",
      device,
      scope,
      () => Effect.void,
      undefined,
      host
    );
    const starting = yield* Effect.forkChild(Effect.result(stream.start()));
    yield* Deferred.await(preparing);
    // Start close now, so it marks the stream closing before preparation ends.
    const closing = yield* Effect.forkChild(stream.close(), {
      startImmediately: true,
    });
    yield* Deferred.succeed(released, "/fixture");
    // it.effect supplies TestClock; one minute is far inside the startup guard.
    yield* TestClock.adjust("1 minute");
    const result = starting.pollUnsafe();
    expect(
      result?._tag === "Success" &&
        result.value._tag === "Failure" &&
        result.value.failure.code
    ).toBe("runtime_closed");
    expect(closing.pollUnsafe()?._tag).toBe("Success");
    expect(helpers).toHaveLength(0);
  }).pipe(Effect.scoped)
);
