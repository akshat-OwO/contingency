import path from "node:path";

import {
  Config,
  Console,
  Effect,
  FileSystem,
  Layer,
  Logger,
  Result,
} from "effect";
import { McpProtocol, McpServer } from "effect/unstable/ai";
import { Command } from "effect/unstable/cli";
import { HttpServerError } from "effect/unstable/http";

import {
  defaultCatalogRoot,
  makeAgentFlowCatalogLayer,
} from "../services/agent-flow-catalog.ts";
import { makeAgentRunStoreLayer } from "../services/agent-run-store.ts";
import {
  defaultAgentResourceDirectory,
  prepareAgentResourceDirectory,
} from "../services/agent-session-resources.ts";
import { makeAgentSessionLayer } from "../services/agent-session.ts";
import { makeHttpServerLayer } from "../services/http-server.ts";
import { McpAgentFlowLayer } from "../services/mcp-agent-flow.ts";
import { McpAgentRunLayer } from "../services/mcp-agent-run.ts";
import { McpAgentSessionLayer } from "../services/mcp-agent-session.ts";
import { defaultRunsDirectory } from "../services/state-directory.ts";
import { resolveAllowedOrigins } from "../services/web-url.ts";

/** How many loopback ports to try after the configured Agent View port is taken. */
const AGENT_VIEW_PORT_FALLBACKS = 16;

const isListenAddressInUse = (error: unknown): boolean => {
  if (!(error instanceof HttpServerError.ServeError)) {
    return false;
  }
  const { cause } = error;
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "EADDRINUSE"
  );
};

/**
 * Start one local MCP process. Its Agent Session layer is passed to both the
 * stdio MCP adapter and Agent View's HTTP RPC adapter, so all browser handles
 * and shutdown finalizers remain owned by this one process.
 */
export const mcpCommand = Command.make(
  "mcp",
  {},
  Effect.fnUntraced(function* runMcp() {
    const config = yield* Config.all({
      host: Config.string("HOST").pipe(Config.withDefault("127.0.0.1")),
      port: Config.number("PORT").pipe(Config.withDefault(7777)),
    }).pipe(Config.nested("CONTINGENCY_MCP"));
    // This command is intentionally local-only. A non-loopback HOST is not
    // accepted even if an operator accidentally configures one in the shell.
    if (config.host !== "127.0.0.1") {
      return yield* Effect.die(
        new Error("The MCP server must bind to 127.0.0.1.")
      );
    }
    const { host, port: configuredPort } = config;
    const boundOrigin = {
      url: `http://${host}:${configuredPort}`,
    };
    return yield* Effect.scoped(
      Effect.gen(function* runMcpServer() {
        const fileSystem = yield* FileSystem.FileSystem;
        const ownerMarker = yield* prepareAgentResourceDirectory(
          defaultAgentResourceDirectory()
        );
        let selectedCatalogRoot = defaultCatalogRoot();
        const agentSession = Layer.succeedContext(
          yield* Layer.build(
            makeAgentSessionLayer({
              get baseUrl() {
                return boundOrigin.url;
              },
              resourceDirectory: ownerMarker,
              traceDirectory: () => path.join(selectedCatalogRoot, "teaching"),
            })
          )
        );
        // The catalog is durable and process-independent: it is selected per
        // process but never part of shutdown cleanup.
        const catalog = Layer.succeedContext(
          yield* Layer.build(
            makeAgentFlowCatalogLayer({
              onSelect: (root) => {
                selectedCatalogRoot = root;
              },
              root: selectedCatalogRoot,
            })
          )
        );
        // Run evidence is durable and lives beside the catalog it belongs to,
        // so it follows the selected Catalog Root rather than this process.
        const runStore = Layer.succeedContext(
          yield* Layer.build(
            makeAgentRunStoreLayer({ root: () => selectedCatalogRoot })
          )
        );
        const mcp = Layer.mergeAll(
          McpServer.layerStdio({
            name: "Contingency",
            protocols: [McpProtocol.v2025_06_18],
            version: "0.0.1",
          }),
          McpAgentSessionLayer,
          McpAgentFlowLayer,
          McpAgentRunLayer
        ).pipe(Layer.provide(Layer.mergeAll(agentSession, catalog, runStore)));
        yield* Effect.addFinalizer(() =>
          fileSystem
            .remove(ownerMarker, { recursive: true })
            .pipe(Effect.ignore)
        );
        // Stdio must come up even when Agent View cannot bind. Cursor 3.19
        // reloads this process while a sibling still holds the configured port;
        // dying on EADDRINUSE is reported as MCP -32000 Connection closed.
        yield* Layer.build(mcp);
        const lastPort = configuredPort + AGENT_VIEW_PORT_FALLBACKS;
        for (let port = configuredPort; port <= lastPort; port += 1) {
          const browserUrl = new URL(`http://${host}:${port}`);
          const outcome = yield* Layer.build(
            makeHttpServerLayer({
              agentFlowCatalog: catalog,
              agentRunStore: runStore,
              agentSession,
              allowedOrigins: resolveAllowedOrigins(browserUrl),
              host,
              port,
              run: { flow: null, outputDirectory: defaultRunsDirectory() },
              serveWebUi: true,
            }).pipe(Layer.provide(agentSession))
          ).pipe(Effect.result);
          if (Result.isSuccess(outcome)) {
            boundOrigin.url = browserUrl.origin;
            yield* Console.error(
              `Contingency MCP Agent View available at ${browserUrl.origin}/agent`
            );
            return yield* Effect.never;
          }
          if (!isListenAddressInUse(outcome.failure) || port === lastPort) {
            if (isListenAddressInUse(outcome.failure)) {
              yield* Console.error(
                `Contingency MCP Agent View could not bind ${host}:${configuredPort}-${lastPort}; tools still run on stdio.`
              );
              return yield* Effect.never;
            }
            return yield* Effect.fail(outcome.failure);
          }
        }
        return yield* Effect.never;
      })
    ).pipe(Effect.provideService(Logger.LogToStderr, true));
  })
).pipe(
  Command.withDescription(
    "Run one process-owned local MCP server and Agent View endpoint."
  )
);
