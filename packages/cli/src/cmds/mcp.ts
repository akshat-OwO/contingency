import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import {
  Config,
  Console,
  Context,
  Effect,
  FileSystem,
  Layer,
  Logger,
  Option,
  Result,
  Schema,
} from "effect";
import { McpProtocol, McpServer } from "effect/ai";
import type { IllegalArgumentError } from "effect/Cause";
import { Command, Flag } from "effect/cli";
import { HttpServer } from "effect/http";
import type { HttpServerError } from "effect/http";
import type { PlatformError } from "effect/PlatformError";

import { makeAgentRunStoreLayer } from "../services/agent-run-store.ts";
import {
  defaultAgentResourceDirectory,
  prepareAgentResourceDirectory,
} from "../services/agent-session-resources.ts";
import { makeAgentSessionLayer } from "../services/agent-session.ts";
import {
  REGISTERED_AGENTS,
  defaultHomeDirectory,
  resolveCatalogDirectory,
} from "../services/catalog-directory.ts";
import { makeDemoSiteLayer } from "../services/demo-site-server.ts";
import { makeFlowSkillCatalogLayer } from "../services/flow-skill-catalog.ts";
import {
  makeHttpServerLayer,
  makeNodeServerLayer,
} from "../services/http-server.ts";
import { McpAgentRunLayer } from "../services/mcp-agent-run.ts";
import { McpAgentSessionLayer } from "../services/mcp-agent-session.ts";
import { McpAuthoringSkillsLayer } from "../services/mcp-authoring-skills.ts";
import { McpAgentCatalogLayer } from "../services/mcp-catalog.ts";
import { McpChannelStdio } from "../services/mcp-channel.ts";
import { McpCodeModeLayer } from "../services/mcp-code-mode.ts";
import { MCP_INSTRUCTIONS, makeMcpHttpLayer } from "../services/mcp-http.ts";
import { makeMcpStartLayer } from "../services/mcp-onboarding.ts";
import { McpTeachingRecordingLayer } from "../services/mcp-teaching-recording.ts";
import { RunVideoRendererLive } from "../services/run-video-renderer.ts";
import {
  makeTeachingRecordingStoreLayer,
  TEACHING_RECORDINGS_DIRECTORY,
} from "../services/teaching-recording-store.ts";
import { resolveAllowedOrigins } from "../services/web-url.ts";

const mcpTools = Layer.mergeAll(
  McpAgentSessionLayer,
  McpAgentCatalogLayer,
  McpAgentRunLayer,
  McpTeachingRecordingLayer,
  McpAuthoringSkillsLayer
);

const ListenError = Schema.Struct({ code: Schema.String });
type McpHttpFailure =
  | HttpServerError.ServeError
  | IllegalArgumentError
  | PlatformError;

export const isListenAddressInUse = (error: McpHttpFailure): boolean => {
  // npm may install separate Effect copies for the CLI and platform-node.
  // Tagged errors retain their identity across those copies; prototypes do not.
  if (error._tag !== "ServeError") {
    return false;
  }
  return Schema.decodeUnknownOption(ListenError)(error.cause).pipe(
    Option.exists(({ code }) => code === "EADDRINUSE")
  );
};

/**
 * Stdin closes when the agent that spawned this process exits, including an
 * agent that is killed without stopping its children. Ending then runs every
 * finalizer, so browsers close and Teaching Recordings and Runs persist under
 * their lifecycle contracts instead of an orphan holding ports. A process a
 * human started directly serves URL clients until it is interrupted, including
 * a headless process whose stdin is closed.
 */
const untilClientLeaves = (agentOwned: boolean): Effect.Effect<void> =>
  !agentOwned || process.stdin.isTTY
    ? Effect.never
    : Effect.callback((resume) => {
        if (process.stdin.readableEnded || process.stdin.destroyed) {
          resume(Effect.void);
          return;
        }
        const leave = (): void => {
          resume(Effect.void);
        };
        process.stdin.once("end", leave);
        process.stdin.once("close", leave);
        return Effect.sync(() => {
          process.stdin.off("end", leave);
          process.stdin.off("close", leave);
        });
      });

/**
 * Start one local MCP process. Its Agent Session layer is passed to both the
 * stdio adapter (Claude, Codex) and the Streamable HTTP `/mcp` route plus
 * Workspace, so all browser handles and shutdown finalizers remain owned by
 * this one process.
 *
 * Non-terminal stdin defaults to port 0, which binds an available port. This
 * includes stdio clients and headless HTTP launches. The bind acquires the
 * port before any route or link is built, so spawned clients never race for
 * one port and each advertises its own Workspace. Terminal stdin defaults to
 * 7777. Headless HTTP callers needing a fixed endpoint must explicitly set
 * `CONTINGENCY_MCP_PORT`, which overrides either default.
 */
export const mcpCommand = Command.make(
  "mcp",
  {
    agent: Flag.Literals("agent", REGISTERED_AGENTS).pipe(
      Flag.withDescription(
        "The agent that spawns this server, which says how its current project directory is found."
      ),
      Flag.optional
    ),
    demo: Flag.Boolean("demo").pipe(
      Flag.withDescription(
        "Serve the bundled demo store, its Examples, and the onboarding prompt, as `contingency start --demo` does. Off by default."
      ),
      Flag.withDefault(false)
    ),
    fallbackDirectory: Flag.String("fallback-directory").pipe(
      Flag.withDescription(
        "The original onboarding directory, used only when no usable current project directory is available."
      ),
      Flag.optional
    ),
  },
  Effect.fnUntraced(function* runMcp({ agent, demo, fallbackDirectory }) {
    const config = yield* Config.all({
      // Claude Code channels are opt-in and stdio-only (ADR 0051).
      channel: Config.Boolean("CHANNEL").pipe(Config.withDefault(false)),
      // Opt-in sandboxed code orchestration (ADR 0045).
      codeMode: Config.Boolean("CODE_MODE").pipe(Config.withDefault(false)),
      host: Config.String("HOST").pipe(Config.withDefault("127.0.0.1")),
      port: Config.Number("PORT").pipe(
        Config.withDefault(process.stdin.isTTY ? 7777 : 0)
      ),
      // How Run videos fast-forward Idle Gaps (ADR 0046).
      videoFastForward: Config.Literals(
        ["capped", "fixed"],
        "VIDEO_FAST_FORWARD"
      ).pipe(Config.withDefault("capped" as const)),
    }).pipe(Config.nested("CONTINGENCY_MCP"));
    // This command is intentionally local-only. A non-loopback HOST is not
    // accepted even if an operator accidentally configures one in the shell.
    if (config.host !== "127.0.0.1") {
      return yield* Effect.die(
        new Error("The MCP server must bind to 127.0.0.1.")
      );
    }
    const { channel, codeMode, host, port, videoFastForward } = config;
    const boundOrigin = { url: new URL(`http://${host}:${port}`).origin };
    return yield* Effect.scoped(
      Effect.gen(function* runMcpServer() {
        const fileSystem = yield* FileSystem.FileSystem;
        const catalogDirectory = yield* resolveCatalogDirectory({
          agent: Option.getOrUndefined(agent),
          cwd: process.cwd(),
          env: process.env,
          fallbackDirectory: Option.getOrUndefined(fallbackDirectory),
          home: defaultHomeDirectory(),
        });
        const ownerMarker = yield* prepareAgentResourceDirectory(
          defaultAgentResourceDirectory()
        );
        let selectedCatalogRoot = catalogDirectory.root;
        const teachingRecordingStore = Layer.succeedContext(
          yield* Layer.build(
            makeTeachingRecordingStoreLayer({
              root: () => selectedCatalogRoot,
            })
          )
        );
        // The catalog is durable and process-independent: it is selected per
        // process but never part of shutdown cleanup.
        const catalog = Layer.succeedContext(
          yield* Layer.build(
            makeFlowSkillCatalogLayer({
              fallback: catalogDirectory.fallback,
              onSelect: (root: string) => {
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
        const runVideoRenderer = Layer.succeedContext(
          yield* Layer.build(RunVideoRendererLive)
        );
        // The demo store binds its own port, so a server without the demo
        // surface never starts it.
        const demoSite = demo
          ? Layer.succeedContext(yield* Layer.build(makeDemoSiteLayer()))
          : undefined;
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
              videoFastForward,
            }).pipe(
              Layer.provide(
                Layer.mergeAll(
                  runStore,
                  teachingRecordingStore,
                  runVideoRenderer
                )
              )
            )
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
        const serveStdio = process.stdin.isTTY
          ? Effect.void
          : Layer.build(
              Layer.mergeAll(
                McpServer.layerStdio({
                  instructions: channel
                    ? MCP_INSTRUCTIONS.replace(
                        "After asking the user to act in the Workspace, call agent_session_get with afterCursor and waitMs instead of asking them to report back.",
                        "On channel events, call agent_session_get with meta.sessionId and meta.eventCursor as afterCursor. Otherwise wait with afterCursor and waitMs."
                      )
                    : MCP_INSTRUCTIONS,
                  name: "Contingency",
                  protocols: [McpProtocol.v2025_06_18, McpProtocol.v2025_11_25],
                  version: "0.0.1",
                }),
                mcpTools,
                makeMcpStartLayer(demoSite),
                codeMode ? McpCodeModeLayer : Layer.empty
              ).pipe(
                Layer.provide(
                  channel
                    ? McpChannelStdio.pipe(Layer.provide(shared))
                    : Layer.empty
                ),
                Layer.provide(shared)
              )
            );
        const bound = yield* Layer.build(
          makeNodeServerLayer({ host, port })
        ).pipe(Effect.result);
        if (Result.isFailure(bound)) {
          // URL clients need this exact port. Spawned stdio clients (Claude,
          // Codex) must keep tools up when the bind is taken, the same
          // contract the occupied-port integration test pins.
          if (isListenAddressInUse(bound.failure) && !process.stdin.isTTY) {
            yield* serveStdio;
            yield* Console.error(
              `Contingency MCP Workspace could not bind ${host}:${port}; tools still run on stdio.`
            );
            return yield* untilClientLeaves(Option.isSome(agent));
          }
          return yield* Effect.fail(bound.failure);
        }
        const { address } = Context.get(bound.success, HttpServer.HttpServer);
        if (address._tag === "UnixPathAddress") {
          return yield* Effect.die(
            new Error("The MCP Workspace must listen on a TCP port.")
          );
        }
        const browserUrl = new URL(`http://${host}:${address.port}`);
        boundOrigin.url = browserUrl.origin;
        const allowedOrigins = resolveAllowedOrigins(browserUrl);
        yield* Layer.build(
          makeHttpServerLayer({
            agentRunStore: runStore,
            agentSession,
            allowedOrigins,
            host,
            mcp: makeMcpHttpLayer(allowedOrigins, { codeMode, demoSite }).pipe(
              Layer.provide(shared)
            ),
            port: address.port,
            runVideoRenderer,
            serveWebUi: true,
            server: Layer.succeedContext(bound.success),
            teachingRecordingStore,
          }).pipe(Layer.provide(agentSession))
        );
        // Tools start only after the Workspace is listening, so a client never
        // reaches a tool whose Workspace link is not served yet.
        yield* serveStdio;
        yield* Console.error(
          `Contingency MCP available at ${browserUrl.origin}/mcp`
        );
        yield* Console.error(
          `Contingency MCP Workspace available at ${browserUrl.origin}/`
        );
        if (catalogDirectory.fallback !== undefined) {
          yield* Console.error(
            `Contingency Catalog Root falls back to ${catalogDirectory.root}. ${catalogDirectory.fallback.reason}`
          );
        }
        return yield* untilClientLeaves(Option.isSome(agent));
      })
    ).pipe(Effect.provideService(Logger.LogToStderr, true));
  })
).pipe(
  Command.withDescription(
    "Run one process-owned local MCP server and Workspace endpoint."
  )
);
