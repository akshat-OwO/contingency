import { createServer } from "node:http";
import path from "node:path";

import { NodeHttpServer } from "@effect/platform-node";
import { Layer } from "effect";
import { HttpRouter, HttpStaticServer } from "effect/unstable/http";

import { makeRpcRoutes } from "../routes/rpc.ts";
import { RunArtifactRoutes } from "../routes/run-artifacts.ts";
import { makeRunSessionLayer } from "./run-session.ts";
import type { RunSessionInput } from "./run-session.ts";

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
  /** The one Flow Audit View can run, and where its Runs are written. */
  readonly run: RunSessionInput;
  readonly serveWebUi: boolean;
}

export const makeHttpServerLayer = ({
  allowedOrigins,
  host,
  port,
  run,
  serveWebUi,
}: HttpServerOptions) => {
  const webRoutes = serveWebUi
    ? HttpStaticServer.layer({ root: webRoot, spa: true })
    : Layer.empty;
  // One Run session behind both surfaces: the RPC group that starts and
  // streams the Run, and the route that serves the video it derived. The same
  // layer value reaches both, so both see the same Run rather than two.
  const runSession = makeRunSessionLayer(run);
  const runRoutes = Layer.mergeAll(
    makeRpcRoutes({ allowedOrigins, runSession }),
    RunArtifactRoutes
  );
  return HttpRouter.serve(Layer.merge(runRoutes, webRoutes)).pipe(
    Layer.provide(NodeHttpServer.layer(createServer, { host, port })),
    // The artifact route reads the session per request, so it is provided to
    // the served router rather than to the route layer.
    Layer.provide(runSession)
  );
};
