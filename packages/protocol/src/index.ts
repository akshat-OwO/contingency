import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

import {
  AgentActionResult,
  AgentBrowserObserve,
  AgentElementRef,
  AgentHistoryAction,
  AgentNavigateAction,
} from "./agent-browser.ts";
import { AgentPendingDecisionResolve } from "./agent-decision.ts";
import { AgentRunOpen, AgentRunSummary, AgentRunViewer } from "./agent-run.ts";
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
  AgentSetupVariableAnswer,
} from "./agent-session.ts";
import { browserAttachmentsField } from "./browser-checks.ts";
import { BrowserTabId } from "./browser-identifiers.ts";
import { BrowserIdentity, UserAgentProfileId } from "./browser-identity.ts";
import { BrowserRpcError } from "./browser-rpc-error.ts";
import {
  CatalogBrowseGet,
  CatalogBrowseResult,
  CatalogFlowSkillGet,
  CatalogFlowSkillResult,
} from "./catalog-browser.ts";
import { Geolocation, PermissionDecisions } from "./emulation.ts";
import { optionalNullable } from "./optional-field.ts";
import { TeachingScan } from "./scans.ts";
import {
  BrowserCookieWrite,
  BrowserStorageSnapshot,
  StorageKind,
} from "./storage.ts";
import {
  FlowSkillName,
  TeachingCaptureState,
  TeachingRecordingCleanupState,
  TeachingRecordingId,
  TeachingVariableInput,
} from "./teaching-recording.ts";
import { Viewport } from "./viewport.ts";

// The protocol package intentionally exposes one public contract surface.
// oxlint-disable-next-line oxc/no-barrel-file
export * from "./browser-checks.ts";
// oxlint-disable-next-line oxc/no-barrel-file
export * from "./scans.ts";
// oxlint-disable-next-line oxc/no-barrel-file
export * from "./emulation.ts";
// oxlint-disable-next-line oxc/no-barrel-file
export * from "./storage.ts";
// oxlint-disable-next-line oxc/no-barrel-file
export * from "./agent-identifiers.ts";
// oxlint-disable-next-line oxc/no-barrel-file
export * from "./agent-session.ts";
export * from "./agent-session-compact.ts";
// oxlint-disable-next-line oxc/no-barrel-file
export * from "./agent-browser.ts";
// oxlint-disable-next-line oxc/no-barrel-file
export * from "./agent-decision.ts";
// oxlint-disable-next-line oxc/no-barrel-file
export * from "./agent-pursuit.ts";
// oxlint-disable-next-line oxc/no-barrel-file
export * from "./agent-run.ts";
// oxlint-disable-next-line oxc/no-barrel-file
export * from "./agent-cursor-path.ts";
// oxlint-disable-next-line oxc/no-barrel-file
export * from "./run-video.ts";
// oxlint-disable-next-line oxc/no-barrel-file
export * from "./teaching-recording.ts";
// oxlint-disable-next-line oxc/no-barrel-file
export * from "./catalog-browser.ts";
// oxlint-disable-next-line oxc/no-barrel-file
export * from "./optional-field.ts";
export {
  BrowserTabId,
  SessionId,
  sessionPrefixes,
} from "./browser-identifiers.ts";
export type { SessionPrefix } from "./browser-identifiers.ts";

export {
  BrowserFailureReason,
  BrowserRpcError,
  isBrowserRpcError,
  makeBrowserRpcError,
} from "./browser-rpc-error.ts";
export type {
  BrowserFailureReason as BrowserFailureReasonType,
  BrowserRpcError as BrowserRpcErrorType,
} from "./browser-rpc-error.ts";

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

/**
 * A site's bot protection rejected a request from the session's browser. The
 * Workspace says so, because a blocked login otherwise looks like a broken
 * site or a broken Flow Skill (#266).
 */
export const BrowserBotProtectionBlock = Schema.Struct({
  provider: Schema.Literal("cloudflare"),
  status: Schema.Int,
  tabId: BrowserTabId,
  timestamp: Schema.Finite,
  type: Schema.Literal("bot_protection_block"),
  url: Schema.String,
});
export type BrowserBotProtectionBlock = typeof BrowserBotProtectionBlock.Type;

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
  data: Schema.Uint8Array,
  metadata: Schema.Struct({
    deviceHeight: Schema.Int,
    deviceWidth: Schema.Int,
    offsetTop: Schema.Finite,
    pageScaleFactor: Schema.Finite,
    scrollOffsetX: Schema.Finite,
    scrollOffsetY: Schema.Finite,
    timestamp: Schema.Finite,
  }),
  receivedAt: Schema.optional(Schema.Finite),
  replayed: Schema.optional(Schema.Boolean),
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

/**
 * Where the agent is about to act, in CSS pixels of the Page viewport. The
 * Workspace draws a cursor travelling to it, so a watcher sees which control
 * the agent reaches for. `click` marks a press; `move` only reaches the
 * control, as a hover, fill, or keyboard action does. `durationMs` is how
 * long the stroke takes: the server waits that long before acting, so the
 * cursor arrives before the Page reacts.
 */
export const BrowserAgentPointer = Schema.Struct({
  action: Schema.Literals(["move", "click"]),
  durationMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  timestamp: Schema.Finite,
  type: Schema.Literal("agent_pointer"),
  x: Schema.Finite,
  y: Schema.Finite,
});
export type BrowserAgentPointer = typeof BrowserAgentPointer.Type;

/** Where the agent's cursor enters from, relative to its first target. */
export const AGENT_POINTER_ENTRY_OFFSET = { x: -72, y: 96 } as const;

/**
 * How long the agent's cursor takes to travel `distance` CSS pixels. It grows
 * with the logarithm of the distance, as Fitts's law has it, so a long reach
 * is not proportionally slower than a short one; the ceiling bounds what the
 * wait costs each action.
 */
export const agentPointerTravelMs = (distance: number): number =>
  distance < 1
    ? 0
    : Math.round(
        Math.min(420, Math.max(160, 120 + 70 * Math.log2(1 + distance / 24)))
      );

export const BrowserStreamEvent = Schema.Union([
  Schema.Struct({ ...AgentBrowserFrame.fields, streamId: BrowserStreamId }),
  BrowserStreamStatus,
  BrowserAgentPointer,
  Schema.Struct({
    tabId: BrowserTabId,
    timestamp: optionalNullable(Schema.Finite),
    type: Schema.Literal("url"),
    url: Schema.String,
  }),
  BrowserConsoleEntry,
  BrowserBotProtectionBlock,
  BrowserTabsEvent,
]);
export type BrowserStreamEvent = typeof BrowserStreamEvent.Type;

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
export const AgentSessionsGet = Schema.Struct({});
export const AgentSessionsResult = Schema.Struct({
  sessions: Schema.Array(AgentSessionSnapshot),
});

export const AgentSessionStartRequest = AgentSessionStart;
export const AgentSessionStarted = AgentSessionStartResult;

export const AgentSessionGetRequest = AgentSessionGet;
export const AgentSessionResult = AgentSessionGetResult;

export const AgentSessionCloseRequest = AgentSessionClose;
export const AgentSessionClosed = AgentSessionCloseResult;

/**
 * Start and Stop are the Teaching privacy boundary ([ADR
 * 0039](../../../docs/adr/0039-flow-skills-are-learned-from-temporary-teaching-recordings.md)).
 * Nothing is captured until the user starts a recording, and every capture
 * source stops against one end timestamp. `operationId` makes each gesture
 * safe to retry: a repeated id returns the same recording rather than opening
 * a second one.
 */
export const AgentTeachingRecordingStartRequest = Schema.Struct({
  operationId: AgentSessionClose.fields.operationId,
  sessionId: AgentSessionClose.fields.sessionId,
});
export const AgentTeachingRecordingStarted = Schema.Struct({
  session: AgentSessionSnapshot,
});

export const AgentTeachingRecordingStopRequest = Schema.Struct({
  operationId: AgentSessionClose.fields.operationId,
  sessionId: AgentSessionClose.fields.sessionId,
});
export const AgentTeachingRecordingStopped = Schema.Struct({
  session: AgentSessionSnapshot,
});

/**
 * Discarding a recording the user does not want to keep. It removes the
 * captured artifacts and returns the session to `setup`, so the next Start
 * records into a clean bundle in the same browser setup.
 */
export const AgentTeachingRecordingDiscardRequest = Schema.Struct({
  operationId: AgentSessionClose.fields.operationId,
  sessionId: AgentSessionClose.fields.sessionId,
});
export const AgentTeachingRecordingDiscarded = Schema.Struct({
  session: AgentSessionSnapshot,
});

const teachingFlowLifecycleRequest = {
  operationId: AgentSessionClose.fields.operationId,
  recordingId: TeachingRecordingId,
};
const teachingFlowLifecycleResponse = {
  captureState: TeachingCaptureState,
  cleanup: TeachingRecordingCleanupState,
};

export const AgentTeachingDryRunStopRequest = Schema.Struct(
  teachingFlowLifecycleRequest
);
export const AgentTeachingDryRunStopped = Schema.Struct(
  teachingFlowLifecycleResponse
);
export const AgentTeachingFlowRejectRequest = Schema.Struct(
  teachingFlowLifecycleRequest
);
export const AgentTeachingFlowRejected = Schema.Struct(
  teachingFlowLifecycleResponse
);
export const AgentTeachingFlowVerifyRequest = Schema.Struct(
  teachingFlowLifecycleRequest
);
export const AgentTeachingFlowVerified = Schema.Struct(
  teachingFlowLifecycleResponse
);
export const AgentTeachingCleanupRetryRequest = Schema.Struct(
  teachingFlowLifecycleRequest
);
export const AgentTeachingCleanupRetried = Schema.Struct(
  teachingFlowLifecycleResponse
);

/**
 * An instruction the user attached from the Workspace while recording. It is
 * the same Teaching instruction the agent relays over MCP, so an inspect
 * comment and a relayed instruction land in one Demonstration rather than two.
 */
export const AgentTeachingInstructionRecordRequest = Schema.Struct({
  attachments: browserAttachmentsField,
  operationId: AgentSessionClose.fields.operationId,
  replaceId: optionalNullable(Schema.String),
  scan: Schema.optional(TeachingScan),
  sessionId: AgentSessionClose.fields.sessionId,
  /**
   * The element the comment was attached to, by role and accessible name.
   * Absent when the instruction names no element, as a relayed one does.
   */
  target: optionalNullable(Schema.String.check(Schema.isMinLength(1))),
  text: Schema.String.check(Schema.isMinLength(1)),
});
export const AgentTeachingInstructionRecorded = Schema.Struct({
  session: AgentSessionSnapshot,
});

/** Renaming the Flow Skill a Teaching session is about to demonstrate. */
export const AgentTeachingFlowRenameRequest = Schema.Struct({
  name: FlowSkillName,
  operationId: AgentSessionClose.fields.operationId,
  sessionId: AgentSessionClose.fields.sessionId,
});
export const AgentTeachingFlowRenamed = Schema.Struct({
  session: AgentSessionSnapshot,
});

/**
 * The element under a point of the live Page, read through the Browser
 * Snapshot rather than the screencast bitmap the Workspace draws. Inspect
 * needs the real element to outline and to name in an instruction.
 */
export const AgentBrowserElementInspectRequest = Schema.Struct({
  sessionId: AgentSessionClose.fields.sessionId,
  x: Schema.Finite,
  y: Schema.Finite,
});
export const AgentInspectedElement = Schema.Struct({
  /** The role and accessible name, as the Browser Snapshot read them. */
  description: Schema.String,
  height: Schema.Finite,
  ref: AgentElementRef,
  width: Schema.Finite,
  /** Page viewport coordinates, in CSS pixels. */
  x: Schema.Finite,
  y: Schema.Finite,
});
export type AgentInspectedElement = typeof AgentInspectedElement.Type;

export const AgentBrowserElementInspected = Schema.Struct({
  element: AgentInspectedElement,
});

export const AgentSessionStreamSubscribeRequest = AgentSessionStreamSubscribe;

/**
 * Agent View receives browser events through the Agent Session boundary. The
 * lower-level Create Browser SessionId is intentionally not part of this
 * contract, so an MCP caller can only stream the session it owns.
 */
export const AgentBrowserStreamSubscribe = AgentSessionStreamSubscribe;
export const AgentBrowserFrameAck = Schema.Struct({
  frameId: FrameSequence,
  sessionId: AgentSessionStreamSubscribe.fields.sessionId,
  streamId: BrowserStreamId,
});
export const AgentBrowserFrameAcked = Schema.Struct({});

/**
 * Takeover is exclusive and the user has priority. Agent View initiates it
 * directly; the external agent may only request it, and that request returns
 * the Agent View link immediately rather than holding a call open while the
 * user acts ([ADR 0027](../../../docs/adr/0027-agent-authority-has-a-user-approved-execution-boundary.md)).
 */
export const AgentSessionTakeoverRequest = AgentSessionTakeover;
export const AgentSessionTakeoverStarted = Schema.Struct({
  session: AgentSessionSnapshot,
});

export const AgentSessionControlReturnRequest = AgentSessionReturnControl;
export const AgentSessionControlReturned = Schema.Struct({
  session: AgentSessionSnapshot,
});

/**
 * What the user does with the browser during Takeover. It is deliberately not
 * an MCP tool: raw input belongs to the person who took control, and control
 * is exclusive, so the agent cannot send it at all.
 *
 * Inputs arrive in the order the user made them. The Workspace sends what
 * queued while its previous request was in flight as one batch, so a key never
 * waits a round trip behind the key before it (#298).
 */
export const AgentBrowserInputSend = Schema.Struct({
  inputs: Schema.NonEmptyArray(BrowserInput).check(Schema.isMaxLength(256)),
  sessionId: AgentBrowserObserve.fields.sessionId,
});
export const AgentBrowserInputSent = Schema.Struct({});

/** Agent View enters one private Variable into the currently focused field. */
export const AgentTeachingVariableInput = TeachingVariableInput;
export const AgentTeachingVariableInputResult = Schema.Struct({
  action: AgentActionResult,
});

/** The user supplies a Dry Run secret in the Workspace, never through MCP. */
export const AgentDryRunVariableSupply = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9_]*$/u)),
  sessionId: AgentBrowserObserve.fields.sessionId,
  value: Schema.String.check(Schema.isMinLength(1)),
});
export const AgentDryRunVariableSupplied = Schema.Struct({
  session: AgentSessionSnapshot,
});
/** Workspace answers a scoped prerequisite request without passing private values to MCP. */
export const AgentDryRunVariableAnswer = Schema.Struct({
  sessionId: AgentBrowserObserve.fields.sessionId,
  ...AgentPendingDecisionResolve.fields,
});
export const AgentDryRunVariableAnswered = Schema.Struct({
  session: AgentSessionSnapshot,
});

export const AgentSetupVariableAnswerRequest = Schema.Struct(
  AgentSetupVariableAnswer.fields
);
export const AgentSetupVariableAnswered = Schema.Struct({
  session: AgentSessionSnapshot,
});

/**
 * Address-bar and history navigation while the user holds the browser. It
 * carries the same actions the agent may take, so a Takeover is a real
 * browser, not a viewport: only the actor changes.
 */
export const AgentBrowserNavigate = Schema.Struct({
  action: Schema.Union([AgentNavigateAction, AgentHistoryAction]),
  sessionId: AgentBrowserObserve.fields.sessionId,
});
export const AgentBrowserNavigated = Schema.Struct({
  session: AgentSessionSnapshot,
});

/**
 * Browser setup tooling in the Workspace. The Agent Session owns the browser,
 * so its lower-level session id never leaves the process: every setup call is
 * addressed by Agent Session id and delegated inside the boundary
 * ([ADR 0038](../../../docs/adr/0038-contingency-is-an-agent-sanity-monitor.md)).
 */
export const AgentBrowserEmulationGet = Schema.Struct({
  sessionId: AgentBrowserObserve.fields.sessionId,
});
/**
 * Update the whole Emulation the Agent Session's browser applies. Absent
 * leaves a part unchanged and `null` clears it (ADR 0013); identity and
 * viewport travel with the same request, so a phone identity is never applied
 * over a desktop viewport.
 */
export const AgentBrowserEmulationSet = Schema.Struct({
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
export const AgentBrowserEmulationUpdated = Schema.Struct({
  emulation: SessionEmulation,
  /**
   * The identity the session was asked for. A session reports the concrete
   * identity it resolved to, so the profile behind it is named separately
   * rather than guessed back out of a user agent string.
   */
  userAgentProfile: UserAgentProfileId,
});

export const AgentBrowserTabsGet = Schema.Struct({
  sessionId: AgentBrowserObserve.fields.sessionId,
});
export const AgentBrowserTabsResult = Schema.Struct({
  tabs: Schema.Array(BrowserTab),
});

export const AgentBrowserNetworkRequestsGet = Schema.Struct({
  sessionId: AgentBrowserObserve.fields.sessionId,
  tabId: BrowserTabId,
});
export const AgentBrowserNetworkRequestsResult = Schema.Struct({
  requests: Schema.Array(BrowserNetworkRequest),
});
export const AgentBrowserNetworkRequestGet = Schema.Struct({
  requestId: BrowserRequestId,
  sessionId: AgentBrowserObserve.fields.sessionId,
  tabId: BrowserTabId,
});
export const AgentBrowserNetworkRequestResult = Schema.Struct({
  request: BrowserNetworkRequestDetail,
});

export const AgentBrowserStorageGet = Schema.Struct({
  kind: StorageKind,
  sessionId: AgentBrowserObserve.fields.sessionId,
  tabId: BrowserTabId,
});
export const AgentBrowserStorageResult = Schema.Struct({
  snapshot: BrowserStorageSnapshot,
});
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
export const AgentBrowserStorageSet = AgentBrowserStorageSetPayload;
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
export const AgentBrowserStorageDelete = AgentBrowserStorageDeletePayload;
export const AgentBrowserStorageClear = Schema.Struct({
  kind: StorageKind,
  sessionId: AgentBrowserObserve.fields.sessionId,
  tabId: BrowserTabId,
});
export const AgentBrowserStorageUpdated = Schema.Struct({});

/**
 * Reading a persisted Run Summary. Agent View uses it in summary mode, and a
 * read-only viewer opened by `open_run` uses nothing else: no browser state is
 * restored ([ADR 0030](../../../docs/adr/0030-agent-view-is-separate-from-audit-view.md)).
 */
export const AgentRunSummaryGet = Schema.Struct({
  runId: AgentRunOpen.fields.runId,
});
export const AgentRunSummaryResult = Schema.Struct({
  summary: AgentRunSummary,
  viewUrl: AgentRunViewer.fields.viewUrl,
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
const AgentTeachingRecordingStartRpc = Rpc.make(
  "agent.teaching.recording.start",
  {
    error: BrowserRpcError,
    payload: AgentTeachingRecordingStartRequest,
    success: AgentTeachingRecordingStarted,
  }
);

const AgentTeachingRecordingStopRpc = Rpc.make(
  "agent.teaching.recording.stop",
  {
    error: BrowserRpcError,
    payload: AgentTeachingRecordingStopRequest,
    success: AgentTeachingRecordingStopped,
  }
);

const AgentTeachingRecordingDiscardRpc = Rpc.make(
  "agent.teaching.recording.discard",
  {
    error: BrowserRpcError,
    payload: AgentTeachingRecordingDiscardRequest,
    success: AgentTeachingRecordingDiscarded,
  }
);

const AgentTeachingDryRunStopRpc = Rpc.make("agent.teaching.dry-run.stop", {
  error: BrowserRpcError,
  payload: AgentTeachingDryRunStopRequest,
  success: AgentTeachingDryRunStopped,
});
const AgentTeachingFlowRejectRpc = Rpc.make("agent.teaching.flow.reject", {
  error: BrowserRpcError,
  payload: AgentTeachingFlowRejectRequest,
  success: AgentTeachingFlowRejected,
});
const AgentTeachingFlowVerifyRpc = Rpc.make("agent.teaching.flow.verify", {
  error: BrowserRpcError,
  payload: AgentTeachingFlowVerifyRequest,
  success: AgentTeachingFlowVerified,
});
const AgentTeachingCleanupRetryRpc = Rpc.make("agent.teaching.cleanup.retry", {
  error: BrowserRpcError,
  payload: AgentTeachingCleanupRetryRequest,
  success: AgentTeachingCleanupRetried,
});

const AgentTeachingInstructionRecordRpc = Rpc.make(
  "agent.teaching.instruction.record",
  {
    error: BrowserRpcError,
    payload: AgentTeachingInstructionRecordRequest,
    success: AgentTeachingInstructionRecorded,
  }
);

const AgentTeachingFlowRenameRpc = Rpc.make("agent.teaching.flow.rename", {
  error: BrowserRpcError,
  payload: AgentTeachingFlowRenameRequest,
  success: AgentTeachingFlowRenamed,
});

const AgentBrowserElementInspectRpc = Rpc.make(
  "agent.browser.element.inspect",
  {
    error: BrowserRpcError,
    payload: AgentBrowserElementInspectRequest,
    success: AgentBrowserElementInspected,
  }
);

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
const AgentDryRunVariableSupplyRpc = Rpc.make("agent.dry-run.variable.supply", {
  error: BrowserRpcError,
  payload: AgentDryRunVariableSupply,
  success: AgentDryRunVariableSupplied,
});
const AgentSetupVariableAnswerRpc = Rpc.make("agent.setup.variable.answer", {
  error: BrowserRpcError,
  payload: AgentSetupVariableAnswerRequest,
  success: AgentSetupVariableAnswered,
});
export const AgentBoundaryDecision = Schema.Struct({
  decision: Schema.Literals(["allow", "refuse"]),
  operationId: AgentPendingDecisionResolve.fields.operationId,
  pendingDecisionId: AgentPendingDecisionResolve.fields.pendingDecisionId,
  sessionId: AgentBrowserObserve.fields.sessionId,
});
const AgentBoundaryDecisionRpc = Rpc.make("agent.boundary.decision", {
  error: BrowserRpcError,
  payload: AgentBoundaryDecision,
  success: AgentSessionResult,
});
const AgentDryRunVariableAnswerRpc = Rpc.make("agent.dry-run.variable.answer", {
  error: BrowserRpcError,
  payload: AgentDryRunVariableAnswer,
  success: AgentDryRunVariableAnswered,
});
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
const AgentRunSummaryGetRpc = Rpc.make("agent.run.summary.get", {
  error: BrowserRpcError,
  payload: AgentRunSummaryGet,
  success: AgentRunSummaryResult,
});
/**
 * The Workspace's Skills drawer. Both are read-only: browsing never writes to
 * either Catalog Root, and neither is an MCP tool (ADR 0051).
 */
const CatalogBrowseGetRpc = Rpc.make("catalog.browse.get", {
  error: BrowserRpcError,
  payload: CatalogBrowseGet,
  success: CatalogBrowseResult,
});
const CatalogFlowSkillGetRpc = Rpc.make("catalog.flow-skill.get", {
  error: BrowserRpcError,
  payload: CatalogFlowSkillGet,
  success: CatalogFlowSkillResult,
});
export class ContingencyRpcs extends RpcGroup.make(
  AgentSessionsGetRpc,
  AgentSessionStartRpc,
  AgentSessionGetRpc,
  AgentSessionCloseRpc,
  AgentTeachingRecordingStartRpc,
  AgentTeachingRecordingStopRpc,
  AgentTeachingRecordingDiscardRpc,
  AgentTeachingDryRunStopRpc,
  AgentTeachingFlowRejectRpc,
  AgentTeachingFlowVerifyRpc,
  AgentTeachingCleanupRetryRpc,
  AgentTeachingInstructionRecordRpc,
  AgentTeachingFlowRenameRpc,
  AgentBrowserElementInspectRpc,
  AgentSessionStreamSubscribeRpc,
  AgentBrowserStreamSubscribeRpc,
  AgentBrowserFrameAckRpc,
  AgentSessionTakeoverRpc,
  AgentSessionControlReturnRpc,
  AgentBrowserInputSendRpc,
  AgentTeachingVariableInputRpc,
  AgentDryRunVariableSupplyRpc,
  AgentDryRunVariableAnswerRpc,
  AgentBoundaryDecisionRpc,
  AgentSetupVariableAnswerRpc,
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
  AgentRunSummaryGetRpc,
  CatalogBrowseGetRpc,
  CatalogFlowSkillGetRpc
) {}
