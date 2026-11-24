import { createServer } from "node:http";
import type { Server } from "node:http";
import type { Socket } from "node:net";
import path from "node:path";

import { NodeHttpServer } from "@effect/platform-node";
import { Cause, Context, Effect, Exit, Layer, Option, Ref } from "effect";
import type { FileSystem } from "effect";
import {
  HttpMiddleware,
  HttpRouter,
  HttpServerError,
  HttpServerRequest,
  HttpStaticServer,
} from "effect/http";

import {
  makeAgentRunArtifactRoutes,
  makeDryRunArtifactRoutes,
} from "../routes/agent-run-artifacts.ts";
import { makeAndroidStreamRoutes } from "../routes/android-stream.ts";
import { makeDeviceKeyframeRoutes } from "../routes/device-keyframes.ts";
import { makeDeviceVideoRoutes } from "../routes/device-video.ts";
import { makeDocsSiteRoutes } from "../routes/docs-site.ts";
import { makeIosStreamRoutes } from "../routes/ios-stream.ts";
import { makeRpcRoutes } from "../routes/rpc.ts";
import { makeTargetAppBuildRoutes } from "../routes/target-app-builds.ts";
import type { AgentRunStoreService } from "./agent-run-store.ts";
import type { AgentSessionService } from "./agent-session.ts";
import type { CatalogBrowserService } from "./catalog-browser.ts";
import type { CreateBrowserService } from "./create-browser-contract.ts";
import type { RunVideoRendererService } from "./run-video-renderer.ts";
import type { TeachingRecordingStoreService } from "./teaching-recording-store.ts";

/**
 * Where the route middleware leaves the template the router matched, such as
 * `/api/runs/:id`, for the access log. A request outside the access log has
 * no slot.
 */
const MatchedRoute = Context.Reference<
  Ref.Ref<Option.Option<string>> | undefined
>("contingency/http/MatchedRoute", { defaultValue: () => {} });

/**
 * Records each matched route's template. It runs inside the route, where the
 * router's `RouteContext` exists, so it holds however the request is traced.
 */
const recordMatchedRoute = HttpRouter.middleware((httpEffect) =>
  Effect.gen(function* recordRoute() {
    const slot = yield* MatchedRoute;
    const { route } = yield* HttpRouter.RouteContext;
    if (slot !== undefined) {
      yield* Ref.set(slot, Option.some(route.path));
    }
    return yield* httpEffect;
  })
).layer;

/**
 * One record per response, in place of Effect's HTTP logger, which logs
 * every response at Info. A response below 500, including a client's mistake
 * such as a missing route, is Debug, so a production terminal shows none. A
 * 5xx is Error, whether a route returned it or a failure produced it.
 * Cancellation, such as Ctrl-C closing a long poll or a WebSocket, is not
 * logged.
 */
export const httpAccessLog = HttpMiddleware.make((httpApp) =>
  Effect.gen(function* logHttpResponse() {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const slot = yield* Ref.make(Option.none<string>());
    const exit = yield* Effect.exit(
      Effect.provideService(httpApp, MatchedRoute, slot)
    );
    // The template, never the requested path, which may carry private
    // segments.
    const route = yield* Ref.get(slot);
    const annotate =
      (status: number) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) => {
        const annotated = Effect.annotateLogs(effect, {
          "http.method": request.method,
          "http.status": status,
        });
        // An unmatched request has no route, and its path is never logged.
        return Option.isSome(route)
          ? Effect.annotateLogs(annotated, "http.route", route.value)
          : annotated;
      };
    if (Exit.isSuccess(exit)) {
      yield* Effect.logWithLevel(exit.value.status >= 500 ? "Error" : "Debug")(
        "HTTP response sent"
      ).pipe(annotate(exit.value.status));
      return yield* exit;
    }
    // The router carries the response it chose as a defect beside the cause.
    const [response, failure] = HttpServerError.causeResponseStripped(
      exit.cause
    );
    const annotated = annotate(response.status);
    if (Option.isNone(failure)) {
      yield* Effect.logWithLevel(response.status >= 500 ? "Error" : "Debug")(
        "HTTP response sent"
      ).pipe(annotated);
    } else if (Cause.hasInterruptsOnly(failure.value)) {
      // Cancellation, such as Ctrl-C closing a long poll: nothing failed.
    } else if (response.status < 500) {
      // The client asked for something wrong, such as a missing route.
      yield* Effect.logDebug("HTTP request refused", failure.value).pipe(
        annotated
      );
    } else {
      yield* Effect.logError("HTTP request failed", failure.value).pipe(
        annotated
      );
    }
    return yield* exit;
  }).pipe(Effect.withLogSpan("http"))
);

/**
 * Serves routes with `httpAccessLog` instead of Effect's HTTP logger, and
 * records each route's template for it.
 */
export const serveWithAccessLog = <E, R>(routes: Layer.Layer<never, E, R>) =>
  HttpRouter.serve(routes.pipe(Layer.provide(recordMatchedRoute)), {
    disableLogger: true,
    middleware: httpAccessLog,
  });

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
  /** The Flows page's read-only view of the Catalog Roots. */
  readonly catalogBrowser?: Layer.Layer<CatalogBrowserService>;
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
  catalogBrowser,
  host,
  mcp = Layer.empty,
  port,
  runVideoRenderer,
  server,
  serveWebUi,
  teachingRecordingStore,
}: HttpServerOptions) => {
  // The docs site is served in development too, where Vite proxies `/docs`
  // here. Its prefixed route outranks the SPA's catch-all.
  const webRoutes = serveWebUi
    ? Layer.mergeAll(
        makeDocsSiteRoutes(),
        HttpStaticServer.layer({ root: webRoot, spa: true })
      )
    : makeDocsSiteRoutes();
  const allRpcRoutes = makeRpcRoutes({ allowedOrigins });
  const rpcRoutes =
    catalogBrowser === undefined
      ? allRpcRoutes
      : allRpcRoutes.pipe(Layer.provide(catalogBrowser));
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
    serveWithAccessLog(
      Layer.mergeAll(
        routes,
        makeIosStreamRoutes(allowedOrigins).pipe(
          Layer.provide(agentSession ?? Layer.empty)
        ),
        makeAndroidStreamRoutes(allowedOrigins).pipe(
          Layer.provide(agentSession ?? Layer.empty)
        ),
        makeDeviceKeyframeRoutes(allowedOrigins).pipe(
          Layer.provide(agentSession ?? Layer.empty)
        ),
        makeDeviceVideoRoutes(allowedOrigins).pipe(
          Layer.provide(agentSession ?? Layer.empty)
        ),
        makeTargetAppBuildRoutes(allowedOrigins).pipe(
          Layer.provide(agentSession ?? Layer.empty)
        ),
        mcp,
        webRoutes
      )
    ).pipe(Layer.provide(server ?? makeNodeServerLayer({ host, port })));
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
