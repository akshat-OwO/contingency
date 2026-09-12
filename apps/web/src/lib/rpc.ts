import { ContingencyRpcs, isBrowserRpcError } from "@contingency/protocol";
import type {
  AgentFlowId,
  AgentFlowRevisionId,
  AgentRunId,
  AgentSessionId,
  AgentSessionSnapshot,
  BrowserStreamEvent,
  RecordingSnapshot,
  RunSnapshot,
  SessionId,
} from "@contingency/protocol";
import { Duration, Effect, Layer, Schedule, Stream } from "effect";
import { Atom, AtomRpc } from "effect/unstable/reactivity";
import {
  RpcClient,
  RpcClientError,
  RpcSerialization,
} from "effect/unstable/rpc";
import { Socket } from "effect/unstable/socket";

const webSocketUrl = Effect.sync(() => {
  const url = new URL("/ws", globalThis.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
});

const SocketLive = Socket.layerWebSocket(webSocketUrl).pipe(
  Layer.provide(Socket.layerWebSocketConstructorGlobal)
);

const RpcProtocolLive = RpcClient.layerProtocolSocket({
  retryTransientErrors: true,
}).pipe(Layer.provide(SocketLive), Layer.provide(RpcSerialization.layerJson));

export class ContingencyRpcClient extends AtomRpc.Service<ContingencyRpcClient>()(
  "contingency/web/ContingencyRpcClient",
  {
    group: ContingencyRpcs,
    protocol: RpcProtocolLive,
  }
) {}

export const browserSessionsAtom = ContingencyRpcClient.query(
  "browser.sessions.get",
  { data: {}, type: "browser.sessions.get" }
);

export const browserSessionCreateMutation = ContingencyRpcClient.mutation(
  "browser.session.create"
);
export const browserSessionAttachMutation = ContingencyRpcClient.mutation(
  "browser.session.attach"
);
export const browserSessionCloseMutation = ContingencyRpcClient.mutation(
  "browser.session.close"
);
export const browserOpenMutation =
  ContingencyRpcClient.mutation("browser.open");
export const browserNavigationMutation = ContingencyRpcClient.mutation(
  "browser.navigation.run"
);
export const browserViewportMutation = ContingencyRpcClient.mutation(
  "browser.viewport.set"
);
export const browserUserAgentMutation = ContingencyRpcClient.mutation(
  "browser.user-agent.set"
);
export const browserEmulationMutation = ContingencyRpcClient.mutation(
  "browser.emulation.set"
);
export const browserEmulationQuery = ContingencyRpcClient.mutation(
  "browser.emulation.get"
);
export const browserInputMutation =
  ContingencyRpcClient.mutation("browser.input.send");
export const browserFrameAckMutation =
  ContingencyRpcClient.mutation("browser.frame.ack");
export const browserTabsMutation =
  ContingencyRpcClient.mutation("browser.tabs.get");
export const browserTabNewMutation =
  ContingencyRpcClient.mutation("browser.tab.new");
export const browserTabSwitchMutation =
  ContingencyRpcClient.mutation("browser.tab.switch");
export const browserTabCloseMutation =
  ContingencyRpcClient.mutation("browser.tab.close");
export const browserNetworkRequestsMutation = ContingencyRpcClient.mutation(
  "browser.network.requests.get"
);
export const browserNetworkRequestMutation = ContingencyRpcClient.mutation(
  "browser.network.request.get"
);
export const browserStorageGetMutation = ContingencyRpcClient.mutation(
  "browser.storage.get"
);
export const browserStorageSetMutation = ContingencyRpcClient.mutation(
  "browser.storage.set"
);
export const browserStorageDeleteMutation = ContingencyRpcClient.mutation(
  "browser.storage.delete"
);
export const browserStorageClearMutation = ContingencyRpcClient.mutation(
  "browser.storage.clear"
);

/** Agent View only sees the sessions owned by the current MCP process. */
export const agentSessionsAtom = ContingencyRpcClient.query(
  "agent.sessions.get",
  { data: {}, type: "agent.sessions.get" }
);
export const agentBrowserFrameAckMutation = ContingencyRpcClient.mutation(
  "agent.browser.frame.ack"
);
/** What the user sends to the browser while they hold it during Takeover. */
export const agentBrowserInputMutation = ContingencyRpcClient.mutation(
  "agent.browser.input.send"
);
/** History and address-bar navigation while the user holds the browser. */
export const agentBrowserNavigateMutation = ContingencyRpcClient.mutation(
  "agent.browser.navigate"
);
/**
 * Browser setup tooling in the Workspace. Every call is addressed by Agent
 * Session id: the Agent Session owns the browser, and its lower-level session
 * id never leaves the server process (ADR 0038).
 */
export const agentBrowserEmulationQuery = ContingencyRpcClient.mutation(
  "agent.browser.emulation.get"
);
export const agentBrowserEmulationMutation = ContingencyRpcClient.mutation(
  "agent.browser.emulation.set"
);
export const agentBrowserTabsMutation = ContingencyRpcClient.mutation(
  "agent.browser.tabs.get"
);
export const agentBrowserNetworkRequestsMutation =
  ContingencyRpcClient.mutation("agent.browser.network.requests.get");
export const agentBrowserNetworkRequestMutation = ContingencyRpcClient.mutation(
  "agent.browser.network.request.get"
);
export const agentBrowserStorageGetMutation = ContingencyRpcClient.mutation(
  "agent.browser.storage.get"
);
export const agentBrowserStorageSetMutation = ContingencyRpcClient.mutation(
  "agent.browser.storage.set"
);
export const agentBrowserStorageDeleteMutation = ContingencyRpcClient.mutation(
  "agent.browser.storage.delete"
);
export const agentBrowserStorageClearMutation = ContingencyRpcClient.mutation(
  "agent.browser.storage.clear"
);
/** Takeover is a direct user action: Agent View alone initiates it. */
export const agentTakeoverMutation = ContingencyRpcClient.mutation(
  "agent.session.takeover"
);
export const agentReturnControlMutation = ContingencyRpcClient.mutation(
  "agent.session.control.return"
);
/**
 * Raising an Agent Step or Run ceiling. It is a direct user action and has no
 * MCP tool: the agent whose work a ceiling bounds cannot raise its own budget.
 */
export const agentRunCeilingExtendMutation = ContingencyRpcClient.mutation(
  "agent.run.ceiling.extend"
);

/**
 * One persisted Run Summary, read by Agent View in summary mode and by the
 * read-only viewer. One atom per Run, so a viewer reads its own Run.
 */
export const agentRunSummaryAtom = Atom.family((runId: AgentRunId) =>
  ContingencyRpcClient.query("agent.run.summary.get", {
    data: { runId },
    type: "agent.run.summary.get",
  })
);

/**
 * The draft under review, with the Evidence Slice summaries behind its Steps.
 * One atom per revision, so a review reads its own draft and nothing else's.
 */
const agentFlowRevisionFamily = Atom.family((agentFlowId: AgentFlowId) =>
  Atom.family((revisionId: AgentFlowRevisionId) =>
    ContingencyRpcClient.query("agent.flow.revision.get", {
      data: { agentFlowId, revisionId },
      type: "agent.flow.revision.get",
    })
  )
);

export const agentFlowRevisionAtom = (
  agentFlowId: AgentFlowId,
  revisionId: AgentFlowRevisionId
) => agentFlowRevisionFamily(agentFlowId)(revisionId);
/** The user's correction of the proposed Agent Steps and Domain Scope. */
/**
 * The two gestures the external agent may ask for but never perform. They live
 * on Agent View's loopback RPC and have no MCP tool.
 */
export const agentFlowVerificationAuthorizeMutation =
  ContingencyRpcClient.mutation("agent.flow.verification.authorize");
export const agentFlowApproveMutation =
  ContingencyRpcClient.mutation("agent.flow.approve");
export const agentFlowArchiveMutation =
  ContingencyRpcClient.mutation("agent.flow.archive");
/** Permanent deletion has no MCP counterpart. Only Agent View can call it. */
export const agentFlowDeleteMutation =
  ContingencyRpcClient.mutation("agent.flow.delete");

export const recordingAtom = ContingencyRpcClient.query("recording.get", {
  data: {},
  type: "recording.get",
});
export const recordingStartMutation =
  ContingencyRpcClient.mutation("recording.start");
export const recordingPauseMutation =
  ContingencyRpcClient.mutation("recording.pause");
export const recordingResumeMutation =
  ContingencyRpcClient.mutation("recording.resume");
export const recordingRecoverMutation =
  ContingencyRpcClient.mutation("recording.recover");
export const recordingFinishMutation =
  ContingencyRpcClient.mutation("recording.finish");
export const recordingDiscardMutation =
  ContingencyRpcClient.mutation("recording.discard");
export const recordingTitleMutation = ContingencyRpcClient.mutation(
  "recording.title.update"
);
export const recordingStepDeleteMutation = ContingencyRpcClient.mutation(
  "recording.step.delete"
);
export const recordingStepUndoMutation = ContingencyRpcClient.mutation(
  "recording.step.undo"
);
export const recordingAuditMutation = ContingencyRpcClient.mutation(
  "recording.audit.add"
);
export const recordingVariableBindMutation = ContingencyRpcClient.mutation(
  "recording.step.variable.bind"
);
export const recordingVariableRenameMutation = ContingencyRpcClient.mutation(
  "recording.variable.rename"
);
export const recordingPreStepMutation = ContingencyRpcClient.mutation(
  "recording.pre-step.arm"
);
export const recordingPreStepConditionMutation = ContingencyRpcClient.mutation(
  "recording.pre-step.condition.arm"
);
export const recordingPreStepConditionUrlMutation =
  ContingencyRpcClient.mutation("recording.pre-step.condition.url");
export const recordingCaptureCancelMutation = ContingencyRpcClient.mutation(
  "recording.capture.cancel"
);
export const recordingHoverArmMutation = ContingencyRpcClient.mutation(
  "recording.hover.arm"
);

export const runAtom = ContingencyRpcClient.query("run.get", {
  data: {},
  type: "run.get",
});
export const runFlowLoadMutation =
  ContingencyRpcClient.mutation("run.flow.load");
export const runStartMutation = ContingencyRpcClient.mutation("run.start");
export const runVariableAnswerMutation = ContingencyRpcClient.mutation(
  "run.variable.answer"
);

const reconnectSchedule = Schedule.exponential("100 millis").pipe(
  Schedule.jittered,
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(5)))
  ),
  Schedule.while(({ input }) => {
    if (isBrowserRpcError(input)) {
      return input.code === "stream_failed";
    }

    if (!(input instanceof RpcClientError.RpcClientError)) {
      return false;
    }

    return (
      input.reason._tag === "SocketCloseError" ||
      input.reason._tag === "SocketOpenError" ||
      input.reason._tag === "SocketReadError" ||
      input.reason._tag === "SocketWriteError"
    );
  })
);

export const runBrowserStream = (
  sessionId: SessionId,
  onEvent: (event: BrowserStreamEvent) => Effect.Effect<void>
) =>
  Effect.scoped(
    Effect.gen(function* streamBrowserSession() {
      const client = yield* RpcClient.make(ContingencyRpcs, { flatten: true });
      const events = client("browser.stream.subscribe", {
        data: { sessionId },
        type: "browser.stream.subscribe",
      });

      yield* events.pipe(Stream.runForEach((event) => onEvent(event)));
    })
  ).pipe(Effect.provide(RpcProtocolLive), Effect.retry(reconnectSchedule));

/** Subscribe to one process-owned Agent Session's lifecycle snapshot. */
export const runAgentSessionStream = (
  sessionId: AgentSessionId,
  onEvent: (event: AgentSessionSnapshot) => Effect.Effect<void>
) =>
  Effect.scoped(
    Effect.gen(function* streamAgentSession() {
      const client = yield* RpcClient.make(ContingencyRpcs, { flatten: true });
      const events = client("agent.session.stream.subscribe", {
        data: { sessionId },
        type: "agent.session.stream.subscribe",
      });

      yield* events.pipe(Stream.runForEach((event) => onEvent(event)));
    })
  ).pipe(Effect.provide(RpcProtocolLive), Effect.retry(reconnectSchedule));

/**
 * Agent-scoped browser frames never expose the lower-level browser session id
 * to Agent View. The MCP-owned server resolves that id inside its adapter.
 */
export const runAgentBrowserStream = (
  sessionId: AgentSessionId,
  onEvent: (event: BrowserStreamEvent) => Effect.Effect<void>
) =>
  Effect.scoped(
    Effect.gen(function* streamAgentBrowser() {
      const client = yield* RpcClient.make(ContingencyRpcs, { flatten: true });
      const events = client("agent.browser.stream.subscribe", {
        data: { sessionId },
        type: "agent.browser.stream.subscribe",
      });

      yield* events.pipe(Stream.runForEach((event) => onEvent(event)));
    })
  ).pipe(Effect.provide(RpcProtocolLive), Effect.retry(reconnectSchedule));

export const runRecordingStream = (
  onEvent: (event: RecordingSnapshot) => Effect.Effect<void>
) =>
  Effect.scoped(
    Effect.gen(function* streamRecording() {
      const client = yield* RpcClient.make(ContingencyRpcs, { flatten: true });
      const events = client("recording.stream.subscribe", {
        data: {},
        type: "recording.stream.subscribe",
      });
      yield* events.pipe(Stream.runForEach(onEvent));
    })
  ).pipe(Effect.provide(RpcProtocolLive), Effect.retry(reconnectSchedule));

export const runRunProgressStream = (
  onEvent: (event: RunSnapshot) => Effect.Effect<void>
) =>
  Effect.scoped(
    Effect.gen(function* streamRun() {
      const client = yield* RpcClient.make(ContingencyRpcs, { flatten: true });
      const events = client("run.stream.subscribe", {
        data: {},
        type: "run.stream.subscribe",
      });
      yield* events.pipe(Stream.runForEach(onEvent));
    })
  ).pipe(Effect.provide(RpcProtocolLive), Effect.retry(reconnectSchedule));
