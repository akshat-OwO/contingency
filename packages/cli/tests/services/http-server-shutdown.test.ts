import { randomBytes } from "node:crypto";
import { connect } from "node:net";

import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";

import { createTrackedServer } from "../../src/services/http-server.ts";

/**
 * The web UI holds an RPC WebSocket open for as long as its tab is open, and
 * an upgraded socket is detached from Node's own connection list. Without the
 * tracking in `createTrackedServer`, closing the server's scope never
 * finishes, which is what a wedged Ctrl-C looks like from the terminal.
 */
it.live("finishes shutdown while a WebSocket is still connected", () =>
  Effect.gen(function* shutdownWithOpenSocket() {
    const closed = yield* Effect.scoped(
      Effect.gen(function* serveThenClose() {
        const context = yield* Layer.build(
          HttpRouter.serve(Layer.empty).pipe(
            Layer.provideMerge(
              NodeHttpServer.layer(createTrackedServer, {
                host: "127.0.0.1",
                port: 0,
              })
            )
          )
        );
        const { address } = Context.get(context, HttpServer.HttpServer);
        if (address._tag !== "TcpAddress") {
          return yield* Effect.die("Expected a TCP server.");
        }
        yield* Effect.callback<boolean>((resume) => {
          const socket = connect(address.port, "127.0.0.1", () => {
            socket.write(
              `GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nOrigin: http://127.0.0.1:${address.port}\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`
            );
          });
          socket.once("data", () => resume(Effect.succeed(true)));
        });
        return true;
      })
    ).pipe(Effect.timeoutOption("5 seconds"));
    expect(closed._tag).toBe("Some");
  })
);
