import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import {
  Config,
  Console,
  Effect,
  FileSystem,
  Layer,
  Logger,
  Option,
  Result,
  Schema,
} from "effect";
import type { IllegalArgumentError } from "effect/Cause";
import type { PlatformError } from "effect/PlatformError";
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
import { McpAuthoringSkillsLayer } from "../services/mcp-authoring-skills.ts";
import { makeMcpHttpLayer } from "../services/mcp-http.ts";
import { McpTeachingRecordingLayer } from "../services/mcp-teaching-recording.ts";
import {
  makeTeachingRecordingStoreLayer,
  TEACHING_RECORDINGS_DIRECTORY,
} from "../services/teaching-recording-store.ts";
import { resolveAllowedOrigins } from "../services/web-url.ts";

const mcpTools = Layer.mergeAll(
  McpAgentSessionLayer,
  McpAgentFlowLayer,
  McpAgentRunLayer,
  McpTeachingRecordingLayer,
  McpAuthoringSkillsLayer
);

const ListenError = Schema.Struct({ code: Schema.String });
type McpHttpFailure =
  | HttpServerError.ServeError
  | IllegalArgumentError
  | PlatformError;

const isListenAddressInUse = (error: McpHttpFailure): boolean => {
  if (!(error instanceof HttpServerError.ServeError)) {
    return false;
  }
  return Schema.decodeUnknownOption(ListenError)(error.cause).pipe(
    Option.exists(({ code }) => code === "EADDRINUSE")
  );
};

/**
 * Start one local MCP process. Its Agent Session layer is passed to both the
 * stdio adapter (Claude, Codex) and the Streamable HTTP `/mcp` route plus
 * Workspace, so all browser handles and shutdown finalizers remain owned by
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
        const teachingRecordingStore = Layer.succeedContext(
          yield* Layer.build(
            makeTeachingRecordingStoreLayer({
              root: () => selectedCatalogRoot,
            })
          )
        );
        const agentSession = Layer.succeedContext(
          yield* Layer.build(
            makeAgentSessionLayer({
              allowedActivity: "any",
              get baseUrl() {
                return boundOrigin.url;
              },
              resourceDirectory: ownerMarker,
              traceDirectory: () =>
                path.join(selectedCatalogRoot, TEACHING_RECORDINGS_DIRECTORY),
            }).pipe(Layer.provide(teachingRecordingStore))
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
        const shared = Layer.mergeAll(
          agentSession,
          catalog,
          runStore,
          teachingRecordingStore,
          NodeServices.layer
        );
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
        const httpOutcome = yield* Layer.build(
          makeHttpServerLayer({
            agentFlowCatalog: catalog,
            agentRunStore: runStore,
            agentSession,
            allowedOrigins,
            host,
            mcp: makeMcpHttpLayer(allowedOrigins).pipe(Layer.provide(shared)),
            port,
            serveWebUi: true,
          }).pipe(Layer.provide(agentSession))
        ).pipe(Effect.result);
        if (Result.isSuccess(httpOutcome)) {
          yield* Console.error(
            `Contingency MCP available at ${browserUrl.origin}/mcp`
          );
          yield* Console.error(
            `Contingency MCP Workspace available at ${browserUrl.origin}/`
          );
          return yield* Effect.never;
        }
        // URL clients need this exact port. Spawned stdio clients (Claude,
        // Codex) must keep tools up when the bind is taken, the same contract
        // the occupied-port integration test pins.
        if (isListenAddressInUse(httpOutcome.failure) && !process.stdin.isTTY) {
          yield* Console.error(
            `Contingency MCP Workspace could not bind ${host}:${port}; tools still run on stdio.`
          );
          return yield* Effect.never;
        }
        return yield* Effect.fail(httpOutcome.failure);
      })
    ).pipe(Effect.provideService(Logger.LogToStderr, true));
  })
).pipe(
  Command.withDescription(
    "Run one process-owned local MCP server and Workspace endpoint."
  )
);
