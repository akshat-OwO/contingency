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

import { toSafeRecord } from "../../src/services/diagnostic-log.ts";
import type { SafeRecord } from "../../src/services/diagnostic-log.ts";
import {
  makeNodeServerLayer,
  serveWithAccessLog,
} from "../../src/services/http-server.ts";

const SECRET = "hunter2";

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
            serveWithAccessLog(routes).pipe(
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
              // Every request in this test goes to /pending.
              if (annotations["http.status"] !== undefined) {
                statuses.push(annotations["http.status"]);
              }
            }),
          ])
        ),
        // Even the Diagnostic Log's level records nothing for a cancellation.
        Effect.provideService(References.MinimumLogLevel, "Debug"),
        Effect.timeout("30 seconds")
      );
      expect(statuses).toEqual([]);
    }),
  35_000
);

it.live("logs by route template, at Error only for a 5xx", () =>
  Effect.gen(function* retainHttpLogs() {
    const records: unknown[] = [];
    const rendered: SafeRecord[] = [];
    const logger = Logger.make((event) => {
      const annotations = event.fiber.getRef(References.CurrentLogAnnotations);
      if (annotations["http.status"] !== undefined) {
        records.push([
          annotations["http.route"],
          annotations["http.status"],
          event.logLevel,
        ]);
        rendered.push(toSafeRecord(event, ""));
      }
    });
    yield* Effect.gen(function* serveResponses() {
      const routes = Layer.mergeAll(
        HttpRouter.add("GET", "/ok", HttpServerResponse.empty()),
        HttpRouter.add("GET", "/failure", Effect.die("request failed")),
        HttpRouter.add(
          "GET",
          "/explicit-error",
          HttpServerResponse.empty({ status: 500 })
        ),
        HttpRouter.add("GET", "/users/:id", HttpServerResponse.empty())
      );
      const context = yield* Layer.build(
        serveWithAccessLog(routes).pipe(
          Layer.provideMerge(
            makeNodeServerLayer({ host: "127.0.0.1", port: 0 })
          )
        )
      );
      const { address } = Context.get(context, HttpServer.HttpServer);
      if (address._tag === "UnixPathAddress") {
        return yield* Effect.die("Expected a TCP server.");
      }
      const statuses = yield* Effect.forEach(
        ["/ok", "/failure", "/explicit-error", `/users/${SECRET}`, "/missing"],
        (path) =>
          Effect.promise(() =>
            fetch(`http://127.0.0.1:${address.port}${path}`)
          ).pipe(Effect.map((response) => response.status))
      );
      expect(statuses).toEqual([204, 500, 500, 204, 404]);
    }).pipe(
      Effect.provide(Logger.layer([logger])),
      // Production records Debug for the Diagnostic Log. Effect's native
      // tracer samples no spans, so the route cannot come from tracing.
      Effect.provideService(References.MinimumLogLevel, "Debug"),
      Effect.timeout("30 seconds")
    );
    expect(records).toEqual([
      ["/ok", 204, "Debug"],
      ["/failure", 500, "Error"],
      ["/explicit-error", 500, "Error"],
      ["/users/:id", 204, "Debug"],
      [undefined, 404, "Debug"],
    ]);
    expect(JSON.stringify(rendered)).not.toContain(SECRET);
  })
);
