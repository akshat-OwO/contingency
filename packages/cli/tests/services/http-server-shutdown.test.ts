import { randomBytes } from "node:crypto";
import { connect } from "node:net";

import { expect, it } from "@effect/vitest";
import {
  Context,
  Deferred,
  Effect,
  Layer,
  Logger,
  References,
  Scope,
} from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";

import {
  makeNodeServerLayer,
  quietHttpInterruptions,
} from "../../src/services/http-server.ts";

it.live.each(["websocket", "long-poll"] as const)(
  "closes a connected %s without logging shutdown as an HTTP failure",
  (transport) =>
    Effect.gen(function* shutdownWithOpenRequest() {
      const statuses: unknown[] = [];
      const clientScope = yield* Effect.scope;
      const started = yield* Deferred.make<boolean>();
      yield* Effect.scoped(
        Effect.gen(function* serveThenClose() {
          const routes = HttpRouter.add(
            "GET",
            "/pending",
            transport === "websocket"
              ? (request) =>
                  Effect.gen(function* upgrade() {
                    const socket = yield* request.upgrade;
                    yield* socket.reader;
                    yield* Effect.never;
                    return HttpServerResponse.empty();
                  })
              : Effect.andThen(Deferred.succeed(started, true), Effect.never)
          );
          const context = yield* Layer.build(
            HttpRouter.serve(
              routes.pipe(Layer.provide(quietHttpInterruptions))
            ).pipe(
              Layer.provideMerge(
                makeNodeServerLayer({ host: "127.0.0.1", port: 0 })
              )
            )
          );
          const { address } = Context.get(context, HttpServer.HttpServer);
          if (address._tag === "UnixPathAddress") {
            return yield* Effect.die("Expected a TCP server.");
          }
          const socket = yield* Effect.acquireRelease(
            Effect.sync(() => connect(address.port, "127.0.0.1")),
            (client) => Effect.sync(() => client.destroy())
          ).pipe(Scope.provide(clientScope));
          const request = `GET /pending HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\n`;
          if (transport === "websocket") {
            const response = yield* Effect.callback<string>((resume) => {
              socket.once("data", (data) =>
                resume(Effect.succeed(data.toString()))
              );
              socket.once("error", (error) => resume(Effect.die(error)));
              socket.write(
                `${request}Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`
              );
            });
            expect(response).toContain("101 Switching Protocols");
            // This raw client never acknowledges the server's close frame.
          } else {
            socket.write(`${request}\r\n`);
            yield* Deferred.await(started);
          }
        })
      ).pipe(
        Effect.provide(
          Logger.layer([
            Logger.make((event) => {
              const annotations = event.fiber.getRef(
                References.CurrentLogAnnotations
              );
              if (annotations["http.url"] === "/pending") {
                statuses.push(annotations["http.status"]);
              }
            }),
          ])
        ),
        Effect.timeout("30 seconds")
      );
      expect(statuses).toEqual([]);
    }),
  35_000
);

it.live("retains successful response and real failure logs", () =>
  Effect.gen(function* retainHttpLogs() {
    const statuses: unknown[] = [];
    const logger = Logger.make((event) => {
      const status = event.fiber.getRef(References.CurrentLogAnnotations)[
        "http.status"
      ];
      if (status !== undefined) {
        statuses.push(status);
      }
    });
    yield* Effect.gen(function* serveResponses() {
      const routes = Layer.mergeAll(
        HttpRouter.add("GET", "/ok", HttpServerResponse.empty()),
        HttpRouter.add("GET", "/failure", Effect.die("request failed"))
      ).pipe(Layer.provide(quietHttpInterruptions));
      const context = yield* Layer.build(
        HttpRouter.serve(routes).pipe(
          Layer.provideMerge(
            makeNodeServerLayer({ host: "127.0.0.1", port: 0 })
          )
        )
      );
      const { address } = Context.get(context, HttpServer.HttpServer);
      if (address._tag === "UnixPathAddress") {
        return yield* Effect.die("Expected a TCP server.");
      }
      const success = yield* Effect.promise(() =>
        fetch(`http://127.0.0.1:${address.port}/ok`)
      );
      const failure = yield* Effect.promise(() =>
        fetch(`http://127.0.0.1:${address.port}/failure`)
      );
      expect(success.status).toBe(204);
      expect(failure.status).toBe(500);
    }).pipe(
      Effect.provide(Logger.layer([logger])),
      Effect.timeout("30 seconds")
    );
    expect(statuses).toEqual([204, 500]);
  })
);
