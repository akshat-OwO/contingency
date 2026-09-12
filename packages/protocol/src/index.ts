import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";

import {
  AgentActionResult,
  AgentBrowserObserve,
  AgentHistoryAction,
  AgentNavigateAction,
} from "./agent-browser.ts";
import {
  AgentFlowApprove,
  AgentFlowArchive,
  AgentFlowDelete,
  AgentFlowDeleteResult,
  AgentFlowGet,
  AgentFlowRevisionDetail,
  AgentFlowVerificationAuthorize,
  TeachingVariableInput,
} from "./agent-flow.ts";
import {
  AgentRunCeilingExtend,
  AgentRunOpen,
  AgentRunSummary,
  AgentRunViewer,
} from "./agent-run.ts";
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
import { BrowserTabId } from "./browser-identifiers.ts";
import { BrowserIdentity, UserAgentProfileId } from "./browser-identity.ts";
import { BrowserRpcError } from "./browser-rpc-error.ts";
import { Geolocation, PermissionDecisions } from "./emulation.ts";
import { optionalNullable } from "./optional-field.ts";
import {
  BrowserCookieWrite,
  BrowserStorageSnapshot,
  StorageKind,
} from "./storage.ts";
import { Viewport } from "./viewport.ts";

// The protocol package intentionally exposes one public contract surface.
// oxlint-disable-next-line oxc/no-barrel-file
export * from "./emulation.ts";
// oxlint-disable-next-line oxc/no-barrel-file
export * from "./storage.ts";
// oxlint-disable-next-line oxc/no-barrel-file
export * from "./agent-identifiers.ts";
// oxlint-disable-next-line oxc/no-barrel-file
export * from "./agent-session.ts";
// oxlint-disable-next-line oxc/no-barrel-file
export * from "./agent-browser.ts";
// oxlint-disable-next-line oxc/no-barrel-file
export * from "./agent-flow.ts";
// oxlint-disable-next-line oxc/no-barrel-file
export * from "./agent-run.ts";
// oxlint-disable-next-line oxc/no-barrel-file
export * from "./optional-field.ts";
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
  viewportForIdentity,
} from "./browser-identity.ts";
export type {
  MatchedUserAgentProfile,
  ProfileIdentity,
  UserAgentProfile,
} from "./browser-identity.ts";

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

export const BrowserHeaders = Schema.Record(Schema.String, Schema.String);
export type BrowserHeaders = typeof BrowserHeaders.Type;

export const BrowserNetworkRequest = Schema.Struct({
  headers: BrowserHeaders,
  method: Schema.String,
  mimeType: optionalNullable(Schema.String),
  postData: optionalNullable(Schema.String),
  requestId: BrowserRequestId,
  resourceType: Schema.String,
  responseHeaders: optionalNullable(BrowserHeaders),
  status: optionalNullable(Schema.Int),
  tabId: BrowserTabId,
  timestamp: Schema.Int,
  url: Schema.String,
});
export type BrowserNetworkRequest = typeof BrowserNetworkRequest.Type;

export const BrowserNetworkRequestDetail = Schema.Struct({
  ...BrowserNetworkRequest.fields,
  initiator: optionalNullable(Schema.Unknown),
  responseBody: optionalNullable(Schema.String),
  timing: optionalNullable(Schema.Unknown),
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
  button: optionalNullable(MouseButton),
  clickCount: optionalNullable(Schema.Int),
  deltaX: optionalNullable(Schema.Finite),
  deltaY: optionalNullable(Schema.Finite),
  eventType: Schema.Literals([
    "mousePressed",
    "mouseReleased",
    "mouseMoved",
    "mouseWheel",
  ]),
  modifiers: optionalNullable(Schema.Int),
  type: Schema.Literal("input_mouse"),
  x: Schema.Finite,
  y: Schema.Finite,
});
export type MouseInput = typeof MouseInput.Type;

export const KeyboardInput = Schema.Struct({
  code: optionalNullable(Schema.String),
  eventType: Schema.Literals(["keyDown", "keyUp", "char"]),
  key: optionalNullable(Schema.String),
  modifiers: optionalNullable(Schema.Int),
  text: optionalNullable(Schema.String),
  type: Schema.Literal("input_keyboard"),
  windowsVirtualKeyCode: optionalNullable(Schema.Int),
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
  recording: optionalNullable(Schema.Boolean),
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
    timestamp: optionalNullable(Schema.Finite),
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
  "agent.teaching.variable.input",
  "agent.teaching.variable.input.result",
  "agent.browser.navigate",
  "agent.browser.navigated",
  "agent.flow.revision.get",
  "agent.flow.revision.result",
  "agent.flow.verification.authorize",
  "agent.flow.approve",
  "agent.run.summary.get",
  "agent.run.summary.result",
  "agent.run.ceiling.extend",
]);
export type BrandId = typeof BrandId.Type;

const nonEmptyProtocolString = Schema.String.check(Schema.isMinLength(1));

/**
 * The emulation a session currently applies to every Page it
 * opens: the Flow's Emulation shape ([ADR
 * 0013](../../../docs/adr/0013-emulation-belongs-to-the-flow.md)) with
 * permission decisions as a plain list, because a fresh session has decided
 * nothing rather than declaring nothing.
 */
export const SessionEmulation = Schema.Struct({
  /** The concrete browser identity the session applies to every Page. */
  browser: optionalNullable(BrowserIdentity),
  colorScheme: optionalNullable(Schema.Literals(["light", "dark"])),
  geolocation: optionalNullable(Geolocation),
  locale: optionalNullable(nonEmptyProtocolString),
  permissions: PermissionDecisions,
  timezoneId: optionalNullable(nonEmptyProtocolString),
  userAgent: optionalNullable(nonEmptyProtocolString),
  viewport: Viewport,
});
export type SessionEmulation = typeof SessionEmulation.Type;

/** Agent View's process-owned session boundary. */
export const AgentSessionsGet = request("agent.sessions.get", {});
export const AgentSessionsResult = response("agent.sessions.result", {
  sessions: Schema.Array(AgentSessionSnapshot),
});

export const AgentSessionStartRequest = request("agent.session.start", {
  activity: AgentSessionStart.fields.activity,
  clientName: AgentSessionStart.fields.clientName,
  clientVersion: AgentSessionStart.fields.clientVersion,
  emulation: AgentSessionStart.fields.emulation,
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

/** Agent View enters one private Variable into the currently focused field. */
export const AgentTeachingVariableInput = request(
  "agent.teaching.variable.input",
  {
    operationId: TeachingVariableInput.fields.operationId,
    ref: TeachingVariableInput.fields.ref,
    sessionId: TeachingVariableInput.fields.sessionId,
    value: TeachingVariableInput.fields.value,
    variable: TeachingVariableInput.fields.variable,
  }
);
export const AgentTeachingVariableInputResult = response(
  "agent.teaching.variable.input.result",
  { action: AgentActionResult }
);

/**
 * Address-bar and history navigation while the user holds the browser. It
 * carries the same actions the agent may take, so a Takeover is a real
 * browser, not a viewport: only the actor changes.
 */
export const AgentBrowserNavigate = request("agent.browser.navigate", {
  action: Schema.Union([AgentNavigateAction, AgentHistoryAction]),
  sessionId: AgentBrowserObserve.fields.sessionId,
});
export const AgentBrowserNavigated = response("agent.browser.navigated", {
  session: AgentSessionSnapshot,
});

/**
 * Browser setup tooling in the Workspace. The Agent Session owns the browser,
 * so its lower-level session id never leaves the process: every setup call is
 * addressed by Agent Session id and delegated inside the boundary
 * ([ADR 0038](../../../docs/adr/0038-contingency-is-an-agent-sanity-monitor.md)).
 */
export const AgentBrowserEmulationGet = request("agent.browser.emulation.get", {
  sessionId: AgentBrowserObserve.fields.sessionId,
});
/**
 * Update the whole Emulation the Agent Session's browser applies. Absent
 * leaves a part unchanged and `null` clears it (ADR 0013); identity and
 * viewport travel with the same request, so a phone identity is never applied
 * over a desktop viewport.
 */
export const AgentBrowserEmulationSet = request("agent.browser.emulation.set", {
  colorScheme: Schema.optional(
    Schema.NullOr(Schema.Literals(["light", "dark"]))
  ),
  geolocation: Schema.optional(Schema.NullOr(Geolocation)),
  locale: Schema.optional(Schema.NullOr(nonEmptyProtocolString)),
  permissions: Schema.optional(Schema.NullOr(PermissionDecisions)),
  sessionId: AgentBrowserObserve.fields.sessionId,
  timezoneId: Schema.optional(Schema.NullOr(nonEmptyProtocolString)),
  userAgentProfile: Schema.optional(UserAgentProfileId),
  viewport: Schema.optional(Viewport),
});
export const AgentBrowserEmulationUpdated = response(
  "agent.browser.emulation.updated",
  {
    emulation: SessionEmulation,
    /**
     * The identity the session was asked for. A session reports the concrete
     * identity it resolved to, so the profile behind it is named separately
     * rather than guessed back out of a user agent string.
     */
    userAgentProfile: UserAgentProfileId,
  }
);

export const AgentBrowserTabsGet = request("agent.browser.tabs.get", {
  sessionId: AgentBrowserObserve.fields.sessionId,
});
export const AgentBrowserTabsResult = response("agent.browser.tabs.result", {
  tabs: Schema.Array(BrowserTab),
});

export const AgentBrowserNetworkRequestsGet = request(
  "agent.browser.network.requests.get",
  { sessionId: AgentBrowserObserve.fields.sessionId, tabId: BrowserTabId }
);
export const AgentBrowserNetworkRequestsResult = response(
  "agent.browser.network.requests.result",
  { requests: Schema.Array(BrowserNetworkRequest) }
);
export const AgentBrowserNetworkRequestGet = request(
  "agent.browser.network.request.get",
  {
    requestId: BrowserRequestId,
    sessionId: AgentBrowserObserve.fields.sessionId,
    tabId: BrowserTabId,
  }
);
export const AgentBrowserNetworkRequestResult = response(
  "agent.browser.network.request.result",
  { request: BrowserNetworkRequestDetail }
);

export const AgentBrowserStorageGet = request("agent.browser.storage.get", {
  kind: StorageKind,
  sessionId: AgentBrowserObserve.fields.sessionId,
  tabId: BrowserTabId,
});
export const AgentBrowserStorageResult = response(
  "agent.browser.storage.result",
  { snapshot: BrowserStorageSnapshot }
);
export const AgentBrowserStorageSetPayload = Schema.Union([
  Schema.Struct({
    cookie: BrowserCookieWrite,
    kind: Schema.Literal("cookies"),
    sessionId: AgentBrowserObserve.fields.sessionId,
    tabId: BrowserTabId,
  }),
  Schema.Struct({
    key: nonEmptyProtocolString,
    kind: Schema.Literals(["local", "session"]),
    sessionId: AgentBrowserObserve.fields.sessionId,
    tabId: BrowserTabId,
    value: Schema.String,
  }),
]);
export const AgentBrowserStorageSet = Schema.Struct({
  data: AgentBrowserStorageSetPayload,
  type: Schema.Literal("agent.browser.storage.set"),
});
export const AgentBrowserStorageDeletePayload = Schema.Union([
  Schema.Struct({
    domain: nonEmptyProtocolString,
    kind: Schema.Literal("cookies"),
    name: Schema.String,
    path: nonEmptyProtocolString,
    sessionId: AgentBrowserObserve.fields.sessionId,
    tabId: BrowserTabId,
  }),
  Schema.Struct({
    key: nonEmptyProtocolString,
    kind: Schema.Literals(["local", "session"]),
    sessionId: AgentBrowserObserve.fields.sessionId,
    tabId: BrowserTabId,
  }),
]);
export const AgentBrowserStorageDelete = Schema.Struct({
  data: AgentBrowserStorageDeletePayload,
  type: Schema.Literal("agent.browser.storage.delete"),
});
export const AgentBrowserStorageClear = request("agent.browser.storage.clear", {
  kind: StorageKind,
  sessionId: AgentBrowserObserve.fields.sessionId,
  tabId: BrowserTabId,
});
export const AgentBrowserStorageUpdated = response(
  "agent.browser.storage.updated",
  {}
);

/** Reading the draft under review. Agent View shows what verification covers. */
export const AgentFlowRevisionGet = request("agent.flow.revision.get", {
  agentFlowId: AgentFlowGet.fields.agentFlowId,
  revisionId: AgentFlowGet.fields.revisionId,
});
export const AgentFlowRevisionResult = response("agent.flow.revision.result", {
  evidence: AgentFlowRevisionDetail.fields.evidence,
  revision: AgentFlowRevisionDetail.fields.revision,
});

/**
 * The two gestures the external agent may ask for but never perform. They
 * exist only on Agent View's loopback RPC
 * ([ADR 0027](../../../docs/adr/0027-agent-authority-has-a-user-approved-execution-boundary.md)).
 */
export const AgentFlowVerificationAuthorizeRequest = request(
  "agent.flow.verification.authorize",
  {
    agentFlowId: AgentFlowVerificationAuthorize.fields.agentFlowId,
    operationId: AgentFlowVerificationAuthorize.fields.operationId,
    revisionId: AgentFlowVerificationAuthorize.fields.revisionId,
    sessionId: AgentFlowVerificationAuthorize.fields.sessionId,
  }
);
export const AgentFlowApproveRequest = request("agent.flow.approve", {
  agentFlowId: AgentFlowApprove.fields.agentFlowId,
  operationId: AgentFlowApprove.fields.operationId,
  revisionId: AgentFlowApprove.fields.revisionId,
});
/**
 * Reading a persisted Run Summary. Agent View uses it in summary mode, and a
 * read-only viewer opened by `open_run` uses nothing else: no browser state is
 * restored ([ADR 0030](../../../docs/adr/0030-agent-view-is-separate-from-audit-view.md)).
 */
export const AgentRunSummaryGet = request("agent.run.summary.get", {
  runId: AgentRunOpen.fields.runId,
});
export const AgentRunSummaryResult = response("agent.run.summary.result", {
  summary: AgentRunSummary,
  viewUrl: AgentRunViewer.fields.viewUrl,
});

/**
 * Extending an Agent Step or Run ceiling. It exists only here: the agent whose
 * work the ceiling bounds may not raise its own budget
 * ([ADR 0029](../../../docs/adr/0029-contingency-owns-the-sole-runner.md)).
 */
export const AgentRunCeilingExtendRequest = request(
  "agent.run.ceiling.extend",
  {
    additionalMs: AgentRunCeilingExtend.fields.additionalMs,
    operationId: AgentRunCeilingExtend.fields.operationId,
    scope: AgentRunCeilingExtend.fields.scope,
    sessionId: AgentRunCeilingExtend.fields.sessionId,
  }
);

export const AgentFlowArchiveRequest = request("agent.flow.archive", {
  agentFlowId: AgentFlowArchive.fields.agentFlowId,
  archived: AgentFlowArchive.fields.archived,
  expectedHeads: AgentFlowArchive.fields.expectedHeads,
  operationId: AgentFlowArchive.fields.operationId,
});
export const AgentFlowDeleteRequest = request("agent.flow.delete", {
  agentFlowId: AgentFlowDelete.fields.agentFlowId,
  confirmation: AgentFlowDelete.fields.confirmation,
  expectedHeads: AgentFlowDelete.fields.expectedHeads,
  operationId: AgentFlowDelete.fields.operationId,
});
export const AgentFlowDeleted = response("agent.flow.deleted", {
  agentFlowId: AgentFlowDeleteResult.fields.agentFlowId,
  deleted: AgentFlowDeleteResult.fields.deleted,
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
const AgentTeachingVariableInputRpc = Rpc.make(
  "agent.teaching.variable.input",
  {
    error: BrowserRpcError,
    payload: AgentTeachingVariableInput,
    success: AgentTeachingVariableInputResult,
  }
);
const AgentBrowserNavigateRpc = Rpc.make("agent.browser.navigate", {
  error: BrowserRpcError,
  payload: AgentBrowserNavigate,
  success: AgentBrowserNavigated,
});
const AgentBrowserEmulationGetRpc = Rpc.make("agent.browser.emulation.get", {
  error: BrowserRpcError,
  payload: AgentBrowserEmulationGet,
  success: AgentBrowserEmulationUpdated,
});
const AgentBrowserEmulationSetRpc = Rpc.make("agent.browser.emulation.set", {
  error: BrowserRpcError,
  payload: AgentBrowserEmulationSet,
  success: AgentBrowserEmulationUpdated,
});
const AgentBrowserTabsGetRpc = Rpc.make("agent.browser.tabs.get", {
  error: BrowserRpcError,
  payload: AgentBrowserTabsGet,
  success: AgentBrowserTabsResult,
});
const AgentBrowserNetworkRequestsGetRpc = Rpc.make(
  "agent.browser.network.requests.get",
  {
    error: BrowserRpcError,
    payload: AgentBrowserNetworkRequestsGet,
    success: AgentBrowserNetworkRequestsResult,
  }
);
const AgentBrowserNetworkRequestGetRpc = Rpc.make(
  "agent.browser.network.request.get",
  {
    error: BrowserRpcError,
    payload: AgentBrowserNetworkRequestGet,
    success: AgentBrowserNetworkRequestResult,
  }
);
const AgentBrowserStorageGetRpc = Rpc.make("agent.browser.storage.get", {
  error: BrowserRpcError,
  payload: AgentBrowserStorageGet,
  success: AgentBrowserStorageResult,
});
const AgentBrowserStorageSetRpc = Rpc.make("agent.browser.storage.set", {
  error: BrowserRpcError,
  payload: AgentBrowserStorageSet,
  success: AgentBrowserStorageUpdated,
});
const AgentBrowserStorageDeleteRpc = Rpc.make("agent.browser.storage.delete", {
  error: BrowserRpcError,
  payload: AgentBrowserStorageDelete,
  success: AgentBrowserStorageUpdated,
});
const AgentBrowserStorageClearRpc = Rpc.make("agent.browser.storage.clear", {
  error: BrowserRpcError,
  payload: AgentBrowserStorageClear,
  success: AgentBrowserStorageUpdated,
});
const AgentFlowRevisionGetRpc = Rpc.make("agent.flow.revision.get", {
  error: BrowserRpcError,
  payload: AgentFlowRevisionGet,
  success: AgentFlowRevisionResult,
});
const AgentFlowVerificationAuthorizeRpc = Rpc.make(
  "agent.flow.verification.authorize",
  {
    error: BrowserRpcError,
    payload: AgentFlowVerificationAuthorizeRequest,
    success: AgentFlowRevisionResult,
  }
);
const AgentFlowApproveRpc = Rpc.make("agent.flow.approve", {
  error: BrowserRpcError,
  payload: AgentFlowApproveRequest,
  success: AgentFlowRevisionResult,
});
const AgentRunSummaryGetRpc = Rpc.make("agent.run.summary.get", {
  error: BrowserRpcError,
  payload: AgentRunSummaryGet,
  success: AgentRunSummaryResult,
});
const AgentRunCeilingExtendRpc = Rpc.make("agent.run.ceiling.extend", {
  error: BrowserRpcError,
  payload: AgentRunCeilingExtendRequest,
  success: AgentSessionResult,
});
const AgentFlowArchiveRpc = Rpc.make("agent.flow.archive", {
  error: BrowserRpcError,
  payload: AgentFlowArchiveRequest,
  success: AgentFlowRevisionResult,
});
const AgentFlowDeleteRpc = Rpc.make("agent.flow.delete", {
  error: BrowserRpcError,
  payload: AgentFlowDeleteRequest,
  success: AgentFlowDeleted,
});

export class ContingencyRpcs extends RpcGroup.make(
  AgentSessionsGetRpc,
  AgentSessionStartRpc,
  AgentSessionGetRpc,
  AgentSessionCloseRpc,
  AgentSessionStreamSubscribeRpc,
  AgentBrowserStreamSubscribeRpc,
  AgentBrowserFrameAckRpc,
  AgentSessionTakeoverRpc,
  AgentSessionControlReturnRpc,
  AgentBrowserInputSendRpc,
  AgentTeachingVariableInputRpc,
  AgentBrowserNavigateRpc,
  AgentBrowserEmulationGetRpc,
  AgentBrowserEmulationSetRpc,
  AgentBrowserTabsGetRpc,
  AgentBrowserNetworkRequestsGetRpc,
  AgentBrowserNetworkRequestGetRpc,
  AgentBrowserStorageGetRpc,
  AgentBrowserStorageSetRpc,
  AgentBrowserStorageDeleteRpc,
  AgentBrowserStorageClearRpc,
  AgentFlowRevisionGetRpc,
  AgentFlowVerificationAuthorizeRpc,
  AgentFlowApproveRpc,
  AgentFlowArchiveRpc,
  AgentFlowDeleteRpc,
  AgentRunSummaryGetRpc,
  AgentRunCeilingExtendRpc
) {}
