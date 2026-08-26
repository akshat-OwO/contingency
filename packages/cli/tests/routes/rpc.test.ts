import {
  BrowserTabId,
  ContingencyRpcs,
  makeBrowserRpcError,
  SessionId,
  STORAGE_LOCKED_MESSAGE,
} from "@contingency/protocol";
import type { RecordingSnapshot } from "@contingency/protocol";
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { RpcTest } from "effect/unstable/rpc";

import {
  browserControlIsLocked,
  browserInputIsReadOnly,
  RpcHandlersLive,
  storageMutationIsLocked,
} from "../../src/routes/rpc.ts";
import { CreateBrowserLive } from "../../src/services/create-browser.ts";
import { RecordingLive } from "../../src/services/recorder.ts";
import { Recording } from "../../src/services/recording.ts";
import type { RecordingService } from "../../src/services/recording.ts";

const sessionId = SessionId.make("create-authoring");
const otherSessionId = SessionId.make("create-other");
const tabId = BrowserTabId.make("page-1");

it("keeps Storage mutation locked to the unfinished Recording's session", () => {
  for (const phase of ["active", "paused", "incomplete"] as const) {
    expect(storageMutationIsLocked({ phase, sessionId }, sessionId)).toBe(true);
    expect(storageMutationIsLocked({ phase, sessionId }, otherSessionId)).toBe(
      false
    );
  }
  expect(
    storageMutationIsLocked({ phase: "finished", sessionId }, sessionId)
  ).toBe(false);
  expect(storageMutationIsLocked(null, sessionId)).toBe(false);
  expect(STORAGE_LOCKED_MESSAGE).toBe(
    "Storage is locked while the Recording is in progress."
  );
});

it("keeps Emulation locked to the unfinished Recording's session", () => {
  // An incomplete Recording keeps its captured Steps, and recover() resumes
  // onto them, so the Emulation those Steps were captured under stays put.
  for (const phase of ["active", "paused", "incomplete"] as const) {
    expect(browserControlIsLocked({ phase, sessionId }, sessionId)).toBe(true);
    expect(browserControlIsLocked({ phase, sessionId }, otherSessionId)).toBe(
      false
    );
  }
  expect(
    browserControlIsLocked({ phase: "finished", sessionId }, sessionId)
  ).toBe(false);
  expect(browserControlIsLocked(null, sessionId)).toBe(false);
});

it("keeps the canvas read-only for paused or incomplete capture", () => {
  expect(
    browserInputIsReadOnly(
      { captureMode: "ordinary", phase: "paused", sessionId },
      sessionId
    )
  ).toBe(true);
  expect(
    browserInputIsReadOnly(
      { captureMode: "conditionPicker", phase: "paused", sessionId },
      sessionId
    )
  ).toBe(false);
  expect(
    browserInputIsReadOnly(
      { captureMode: "ordinary", phase: "incomplete", sessionId },
      sessionId
    )
  ).toBe(true);
});

const activeRecording: RecordingSnapshot = {
  captureMode: "ordinary",
  flow: {
    steps: [{ type: "navigate", url: "https://example.com/" }],
    title: "Authoring",
  },
  initialUrl: "https://example.com/",
  phase: "active",
  recordedSteps: [
    {
      id: "initial",
      preSteps: [],
      step: { type: "navigate", url: "https://example.com/" },
    },
  ],
  revision: 1,
  sessionId,
  tabId,
  undoAvailable: false,
};

/**
 * A Recording that is merely *there*. These tests are about what the RPC layer
 * refuses while one is in progress, so every authoring operation is out of
 * scope and answers as such rather than pretending to work.
 */
const outOfScope = Effect.fail(
  makeBrowserRpcError("recording_unavailable", "Not under test.")
);
const recordingService: RecordingService = {
  addAudit: () => outOfScope,
  armHover: () => outOfScope,
  armPreStep: () => outOfScope,
  armPreStepCondition: () => outOfScope,
  bindVariable: () => outOfScope,
  cancelCaptureMode: () => outOfScope,
  changes: () => Stream.never,
  deleteStep: () => outOfScope,
  discard: () => outOfScope,
  fail: () => Effect.void,
  finish: () => outOfScope,
  get: () => Effect.succeed(activeRecording),
  pause: () => outOfScope,
  recover: () => outOfScope,
  renameVariable: () => outOfScope,
  resume: () => outOfScope,
  setPreStepConditionUrl: () => outOfScope,
  start: () => outOfScope,
  undoDelete: () => outOfScope,
  updateTitle: () => outOfScope,
};

it("keeps the Recording update stream connected", async () => {
  const fiber = Effect.runFork(
    Effect.gen(function* keepRecordingStreamConnected() {
      const client = yield* RpcTest.makeClient(ContingencyRpcs, {
        flatten: true,
      });
      yield* client("recording.stream.subscribe", {
        data: {},
        type: "recording.stream.subscribe",
      }).pipe(Stream.runForEach(() => Effect.void));
    }).pipe(
      Effect.scoped,
      Effect.provide(
        RpcHandlersLive.pipe(
          Layer.provide(
            RecordingLive.pipe(Layer.provideMerge(CreateBrowserLive))
          )
        )
      )
    )
  );

  await Effect.runPromise(Effect.sleep("25 millis"));
  expect(fiber.pollUnsafe()).toBeUndefined();
  fiber.interruptUnsafe();
});

it.effect("rejects a Storage mutation before it reaches Playwright", () =>
  Effect.gen(function* rejectLockedStorageMutation() {
    const client = yield* RpcTest.makeClient(ContingencyRpcs, {
      flatten: true,
    });
    const error = yield* Effect.flip(
      client("browser.storage.set", {
        data: {
          key: "draft",
          kind: "local",
          sessionId,
          tabId,
          value: "changed",
        },
        type: "browser.storage.set",
      })
    );
    expect(error.code).toBe("recording_conflict");
    expect(error.message).toBe(STORAGE_LOCKED_MESSAGE);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      RpcHandlersLive.pipe(
        Layer.provide(CreateBrowserLive),
        Layer.provide(Layer.succeed(Recording, recordingService))
      )
    )
  )
);
