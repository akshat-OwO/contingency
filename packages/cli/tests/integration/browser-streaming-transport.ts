import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { ContingencyRpcs } from "@contingency/protocol";
import { NodeSocket } from "@effect/platform-node";
import { Effect, Layer, Option, Schema } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";

const isTcpAddress = (
  address: AddressInfo | string | null
): address is AddressInfo => address !== null && typeof address !== "string";

export const reservePort = Effect.promise(
  () =>
    // oxlint-disable-next-line promise/avoid-new -- Bridges the Node server callback in this test.
    new Promise<number>((resolve, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        if (!isTcpAddress(address)) {
          reject(new Error("Could not reserve a loopback port."));
          return;
        }
        probe.close((cause) =>
          cause === undefined ? resolve(address.port) : reject(cause)
        );
      });
    })
);

export const makeLoopbackRpcClient = (origin: string, binary = false) =>
  Effect.gen(function* makeLoopbackClient() {
    type StandardWebSocket = InstanceType<typeof globalThis.WebSocket>;

    class OriginWebSocket extends EventTarget {
      readonly CLOSED = 3;
      readonly CLOSING = 2;
      readonly CONNECTING = 0;
      readonly OPEN = 1;
      onclose: StandardWebSocket["onclose"] = null;
      onerror: StandardWebSocket["onerror"] = null;
      onmessage: StandardWebSocket["onmessage"] = null;
      onopen: StandardWebSocket["onopen"] = null;
      private readonly socket: NodeSocket.NodeWS.WebSocket;

      constructor(url: string, options?: Socket.WebSocketConstructorOptions) {
        super();
        const protocols = Schema.decodeUnknownOption(
          Schema.Union([
            Schema.String,
            Schema.mutable(Schema.Array(Schema.String)),
          ])
        )(options).pipe(Option.getOrUndefined);
        this.socket = new NodeSocket.NodeWS.WebSocket(url, protocols, {
          origin,
        });
        this.socket.on("open", () => {
          const event = new Event("open");
          this.dispatchEvent(event);
          this.onopen?.(event);
        });
        this.socket.on("message", (data) => {
          const event = new MessageEvent("message", { data });
          this.dispatchEvent(event);
          this.onmessage?.(event);
        });
        this.socket.on("error", () => {
          const event = new ErrorEvent("error");
          this.dispatchEvent(event);
          this.onerror?.(event);
        });
        this.socket.on("close", (code, reason) => {
          const event = new CloseEvent("close", {
            code,
            reason: reason.toString(),
            wasClean: code === 1000,
          });
          this.dispatchEvent(event);
          this.onclose?.(event);
        });
      }

      get binaryType(): StandardWebSocket["binaryType"] {
        return this.socket.binaryType === "arraybuffer"
          ? "arraybuffer"
          : "blob";
      }

      set binaryType(value: StandardWebSocket["binaryType"]) {
        this.socket.binaryType = value === "arraybuffer" ? value : "nodebuffer";
      }

      get bufferedAmount(): number {
        return this.socket.bufferedAmount;
      }

      get extensions(): string {
        return this.socket.extensions;
      }

      get protocol(): string {
        return this.socket.protocol;
      }

      get readyState(): number {
        return this.socket.readyState;
      }

      get url(): string {
        return this.socket.url;
      }

      close(code?: number, reason?: string): void {
        this.socket.close(code, reason);
      }

      send(data: Parameters<StandardWebSocket["send"]>[0]): void {
        if (data instanceof Blob) {
          throw new TypeError("Blob WebSocket messages are not used by RPC.");
        }
        this.socket.send(data);
      }
    }

    const socketConstructor = Layer.succeed(
      Socket.WebSocketConstructor,
      (url: string, options?: Socket.WebSocketConstructorOptions) =>
        new OriginWebSocket(url, options)
    );
    const socket = Layer.effect(Socket.Socket)(
      Socket.makeWebSocket(
        `${origin.replace("http", "ws")}${binary ? "/ws/browser" : "/ws"}`
      ).pipe(Effect.provide(socketConstructor))
    );
    const clientLayer = RpcClient.layerProtocolSocket().pipe(
      Layer.provide(socket),
      Layer.provide(
        binary
          ? RpcSerialization.layerSchemaBinary()
          : RpcSerialization.layerJson
      ),
      Layer.provide(socketConstructor)
    );
    const clientContext = yield* Layer.build(clientLayer);
    return yield* RpcClient.make(ContingencyRpcs, {
      flatten: true,
    }).pipe(Effect.provideContext(clientContext));
  });
