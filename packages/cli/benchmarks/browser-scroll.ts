import path from "node:path";

import { OperationId } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import {
  Context,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Stream,
} from "effect";

import { makeBrowserInputQueue } from "../../../apps/web/src/components/browser/browser-input-queue.ts";
import { AgentSession } from "../src/services/agent-session.ts";
import {
  agentProcessLayer,
  startUserTeaching,
} from "../tests/integration/agent-harness.ts";
import { fixtureServer } from "../tests/integration/harness.ts";

const main = Effect.gen(function* benchmarkWheelInput() {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({
    prefix: "scroll-benchmark-",
  });
  const fixtures = yield* fixtureServer;
  const services = yield* Layer.build(agentProcessLayer(root));
  const agent = Context.get(services, AgentSession);
  const width = Number(process.env["SCROLL_BENCHMARK_WIDTH"] ?? "1024");
  const height = Number(process.env["SCROLL_BENCHMARK_HEIGHT"] ?? "720");
  if (
    ![width, height].every(
      (value) => Number.isInteger(value) && value >= 240 && value <= 4096
    )
  ) {
    return yield* Effect.fail(
      new Error(
        "Scroll benchmark dimensions must be integers between 240 and 4096."
      )
    );
  }
  const url =
    process.env["SCROLL_BENCHMARK_URL"] ??
    fixtures.url("streaming-benchmark.html");
  const rows = [];
  for (const pattern of ["down", "down-up"]) {
    for (const recording of [false, true]) {
      const session = yield* startUserTeaching({
        activity: "teaching",
        clientName: "scroll-benchmark",
        clientVersion: "1",
        name: "scroll-benchmark",
        operationId: OperationId.make(`scroll-start-${pattern}-${recording}`),
        url,
        viewport: { deviceScaleFactor: 1, height, width },
      }).pipe(Effect.provideContext(services));
      if (recording) {
        yield* agent.startTeachingRecording(
          session.id,
          OperationId.make(`scroll-record-${pattern}`)
        );
      }
      let started = 0;
      let firstMovementMs: number | undefined;
      let finalMovementMs: number | undefined;
      let previousOffset = 0;
      let received = 0;
      let completedDelta = 0;
      let completedDistance = 0;
      let dispatchedEvents = 0;
      let failure: unknown;
      let previousFrameAt: number | undefined;
      const frameGaps: number[] = [];
      const requestMs: number[] = [];
      const streamReady = yield* Deferred.make<true>();
      const drained = yield* Deferred.make<true>();
      const stream = yield* agent.browserStream(session.id).pipe(
        Stream.runForEach((frame) =>
          Effect.sync(() => {
            if (frame.type !== "frame") {
              return;
            }
            Deferred.doneUnsafe(streamReady, Effect.succeed(true));
            if (
              started === 0 ||
              frame.metadata.scrollOffsetY === previousOffset
            ) {
              return;
            }
            previousOffset = frame.metadata.scrollOffsetY;
            const frameAt = performance.now();
            if (previousFrameAt !== undefined) {
              frameGaps.push(frameAt - previousFrameAt);
            }
            previousFrameAt = frameAt;
            received += 1;
            firstMovementMs ??= performance.now() - started;
            if (
              (pattern === "down" && previousOffset >= 1439) ||
              (pattern === "down-up" &&
                completedDistance > 720 &&
                previousOffset <= 1)
            ) {
              finalMovementMs ??= performance.now() - started;
            }
          })
        ),
        Effect.forkChild
      );
      yield* Deferred.await(streamReady).pipe(Effect.timeout("10 seconds"));
      const settleDrain = () => {
        if (completedDistance >= 1440 || failure !== undefined) {
          Deferred.doneUnsafe(drained, Effect.succeed(true));
        }
      };
      const enqueue = makeBrowserInputQueue((id: typeof session.id, inputs) =>
        Effect.gen(function* dispatchBatch() {
          for (const input of inputs) {
            const at = performance.now();
            const result = yield* Effect.result(agent.sendInput(id, input));
            if (result._tag === "Failure") {
              ({ failure } = result);
              settleDrain();
              return;
            }
            requestMs.push(performance.now() - at);
            completedDelta +=
              input.type === "input_mouse" ? (input.deltaY ?? 0) : 0;
            completedDistance +=
              input.type === "input_mouse" ? Math.abs(input.deltaY ?? 0) : 0;
            dispatchedEvents += 1;
            settleDrain();
          }
        })
      );
      started = performance.now();
      for (let index = 0; index < 120; index += 1) {
        enqueue(session.id, {
          deltaX: 0,
          deltaY: pattern === "down-up" && index >= 60 ? -12 : 12,
          eventType: "mouseWheel",
          type: "input_mouse",
          x: 512,
          y: 360,
        });
        yield* Effect.sleep("8 millis");
      }
      const gestureMs = performance.now() - started;
      yield* Deferred.await(drained).pipe(Effect.timeout("15 seconds"));
      const drainedMs = performance.now() - started;
      yield* Effect.sleep("250 millis");
      yield* Fiber.interrupt(stream);
      const row = {
        changingFrames: received,
        changingFramesPerSecond:
          received / ((finalMovementMs ?? drainedMs) / 1000),
        completedDelta,
        dispatchMaxMs: Math.max(0, ...requestMs),
        dispatchP95Ms: requestMs.toSorted((a, b) => a - b)[
          Math.ceil(requestMs.length * 0.95) - 1
        ],
        dispatchedEvents,
        drainedMs,
        failure: failure === undefined ? undefined : String(failure),
        finalMovementMs,
        firstMovementMs,
        frameGapMaxMs: Math.max(0, ...frameGaps),
        frameGapP95Ms: frameGaps.toSorted((a, b) => a - b)[
          Math.ceil(frameGaps.length * 0.95) - 1
        ],
        gestureMs,
        height,
        inputEvents: 120,
        movementTailMs:
          finalMovementMs === undefined
            ? undefined
            : Math.max(0, finalMovementMs - gestureMs),
        pattern,
        recording,
        tailMs: Math.max(0, drainedMs - gestureMs),
        width,
      };
      rows.push(row);
      process.stdout.write(`${JSON.stringify(row)}\n`);
      if (recording) {
        yield* agent.stopTeachingRecording(
          session.id,
          OperationId.make(`scroll-stop-${pattern}`)
        );
      }
      yield* agent.close(
        session.id,
        OperationId.make(`scroll-close-${pattern}-${recording}`)
      );
    }
  }
  const directory = path.resolve(
    ".cursor/skills/verify-contingency/artifacts/streaming-scroll"
  );
  yield* fs.makeDirectory(directory, { recursive: true });
  yield* fs.writeFileString(
    path.join(
      directory,
      `${process.env["SCROLL_BENCHMARK_LABEL"] ?? "candidate"}.json`
    ),
    JSON.stringify(
      {
        notes: [
          "Real Workspace input queue and Agent Session Teaching input path, no RPC network or viewer decode. Frame movement ends at service stream receipt, not screen presentation.",
        ],
        rows,
      },
      null,
      2
    )
  );
  if (
    process.argv.includes("--check") &&
    rows.some(
      (row) =>
        row.failure !== undefined ||
        row.finalMovementMs === undefined ||
        row.tailMs > 150 ||
        (row.movementTailMs ?? Infinity) > 150
    )
  ) {
    return yield* Effect.die(
      "Scrolling did not catch up within the 150 ms input-drain budget."
    );
  }
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

await Effect.runPromise(main);
