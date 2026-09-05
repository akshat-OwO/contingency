import path from "node:path";

import { Config, Console, Effect, FileSystem, Layer, Logger } from "effect";
import { McpProtocol, McpServer } from "effect/unstable/ai";
import { Command } from "effect/unstable/cli";

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
import { makeMcpHttpLayer } from "../services/mcp-http.ts";
import { defaultRunsDirectory } from "../services/state-directory.ts";
import { resolveAllowedOrigins } from "../services/web-url.ts";

const mcpTools = Layer.mergeAll(
  McpAgentSessionLayer,
  McpAgentFlowLayer,
  McpAgentRunLayer
);

/**
 * Start one local MCP process. Its Agent Session layer is passed to both the
 * stdio adapter (Claude, Codex) and the Streamable HTTP `/mcp` route plus
 * Agent View, so all browser handles and shutdown finalizers remain owned by
 * this one process.
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
    const { host, port } = config;
    const browserUrl = new URL(`http://${host}:${port}`);
    const boundOrigin = { url: browserUrl.origin };
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
        const shared = Layer.mergeAll(agentSession, catalog, runStore);
        yield* Effect.addFinalizer(() =>
          fileSystem
            .remove(ownerMarker, { recursive: true })
            .pipe(Effect.ignore)
        );
        // A TTY means a human started this process for URL clients. Stdio
        // would then consume the terminal. Claude and Codex spawn us with a
        // pipe and still get NDJSON on stdin.
        if (!process.stdin.isTTY) {
          yield* Layer.build(
            Layer.mergeAll(
              McpServer.layerStdio({
                name: "Contingency",
                protocols: [McpProtocol.v2025_06_18],
                version: "0.0.1",
              }),
              mcpTools
            ).pipe(Layer.provide(shared))
          );
        }
        const allowedOrigins = resolveAllowedOrigins(browserUrl);
        yield* Layer.build(
          makeHttpServerLayer({
            agentFlowCatalog: catalog,
            agentRunStore: runStore,
            agentSession,
            allowedOrigins,
            host,
            mcp: makeMcpHttpLayer(allowedOrigins).pipe(Layer.provide(shared)),
            port,
            run: { flow: null, outputDirectory: defaultRunsDirectory() },
            serveWebUi: true,
          }).pipe(Layer.provide(agentSession))
        );
        yield* Console.error(
          `Contingency MCP available at ${browserUrl.origin}/mcp`
        );
        yield* Console.error(
          `Contingency MCP Agent View available at ${browserUrl.origin}/agent`
        );
        return yield* Effect.never;
      })
    ).pipe(Effect.provideService(Logger.LogToStderr, true));
  })
).pipe(
  Command.withDescription(
    "Run one process-owned local MCP server and Agent View endpoint."
  )
);
