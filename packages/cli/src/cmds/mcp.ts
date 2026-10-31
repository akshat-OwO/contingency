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
import { constUndefined } from "effect/Function";
import { HttpServer } from "effect/http";
import type { HttpServerError } from "effect/http";
import type { PlatformError } from "effect/PlatformError";

import packageJson from "../../package.json" with { type: "json" };
import { AgentHarnesses, HARNESS_IDS } from "../services/agent-harness.ts";
import {
  persistentInvocation,
  reconnectCommand,
  registrationCommand,
} from "../services/agent-launch.ts";
import { makeAgentRunStoreLayer } from "../services/agent-run-store.ts";
import {
  defaultAgentResourceDirectory,
  prepareAgentResourceDirectory,
} from "../services/agent-session-resources.ts";
import { makeAgentSessionLayer } from "../services/agent-session.ts";
import { makeAndroidWorkspaceLayer } from "../services/android-workspace.ts";
import {
  defaultGlobalCatalogRoot,
  makeCatalogBrowserLayer,
} from "../services/catalog-browser.ts";
import {
  defaultHomeDirectory,
  resolveCatalogDirectory,
} from "../services/catalog-directory.ts";
import { makeDemoSiteLayer } from "../services/demo-site-server.ts";
import { makeFlowSkillCatalogLayer } from "../services/flow-skill-catalog.ts";
import {
  makeHttpServerLayer,
  makeNodeServerLayer,
} from "../services/http-server.ts";
import { makeIosWorkspaceLayer } from "../services/ios-workspace.ts";
import { LocalSystemOneLifecycleLive } from "../services/local-system-one-lifecycle-live.ts";
import { LocalSystemOneLifecycle } from "../services/local-system-one-lifecycle.ts";
import { LocalSystemOneLive } from "../services/local-system-one-live.ts";
import {
  processAlive,
  supervisorAlive,
} from "../services/local-system-one-process.ts";
import {
  readLocalSystemOneUpdateCache,
  refreshLocalSystemOneUpdateCache,
  localSystemOneUpdateNotice,
} from "../services/local-system-one-updates.ts";
import { LocalSystemOne } from "../services/local-system-one.ts";
import { McpChannelStdio } from "../services/mcp-channel.ts";
import {
  makeMcpCatalogLayer,
  makeMcpInstructions,
  makeMcpHttpLayer,
} from "../services/mcp-http.ts";
import {
  availablePlatforms,
  describeSettings,
  describeSystemOne,
} from "../services/mcp-process-info.ts";
import { RunVideoRendererLive } from "../services/run-video-renderer.ts";
import {
  DEFAULT_MCP_INTERFACE,
  loadSettings,
  MCP_INTERFACES,
  VIDEO_FAST_FORWARD_MODES,
} from "../services/settings.ts";
import { resolveSystemOne } from "../services/system-one-discovery.ts";
import {
  makeTeachingRecordingStoreLayer,
  TEACHING_RECORDINGS_DIRECTORY,
} from "../services/teaching-recording-store.ts";
import { resolveAllowedOrigins } from "../services/web-url.ts";

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
  process.stdin.isTTY
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
      }).pipe(
        Effect.andThen(
          agentOwned
            ? Effect.void
            : Console.error("Contingency MCP headless stdin closed.").pipe(
                Effect.andThen(Effect.never)
              )
        )
      );

/**
 * The Settings `contingency mcp` reads. Non-terminal stdin defaults to port
 * 0, which binds an available port; terminal stdin defaults to 7777.
 */
export const mcpConfig = (isTerminal: boolean) =>
  Config.all({
    // Claude Code channels are opt-in and stdio-only (ADR 0055).
    channel: Config.Boolean("CHANNEL").pipe(Config.withDefault(false)),
    // One code tool by default (ADR 0059, #461); "native" registers each
    // tool directly.
    interface: Config.Literals(MCP_INTERFACES, "INTERFACE").pipe(
      Config.withDefault(DEFAULT_MCP_INTERFACE)
    ),
    port: Config.Number("PORT").pipe(Config.withDefault(isTerminal ? 7777 : 0)),
    // How Run videos fast-forward Idle Gaps (ADR 0046).
    videoFastForward: Config.Literals(
      VIDEO_FAST_FORWARD_MODES,
      "VIDEO_FAST_FORWARD"
    ).pipe(Config.withDefault("capped" as const)),
  }).pipe(Config.nested("CONTINGENCY_MCP"));

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
    agent: Flag.Literals("agent", HARNESS_IDS).pipe(
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
    sessionOnly: Flag.Boolean("session-only").pipe(
      Flag.withDescription(
        "Identify a session-only server launched by contingency start."
      ),
      Flag.withDefault(false)
    ),
  },
  Effect.fnUntraced(function* runMcp({
    agent,
    demo,
    fallbackDirectory,
    sessionOnly,
  }) {
    const harnesses = yield* AgentHarnesses;
    const projectDirectory = Option.isSome(agent)
      ? yield* harnesses[agent.value].currentProjectDirectory({
          cwd: process.cwd(),
          env: process.env,
        })
      : process.cwd();
    const catalogDirectory = yield* resolveCatalogDirectory({
      env: process.env,
      fallbackDirectory: Option.getOrUndefined(fallbackDirectory),
      home: defaultHomeDirectory(),
      projectDirectory,
    });
    const invocation = persistentInvocation({
      execPath: process.execPath,
      packageName: packageJson.name,
      script: process.argv[1] ?? "",
      version: packageJson.version,
    });
    const launchContext = [
      "## Launch context",
      "",
      `- Agent: ${Option.isSome(agent) ? harnesses[agent.value].label : "Unspecified Agent Harness"}`,
      `- Working directory: ${projectDirectory}`,
      `- Catalog Root: ${catalogDirectory.root}`,
      `- Connection: ${sessionOnly ? "session-only; the user's agent configuration is unchanged." : "configured MCP connection; registration is managed by the Agent Harness."}`,
      ...(catalogDirectory.fallback === undefined
        ? []
        : [
            `- Catalog fallback: ${catalogDirectory.fallback.directory}. ${catalogDirectory.fallback.reason}`,
          ]),
      ...(Option.isSome(agent)
        ? [
            `- Reconnect command (run from the working directory; add --demo for the guided demo): ${reconnectCommand({ agent: agent.value, invocation })}`,
            `- Original onboarding directory (fallback for registration across projects): ${Option.getOrElse(fallbackDirectory, () => projectDirectory)}`,
            `- Registration command (add --scope project or --scope user, and --replace only after the user chooses replacement): ${registrationCommand({ agent: agent.value, directory: Option.getOrElse(fallbackDirectory, () => projectDirectory), invocation })}`,
          ]
        : []),
    ].join("\n");
    // Settings follow the Catalog Root this process starts with (ADR 0063).
    const settings = yield* loadSettings({
      catalogRoot: catalogDirectory.root,
      env: process.env,
    });
    for (const warning of settings.warnings) {
      yield* Console.error(warning);
    }
    const config = yield* mcpConfig(process.stdin.isTTY).parse(
      settings.provider
    );
    // This command is intentionally local-only: it always binds loopback.
    const host = "127.0.0.1";
    const { channel, port, videoFastForward } = config;
    const mcpInterface = config.interface;
    // Delegated sub-goals, only when this machine names an endpoint (ADR 0057).
    const localServices = Layer.merge(
      LocalSystemOneLive,
      LocalSystemOneLifecycleLive.pipe(Layer.provide(LocalSystemOneLive))
    );
    const {
      systemOne,
      lifecycle: localLifecycle,
      local: localInstallation,
    } = yield* Effect.gen(function* localDiscovery() {
      const local = yield* LocalSystemOne;
      const lifecycle = yield* LocalSystemOneLifecycle;
      const resolvedSystemOne = yield* resolveSystemOne(
        settings.provider,
        local,
        lifecycle
      );
      return { lifecycle, local, systemOne: resolvedSystemOne };
    }).pipe(Effect.provide(localServices));
    // Keep startup Settings and interface fixed; reread only for diagnostics.
    const settingsInput = {
      catalogRoot: catalogDirectory.root,
      env: { ...process.env },
    };
    const diagnosticsFileSystem = yield* FileSystem.FileSystem;
    const processInfo = Effect.gen(function* readProcessInfo() {
      const current = yield* loadSettings(settingsInput).pipe(
        Effect.orElseSucceed(constUndefined)
      );
      const local = yield* Effect.gen(function* readLocalStatus() {
        const state = yield* localInstallation.status;
        const server = state?.server;
        const running =
          server !== undefined &&
          server !== null &&
          (yield* supervisorAlive(server)) &&
          (yield* processAlive(server.kevPid, server.kevStartIdentity));
        return { running, state };
      }).pipe(Effect.orElseSucceed(constUndefined));
      return {
        mcpInterface,
        platforms: yield* availablePlatforms,
        settings: describeSettings(settings, current, mcpInterface),
        systemOne: describeSystemOne(systemOne, local),
      };
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, diagnosticsFileSystem)
    );
    const boundOrigin = { url: new URL(`http://${host}:${port}`).origin };
    return yield* Effect.scoped(
      Effect.gen(function* runMcpServer() {
        const installation = yield* localInstallation.status.pipe(
          Effect.orElseSucceed(constUndefined)
        );
        if (installation !== undefined) {
          const notice = localSystemOneUpdateNotice(
            yield* readLocalSystemOneUpdateCache(
              localInstallation.dataDirectory,
              installation
            )
          );
          if (notice !== undefined) {
            yield* Console.error(notice);
          }
          yield* refreshLocalSystemOneUpdateCache(
            localInstallation.dataDirectory,
            installation
          ).pipe(
            Effect.catch((error) => Effect.logDebug(error.message)),
            Effect.forkChild
          );
        }
        if (systemOne?.local !== undefined) {
          yield* localLifecycle.ensureStarted.pipe(
            Effect.catch((error) => Console.error(error.message)),
            Effect.forkChild
          );
        }
        const fileSystem = yield* FileSystem.FileSystem;
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
        // The Workspace's Skills drawer follows the selected root, and also
        // lists the user's global root; no tool reads the global one.
        const catalogBrowser = Layer.succeedContext(
          yield* Layer.build(
            makeCatalogBrowserLayer({
              globalRoot: defaultGlobalCatalogRoot(),
              localRoot: () => selectedCatalogRoot,
            }).pipe(Layer.provide(catalog))
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
        const browserSession = Layer.succeedContext(
          yield* Layer.build(
            makeAgentSessionLayer({
              allowedActivity: "any",
              get baseUrl() {
                return boundOrigin.url;
              },
              catalogRoot: () => selectedCatalogRoot,
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
        const androidWorkspace = Layer.succeedContext(
          yield* Layer.build(
            makeAndroidWorkspaceLayer({ root: () => selectedCatalogRoot }).pipe(
              Layer.provide(Layer.merge(teachingRecordingStore, catalog))
            )
          )
        );
        const iosWorkspace = Layer.succeedContext(
          yield* Layer.build(
            makeIosWorkspaceLayer({
              root: () => selectedCatalogRoot,
            }).pipe(Layer.provide(Layer.merge(teachingRecordingStore, catalog)))
          )
        );
        const agentSession = Layer.mergeAll(
          browserSession,
          androidWorkspace,
          iosWorkspace
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
                  instructions: makeMcpInstructions(
                    channel,
                    systemOne,
                    mcpInterface
                  ),
                  name: "Contingency",
                  protocols: [McpProtocol.v2025_06_18, McpProtocol.v2025_11_25],
                  version: "0.0.1",
                }),
                makeMcpCatalogLayer({
                  demoSite,
                  interface: mcpInterface,
                  launchContext,
                  processInfo,
                  systemOne,
                })
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
            catalogBrowser,
            host,
            mcp: makeMcpHttpLayer(allowedOrigins, {
              demoSite,
              interface: mcpInterface,
              launchContext,
              processInfo,
              systemOne,
            }).pipe(Layer.provide(shared)),
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
