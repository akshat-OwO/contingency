import { ContingencyRpcs, isBrowserRpcError } from "@contingency/protocol";
import type {
  AgentFlowId,
  AgentFlowRevisionId,
  AgentRunId,
  AgentSessionId,
  AgentSessionSnapshot,
  BrowserStreamEvent,
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

/** The Workspace only sees the sessions owned by the current MCP process. */
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
/** Takeover is a direct user action: the Workspace alone initiates it. */
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
 * One persisted Run Summary, read by the Workspace in summary mode and by the
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
 * on the Workspace's loopback RPC and have no MCP tool.
 */
export const agentFlowVerificationAuthorizeMutation =
  ContingencyRpcClient.mutation("agent.flow.verification.authorize");
export const agentFlowApproveMutation =
  ContingencyRpcClient.mutation("agent.flow.approve");
export const agentFlowArchiveMutation =
  ContingencyRpcClient.mutation("agent.flow.archive");
/** Permanent deletion has no MCP counterpart. Only the Workspace can call it. */
export const agentFlowDeleteMutation =
  ContingencyRpcClient.mutation("agent.flow.delete");

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
 * to the Workspace. The MCP-owned server resolves that id inside its adapter.
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
