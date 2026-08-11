import { ContingencyRpcs, isBrowserRpcError } from "@contingency/protocol";
import type { BrowserStreamEvent, SessionId } from "@contingency/protocol";
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
