import {
  BrowserTabId,
  BrowserStreamId,
  ContingencyRpcs,
  FrameSequence,
  AgentSessionId,
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
import { AgentSession } from "../../src/services/agent-session.ts";
import type { AgentSessionService } from "../../src/services/agent-session.ts";
import { CreateBrowser } from "../../src/services/create-browser-contract.ts";
import type { CreateBrowserService } from "../../src/services/create-browser-contract.ts";
import { CreateBrowserLive } from "../../src/services/create-browser.ts";
import { RecordingLive } from "../../src/services/recorder.ts";
import { Recording } from "../../src/services/recording.ts";
import type { RecordingService } from "../../src/services/recording.ts";
import { RunSession } from "../../src/services/run-session.ts";
import type { RunSessionService } from "../../src/services/run-session.ts";

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

/**
 * A Run session that would start if it were asked. These tests are about what
 * the RPC layer refuses before it asks, so a reached `start` is a failure of
 * the guard rather than of the Runner.
 */
let startsAsked = 0;
const runSessionService: RunSessionService = {
  answerVariable: () =>
    Effect.fail(makeBrowserRpcError("run_invalid", "Not under test.")),
  artifactPath: () =>
    Effect.fail(makeBrowserRpcError("run_invalid", "Not under test.")),
  changes: () => Stream.never,
  get: () => Effect.succeed(null),
  loadFlow: () =>
    Effect.fail(makeBrowserRpcError("run_invalid", "Not under test.")),
  start: () =>
    Effect.sync(() => {
      startsAsked += 1;
    }).pipe(
      Effect.andThen(
        Effect.fail(makeBrowserRpcError("run_invalid", "Not under test."))
      )
    ),
};
const RunSessionStub = Layer.succeed(RunSession, runSessionService);

const genericPrivateSessionId = SessionId.make("create-agent-private");
const genericPublicSessionId = SessionId.make("create-public");
const genericAgentSessionId = AgentSessionId.make("agent-private");
let genericCloseCalls = 0;
let agentAcknowledgeCalls = 0;
const rpcNotUnderTest = () => Effect.die("Not under test.");
const rpcStreamNotUnderTest = () => Stream.never;

const genericBrowser: CreateBrowserService = {
  acknowledgeFrame: rpcNotUnderTest,
  activePage: rpcNotUnderTest,
  clearStorage: rpcNotUnderTest,
  close: () =>
    Effect.sync(() => {
      genericCloseCalls += 1;
    }),
  closeTab: rpcNotUnderTest,
  create: rpcNotUnderTest,
  currentUrl: rpcNotUnderTest,
  deleteStorage: rpcNotUnderTest,
  getEmulation: rpcNotUnderTest,
  getNetworkRequest: rpcNotUnderTest,
  getNetworkRequests: rpcNotUnderTest,
  getStorage: rpcNotUnderTest,
  getTabs: rpcNotUnderTest,
  list: () => Effect.succeed([genericPrivateSessionId, genericPublicSessionId]),
  navigate: rpcNotUnderTest,
  newTab: rpcNotUnderTest,
  open: rpcNotUnderTest,
  recorderTarget: rpcNotUnderTest,
  sendInput: rpcNotUnderTest,
  setEmulation: rpcNotUnderTest,
  setStorage: rpcNotUnderTest,
  setUserAgent: rpcNotUnderTest,
  setViewport: rpcNotUnderTest,
  stream: rpcStreamNotUnderTest,
  switchTab: rpcNotUnderTest,
};

const agentSessionOwnership: AgentSessionService = {
  acknowledgeFrame: () =>
    Effect.sync(() => {
      agentAcknowledgeCalls += 1;
    }),
  act: rpcNotUnderTest,
  assessStep: rpcNotUnderTest,
  browserStream: rpcStreamNotUnderTest,
  changes: rpcStreamNotUnderTest,
  close: rpcNotUnderTest,
  closeAll: () => Effect.void,
  completeRun: rpcNotUnderTest,
  enterAgentVariable: rpcNotUnderTest,
  enterSuppliedVariable: rpcNotUnderTest,
  enterUserVariable: rpcNotUnderTest,
  extendCeiling: rpcNotUnderTest,
  get: rpcNotUnderTest,
  list: () => Effect.succeed([]),
  ownsBrowserSession: (ownedSessionId) =>
    Effect.succeed(ownedSessionId === genericPrivateSessionId),
  recordDraft: rpcNotUnderTest,
  recordInstruction: rpcNotUnderTest,
  recordPendingDecisionState: rpcNotUnderTest,
  recordVerificationOutcome: rpcNotUnderTest,
  requestTakeover: rpcNotUnderTest,
  resolveBoundary: rpcNotUnderTest,
  returnControl: rpcNotUnderTest,
  runViewUrl: rpcNotUnderTest,
  screenshot: rpcNotUnderTest,
  sendInput: rpcNotUnderTest,
  snapshot: rpcNotUnderTest,
  start: rpcNotUnderTest,
  supplyVariable: rpcNotUnderTest,
  takeover: rpcNotUnderTest,
  teachingFeed: rpcNotUnderTest,
  teachingScreenshot: rpcNotUnderTest,
  teachingSource: rpcNotUnderTest,
  userNavigate: rpcNotUnderTest,
  verification: rpcNotUnderTest,
};

it.effect("refuses to start a Run while a Recording is in progress", () =>
  Effect.gen(function* refuseRunDuringRecording() {
    const client = yield* RpcTest.makeClient(ContingencyRpcs, {
      flatten: true,
    });
    const error = yield* Effect.flip(
      client("run.start", { data: {}, type: "run.start" })
    );
    expect(error.code).toBe("recording_conflict");
    // The guard answers before the Runner is asked: a Run and a Recording
    // cannot share the process, so the second is refused, not contended for.
    expect(startsAsked).toBe(0);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      RpcHandlersLive.pipe(
        Layer.provide(CreateBrowserLive),
        Layer.provide(Layer.succeed(Recording, recordingService)),
        Layer.provide(RunSessionStub)
      )
    )
  )
);

it.effect(
  "answers a typed unavailable error without an Agent Session layer",
  () =>
    Effect.gen(function* agentSessionUnavailable() {
      const client = yield* RpcTest.makeClient(ContingencyRpcs, {
        flatten: true,
      });
      const error = yield* Effect.flip(
        client("agent.sessions.get", { data: {}, type: "agent.sessions.get" })
      );
      expect(error.code).toBe("agent_session_unavailable");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        RpcHandlersLive.pipe(
          Layer.provide(CreateBrowserLive),
          Layer.provide(Layer.succeed(Recording, recordingService)),
          Layer.provide(RunSessionStub)
        )
      )
    )
);

it.effect("hides Agent Session browsers from generic browser RPC", () =>
  Effect.gen(function* genericBrowserOwnership() {
    genericCloseCalls = 0;
    agentAcknowledgeCalls = 0;
    const client = yield* RpcTest.makeClient(ContingencyRpcs, {
      flatten: true,
    });
    const listed = yield* client("browser.sessions.get", {
      data: {},
      type: "browser.sessions.get",
    });
    expect(listed.data.sessions.map(({ id }) => id)).toEqual([
      genericPublicSessionId,
    ]);

    const rejected = yield* Effect.flip(
      client("browser.session.close", {
        data: { sessionId: genericPrivateSessionId },
        type: "browser.session.close",
      })
    );
    expect(rejected.code).toBe("agent_session_conflict");
    expect(genericCloseCalls).toBe(0);

    const acknowledged = yield* client("agent.browser.frame.ack", {
      data: {
        frameId: FrameSequence.make(1),
        sessionId: genericAgentSessionId,
        streamId: BrowserStreamId.make("agent-stream"),
      },
      type: "agent.browser.frame.ack",
    });
    expect(acknowledged.type).toBe("agent.browser.frame.acked");
    expect(agentAcknowledgeCalls).toBe(1);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      RpcHandlersLive.pipe(
        Layer.provide(Layer.succeed(CreateBrowser, genericBrowser)),
        Layer.provide(Layer.succeed(AgentSession, agentSessionOwnership)),
        Layer.provide(Layer.succeed(Recording, recordingService)),
        Layer.provide(RunSessionStub)
      )
    )
  )
);

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
          ),
          Layer.provide(RunSessionStub)
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
        Layer.provide(Layer.succeed(Recording, recordingService)),
        Layer.provide(RunSessionStub)
      )
    )
  )
);
