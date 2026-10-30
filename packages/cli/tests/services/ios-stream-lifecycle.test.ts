import { ChildProcess } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough } from "node:stream";

import { expect, it } from "@effect/vitest";
import { Effect, Deferred } from "effect";
import { TestClock } from "effect/testing";

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
  constructor() {
    super();
    this.stdin.on("data", (bytes: Buffer) => {
      if (bytes.toString().includes("start\n")) {
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
    });
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
