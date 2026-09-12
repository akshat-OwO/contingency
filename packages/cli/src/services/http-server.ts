import { createServer } from "node:http";
import type { Server } from "node:http";
import type { Socket } from "node:net";
import path from "node:path";

import { NodeHttpServer } from "@effect/platform-node";
import { Layer } from "effect";
import type { Cause, FileSystem } from "effect";
import { HttpRouter, HttpStaticServer } from "effect/unstable/http";

import { makeAgentRunArtifactRoutes } from "../routes/agent-run-artifacts.ts";
import { makeRpcRoutes } from "../routes/rpc.ts";
import type { AgentFlowCatalogService } from "./agent-flow-catalog.ts";
import type { AgentRunStoreService } from "./agent-run-store.ts";
import type { AgentSessionService } from "./agent-session.ts";
import type { CreateBrowserService } from "./create-browser-contract.ts";

export { isAllowedWebSocketOrigin } from "./web-url.ts";

/**
 * A Node server that does not outlive Ctrl-C.
 *
 * `server.close()` resolves only once every live connection is gone, and the
 * web UI holds an RPC WebSocket open for as long as its tab is open. An
 * upgraded socket is detached from Node's own connection list, so neither
 * `close()` nor `closeAllConnections()` ever lets go of it: the shutdown
 * finalizer waits forever and Ctrl-C appears to wedge the CLI. Sockets are
 * tracked from `connection`, before any upgrade can detach them, and dropped
 * the moment a close is asked for. A shutting-down local server has nothing
 * left to say to its own UI, so tearing the sockets down is the whole answer.
 */
export const createTrackedServer = (): Server => {
  const server = createServer();
  const sockets = new Set<Socket>();
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
  });
  const close = server.close.bind(server);
  server.close = (...args: Parameters<Server["close"]>) => {
    const closing = close(...args);
    for (const socket of sockets) {
      socket.destroy();
    }
    sockets.clear();
    return closing;
  };
  return server;
};

export const resolveWebRoot = (moduleDirectory: string): string =>
  path.basename(moduleDirectory) === "dist"
    ? path.join(moduleDirectory, "web")
    : path.resolve(moduleDirectory, "../../dist/web");

const webRoot = resolveWebRoot(import.meta.dirname);

export interface HttpServerOptions {
  /**
   * The durable Agent Flow Catalog behind the Workspace's draft review. It is
   * the same value MCP reads, so the user reviews the draft the agent saved.
   */
  readonly agentFlowCatalog?: Layer.Layer<AgentFlowCatalogService>;
  /**
   * Persisted Interactive Run evidence, behind the Workspace's summary mode
   * and the read-only viewer. Absent in a process that serves no Runs.
   */
  readonly agentRunStore?: Layer.Layer<AgentRunStoreService>;
  readonly allowedOrigins: ReadonlySet<string>;
  /** A shared process-owned registry for MCP and the Workspace, when supplied. */
  readonly agentSession?: Layer.Layer<
    AgentSessionService,
    never,
    CreateBrowserService | FileSystem.FileSystem
  >;
  readonly host: string;
  /**
   * Streamable HTTP MCP on this process's Workspace server. Absent on
   * `contingency web`, which must not own Agent Sessions.
   */
  readonly mcp?: Layer.Layer<
    never,
    Cause.IllegalArgumentError,
    HttpRouter.HttpRouter
  >;
  readonly port: number;
  readonly serveWebUi: boolean;
}

export const makeHttpServerLayer = ({
  agentFlowCatalog,
  agentRunStore,
  allowedOrigins,
  agentSession,
  host,
  mcp = Layer.empty,
  port,
  serveWebUi,
}: HttpServerOptions) => {
  const webRoutes = serveWebUi
    ? HttpStaticServer.layer({ root: webRoot, spa: true })
    : Layer.empty;
  // `web` deliberately has no Agent Session registry. MCP is the explicit
  // owner of that process-scoped service and passes the same layer to both
  // stdio tools and the Workspace. Keeping this optional also makes an ordinary
  // web server answer a typed `agent_session_unavailable` error rather than
  // accidentally launching Chromium on behalf of an HTTP caller.
  const rpcRoutes = makeRpcRoutes({ allowedOrigins });
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
  // The artifact routes read their stores per request, so those are provided
  // to the served router rather than to the route layers.
  const serveRoutes = <E, R>(routes: Layer.Layer<never, E, R>) =>
    HttpRouter.serve(Layer.mergeAll(routes, mcp, webRoutes)).pipe(
      Layer.provide(NodeHttpServer.layer(createTrackedServer, { host, port }))
    );
  // The Agent Run video route exists only where a Run store does: a process
  // that owns no Agent Sessions has no persisted Interactive Runs to serve.
  return agentRunStore === undefined
    ? serveRoutes(agentRpcRoutes)
    : serveRoutes(
        Layer.mergeAll(
          agentRpcRoutes,
          makeAgentRunArtifactRoutes({ allowedOrigins })
        )
      ).pipe(Layer.provide(agentRunStore));
};
