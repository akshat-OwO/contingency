import { createServer } from "node:http";
import path from "node:path";

import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import {
  HttpRouter,
  HttpServerResponse,
  HttpStaticServer,
} from "effect/unstable/http";
import { Socket } from "effect/unstable/socket";

export const resolveWebRoot = (moduleDirectory: string): string =>
  path.basename(moduleDirectory) === "dist"
    ? path.join(moduleDirectory, "web")
    : path.resolve(moduleDirectory, "../../dist/web");

const webRoot = resolveWebRoot(import.meta.dirname);

export interface HttpServerOptions {
  readonly allowedOrigins: ReadonlySet<string>;
  readonly host: string;
  readonly port: number;
  readonly serveWebUi: boolean;
}

export const isAllowedWebSocketOrigin = (
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
): boolean => origin !== undefined && allowedOrigins.has(origin);

const makeWebSocketRoutes = (allowedOrigins: ReadonlySet<string>) =>
  HttpRouter.add("GET", "/ws", (request) => {
    const { origin } = request.headers;

    if (!isAllowedWebSocketOrigin(origin, allowedOrigins)) {
      return Effect.succeed(HttpServerResponse.empty({ status: 403 }));
    }

    return Effect.gen(function* serveWebSocket() {
      const socket = yield* request.upgrade;
      const write = yield* socket.writer;

      yield* socket
        .runString(() => Effect.void, {
          onOpen: write(JSON.stringify({ type: "connected" })).pipe(
            Effect.ignore
          ),
        })
        .pipe(
          Effect.catchIf(
            (error): error is Socket.SocketError =>
              Socket.SocketError.is(error) &&
              error.reason._tag === "SocketCloseError",
            () => Effect.void
          )
        );

      return HttpServerResponse.empty();
    });
  });

export const makeHttpServerLayer = ({
  allowedOrigins,
  host,
  port,
  serveWebUi,
}: HttpServerOptions) => {
  const webRoutes = serveWebUi
    ? HttpStaticServer.layer({
        root: webRoot,
        spa: true,
      })
    : Layer.empty;
  const routes = Layer.merge(makeWebSocketRoutes(allowedOrigins), webRoutes);

  return HttpRouter.serve(routes).pipe(
    Layer.provide(
      NodeHttpServer.layer(createServer, {
        host,
        port,
      })
    )
  );
};
