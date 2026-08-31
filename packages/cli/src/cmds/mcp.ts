import { Config, Console, Effect, FileSystem, Layer, Logger } from "effect";
import { McpProtocol, McpServer } from "effect/unstable/ai";
import { Command } from "effect/unstable/cli";

import {
  defaultAgentResourceDirectory,
  prepareAgentResourceDirectory,
} from "../services/agent-session-resources.ts";
import { makeAgentSessionLayer } from "../services/agent-session.ts";
import { makeHttpServerLayer } from "../services/http-server.ts";
import { McpAgentSessionLayer } from "../services/mcp-agent-session.ts";
import { defaultRunsDirectory } from "../services/state-directory.ts";
import { resolveAllowedOrigins } from "../services/web-url.ts";

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
    const browserUrl = new URL(`http://${config.host}:${config.port}`);
    return yield* Effect.scoped(
      Effect.gen(function* runMcpServer() {
        const fileSystem = yield* FileSystem.FileSystem;
        const ownerMarker = yield* prepareAgentResourceDirectory(
          defaultAgentResourceDirectory()
        );
        const agentSession = makeAgentSessionLayer({
          baseUrl: browserUrl.origin,
          resourceDirectory: ownerMarker,
        });
        const server = Layer.mergeAll(
          makeHttpServerLayer({
            agentSession,
            allowedOrigins: resolveAllowedOrigins(browserUrl),
            host: config.host,
            port: config.port,
            run: { flow: null, outputDirectory: defaultRunsDirectory() },
            serveWebUi: true,
          }),
          McpServer.layerStdio({
            name: "Contingency",
            protocols: [McpProtocol.v2025_06_18],
            version: "0.0.1",
          }),
          McpAgentSessionLayer
        ).pipe(Layer.provide(agentSession));
        yield* Effect.addFinalizer(() =>
          fileSystem
            .remove(ownerMarker, { recursive: true })
            .pipe(Effect.ignore)
        );
        yield* Layer.build(server);
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
