import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";

import { BrowserTabId, SessionId } from "./browser-identifiers.ts";
import { BrowserRpcError } from "./browser-rpc-error.ts";
import { AuditKind, RecordingSnapshot } from "./flow.ts";
import {
  BrowserStorageDeletePayload,
  BrowserStorageSetPayload,
  BrowserStorageSnapshot,
  StorageKind,
} from "./storage.ts";

// The protocol package intentionally exposes one public contract surface.
// oxlint-disable-next-line oxc/no-barrel-file
export * from "./flow.ts";
// oxlint-disable-next-line oxc/no-barrel-file
export * from "./storage.ts";
export { BrowserTabId, SessionId } from "./browser-identifiers.ts";

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

export const Viewport = Schema.Struct({
  deviceScaleFactor: Schema.Finite.check(
    Schema.isBetween({ maximum: 4, minimum: 0.25 })
  ),
  height: Schema.Int.check(Schema.isBetween({ maximum: 10_000, minimum: 1 })),
  width: Schema.Int.check(Schema.isBetween({ maximum: 10_000, minimum: 1 })),
});
export type Viewport = typeof Viewport.Type;

export const UserAgentProfileId = Schema.Literals([
  "default",
  "chrome-android-mobile",
  "chrome-android-mobile-high-end",
  "chrome-android-tablet",
  "chrome-iphone",
  "chrome-ipad",
  "chrome-chrome-os",
  "chrome-mac",
  "chrome-windows",
  "firefox-android-mobile",
  "firefox-android-tablet",
  "firefox-iphone",
  "firefox-ipad",
  "firefox-mac",
  "firefox-windows",
  "googlebot",
  "googlebot-desktop",
  "googlebot-smartphone",
  "edge-chromium-windows",
  "edge-chromium-mac",
  "edge-iphone",
  "edge-ipad",
  "edge-android-mobile",
  "edge-android-tablet",
  "safari-ipad",
  "safari-iphone",
  "safari-mac",
]);
export type UserAgentProfileId = typeof UserAgentProfileId.Type;

export interface UserAgentProfile {
  readonly group: string;
  readonly id: UserAgentProfileId;
  readonly label: string;
  readonly template: string | undefined;
}

export const userAgentProfiles: readonly UserAgentProfile[] = [
  {
    group: "Default",
    id: "default",
    label: "Browser default",
    template: undefined,
  },
  {
    group: "Chrome",
    id: "chrome-android-mobile",
    label: "Chrome — Android Mobile",
    template:
      "Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Mobile Safari/537.36",
  },
  {
    group: "Chrome",
    id: "chrome-android-mobile-high-end",
    label: "Chrome — Android Mobile (high-end)",
    template:
      "Mozilla/5.0 (Linux; Android 16; Pixel 10 Pro XL) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Mobile Safari/537.36",
  },
  {
    group: "Chrome",
    id: "chrome-android-tablet",
    label: "Chrome — Android Tablet",
    template:
      "Mozilla/5.0 (Linux; Android 16; Pixel Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Safari/537.36",
  },
  {
    group: "Chrome",
    id: "chrome-iphone",
    label: "Chrome — iPhone",
    template:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 26_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/%s Mobile/15E148 Safari/604.1",
  },
  {
    group: "Chrome",
    id: "chrome-ipad",
    label: "Chrome — iPad",
    template:
      "Mozilla/5.0 (iPad; CPU OS 26_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/%s Mobile/15E148 Safari/604.1",
  },
  {
    group: "Chrome",
    id: "chrome-chrome-os",
    label: "Chrome — Chrome OS",
    template:
      "Mozilla/5.0 (X11; CrOS x86_64 10066.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Safari/537.36",
  },
  {
    group: "Chrome",
    id: "chrome-mac",
    label: "Chrome — Mac",
    template:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Safari/537.36",
  },
  {
    group: "Chrome",
    id: "chrome-windows",
    label: "Chrome — Windows",
    template:
      "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Safari/537.36",
  },
  {
    group: "Firefox",
    id: "firefox-android-mobile",
    label: "Firefox — Android Mobile",
    template:
      "Mozilla/5.0 (Android 4.4; Mobile; rv:70.0) Gecko/70.0 Firefox/70.0",
  },
  {
    group: "Firefox",
    id: "firefox-android-tablet",
    label: "Firefox — Android Tablet",
    template:
      "Mozilla/5.0 (Android 4.4; Tablet; rv:70.0) Gecko/70.0 Firefox/70.0",
  },
  {
    group: "Firefox",
    id: "firefox-iphone",
    label: "Firefox — iPhone",
    template:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 8_3 like Mac OS X) AppleWebKit/600.1.4 (KHTML, like Gecko) FxiOS/1.0 Mobile/12F69 Safari/600.1.4",
  },
  {
    group: "Firefox",
    id: "firefox-ipad",
    label: "Firefox — iPad",
    template:
      "Mozilla/5.0 (iPad; CPU iPhone OS 8_3 like Mac OS X) AppleWebKit/600.1.4 (KHTML, like Gecko) FxiOS/1.0 Mobile/12F69 Safari/600.1.4",
  },
  {
    group: "Firefox",
    id: "firefox-mac",
    label: "Firefox — Mac",
    template:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.14; rv:70.0) Gecko/20100101 Firefox/70.0",
  },
  {
    group: "Firefox",
    id: "firefox-windows",
    label: "Firefox — Windows",
    template:
      "Mozilla/5.0 (Windows NT 10.0; WOW64; rv:70.0) Gecko/20100101 Firefox/70.0",
  },
  {
    group: "Googlebot",
    id: "googlebot",
    label: "Googlebot",
    template:
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  },
  {
    group: "Googlebot",
    id: "googlebot-desktop",
    label: "Googlebot Desktop",
    template:
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/%s Safari/537.36",
  },
  {
    group: "Googlebot",
    id: "googlebot-smartphone",
    label: "Googlebot Smartphone",
    template:
      "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  },
  {
    group: "Microsoft Edge",
    id: "edge-chromium-windows",
    label: "Microsoft Edge (Chromium) — Windows",
    template:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Safari/537.36 Edg/%s",
  },
  {
    group: "Microsoft Edge",
    id: "edge-chromium-mac",
    label: "Microsoft Edge (Chromium) — Mac",
    template:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Chrome/%s Safari/604.1 Edg/%s",
  },
  {
    group: "Microsoft Edge",
    id: "edge-iphone",
    label: "Microsoft Edge — iPhone",
    template:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 12_3_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1.1 EdgiOS/44.5.0.10 Mobile/15E148 Safari/604.1",
  },
  {
    group: "Microsoft Edge",
    id: "edge-ipad",
    label: "Microsoft Edge — iPad",
    template:
      "Mozilla/5.0 (iPad; CPU OS 12_3_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.0 EdgiOS/44.5.2 Mobile/15E148 Safari/605.1.15",
  },
  {
    group: "Microsoft Edge",
    id: "edge-android-mobile",
    label: "Microsoft Edge — Android Mobile",
    template:
      "Mozilla/5.0 (Linux; Android 8.1.0; Pixel Build/OPM4.171019.021.D1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Mobile Safari/537.36 EdgA/42.0.0.2057",
  },
  {
    group: "Microsoft Edge",
    id: "edge-android-tablet",
    label: "Microsoft Edge — Android Tablet",
    template:
      "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 7 Build/MOB30X) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Safari/537.36 EdgA/42.0.0.2057",
  },
  {
    group: "Safari",
    id: "safari-ipad",
    label: "Safari — iPad iOS 13.2",
    template:
      "Mozilla/5.0 (iPad; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1",
  },
  {
    group: "Safari",
    id: "safari-iphone",
    label: "Safari — iPhone iOS 13.2",
    template:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1",
  },
  {
    group: "Safari",
    id: "safari-mac",
    label: "Safari — Mac",
    template:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Safari/605.1.15",
  },
];

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
  "recording.step.secret.bind",
  "recording.secret.rename",
  "recording.pre-step.arm",
  "recording.pre-step.condition.arm",
  "recording.capture.cancel",
  "recording.stream.subscribe",
]);
export type BrandId = typeof BrandId.Type;

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

export const BrowserOpen = request("browser.open", {
  sessionId: Schema.optional(SessionId),
  url: Schema.String,
  userAgentProfile: UserAgentProfileId,
  viewport: Viewport,
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
export const RecordingStepSecretBind = request("recording.step.secret.bind", {
  name: Schema.String,
  stepId: Schema.String,
});
export const RecordingSecretRename = request("recording.secret.rename", {
  from: Schema.String,
  name: Schema.String,
});
const stepId = Schema.String.check(Schema.isMinLength(1));
const RecordingPreStepScope = Schema.Union([
  Schema.Struct({ scope: Schema.Literal("flow") }),
  Schema.Struct({ scope: Schema.Literal("step"), stepId }),
]);

export const RecordingPreStepArm = Schema.Struct({
  data: RecordingPreStepScope,
  type: Schema.Literal("recording.pre-step.arm"),
});
export const RecordingPreStepConditionArm = Schema.Struct({
  data: Schema.Union([
    Schema.Struct({ index: Schema.Int, scope: Schema.Literal("flow") }),
    Schema.Struct({
      index: Schema.Int,
      scope: Schema.Literal("step"),
      stepId,
    }),
  ]),
  type: Schema.Literal("recording.pre-step.condition.arm"),
});
export const RecordingCaptureCancel = request("recording.capture.cancel", {});
export const RecordingStreamSubscribe = request(
  "recording.stream.subscribe",
  {}
);

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
const RecordingStepSecretBindRpc = Rpc.make("recording.step.secret.bind", {
  error: BrowserRpcError,
  payload: RecordingStepSecretBind,
  success: RecordingResult,
});
const RecordingSecretRenameRpc = Rpc.make("recording.secret.rename", {
  error: BrowserRpcError,
  payload: RecordingSecretRename,
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
const RecordingCaptureCancelRpc = Rpc.make("recording.capture.cancel", {
  error: BrowserRpcError,
  payload: RecordingCaptureCancel,
  success: RecordingResult,
});
const RecordingStreamSubscribeRpc = Rpc.make("recording.stream.subscribe", {
  error: BrowserRpcError,
  payload: RecordingStreamSubscribe,
  stream: true,
  success: RecordingSnapshot,
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
  RecordingStepSecretBindRpc,
  RecordingSecretRenameRpc,
  RecordingPreStepArmRpc,
  RecordingPreStepConditionArmRpc,
  RecordingCaptureCancelRpc,
  RecordingStreamSubscribeRpc
) {}
