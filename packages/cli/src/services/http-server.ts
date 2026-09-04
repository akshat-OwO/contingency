import { createServer } from "node:http";
import path from "node:path";

import { NodeHttpServer } from "@effect/platform-node";
import { Layer } from "effect";
import type { FileSystem } from "effect";
import { HttpRouter, HttpStaticServer } from "effect/unstable/http";

import { makeAgentRunArtifactRoutes } from "../routes/agent-run-artifacts.ts";
import { makeRpcRoutes } from "../routes/rpc.ts";
import { makeRunArtifactRoutes } from "../routes/run-artifacts.ts";
import type { AgentFlowCatalogService } from "./agent-flow-catalog.ts";
import type { AgentRunStoreService } from "./agent-run-store.ts";
import type { AgentSessionService } from "./agent-session.ts";
import type { CreateBrowserService } from "./create-browser-contract.ts";
import { makeRunSessionLayer } from "./run-session.ts";
import type { RunSessionInput } from "./run-session.ts";

export { isAllowedWebSocketOrigin } from "./web-url.ts";

export const resolveWebRoot = (moduleDirectory: string): string =>
  path.basename(moduleDirectory) === "dist"
    ? path.join(moduleDirectory, "web")
    : path.resolve(moduleDirectory, "../../dist/web");

const webRoot = resolveWebRoot(import.meta.dirname);

export interface HttpServerOptions {
  /**
   * The durable Agent Flow Catalog behind Agent View's draft review. It is the
   * same value MCP reads, so the user reviews the draft the agent saved.
   */
  readonly agentFlowCatalog?: Layer.Layer<AgentFlowCatalogService>;
  /**
   * Persisted Interactive Run evidence, behind Agent View's summary mode and
   * the read-only viewer. Absent in a process that serves Audit View alone.
   */
  readonly agentRunStore?: Layer.Layer<AgentRunStoreService>;
  readonly allowedOrigins: ReadonlySet<string>;
  /** A shared process-owned registry for MCP and Agent View, when supplied. */
  readonly agentSession?: Layer.Layer<
    AgentSessionService,
    never,
    CreateBrowserService | FileSystem.FileSystem
  >;
  readonly host: string;
  readonly port: number;
  /** The one Flow Audit View can run, and where its Runs are written. */
  readonly run: RunSessionInput;
  readonly serveWebUi: boolean;
}

export const makeHttpServerLayer = ({
  agentFlowCatalog,
  agentRunStore,
  allowedOrigins,
  agentSession,
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
  // `web` deliberately has no Agent Session registry. MCP is the explicit
  // owner of that process-scoped service and passes the same layer to both
  // stdio tools and Agent View. Keeping this optional also makes an ordinary
  // web server answer a typed `agent_session_unavailable` error rather than
  // accidentally launching Chromium on behalf of an HTTP caller.
  const rpcRoutes = makeRpcRoutes({ allowedOrigins, runSession });
  const sessionRpcRoutes =
    agentSession === undefined
      ? rpcRoutes
      : rpcRoutes.pipe(Layer.provide(agentSession));
  const catalogRpcRoutes =
    agentFlowCatalog === undefined
      ? sessionRpcRoutes
      : sessionRpcRoutes.pipe(Layer.provide(agentFlowCatalog));
  const agentRpcRoutes =
    agentRunStore === undefined
      ? catalogRpcRoutes
      : catalogRpcRoutes.pipe(Layer.provide(agentRunStore));
  const artifactRoutes = makeRunArtifactRoutes({ allowedOrigins });
  const httpServer = NodeHttpServer.layer(createServer, { host, port });
  // The artifact routes read their stores per request, so those are provided
  // to the served router rather than to the route layers.
  if (agentRunStore === undefined) {
    return HttpRouter.serve(
      Layer.merge(Layer.mergeAll(agentRpcRoutes, artifactRoutes), webRoutes)
    ).pipe(Layer.provide(httpServer), Layer.provide(runSession));
  }
  return HttpRouter.serve(
    Layer.merge(
      Layer.mergeAll(
        agentRpcRoutes,
        artifactRoutes,
        makeAgentRunArtifactRoutes({ allowedOrigins })
      ),
      webRoutes
    )
  ).pipe(
    Layer.provide(httpServer),
    Layer.provide(runSession),
    Layer.provide(agentRunStore)
  );
};
