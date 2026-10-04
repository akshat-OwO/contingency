import { createServer } from "node:http";
import type { Server } from "node:http";
import type { Socket } from "node:net";
import path from "node:path";

import { NodeHttpServer } from "@effect/platform-node";
import { Layer } from "effect";
import type { Cause, FileSystem } from "effect";
import { HttpRouter, HttpStaticServer } from "effect/http";

import {
  makeAgentRunArtifactRoutes,
  makeDryRunArtifactRoutes,
} from "../routes/agent-run-artifacts.ts";
import { makeRpcRoutes } from "../routes/rpc.ts";
import type { AgentRunStoreService } from "./agent-run-store.ts";
import type { AgentSessionService } from "./agent-session.ts";
import type { CreateBrowserService } from "./create-browser-contract.ts";
import type { RunVideoRendererService } from "./run-video-renderer.ts";
import type { TeachingRecordingStoreService } from "./teaching-recording-store.ts";

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
   * Persisted Interactive Run evidence, behind the Workspace's summary mode
   * and the read-only viewer. Absent in a process that serves no Runs.
   */
  readonly agentRunStore?: Layer.Layer<AgentRunStoreService>;
  /** Condenses Run footage, and reports a video's readiness to the Workspace. */
  readonly runVideoRenderer: Layer.Layer<RunVideoRendererService>;
  readonly teachingRecordingStore: Layer.Layer<TeachingRecordingStoreService>;
  readonly allowedOrigins: ReadonlySet<string>;
  /** A shared process-owned registry for MCP and the Workspace, when supplied. */
  readonly agentSession?: Layer.Layer<
    AgentSessionService,
    never,
    CreateBrowserService | FileSystem.FileSystem
  >;
  readonly host: string;
  readonly mcp?: Layer.Layer<
    never,
    Cause.IllegalArgumentError,
    HttpRouter.HttpRouter
  >;
  readonly port: number;
  /**
   * An already listening server. A process that binds an available port reads
   * the acquired port before it builds routes, so allowed origins and every
   * advertised link name the real port.
   */
  readonly server?: Layer.Layer<NodeHttpServerServices>;
  readonly serveWebUi: boolean;
}

/** What `NodeHttpServer.layer` provides: the listening server and its platform. */
export type NodeHttpServerServices = Layer.Success<
  ReturnType<typeof NodeHttpServer.layer>
>;

/** Bind the tracked Node server on `host:port`; port 0 acquires an available one. */
export const makeNodeServerLayer = (options: {
  readonly host: string;
  readonly port: number;
}) => NodeHttpServer.layer(createTrackedServer, options);

export const makeHttpServerLayer = ({
  agentRunStore,
  allowedOrigins,
  agentSession,
  host,
  mcp = Layer.empty,
  port,
  runVideoRenderer,
  server,
  serveWebUi,
  teachingRecordingStore,
}: HttpServerOptions) => {
  const webRoutes = serveWebUi
    ? HttpStaticServer.layer({ root: webRoot, spa: true })
    : Layer.empty;
  const rpcRoutes = makeRpcRoutes({ allowedOrigins });
  const sessionRpcRoutes =
    agentSession === undefined
      ? rpcRoutes
      : rpcRoutes.pipe(Layer.provide(agentSession));
  const agentRpcRoutes =
    agentRunStore === undefined
      ? sessionRpcRoutes
      : sessionRpcRoutes.pipe(Layer.provide(agentRunStore));
  // The artifact routes read their stores per request, so those are provided
  // to the served router rather than to the route layers.
  const serveRoutes = <E, R>(routes: Layer.Layer<never, E, R>) =>
    HttpRouter.serve(Layer.mergeAll(routes, mcp, webRoutes)).pipe(
      Layer.provide(server ?? makeNodeServerLayer({ host, port }))
    );
  // The Agent Run video route exists only where a Run store does: a process
  // that owns no Agent Sessions has no persisted Interactive Runs to serve.
  return agentRunStore === undefined
    ? serveRoutes(agentRpcRoutes)
    : serveRoutes(
        Layer.mergeAll(
          agentRpcRoutes,
          makeAgentRunArtifactRoutes({ allowedOrigins }),
          makeDryRunArtifactRoutes({ allowedOrigins })
        )
      ).pipe(
        Layer.provide(agentRunStore),
        Layer.provide(teachingRecordingStore),
        Layer.provide(runVideoRenderer)
      );
};
