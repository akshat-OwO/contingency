import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";

import { AgentBrowserObserve } from "./agent-browser.ts";
import {
  AgentSessionClose,
  AgentSessionCloseResult,
  AgentSessionGet,
  AgentSessionGetResult,
  AgentSessionSnapshot,
  AgentSessionStart,
  AgentSessionStartResult,
  AgentSessionStreamSubscribe,
  AgentSessionReturnControl,
  AgentSessionTakeover,
} from "./agent-session.ts";
import { BrowserTabId, SessionId } from "./browser-identifiers.ts";
import { BrowserIdentity, UserAgentProfileId } from "./browser-identity.ts";
import { BrowserRpcError } from "./browser-rpc-error.ts";
import {
  AuditKind,
  Geolocation,
  PermissionDecisions,
  RecordingSnapshot,
} from "./flow.ts";
import { RunSnapshot } from "./run.ts";
import {
  BrowserStorageDeletePayload,
  BrowserStorageSetPayload,
  BrowserStorageSnapshot,
  StorageKind,
} from "./storage.ts";
import { Viewport } from "./viewport.ts";

// The protocol package intentionally exposes one public contract surface.
// oxlint-disable-next-line oxc/no-barrel-file
export * from "./flow.ts";
// oxlint-disable-next-line oxc/no-barrel-file
export * from "./run.ts";
// oxlint-disable-next-line oxc/no-barrel-file
export * from "./storage.ts";
// oxlint-disable-next-line oxc/no-barrel-file
export * from "./agent-identifiers.ts";
// oxlint-disable-next-line oxc/no-barrel-file
export * from "./agent-session.ts";
// oxlint-disable-next-line oxc/no-barrel-file
export * from "./agent-browser.ts";
export {
  BrowserTabId,
  SessionId,
  sessionPrefixes,
} from "./browser-identifiers.ts";
export type { SessionPrefix } from "./browser-identifiers.ts";

export {
  BrowserRpcError,
  isBrowserRpcError,
  makeBrowserRpcError,
} from "./browser-rpc-error.ts";
export type { BrowserRpcError as BrowserRpcErrorType } from "./browser-rpc-error.ts";

export const BrowserRequestId = Schema.String.check(Schema.isMinLength(1)).pipe(
  Schema.brand("@contingency/BrowserRequestId")
);
export type BrowserRequestId = typeof BrowserRequestId.Type;

export const FrameSequence = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0)
).pipe(Schema.brand("@contingency/FrameSequence"));
export type FrameSequence = typeof FrameSequence.Type;

export const BrowserStreamId = Schema.String.check(Schema.isMinLength(1)).pipe(
  Schema.brand("@contingency/BrowserStreamId")
);
export type BrowserStreamId = typeof BrowserStreamId.Type;

export { Viewport } from "./viewport.ts";
export {
  BrandVersion,
  BrowserIdentity,
  browserIdentityCompatibilityWarning,
  browserIdentityFor,
  matchUserAgentProfile,
  profileIdentity,
  profileViewport,
  resolveIdentity,
  resolveUserAgent,
  resolveUserAgentMetadata,
  selectableUserAgentProfiles,
  stringOnlyIdentity,
  UserAgentMetadata,
  UserAgentProfileId,
  userAgentProfiles,
} from "./browser-identity.ts";
export type {
  MatchedUserAgentProfile,
  ProfileIdentity,
  UserAgentProfile,
} from "./browser-identity.ts";

export const BrowserSession = Schema.Struct({
  id: SessionId,
  selected: Schema.Boolean,
});
export type BrowserSession = typeof BrowserSession.Type;

export const BrowserTab = Schema.Struct({
  active: Schema.Boolean,
  label: Schema.optional(Schema.NullOr(Schema.String)),
  tabId: BrowserTabId,
  title: Schema.String,
  type: Schema.String,
  url: Schema.String,
});
export type BrowserTab = typeof BrowserTab.Type;

export const BrowserConsoleEntry = Schema.Union([
  Schema.Struct({
    level: Schema.String,
    tabId: BrowserTabId,
    text: Schema.String,
    timestamp: Schema.Finite,
    type: Schema.Literal("console"),
  }),
  Schema.Struct({
    column: Schema.NullOr(Schema.Int),
    line: Schema.NullOr(Schema.Int),
    tabId: BrowserTabId,
    text: Schema.String,
    timestamp: Schema.Finite,
    type: Schema.Literal("page_error"),
  }),
]);
export type BrowserConsoleEntry = typeof BrowserConsoleEntry.Type;

export const BrowserNetworkRequest = Schema.Struct({
  headers: Schema.Unknown,
  method: Schema.String,
  mimeType: Schema.optional(Schema.String),
  postData: Schema.optional(Schema.String),
  requestId: BrowserRequestId,
  resourceType: Schema.String,
  responseHeaders: Schema.optional(Schema.Unknown),
  status: Schema.optional(Schema.Int),
  tabId: BrowserTabId,
  timestamp: Schema.Int,
  url: Schema.String,
});
export type BrowserNetworkRequest = typeof BrowserNetworkRequest.Type;

export const BrowserNetworkRequestDetail = Schema.Struct({
  ...BrowserNetworkRequest.fields,
  initiator: Schema.optional(Schema.Unknown),
  responseBody: Schema.optional(Schema.String),
  timing: Schema.optional(Schema.Unknown),
});
export type BrowserNetworkRequestDetail =
  typeof BrowserNetworkRequestDetail.Type;

export const MouseButton = Schema.Literals([
  "none",
  "left",
  "middle",
  "right",
  "back",
  "forward",
]);

export const MouseInput = Schema.Struct({
  button: Schema.optional(MouseButton),
  clickCount: Schema.optional(Schema.Int),
  deltaX: Schema.optional(Schema.Finite),
  deltaY: Schema.optional(Schema.Finite),
  eventType: Schema.Literals([
    "mousePressed",
    "mouseReleased",
    "mouseMoved",
    "mouseWheel",
  ]),
  modifiers: Schema.optional(Schema.Int),
  type: Schema.Literal("input_mouse"),
  x: Schema.Finite,
  y: Schema.Finite,
});
export type MouseInput = typeof MouseInput.Type;

export const KeyboardInput = Schema.Struct({
  code: Schema.optional(Schema.String),
  eventType: Schema.Literals(["keyDown", "keyUp", "char"]),
  key: Schema.optional(Schema.String),
  modifiers: Schema.optional(Schema.Int),
  text: Schema.optional(Schema.String),
  type: Schema.Literal("input_keyboard"),
  windowsVirtualKeyCode: Schema.optional(Schema.Int),
});
export type KeyboardInput = typeof KeyboardInput.Type;

export const BrowserInput = Schema.Union([MouseInput, KeyboardInput]);
export type BrowserInput = typeof BrowserInput.Type;

export const AgentBrowserFrame = Schema.Struct({
  data: Schema.String,
  metadata: Schema.Struct({
    deviceHeight: Schema.Int,
    deviceWidth: Schema.Int,
    offsetTop: Schema.Finite,
    pageScaleFactor: Schema.Finite,
    scrollOffsetX: Schema.Finite,
    scrollOffsetY: Schema.Finite,
    timestamp: Schema.Finite,
  }),
  seq: FrameSequence,
  type: Schema.Literal("frame"),
});

export const BrowserStreamStatus = Schema.Struct({
  connected: Schema.Boolean,
  recording: Schema.optional(Schema.Boolean),
  screencasting: Schema.Boolean,
  type: Schema.Literal("status"),
  viewportHeight: Schema.Int,
  viewportWidth: Schema.Int,
});

export const BrowserTabsEvent = Schema.Struct({
  tabs: Schema.Array(BrowserTab),
  timestamp: Schema.Finite,
  type: Schema.Literal("tabs"),
});

export const AgentBrowserViewEvent = Schema.Union([
  AgentBrowserFrame,
  BrowserStreamStatus,
  BrowserTabsEvent,
]);

export const BrowserStreamEvent = Schema.Union([
  Schema.Struct({ ...AgentBrowserFrame.fields, streamId: BrowserStreamId }),
  BrowserStreamStatus,
  Schema.Struct({
    tabId: BrowserTabId,
    timestamp: Schema.optional(Schema.Finite),
    type: Schema.Literal("url"),
    url: Schema.String,
  }),
  BrowserConsoleEntry,
  BrowserTabsEvent,
]);
export type BrowserStreamEvent = typeof BrowserStreamEvent.Type;

const request = <const Type extends string, Data extends Schema.Struct.Fields>(
  type: Type,
  data: Data
) => Schema.Struct({ data: Schema.Struct(data), type: Schema.Literal(type) });

const response = <const Type extends string, Data extends Schema.Struct.Fields>(
  type: Type,
  data: Data
) => Schema.Struct({ data: Schema.Struct(data), type: Schema.Literal(type) });

export const BrandId = Schema.Literals([
  "browser.sessions.get",
  "browser.sessions.result",
  "browser.session.create",
  "browser.session.created",
  "browser.session.attach",
  "browser.session.attached",
  "browser.session.close",
  "browser.session.closed",
  "browser.open",
  "browser.opened",
  "browser.navigation.run",
  "browser.navigation.completed",
  "browser.viewport.set",
  "browser.viewport.updated",
  "browser.user-agent.set",
  "browser.user-agent.updated",
  "browser.emulation.get",
  "browser.emulation.set",
  "browser.emulation.updated",
  "browser.stream.subscribe",
  "browser.input.send",
  "browser.input.sent",
  "browser.frame.ack",
  "browser.frame.acked",
  "browser.tabs.get",
  "browser.tabs.result",
  "browser.tab.new",
  "browser.tab.created",
  "browser.tab.switch",
  "browser.tab.switched",
  "browser.tab.close",
  "browser.tab.closed",
  "browser.network.requests.get",
  "browser.network.requests.result",
  "browser.network.request.get",
  "browser.network.request.result",
  "browser.storage.get",
  "browser.storage.result",
  "browser.storage.set",
  "browser.storage.delete",
  "browser.storage.clear",
  "browser.storage.updated",
  "recording.get",
  "recording.result",
  "recording.start",
  "recording.pause",
  "recording.resume",
  "recording.recover",
  "recording.finish",
  "recording.discard",
  "recording.discarded",
  "recording.title.update",
  "recording.step.delete",
  "recording.step.undo",
  "recording.audit.add",
  "recording.step.variable.bind",
  "recording.variable.rename",
  "recording.pre-step.arm",
  "recording.pre-step.condition.arm",
  "recording.pre-step.condition.url",
  "recording.capture.cancel",
  "recording.hover.arm",
  "recording.stream.subscribe",
  "run.flow.load",
  "run.get",
  "run.result",
  "run.start",
  "run.variable.answer",
  "run.stream.subscribe",
  "agent.sessions.get",
  "agent.session.start",
  "agent.session.get",
  "agent.session.close",
  "agent.session.stream.subscribe",
  "agent.browser.stream.subscribe",
  "agent.browser.frame.ack",
  "agent.session.takeover",
  "agent.session.takeover.started",
  "agent.session.control.return",
  "agent.session.control.returned",
  "agent.browser.input.send",
  "agent.browser.input.sent",
]);
export type BrandId = typeof BrandId.Type;

const nonEmptyProtocolString = Schema.String.check(Schema.isMinLength(1));

export const BrowserSessionsGet = request("browser.sessions.get", {});
export const BrowserSessionsResult = response("browser.sessions.result", {
  sessions: Schema.Array(BrowserSession),
});

export const BrowserSessionCreate = request("browser.session.create", {
  name: Schema.String,
  viewport: Viewport,
});
export const BrowserSessionCreated = response("browser.session.created", {
  sessionId: SessionId,
});

export const BrowserSessionAttach = request("browser.session.attach", {
  sessionId: SessionId,
});
export const BrowserSessionAttached = response("browser.session.attached", {
  sessionId: SessionId,
  url: Schema.String,
});

export const BrowserSessionClose = request("browser.session.close", {
  sessionId: SessionId,
});
export const BrowserSessionClosed = response("browser.session.closed", {});

/**
 * One whole Emulation Create View has composed but no session applies yet: the
 * browser identity, its viewport, and the environment around it as a single
 * value. It travels with the first navigation so the session's first request
 * and document already carry it, rather than being patched in afterwards ([ADR
 * 0013](../../../docs/adr/0013-emulation-belongs-to-the-flow.md)).
 */
export const DraftEmulation = Schema.Struct({
  colorScheme: Schema.optional(Schema.Literals(["light", "dark"])),
  geolocation: Schema.optional(Geolocation),
  locale: Schema.optional(nonEmptyProtocolString),
  permissions: PermissionDecisions,
  timezoneId: Schema.optional(nonEmptyProtocolString),
  userAgentProfile: UserAgentProfileId,
  viewport: Viewport,
});
export type DraftEmulation = typeof DraftEmulation.Type;

export const BrowserOpen = request("browser.open", {
  /** The whole Emulation to apply before the first request leaves. */
  emulation: DraftEmulation,
  sessionId: Schema.optional(SessionId),
  url: Schema.String,
});
export const BrowserOpened = response("browser.opened", {
  sessionId: SessionId,
  url: Schema.String,
});

export const BrowserNavigationRun = request("browser.navigation.run", {
  action: Schema.Literals(["back", "forward", "reload"]),
  sessionId: SessionId,
});
export const BrowserNavigationCompleted = response(
  "browser.navigation.completed",
  {}
);

export const BrowserViewportSet = request("browser.viewport.set", {
  sessionId: SessionId,
  viewport: Viewport,
});
export const BrowserViewportUpdated = response("browser.viewport.updated", {
  viewport: Viewport,
});

export const BrowserUserAgentSet = request("browser.user-agent.set", {
  sessionId: SessionId,
  url: Schema.String,
  userAgentProfile: UserAgentProfileId,
  viewport: Viewport,
});
export const BrowserUserAgentUpdated = response("browser.user-agent.updated", {
  url: Schema.String,
  userAgentProfile: UserAgentProfileId,
});

/**
 * The emulation a Create View session currently applies to every Page it
 * opens: the Flow's Emulation shape ([ADR
 * 0013](../../../docs/adr/0013-emulation-belongs-to-the-flow.md)) with
 * permission decisions as a plain list, because a fresh session has decided
 * nothing rather than declaring nothing.
 */
export const SessionEmulation = Schema.Struct({
  /** The concrete browser identity the session applies to every Page. */
  browser: Schema.optional(BrowserIdentity),
  colorScheme: Schema.optional(Schema.Literals(["light", "dark"])),
  geolocation: Schema.optional(Geolocation),
  locale: Schema.optional(nonEmptyProtocolString),
  permissions: PermissionDecisions,
  timezoneId: Schema.optional(nonEmptyProtocolString),
  userAgent: Schema.optional(nonEmptyProtocolString),
  viewport: Viewport,
});
export type SessionEmulation = typeof SessionEmulation.Type;

/**
 * Read one session's Emulation without changing it, so a client can seed its
 * view of what the session already emulates instead of assuming a fresh one.
 */
export const BrowserEmulationGet = request("browser.emulation.get", {
  sessionId: SessionId,
});

/**
 * Update one session's Emulation. Every field is optional; absent leaves that
 * part unchanged and `null` clears it, so permissions and a location override
 * can be dropped without closing the browser session (ADR 0013). A change is
 * atomic: the session's whole Emulation is re-applied together, so changing
 * one part never silently drops another.
 */
export const BrowserEmulationSet = request("browser.emulation.set", {
  colorScheme: Schema.optional(
    Schema.NullOr(Schema.Literals(["light", "dark"]))
  ),
  geolocation: Schema.optional(Schema.NullOr(Geolocation)),
  locale: Schema.optional(Schema.NullOr(nonEmptyProtocolString)),
  permissions: Schema.optional(Schema.NullOr(PermissionDecisions)),
  sessionId: SessionId,
  timezoneId: Schema.optional(Schema.NullOr(nonEmptyProtocolString)),
});
export const BrowserEmulationUpdated = response("browser.emulation.updated", {
  emulation: SessionEmulation,
});

export const BrowserStreamSubscribe = request("browser.stream.subscribe", {
  sessionId: SessionId,
});

export const BrowserInputSend = request("browser.input.send", {
  input: BrowserInput,
  sessionId: SessionId,
});
export const BrowserInputSent = response("browser.input.sent", {});

export const BrowserFrameAck = request("browser.frame.ack", {
  seq: FrameSequence,
  sessionId: SessionId,
  streamId: BrowserStreamId,
});
export const BrowserFrameAcked = response("browser.frame.acked", {});

export const BrowserTabsGet = request("browser.tabs.get", {
  sessionId: SessionId,
});
export const BrowserTabsResult = response("browser.tabs.result", {
  tabs: Schema.Array(BrowserTab),
});

export const BrowserTabNew = request("browser.tab.new", {
  sessionId: SessionId,
});
export const BrowserTabCreated = response("browser.tab.created", {});

export const BrowserTabSwitch = request("browser.tab.switch", {
  sessionId: SessionId,
  tabId: BrowserTabId,
});
export const BrowserTabSwitched = response("browser.tab.switched", {});

export const BrowserTabClose = request("browser.tab.close", {
  sessionId: SessionId,
  tabId: BrowserTabId,
});
export const BrowserTabClosed = response("browser.tab.closed", {});

export const BrowserNetworkRequestsGet = request(
  "browser.network.requests.get",
  { sessionId: SessionId, tabId: BrowserTabId }
);
export const BrowserNetworkRequestsResult = response(
  "browser.network.requests.result",
  { requests: Schema.Array(BrowserNetworkRequest) }
);

export const BrowserNetworkRequestGet = request("browser.network.request.get", {
  requestId: BrowserRequestId,
  sessionId: SessionId,
  tabId: BrowserTabId,
});
export const BrowserNetworkRequestResult = response(
  "browser.network.request.result",
  { request: BrowserNetworkRequestDetail }
);

export const BrowserStorageGet = request("browser.storage.get", {
  kind: StorageKind,
  sessionId: SessionId,
  tabId: BrowserTabId,
});
export const BrowserStorageResult = Schema.Struct({
  data: Schema.Struct({ snapshot: BrowserStorageSnapshot }),
  type: Schema.Literal("browser.storage.result"),
});
export const BrowserStorageSet = Schema.Struct({
  data: BrowserStorageSetPayload,
  type: Schema.Literal("browser.storage.set"),
});
export const BrowserStorageDelete = Schema.Struct({
  data: BrowserStorageDeletePayload,
  type: Schema.Literal("browser.storage.delete"),
});
export const BrowserStorageClear = request("browser.storage.clear", {
  kind: StorageKind,
  sessionId: SessionId,
  tabId: BrowserTabId,
});
export const BrowserStorageUpdated = response("browser.storage.updated", {});

export const RecordingGet = request("recording.get", {});
export const RecordingResult = response("recording.result", {
  recording: Schema.NullOr(RecordingSnapshot),
});
export const RecordingStart = request("recording.start", {
  sessionId: SessionId,
  title: Schema.String,
});
export const RecordingPause = request("recording.pause", {});
export const RecordingResume = request("recording.resume", {});
export const RecordingRecover = request("recording.recover", {});
export const RecordingFinish = request("recording.finish", {});
export const RecordingDiscard = request("recording.discard", {});
export const RecordingDiscarded = response("recording.discarded", {});
export const RecordingTitleUpdate = request("recording.title.update", {
  title: Schema.String,
});
export const RecordingStepDelete = request("recording.step.delete", {
  stepId: Schema.String,
});
export const RecordingStepUndo = request("recording.step.undo", {});
export const RecordingAuditAdd = request("recording.audit.add", {
  audit: AuditKind,
});
export const RecordingStepVariableBind = request(
  "recording.step.variable.bind",
  {
    name: Schema.String,
    stepId: Schema.String,
  }
);
export const RecordingVariableRename = request("recording.variable.rename", {
  from: Schema.String,
  name: Schema.String,
});
const stepId = Schema.String.check(Schema.isMinLength(1));
const RecordingPreStepScope = Schema.Union([
  Schema.Struct({ scope: Schema.Literal("flow") }),
  Schema.Struct({ scope: Schema.Literal("step"), stepId }),
]);
/**
 * The element-pick conditions a Pre-step's `when` can be armed with. Both are
 * picked by clicking the element in the live browser; only the resulting
 * condition differs.
 */
export const PreStepPickKind = Schema.Literals([
  "selectorVisible",
  "selectorHidden",
]);
export type PreStepPickKind = typeof PreStepPickKind.Type;

export const RecordingPreStepArm = Schema.Struct({
  data: RecordingPreStepScope,
  type: Schema.Literal("recording.pre-step.arm"),
});
export const RecordingPreStepConditionArm = Schema.Struct({
  data: Schema.Union([
    Schema.Struct({
      index: Schema.Int,
      kind: PreStepPickKind,
      scope: Schema.Literal("flow"),
    }),
    Schema.Struct({
      index: Schema.Int,
      kind: PreStepPickKind,
      scope: Schema.Literal("step"),
      stepId,
    }),
  ]),
  type: Schema.Literal("recording.pre-step.condition.arm"),
});
/**
 * Writes a `urlMatches` condition onto a Pre-step directly: there is no
 * element to pick, so the author supplies the pattern themselves.
 */
export const RecordingPreStepConditionUrl = Schema.Struct({
  data: Schema.Union([
    Schema.Struct({
      index: Schema.Int,
      pattern: Schema.String.check(Schema.isMinLength(1)),
      scope: Schema.Literal("flow"),
    }),
    Schema.Struct({
      index: Schema.Int,
      pattern: Schema.String.check(Schema.isMinLength(1)),
      scope: Schema.Literal("step"),
      stepId,
    }),
  ]),
  type: Schema.Literal("recording.pre-step.condition.url"),
});
export const RecordingCaptureCancel = request("recording.capture.cancel", {});
/**
 * Arm hover capture. Hover is captured by explicit author gesture rather than
 * from mouse movement ([ADR 0019](../../../docs/adr/0019-recording-follows-pages.md)):
 * every mouse move is a hover, so a dwell heuristic would produce junk Steps
 * at volume. Armed, the next element the author picks becomes a hover Step.
 */
export const RecordingHoverArm = request("recording.hover.arm", {});
export const RecordingStreamSubscribe = request(
  "recording.stream.subscribe",
  {}
);

/**
 * The Run group is deliberately small. Audit View starts one Run of the one
 * Flow this process was opened on and watches it
 * ([ADR 0023](../../../docs/adr/0023-audit-view-starts-runs.md)); it does not
 * list Flows, browse Run history, or attach to a Run some terminal started.
 */
export const RunGet = request("run.get", {});
/**
 * Every Run operation answers with the whole snapshot, exactly as every
 * Recording operation answers with the Recording. `null` means this process
 * was opened without a Flow, so there is nothing to audit.
 */
export const RunResult = response("run.result", {
  run: Schema.NullOr(RunSnapshot),
});
/**
 * Start the loaded Flow. A Run started here forces its Trace and its video on
 * whatever the Flow or the defaults say, because stepping the timeline is
 * stepping those frames (ADR 0023).
 */
export const RunStart = request("run.start", {});
/**
 * Answer the `runtime` Variable the Runner is waiting on. The name travels so
 * a stale answer to an earlier prompt is rejected rather than applied to the
 * wrong Variable.
 */
export const RunVariableAnswer = request("run.variable.answer", {
  name: nonEmptyProtocolString,
  value: Schema.String,
});
export const RunStreamSubscribe = request("run.stream.subscribe", {});
/**
 * Hand the server a Flow document to audit, from a browser that has the file
 * and a server that was opened without one. This is not the Flow picker ADR
 * 0023 rules out: there is still exactly one loaded Flow at a time, and the
 * server never lists or searches for Flows — the document travels in the
 * request, so nothing a caller sends is read as a path.
 */
export const RunFlowLoad = request("run.flow.load", {
  document: nonEmptyProtocolString,
  /** What to call the document in a decode failure. Never opened as a path. */
  source: nonEmptyProtocolString,
});

/** Agent View's process-owned session boundary. */
export const AgentSessionsGet = request("agent.sessions.get", {});
export const AgentSessionsResult = response("agent.sessions.result", {
  sessions: Schema.Array(AgentSessionSnapshot),
});

export const AgentSessionStartRequest = request("agent.session.start", {
  activity: AgentSessionStart.fields.activity,
  clientName: AgentSessionStart.fields.clientName,
  clientVersion: AgentSessionStart.fields.clientVersion,
  name: AgentSessionStart.fields.name,
  operationId: AgentSessionStart.fields.operationId,
  url: AgentSessionStart.fields.url,
  viewport: AgentSessionStart.fields.viewport,
});
export const AgentSessionStarted = response("agent.session.started", {
  session: AgentSessionStartResult.fields.session,
});

export const AgentSessionGetRequest = request("agent.session.get", {
  sessionId: AgentSessionGet.fields.sessionId,
});
export const AgentSessionResult = response("agent.session.result", {
  session: AgentSessionGetResult.fields.session,
});

export const AgentSessionCloseRequest = request("agent.session.close", {
  operationId: AgentSessionClose.fields.operationId,
  sessionId: AgentSessionClose.fields.sessionId,
});
export const AgentSessionClosed = response("agent.session.closed", {
  session: AgentSessionCloseResult.fields.session,
});

export const AgentSessionStreamSubscribeRequest = request(
  "agent.session.stream.subscribe",
  { sessionId: AgentSessionStreamSubscribe.fields.sessionId }
);

/**
 * Agent View receives browser events through the Agent Session boundary. The
 * lower-level Create Browser SessionId is intentionally not part of this
 * contract, so an MCP caller can only stream the session it owns.
 */
export const AgentBrowserStreamSubscribe = request(
  "agent.browser.stream.subscribe",
  { sessionId: AgentSessionStreamSubscribe.fields.sessionId }
);
export const AgentBrowserFrameAck = request("agent.browser.frame.ack", {
  frameId: FrameSequence,
  sessionId: AgentSessionStreamSubscribe.fields.sessionId,
  streamId: BrowserStreamId,
});
export const AgentBrowserFrameAcked = response("agent.browser.frame.acked", {});

/**
 * Takeover is exclusive and the user has priority. Agent View initiates it
 * directly; the external agent may only request it, and that request returns
 * the Agent View link immediately rather than holding a call open while the
 * user acts ([ADR 0027](../../../docs/adr/0027-agent-authority-has-a-user-approved-execution-boundary.md)).
 */
export const AgentSessionTakeoverRequest = request("agent.session.takeover", {
  operationId: AgentSessionTakeover.fields.operationId,
  reason: AgentSessionTakeover.fields.reason,
  sessionId: AgentSessionTakeover.fields.sessionId,
});
export const AgentSessionTakeoverStarted = response(
  "agent.session.takeover.started",
  { session: AgentSessionSnapshot }
);

export const AgentSessionControlReturnRequest = request(
  "agent.session.control.return",
  {
    operationId: AgentSessionReturnControl.fields.operationId,
    sessionId: AgentSessionReturnControl.fields.sessionId,
  }
);
export const AgentSessionControlReturned = response(
  "agent.session.control.returned",
  { session: AgentSessionSnapshot }
);

/**
 * What the user does with the browser during Takeover. It is deliberately not
 * an MCP tool: raw input belongs to the person who took control, and control
 * is exclusive, so the agent cannot send it at all.
 */
export const AgentBrowserInputSend = request("agent.browser.input.send", {
  input: BrowserInput,
  sessionId: AgentBrowserObserve.fields.sessionId,
});
export const AgentBrowserInputSent = response("agent.browser.input.sent", {});

const BrowserSessionsGetRpc = Rpc.make("browser.sessions.get", {
  error: BrowserRpcError,
  payload: BrowserSessionsGet,
  success: BrowserSessionsResult,
});
const BrowserSessionCreateRpc = Rpc.make("browser.session.create", {
  error: BrowserRpcError,
  payload: BrowserSessionCreate,
  success: BrowserSessionCreated,
});
const BrowserSessionAttachRpc = Rpc.make("browser.session.attach", {
  error: BrowserRpcError,
  payload: BrowserSessionAttach,
  success: BrowserSessionAttached,
});
const BrowserSessionCloseRpc = Rpc.make("browser.session.close", {
  error: BrowserRpcError,
  payload: BrowserSessionClose,
  success: BrowserSessionClosed,
});
const BrowserOpenRpc = Rpc.make("browser.open", {
  error: BrowserRpcError,
  payload: BrowserOpen,
  success: BrowserOpened,
});
const BrowserNavigationRunRpc = Rpc.make("browser.navigation.run", {
  error: BrowserRpcError,
  payload: BrowserNavigationRun,
  success: BrowserNavigationCompleted,
});
const BrowserViewportSetRpc = Rpc.make("browser.viewport.set", {
  error: BrowserRpcError,
  payload: BrowserViewportSet,
  success: BrowserViewportUpdated,
});
const BrowserUserAgentSetRpc = Rpc.make("browser.user-agent.set", {
  error: BrowserRpcError,
  payload: BrowserUserAgentSet,
  success: BrowserUserAgentUpdated,
});
const BrowserEmulationGetRpc = Rpc.make("browser.emulation.get", {
  error: BrowserRpcError,
  payload: BrowserEmulationGet,
  success: BrowserEmulationUpdated,
});
const BrowserEmulationSetRpc = Rpc.make("browser.emulation.set", {
  error: BrowserRpcError,
  payload: BrowserEmulationSet,
  success: BrowserEmulationUpdated,
});
const BrowserStreamSubscribeRpc = Rpc.make("browser.stream.subscribe", {
  error: BrowserRpcError,
  payload: BrowserStreamSubscribe,
  stream: true,
  success: BrowserStreamEvent,
});
const BrowserInputSendRpc = Rpc.make("browser.input.send", {
  error: BrowserRpcError,
  payload: BrowserInputSend,
  success: BrowserInputSent,
});
const BrowserFrameAckRpc = Rpc.make("browser.frame.ack", {
  error: BrowserRpcError,
  payload: BrowserFrameAck,
  success: BrowserFrameAcked,
});
const BrowserTabsGetRpc = Rpc.make("browser.tabs.get", {
  error: BrowserRpcError,
  payload: BrowserTabsGet,
  success: BrowserTabsResult,
});
const BrowserTabNewRpc = Rpc.make("browser.tab.new", {
  error: BrowserRpcError,
  payload: BrowserTabNew,
  success: BrowserTabCreated,
});
const BrowserTabSwitchRpc = Rpc.make("browser.tab.switch", {
  error: BrowserRpcError,
  payload: BrowserTabSwitch,
  success: BrowserTabSwitched,
});
const BrowserTabCloseRpc = Rpc.make("browser.tab.close", {
  error: BrowserRpcError,
  payload: BrowserTabClose,
  success: BrowserTabClosed,
});
const BrowserNetworkRequestsGetRpc = Rpc.make("browser.network.requests.get", {
  error: BrowserRpcError,
  payload: BrowserNetworkRequestsGet,
  success: BrowserNetworkRequestsResult,
});
const BrowserNetworkRequestGetRpc = Rpc.make("browser.network.request.get", {
  error: BrowserRpcError,
  payload: BrowserNetworkRequestGet,
  success: BrowserNetworkRequestResult,
});
const BrowserStorageGetRpc = Rpc.make("browser.storage.get", {
  error: BrowserRpcError,
  payload: BrowserStorageGet,
  success: BrowserStorageResult,
});
const BrowserStorageSetRpc = Rpc.make("browser.storage.set", {
  error: BrowserRpcError,
  payload: BrowserStorageSet,
  success: BrowserStorageUpdated,
});
const BrowserStorageDeleteRpc = Rpc.make("browser.storage.delete", {
  error: BrowserRpcError,
  payload: BrowserStorageDelete,
  success: BrowserStorageUpdated,
});
const BrowserStorageClearRpc = Rpc.make("browser.storage.clear", {
  error: BrowserRpcError,
  payload: BrowserStorageClear,
  success: BrowserStorageUpdated,
});
const RecordingGetRpc = Rpc.make("recording.get", {
  error: BrowserRpcError,
  payload: RecordingGet,
  success: RecordingResult,
});
const RecordingStartRpc = Rpc.make("recording.start", {
  error: BrowserRpcError,
  payload: RecordingStart,
  success: RecordingResult,
});
const RecordingPauseRpc = Rpc.make("recording.pause", {
  error: BrowserRpcError,
  payload: RecordingPause,
  success: RecordingResult,
});
const RecordingResumeRpc = Rpc.make("recording.resume", {
  error: BrowserRpcError,
  payload: RecordingResume,
  success: RecordingResult,
});
const RecordingRecoverRpc = Rpc.make("recording.recover", {
  error: BrowserRpcError,
  payload: RecordingRecover,
  success: RecordingResult,
});
const RecordingFinishRpc = Rpc.make("recording.finish", {
  error: BrowserRpcError,
  payload: RecordingFinish,
  success: RecordingResult,
});
const RecordingDiscardRpc = Rpc.make("recording.discard", {
  error: BrowserRpcError,
  payload: RecordingDiscard,
  success: RecordingDiscarded,
});
const RecordingTitleUpdateRpc = Rpc.make("recording.title.update", {
  error: BrowserRpcError,
  payload: RecordingTitleUpdate,
  success: RecordingResult,
});
const RecordingStepDeleteRpc = Rpc.make("recording.step.delete", {
  error: BrowserRpcError,
  payload: RecordingStepDelete,
  success: RecordingResult,
});
const RecordingStepUndoRpc = Rpc.make("recording.step.undo", {
  error: BrowserRpcError,
  payload: RecordingStepUndo,
  success: RecordingResult,
});
const RecordingAuditAddRpc = Rpc.make("recording.audit.add", {
  error: BrowserRpcError,
  payload: RecordingAuditAdd,
  success: RecordingResult,
});
const RecordingStepVariableBindRpc = Rpc.make("recording.step.variable.bind", {
  error: BrowserRpcError,
  payload: RecordingStepVariableBind,
  success: RecordingResult,
});
const RecordingVariableRenameRpc = Rpc.make("recording.variable.rename", {
  error: BrowserRpcError,
  payload: RecordingVariableRename,
  success: RecordingResult,
});
const RecordingPreStepArmRpc = Rpc.make("recording.pre-step.arm", {
  error: BrowserRpcError,
  payload: RecordingPreStepArm,
  success: RecordingResult,
});
const RecordingPreStepConditionArmRpc = Rpc.make(
  "recording.pre-step.condition.arm",
  {
    error: BrowserRpcError,
    payload: RecordingPreStepConditionArm,
    success: RecordingResult,
  }
);
const RecordingPreStepConditionUrlRpc = Rpc.make(
  "recording.pre-step.condition.url",
  {
    error: BrowserRpcError,
    payload: RecordingPreStepConditionUrl,
    success: RecordingResult,
  }
);
const RecordingCaptureCancelRpc = Rpc.make("recording.capture.cancel", {
  error: BrowserRpcError,
  payload: RecordingCaptureCancel,
  success: RecordingResult,
});
const RecordingHoverArmRpc = Rpc.make("recording.hover.arm", {
  error: BrowserRpcError,
  payload: RecordingHoverArm,
  success: RecordingResult,
});
const RecordingStreamSubscribeRpc = Rpc.make("recording.stream.subscribe", {
  error: BrowserRpcError,
  payload: RecordingStreamSubscribe,
  stream: true,
  success: RecordingSnapshot,
});

const RunGetRpc = Rpc.make("run.get", {
  error: BrowserRpcError,
  payload: RunGet,
  success: RunResult,
});
const RunStartRpc = Rpc.make("run.start", {
  error: BrowserRpcError,
  payload: RunStart,
  success: RunResult,
});
const RunVariableAnswerRpc = Rpc.make("run.variable.answer", {
  error: BrowserRpcError,
  payload: RunVariableAnswer,
  success: RunResult,
});
const RunFlowLoadRpc = Rpc.make("run.flow.load", {
  error: BrowserRpcError,
  payload: RunFlowLoad,
  success: RunResult,
});
const RunStreamSubscribeRpc = Rpc.make("run.stream.subscribe", {
  error: BrowserRpcError,
  payload: RunStreamSubscribe,
  stream: true,
  success: RunSnapshot,
});

const AgentSessionsGetRpc = Rpc.make("agent.sessions.get", {
  error: BrowserRpcError,
  payload: AgentSessionsGet,
  success: AgentSessionsResult,
});
const AgentSessionStartRpc = Rpc.make("agent.session.start", {
  error: BrowserRpcError,
  payload: AgentSessionStartRequest,
  success: AgentSessionStarted,
});
const AgentSessionGetRpc = Rpc.make("agent.session.get", {
  error: BrowserRpcError,
  payload: AgentSessionGetRequest,
  success: AgentSessionResult,
});
const AgentSessionCloseRpc = Rpc.make("agent.session.close", {
  error: BrowserRpcError,
  payload: AgentSessionCloseRequest,
  success: AgentSessionClosed,
});
const AgentSessionStreamSubscribeRpc = Rpc.make(
  "agent.session.stream.subscribe",
  {
    error: BrowserRpcError,
    payload: AgentSessionStreamSubscribeRequest,
    stream: true,
    success: AgentSessionSnapshot,
  }
);
const AgentBrowserStreamSubscribeRpc = Rpc.make(
  "agent.browser.stream.subscribe",
  {
    error: BrowserRpcError,
    payload: AgentBrowserStreamSubscribe,
    stream: true,
    success: BrowserStreamEvent,
  }
);
const AgentBrowserFrameAckRpc = Rpc.make("agent.browser.frame.ack", {
  error: BrowserRpcError,
  payload: AgentBrowserFrameAck,
  success: AgentBrowserFrameAcked,
});
const AgentSessionTakeoverRpc = Rpc.make("agent.session.takeover", {
  error: BrowserRpcError,
  payload: AgentSessionTakeoverRequest,
  success: AgentSessionTakeoverStarted,
});
const AgentSessionControlReturnRpc = Rpc.make("agent.session.control.return", {
  error: BrowserRpcError,
  payload: AgentSessionControlReturnRequest,
  success: AgentSessionControlReturned,
});
const AgentBrowserInputSendRpc = Rpc.make("agent.browser.input.send", {
  error: BrowserRpcError,
  payload: AgentBrowserInputSend,
  success: AgentBrowserInputSent,
});

export class ContingencyRpcs extends RpcGroup.make(
  BrowserSessionsGetRpc,
  BrowserSessionCreateRpc,
  BrowserSessionAttachRpc,
  BrowserSessionCloseRpc,
  BrowserOpenRpc,
  BrowserNavigationRunRpc,
  BrowserViewportSetRpc,
  BrowserUserAgentSetRpc,
  BrowserEmulationGetRpc,
  BrowserEmulationSetRpc,
  BrowserStreamSubscribeRpc,
  BrowserInputSendRpc,
  BrowserFrameAckRpc,
  BrowserTabsGetRpc,
  BrowserTabNewRpc,
  BrowserTabSwitchRpc,
  BrowserTabCloseRpc,
  BrowserNetworkRequestsGetRpc,
  BrowserNetworkRequestGetRpc,
  BrowserStorageGetRpc,
  BrowserStorageSetRpc,
  BrowserStorageDeleteRpc,
  BrowserStorageClearRpc,
  RecordingGetRpc,
  RecordingStartRpc,
  RecordingPauseRpc,
  RecordingResumeRpc,
  RecordingRecoverRpc,
  RecordingFinishRpc,
  RecordingDiscardRpc,
  RecordingTitleUpdateRpc,
  RecordingStepDeleteRpc,
  RecordingStepUndoRpc,
  RecordingAuditAddRpc,
  RecordingStepVariableBindRpc,
  RecordingVariableRenameRpc,
  RecordingPreStepArmRpc,
  RecordingPreStepConditionArmRpc,
  RecordingPreStepConditionUrlRpc,
  RecordingCaptureCancelRpc,
  RecordingHoverArmRpc,
  RecordingStreamSubscribeRpc,
  RunGetRpc,
  RunStartRpc,
  RunVariableAnswerRpc,
  RunStreamSubscribeRpc,
  RunFlowLoadRpc,
  AgentSessionsGetRpc,
  AgentSessionStartRpc,
  AgentSessionGetRpc,
  AgentSessionCloseRpc,
  AgentSessionStreamSubscribeRpc,
  AgentBrowserStreamSubscribeRpc,
  AgentBrowserFrameAckRpc,
  AgentSessionTakeoverRpc,
  AgentSessionControlReturnRpc,
  AgentBrowserInputSendRpc
) {}
