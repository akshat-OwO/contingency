import { ContingencyRpcs, isBrowserRpcError } from "@contingency/protocol";
import type {
  BrowserStreamEvent,
  RecordingSnapshot,
  SessionId,
} from "@contingency/protocol";
import { Duration, Effect, Layer, Schedule, Stream } from "effect";
import { AtomRpc } from "effect/unstable/reactivity";
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
export const recordingSecretBindMutation = ContingencyRpcClient.mutation(
  "recording.step.secret.bind"
);
export const recordingSecretRenameMutation = ContingencyRpcClient.mutation(
  "recording.secret.rename"
);
export const recordingPreStepMutation = ContingencyRpcClient.mutation(
  "recording.pre-step.arm"
);
export const recordingPreStepConditionMutation = ContingencyRpcClient.mutation(
  "recording.pre-step.condition.arm"
);
export const recordingCaptureCancelMutation = ContingencyRpcClient.mutation(
  "recording.capture.cancel"
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
