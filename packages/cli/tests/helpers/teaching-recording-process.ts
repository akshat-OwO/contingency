import {
  AgentSessionId,
  FlowSkillName,
  OperationId,
  TeachingRecordingId,
  UserAgentProfileId,
} from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Layer } from "effect";

import {
  makeTeachingRecordingStoreLayer,
  TeachingRecordingStore,
} from "../../src/services/teaching-recording-store.ts";

const [mode, root, operation, barrier] = process.argv.slice(2);
if (
  (mode !== "write" && mode !== "read" && mode !== "claim") ||
  root === undefined
) {
  throw new Error("Expected write|read|claim and a Catalog Root.");
}

const recordingId = TeachingRecordingId.make("recording-process-restart");
const at = "2026-09-13T10:00:00.000Z";
const layer = makeTeachingRecordingStoreLayer({
  now: () => new Date(at),
  root: () => root,
}).pipe(Layer.provideMerge(NodeServices.layer));

const program = Effect.gen(function* runProcessCheck() {
  const store = yield* TeachingRecordingStore;
  if (mode === "write") {
    const begun = yield* store.begin({
      emulation: {
        permissions: [],
        userAgentProfile: UserAgentProfileId.make("default"),
        viewport: { deviceScaleFactor: 1, height: 720, width: 1280 },
      },
      flowSkillName: FlowSkillName.make("checkout-flow"),
      operationId: OperationId.make("process-begin"),
      recordingId,
      sessionId: AgentSessionId.make("agent-process-restart"),
    });
    yield* store.start({
      emulation: begun.emulation,
      operationId: OperationId.make("process-start"),
      recordingId,
    });
    yield* store.stop({
      artifacts: [],
      operationId: OperationId.make("process-stop"),
      recordingId,
    });
  }
  if (mode === "claim") {
    const result = yield* Effect.result(
      store.startLearning({
        operationId: OperationId.make(operation ?? "process-claim"),
        recordingId,
      })
    );
    // A winner that exits before a slow peer attempts leaves a stale claim
    // the peer may lawfully reclaim, so hold until every peer has attempted.
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.writeFileString(
      `${root}/.claim-attempt-${operation ?? "process-claim"}`,
      ""
    );
    if (barrier === "barrier") {
      process.stdout.write("attempted\n");
      yield* Effect.callback((resume) => {
        if (process.stdin.readableEnded || process.stdin.destroyed) {
          resume(Effect.void);
          return;
        }
        const released = () => resume(Effect.void);
        process.stdin.once("end", released);
        process.stdin.once("close", released);
        process.stdin.resume();
        return Effect.sync(() => {
          process.stdin.off("end", released);
          process.stdin.off("close", released);
        });
      }).pipe(Effect.timeout("10 seconds"), Effect.orDie);
    }
    if (result._tag === "Success") {
      process.stdout.write(
        `${JSON.stringify({ lifecycle: result.success.lifecycle._tag })}\n`
      );
    } else {
      process.stdout.write(
        `${JSON.stringify({ code: result.failure.code })}\n`
      );
    }
    return;
  }
  const manifest = yield* store.read(recordingId);
  process.stdout.write(
    `${JSON.stringify({
      lifecycle: manifest.lifecycle._tag,
      receipts: manifest.receipts.map((receipt) => receipt.operation),
    })}\n`
  );
});

await Effect.runPromise(program.pipe(Effect.provide(layer)));
