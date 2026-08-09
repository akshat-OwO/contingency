import { Duration, Effect, Fiber, Layer, Schedule } from "effect";
import { Socket } from "effect/unstable/socket";
import { useEffect, useState } from "react";

export type WebSocketStatus = "connected" | "connecting" | "disconnected";

const webSocketUrl = Effect.sync(() => {
  const url = new URL("/ws", globalThis.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
});

const SocketLive = Socket.layerWebSocket(webSocketUrl).pipe(
  Layer.provide(Socket.layerWebSocketConstructorGlobal)
);

const maximumRetryDelay = Duration.seconds(5);
const reconnectSchedule = Schedule.exponential("100 millis").pipe(
  Schedule.jittered,
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, maximumRetryDelay))
  )
);

export const useWebSocketStatus = (): WebSocketStatus => {
  const [status, setStatus] = useState<WebSocketStatus>("connecting");

  useEffect(() => {
    let mounted = true;
    const updateStatus = (nextStatus: WebSocketStatus) =>
      Effect.sync(() => {
        if (mounted) {
          setStatus(nextStatus);
        }
      });
    const connect = Effect.scoped(
      Effect.gen(function* connectWebSocket() {
        const socket = yield* Socket.Socket;

        yield* socket.runString(() => Effect.void, {
          onOpen: updateStatus("connected"),
        });
      })
    ).pipe(
      Effect.provide(SocketLive),
      Effect.ensuring(updateStatus("disconnected")),
      Effect.retry(reconnectSchedule)
    );
    const connectionFiber = Effect.runFork(connect);

    return () => {
      mounted = false;
      Effect.runFork(Fiber.interrupt(connectionFiber));
    };
  }, []);

  return status;
};
