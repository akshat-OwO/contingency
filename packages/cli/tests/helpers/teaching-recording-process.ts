import {
  AgentSessionId,
  FlowSkillName,
  OperationId,
  TeachingRecordingId,
  UserAgentProfileId,
} from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Layer, Schedule } from "effect";

import {
  makeTeachingRecordingStoreLayer,
  TeachingRecordingStore,
} from "../../src/services/teaching-recording-store.ts";

const [mode, root, operation, peerArgument] = process.argv.slice(2);
/** Concurrent claimers keep their outcome until every peer has attempted. */
const peers = Number(peerArgument ?? "1");
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
    yield* store.begin({
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
    yield* fileSystem.readDirectory(root).pipe(
      Effect.flatMap((entries) =>
        entries.filter((entry) => entry.startsWith(".claim-attempt-")).length >=
        peers
          ? Effect.void
          : Effect.fail("waiting" as const)
      ),
      Effect.retry(Schedule.spaced("25 millis")),
      Effect.timeout("10 seconds"),
      Effect.orDie
    );
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
