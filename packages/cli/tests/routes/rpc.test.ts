import {
  BrowserTabId,
  ContingencyRpcs,
  SessionId,
  STORAGE_LOCKED_MESSAGE,
} from "@contingency/protocol";
import type { RecordingSnapshot } from "@contingency/protocol";
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { RpcTest } from "effect/unstable/rpc";
import { describe } from "vitest";

import { browserInputIsReadOnly, RpcHandlersLive } from "../../src/routes/rpc";
import type { AgentBrowser } from "../../src/services/agent-browser";
import { AgentBrowser as AgentBrowserTag } from "../../src/services/agent-browser";
import type { RecordingService } from "../../src/services/recording";
import { Recording } from "../../src/services/recording";

const sessionId = SessionId.make("create-session-1");
const otherSessionId = SessionId.make("create-session-2");
const tabId = BrowserTabId.make("tab-1");

const snapshotWithPhase = (
  phase: "active" | "finished" | "incomplete" | "paused"
) =>
  ({
    captureMode: "ordinary",
    phase,
    sessionId,
  }) as const;

describe("browser input guard", () => {
  it("rejects input after a single-tab Recording becomes incomplete", () => {
    expect(
      browserInputIsReadOnly(snapshotWithPhase("incomplete"), sessionId)
    ).toBe(true);
  });
});

const unused = (): never => {
  throw new Error("unused");
};

const recordingSnapshot = (
  phase: RecordingSnapshot["phase"],
  recordingSessionId: SessionId = sessionId
): RecordingSnapshot => ({
  captureMode: "ordinary",
  flow: {
    steps: [{ type: "navigate", url: "https://app.example.com/" }],
    title: "Storage",
  },
  initialUrl: "https://app.example.com/",
  ...(phase === "incomplete"
    ? { incompleteReason: "The original capture connection failed." }
    : {}),
  phase,
  recordedSteps: [
    {
      id: "initial",
      preSteps: [],
      step: { type: "navigate", url: "https://app.example.com/" },
    },
  ],
  revision: 1,
  sessionId: recordingSessionId,
  tabId,
  undoAvailable: false,
});

const recordingService = (
  snapshot: RecordingSnapshot | null
): RecordingService => ({
  addAudit: unused,
  armPreStep: unused,
  armPreStepCondition: unused,
  bindVariable: unused,
  cancelCaptureMode: unused,
  deleteStep: unused,
  discard: unused,
  fail: unused,
  finish: unused,
  get: () => Effect.succeed(snapshot),
  pause: unused,
  recordNavigation: unused,
  recover: unused,
  renameVariable: unused,
  resume: unused,
  start: unused,
  stream: () => Stream.empty,
  undoDelete: unused,
  updateTitle: unused,
});

const storageCalls = {
  clear: [] as string[],
  delete: [] as string[],
  get: [] as string[],
  set: [] as string[],
};

const resetStorageCalls = () => {
  storageCalls.clear.length = 0;
  storageCalls.delete.length = 0;
  storageCalls.get.length = 0;
  storageCalls.set.length = 0;
};

const agentBrowserStub: AgentBrowser = {
  acknowledgeFrame: unused,
  attach: unused,
  cdpUrl: unused,
  clearStorage: (_sessionId, _tabId, kind) =>
    Effect.sync(() => {
      storageCalls.clear.push(kind);
    }),
  clickSelector: unused,
  close: unused,
  closeTab: unused,
  create: unused,
  currentUrl: unused,
  deleteStorage: (_sessionId, _tabId, payload) =>
    Effect.sync(() => {
      storageCalls.delete.push(payload.kind);
    }),
  fillSelector: unused,
  getNetworkRequest: unused,
  getNetworkRequests: unused,
  getStorage: (_sessionId, requestedTabId, kind) =>
    Effect.sync(() => {
      storageCalls.get.push(kind);
      return kind === "cookies"
        ? { cookies: [], kind, tabId: requestedTabId }
        : { entries: { flag: "on" }, kind, tabId: requestedTabId };
    }),
  getTabs: unused,
  goto: unused,
  init: unused,
  keyDown: unused,
  keyUp: unused,
  list: unused,
  navigate: unused,
  newTab: unused,
  open: unused,
  sendInput: unused,
  setStorage: (_sessionId, _tabId, payload) =>
    Effect.sync(() => {
      storageCalls.set.push(payload.kind);
    }),
  setUserAgent: unused,
  setViewport: unused,
  stream: () => Stream.empty,
  switchTab: unused,
  typeSelector: unused,
  waitForSelector: unused,
};

const withHandlers = (snapshot: RecordingSnapshot | null) =>
  RpcHandlersLive.pipe(
    Layer.provide(Layer.succeed(AgentBrowserTag, agentBrowserStub)),
    Layer.provide(Layer.succeed(Recording, recordingService(snapshot)))
  );

const cookieSetPayload = {
  data: {
    cookie: {
      domain: "app.example.com",
      httpOnly: false,
      name: "sid",
      path: "/",
      secure: false,
      value: "1",
    },
    kind: "cookies" as const,
    sessionId,
    tabId,
  },
  type: "browser.storage.set" as const,
};

it.effect("allows storage get while a Recording is in progress", () => {
  resetStorageCalls();
  return Effect.gen(function* getDuringRecording() {
    const client = yield* RpcTest.makeClient(ContingencyRpcs, {
      flatten: true,
    });
    const result = yield* client("browser.storage.get", {
      data: { kind: "cookies", sessionId, tabId },
      type: "browser.storage.get",
    });
    expect(result.data.snapshot).toEqual({
      cookies: [],
      kind: "cookies",
      tabId,
    });
    expect(storageCalls.get).toEqual(["cookies"]);
  }).pipe(
    Effect.scoped,
    Effect.provide(withHandlers(recordingSnapshot("active")))
  );
});

const rejectMutate = (phase: RecordingSnapshot["phase"]) =>
  Effect.gen(function* rejectLockedPhase() {
    const client = yield* RpcTest.makeClient(ContingencyRpcs, {
      flatten: true,
    });
    const error = yield* Effect.flip(
      client("browser.storage.set", cookieSetPayload)
    );
    expect(error.code).toBe("recording_conflict");
    expect(error.message).toBe(STORAGE_LOCKED_MESSAGE);
  }).pipe(
    Effect.scoped,
    Effect.provide(withHandlers(recordingSnapshot(phase)))
  );

it.effect(
  "rejects storage mutations for active, paused, and incomplete Recordings on that session",
  () => {
    resetStorageCalls();
    return Effect.gen(function* rejectLockedMutations() {
      yield* rejectMutate("active");
      yield* rejectMutate("paused");
      yield* rejectMutate("incomplete");
      expect(storageCalls.set).toEqual([]);
    });
  }
);

it.effect(
  "allows storage mutations when there is no Recording or it is finished",
  () => {
    resetStorageCalls();
    return Effect.gen(function* allowUnlockedMutations() {
      yield* Effect.gen(function* setWithoutRecording() {
        const client = yield* RpcTest.makeClient(ContingencyRpcs, {
          flatten: true,
        });
        yield* client("browser.storage.set", cookieSetPayload);
      }).pipe(Effect.scoped, Effect.provide(withHandlers(null)));
      yield* Effect.gen(function* deleteWhenFinished() {
        const client = yield* RpcTest.makeClient(ContingencyRpcs, {
          flatten: true,
        });
        yield* client("browser.storage.delete", {
          data: {
            domain: "app.example.com",
            kind: "cookies",
            name: "sid",
            path: "/",
            sessionId,
            tabId,
          },
          type: "browser.storage.delete",
        });
      }).pipe(
        Effect.scoped,
        Effect.provide(withHandlers(recordingSnapshot("finished")))
      );
      yield* Effect.gen(function* clearWithoutRecording() {
        const client = yield* RpcTest.makeClient(ContingencyRpcs, {
          flatten: true,
        });
        yield* client("browser.storage.clear", {
          data: { kind: "local", sessionId, tabId },
          type: "browser.storage.clear",
        });
      }).pipe(Effect.scoped, Effect.provide(withHandlers(null)));
      expect(storageCalls.set).toEqual(["cookies"]);
      expect(storageCalls.delete).toEqual(["cookies"]);
      expect(storageCalls.clear).toEqual(["local"]);
    });
  }
);

it.effect(
  "does not lock storage mutations on a different browser session",
  () => {
    resetStorageCalls();
    return Effect.gen(function* otherSessionStaysMutable() {
      const client = yield* RpcTest.makeClient(ContingencyRpcs, {
        flatten: true,
      });
      yield* client("browser.storage.set", cookieSetPayload);
      expect(storageCalls.set).toEqual(["cookies"]);
    }).pipe(
      Effect.scoped,
      Effect.provide(withHandlers(recordingSnapshot("active", otherSessionId)))
    );
  }
);
