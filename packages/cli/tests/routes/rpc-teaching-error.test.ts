import {
  ContingencyRpcs,
  OperationId,
  TeachingRecordingId,
} from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Record } from "effect";
import { RpcTest } from "effect/rpc";
import { test } from "vitest";

import {
  RpcHandlersLive,
  teachingRecordingError,
} from "../../src/routes/rpc.ts";
import { makeTeachingRecordingStoreLayer } from "../../src/services/teaching-recording-store.ts";
import type { TeachingRecordingStoreError } from "../../src/services/teaching-recording-store.ts";

const errorCodes = {
  teaching_recording_conflict: "agent_teaching_conflict",
  teaching_recording_invalid: "agent_teaching_invalid",
  teaching_recording_io: "agent_teaching_unavailable",
  teaching_recording_not_found: "agent_teaching_not_found",
  teaching_recording_unclaimed: "agent_teaching_conflict",
} as const satisfies Record<TeachingRecordingStoreError["code"], string>;

test("preserves each Teaching store failure's meaning and message", () => {
  for (const [code, expected] of Record.toEntries(errorCodes)) {
    const message = `Teaching storage refused ${code}.`;
    expect(
      teachingRecordingError({
        _tag: "TeachingRecordingStoreError",
        code,
        message,
      })
    ).toEqual({
      _tag: "BrowserRpcError",
      code: expected,
      message,
    });
  }
});

it.effect("surfaces a real Teaching storage I/O failure through RPC", () =>
  Effect.gen(function* teachingIoFailure() {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    const root = `${directory}/not-a-directory`;
    yield* fs.writeFileString(root, "blocks the catalog path");
    const client = yield* RpcTest.makeClient(ContingencyRpcs, {
      flatten: true,
    }).pipe(
      Effect.provide(
        RpcHandlersLive.pipe(
          Layer.provide(makeTeachingRecordingStoreLayer({ root: () => root }))
        )
      )
    );
    const result = yield* client("agent.teaching.flow.verify", {
      operationId: OperationId.make("verify-io"),
      recordingId: TeachingRecordingId.make("recording-io"),
    }).pipe(Effect.result);
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "BrowserRpcError", code: "agent_teaching_unavailable" },
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
