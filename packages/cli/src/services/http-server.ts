import { createServer } from "node:http";
import path from "node:path";

import { NodeHttpServer } from "@effect/platform-node";
import { Layer } from "effect";
import { HttpRouter, HttpStaticServer } from "effect/unstable/http";

import { makeRpcRoutes } from "../routes/rpc";

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
  const routes = Layer.merge(makeRpcRoutes({ allowedOrigins }), webRoutes);

  return HttpRouter.serve(routes).pipe(
    Layer.provide(
      NodeHttpServer.layer(createServer, {
        host,
        port,
      })
    )
  );
};
