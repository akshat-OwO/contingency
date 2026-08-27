import { createServer } from "node:http";
import path from "node:path";

import { NodeHttpServer } from "@effect/platform-node";
import { Layer } from "effect";
import { HttpRouter, HttpStaticServer } from "effect/unstable/http";

import { makeRpcRoutes } from "../routes/rpc.ts";

export { isAllowedWebSocketOrigin } from "./web-url.ts";

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

export const makeHttpServerLayer = ({
  allowedOrigins,
  host,
  port,
  serveWebUi,
}: HttpServerOptions) => {
  const webRoutes = serveWebUi
    ? HttpStaticServer.layer({ root: webRoot, spa: true })
    : Layer.empty;
  return HttpRouter.serve(
    Layer.merge(makeRpcRoutes({ allowedOrigins }), webRoutes)
  ).pipe(Layer.provide(NodeHttpServer.layer(createServer, { host, port })));
};
