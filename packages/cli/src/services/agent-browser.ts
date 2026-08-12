import { randomUUID } from "node:crypto";
import { arch, homedir, platform } from "node:os";
import path from "node:path";

import {
  BrowserRequestId,
  BrowserStreamEvent as BrowserStreamEventSchema,
  BrowserTabId,
  isBrowserRpcError,
  makeBrowserRpcError,
  SessionId as SessionIdSchema,
  userAgentProfiles,
} from "@contingency/protocol";
import type {
  BrowserInput,
  BrowserNetworkRequest,
  BrowserNetworkRequestDetail,
  BrowserRpcErrorType,
  BrowserStreamEvent,
  BrowserTab,
  SessionId,
  UserAgentProfileId,
  Viewport,
} from "@contingency/protocol";
import {
  Console,
  Context,
  Data,
  Effect,
  FileSystem,
  Layer,
  Queue,
  Ref,
  Result,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import type { PlatformError } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import agentBrowserPackage from "../../assets/agent-browser/package.json" with { type: "json" };

const getAgentBrowserAssetsDirectory = (): string => {
  const moduleDirectory = import.meta.dirname;
  const packageDirectory =
    path.basename(moduleDirectory) === "dist"
      ? path.dirname(moduleDirectory)
      : path.resolve(moduleDirectory, "../..");

  return path.join(packageDirectory, "assets", "agent-browser", "bin");
};

const AGENT_BROWSER_ASSETS_DIRECTORY = getAgentBrowserAssetsDirectory();
const INSTALL_MARKER = `agent-browser-${agentBrowserPackage.version}.installed`;
// Match the protocol's maximum viewport so agent-browser never downsamples a frame.
const MAX_STREAM_DIMENSION = "10000";

class AgentBrowserSetupError extends Data.TaggedError(
  "AgentBrowserSetupError"
)<{
  readonly message: string;
}> {}

type AgentBrowserInitError =
  | AgentBrowserSetupError
  | PlatformError.PlatformError;

export interface AgentBrowser {
  readonly acknowledgeFrame: (
    sessionId: SessionId,
    sequence: number
  ) => Effect.Effect<void, BrowserRpcErrorType>;
  readonly attach: (
    sessionId: SessionId
  ) => Effect.Effect<SessionId, BrowserRpcErrorType>;
  readonly close: (
    sessionId: SessionId
  ) => Effect.Effect<void, BrowserRpcErrorType>;
  readonly create: (
    name: string,
    viewport: Viewport
  ) => Effect.Effect<SessionId, BrowserRpcErrorType>;
  readonly init: () => Effect.Effect<void, AgentBrowserInitError>;
  readonly currentUrl: (
    sessionId: SessionId
  ) => Effect.Effect<string, BrowserRpcErrorType>;
  readonly getNetworkRequests: (
    sessionId: SessionId,
    tabId: BrowserTabId
  ) => Effect.Effect<readonly BrowserNetworkRequest[], BrowserRpcErrorType>;
  readonly getNetworkRequest: (
    sessionId: SessionId,
    tabId: BrowserTabId,
    requestId: BrowserRequestId
  ) => Effect.Effect<BrowserNetworkRequestDetail, BrowserRpcErrorType>;
  readonly getTabs: (
    sessionId: SessionId
  ) => Effect.Effect<readonly BrowserTab[], BrowserRpcErrorType>;
  readonly list: () => Effect.Effect<readonly SessionId[], BrowserRpcErrorType>;
  readonly navigate: (
    sessionId: SessionId,
    action: "back" | "forward" | "reload"
  ) => Effect.Effect<void, BrowserRpcErrorType>;
  readonly newTab: (
    sessionId: SessionId
  ) => Effect.Effect<void, BrowserRpcErrorType>;
  readonly open: (
    sessionId: SessionId | undefined,
    url: string,
    viewport: Viewport,
    userAgentProfile: UserAgentProfileId
  ) => Effect.Effect<
    { readonly sessionId: SessionId; readonly url: string },
    BrowserRpcErrorType
  >;
  readonly sendInput: (
    sessionId: SessionId,
    input: BrowserInput
  ) => Effect.Effect<void, BrowserRpcErrorType>;
  readonly stream: (
    sessionId: SessionId
  ) => Stream.Stream<BrowserStreamEvent, BrowserRpcErrorType>;
  readonly switchTab: (
    sessionId: SessionId,
    tabId: BrowserTabId
  ) => Effect.Effect<void, BrowserRpcErrorType>;
  readonly closeTab: (
    sessionId: SessionId,
    tabId: BrowserTabId
  ) => Effect.Effect<void, BrowserRpcErrorType>;
  readonly setViewport: (
    sessionId: SessionId,
    viewport: Viewport
  ) => Effect.Effect<void, BrowserRpcErrorType>;
  readonly setUserAgent: (
    sessionId: SessionId,
    url: string,
    viewport: Viewport,
    userAgentProfile: UserAgentProfileId
  ) => Effect.Effect<{ readonly url: string }, BrowserRpcErrorType>;
}

export interface AgentBrowserRuntime {
  readonly architecture: string;
  readonly isMusl: boolean;
  readonly operatingSystem: NodeJS.Platform;
}

export const AgentBrowser = Context.Service<AgentBrowser>(
  "@contingency/AgentBrowser"
);

const isMusl = (): boolean => {
  const report = process.report.getReport();
  if (
    !("header" in report) ||
    report.header === null ||
    typeof report.header !== "object"
  ) {
    return false;
  }

  return !("glibcVersionRuntime" in report.header);
};

const getRuntime = (): AgentBrowserRuntime => {
  const operatingSystem = platform();

  return {
    architecture: arch(),
    isMusl: operatingSystem === "linux" && isMusl(),
    operatingSystem,
  };
};

const getAgentBrowserExecutable = Effect.fn("getAgentBrowserExecutable")(
  function* getAgentBrowserExecutable(runtime: AgentBrowserRuntime) {
    const { architecture, operatingSystem } = runtime;

    if (
      operatingSystem === "win32" &&
      (architecture === "x64" || architecture === "arm64")
    ) {
      return {
        browserInstallSupported: true,
        name: "agent-browser-win32-x64.exe",
      } as const;
    }

    if (
      (operatingSystem === "darwin" || operatingSystem === "linux") &&
      (architecture === "x64" || architecture === "arm64")
    ) {
      const operatingSystemKey =
        operatingSystem === "linux" && runtime.isMusl
          ? "linux-musl"
          : operatingSystem;

      return {
        browserInstallSupported: !(
          operatingSystem === "linux" && architecture === "arm64"
        ),
        name: `agent-browser-${operatingSystemKey}-${architecture}`,
      } as const;
    }

    return yield* new AgentBrowserSetupError({
      message: `agent-browser does not support ${operatingSystem}-${architecture}`,
    });
  }
);

const getStateDirectory = (operatingSystem: NodeJS.Platform): string => {
  const configuredStateDirectory = process.env.CONTINGENCY_STATE_DIR?.trim();
  if (configuredStateDirectory) {
    return configuredStateDirectory;
  }

  if (operatingSystem === "win32") {
    const localApplicationData = process.env.LOCALAPPDATA?.trim();
    return path.join(
      localApplicationData || path.join(homedir(), "AppData", "Local"),
      "contingency"
    );
  }

  const xdgStateHome = process.env.XDG_STATE_HOME?.trim();
  return path.join(
    xdgStateHome || path.join(homedir(), ".local", "state"),
    "contingency"
  );
};

const AgentBrowserJsonResult = <Data extends Schema.Top>(data: Data) =>
  Schema.Struct({ data, success: Schema.Literal(true) });

const SessionListResult = AgentBrowserJsonResult(
  Schema.Struct({ sessions: Schema.Array(Schema.String) })
);

const StreamStatusResult = AgentBrowserJsonResult(
  Schema.Struct({
    connected: Schema.Boolean,
    enabled: Schema.Boolean,
    port: Schema.Int,
  })
);

const EvalStringResult = AgentBrowserJsonResult(
  Schema.Struct({ result: Schema.String })
);

const CurrentUrlResult = AgentBrowserJsonResult(
  Schema.Struct({ url: Schema.String })
);

const CurrentTitleResult = AgentBrowserJsonResult(
  Schema.Struct({ title: Schema.String })
);

const BrowserTabSchema = Schema.Struct({
  active: Schema.Boolean,
  label: Schema.optional(Schema.NullOr(Schema.String)),
  tabId: BrowserTabId,
  title: Schema.String,
  type: Schema.String,
  url: Schema.String,
});

const BrowserTabsResult = AgentBrowserJsonResult(
  Schema.Struct({ tabs: Schema.Array(BrowserTabSchema) })
);

const AgentBrowserNetworkRequestSchema = Schema.Struct({
  headers: Schema.Unknown,
  method: Schema.String,
  mimeType: Schema.optional(Schema.String),
  postData: Schema.optional(Schema.String),
  requestId: BrowserRequestId,
  resourceType: Schema.String,
  responseHeaders: Schema.optional(Schema.Unknown),
  status: Schema.optional(Schema.Int),
  timestamp: Schema.Int,
  url: Schema.String,
});

const BrowserNetworkRequestsResult = AgentBrowserJsonResult(
  Schema.Struct({ requests: Schema.Array(AgentBrowserNetworkRequestSchema) })
);

const BrowserNetworkRequestDetailResult = AgentBrowserJsonResult(
  Schema.Struct({
    ...AgentBrowserNetworkRequestSchema.fields,
    initiator: Schema.optional(Schema.Unknown),
    responseBody: Schema.optional(Schema.String),
    timing: Schema.optional(Schema.Unknown),
  })
);

const AgentBrowserConsoleEntry = Schema.Union([
  Schema.Struct({
    level: Schema.String,
    text: Schema.String,
    timestamp: Schema.Finite,
    type: Schema.Literal("console"),
  }),
  Schema.Struct({
    column: Schema.NullOr(Schema.Int),
    line: Schema.NullOr(Schema.Int),
    text: Schema.String,
    timestamp: Schema.Finite,
    type: Schema.Literal("page_error"),
  }),
]);

const AgentBrowserUrlEvent = Schema.Struct({
  timestamp: Schema.optional(Schema.Finite),
  type: Schema.Literal("url"),
  url: Schema.String,
});

const StreamMessageEnvelope = Schema.Struct({ type: Schema.String });
const relayedStreamMessageTypes = new Set([
  "console",
  "frame",
  "page_error",
  "status",
  "tabs",
  "url",
]);

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const browserError = (
  code: BrowserRpcErrorType["code"],
  message: string
): BrowserRpcErrorType => makeBrowserRpcError(code, message);

const normalizeUrl = (value: string) =>
  Effect.try({
    catch: () => browserError("invalid_url", `Invalid URL: ${value}`),
    try: () => {
      const trimmed = value.trim();
      const url = new URL(
        /^[A-Za-z][A-Za-z\d+.-]*:/u.test(trimmed)
          ? trimmed
          : `https://${trimmed}`
      );

      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("Only HTTP and HTTPS URLs are supported");
      }

      return url.href;
    },
  });

const normalizeSessionId = (name: string) => {
  const trimmed = name.trim();
  const candidate = trimmed.startsWith("create-")
    ? trimmed
    : `create-${trimmed}`;

  return Schema.decodeUnknownEffect(SessionIdSchema)(candidate).pipe(
    Effect.mapError(() =>
      browserError(
        "invalid_session",
        "Session names may contain letters, numbers, dots, underscores, and hyphens."
      )
    )
  );
};

const makeAgentBrowser = (runtime: AgentBrowserRuntime) =>
  Effect.gen(function* buildAgentBrowser() {
    const fileSystem = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const namespace = `contingency-${randomUUID()}`;
    const socketDirectory = yield* fileSystem
      .makeTempDirectoryScoped({
        ...(runtime.operatingSystem === "win32" ? {} : { directory: "/tmp" }),
        prefix: "ctg-",
      })
      .pipe(Effect.orDie);
    const ownsSessions = yield* Ref.make(false);
    const chromeVersion = yield* Ref.make<string | null>(null);
    const defaultUserAgent = yield* Ref.make<string | null>(null);
    const inputSemaphores = new Map<SessionId, Semaphore.Semaphore>();
    const tabCommandSemaphores = new Map<SessionId, Semaphore.Semaphore>();
    const sessionProfiles = new Map<SessionId, UserAgentProfileId>();
    const streamConnections = new Map<SessionId, WebSocket>();
    const activeTabIds = new Map<SessionId, BrowserTabId>();
    const tabMetadata = new Map<
      SessionId,
      Map<BrowserTabId, { readonly title: string; readonly url: string }>
    >();

    const executablePath = Effect.gen(function* resolveExecutablePath() {
      const executable = yield* getAgentBrowserExecutable(runtime);
      return path.join(AGENT_BROWSER_ASSETS_DIRECTORY, executable.name);
    });

    const run = Effect.fn("AgentBrowser.run")(function* run(
      args: readonly string[]
    ) {
      const binaryPath = yield* executablePath.pipe(
        Effect.mapError((cause) =>
          browserError("agent_browser_failed", errorMessage(cause))
        )
      );
      const command = ChildProcess.make(binaryPath, [...args], {
        env: {
          AGENT_BROWSER_SOCKET_DIR: socketDirectory,
          AGENT_BROWSER_STREAM_MAX_HEIGHT: MAX_STREAM_DIMENSION,
          AGENT_BROWSER_STREAM_MAX_WIDTH: MAX_STREAM_DIMENSION,
          AGENT_BROWSER_STREAM_QUALITY: "100",
        },
        extendEnv: true,
        stderr: "pipe",
        stdout: "pipe",
      });

      const result = yield* Effect.scoped(
        Effect.gen(function* executeAgentBrowser() {
          const handle = yield* spawner.spawn(command);
          const [stdout, stderr, exitCode] = yield* Effect.all(
            [
              Stream.decodeText(handle.stdout).pipe(Stream.mkString),
              Stream.decodeText(handle.stderr).pipe(Stream.mkString),
              handle.exitCode,
            ],
            { concurrency: "unbounded" }
          );
          return { exitCode: Number(exitCode), stderr, stdout };
        })
      ).pipe(
        Effect.mapError((cause) =>
          browserError("agent_browser_failed", errorMessage(cause))
        )
      );

      if (result.exitCode !== 0) {
        return yield* Effect.fail(
          browserError(
            "agent_browser_failed",
            result.stderr.trim() ||
              result.stdout.trim() ||
              `agent-browser exited with code ${result.exitCode}`
          )
        );
      }

      return result.stdout.trim();
    });

    const runJson = Effect.fn("AgentBrowser.runJson")(function* runJson<
      Data extends Schema.Top,
    >(args: readonly string[], schema: Data) {
      const output = yield* run(args);
      const parsed = yield* Effect.try({
        catch: (cause) =>
          browserError(
            "agent_browser_failed",
            `Unable to parse agent-browser output: ${errorMessage(cause)}`
          ),
        try: () => JSON.parse(output) as unknown,
      });

      return yield* Schema.decodeUnknownEffect(schema)(parsed).pipe(
        Effect.mapError((cause) =>
          browserError(
            "agent_browser_failed",
            `Unexpected agent-browser response: ${errorMessage(cause)}`
          )
        )
      );
    });

    const sessionArgs = (sessionId: SessionId, args: readonly string[]) => [
      "--namespace",
      namespace,
      "--session",
      sessionId,
      ...args,
      "--json",
    ];

    const init = Effect.fn("AgentBrowser.init")(function* init() {
      const stateDirectory = getStateDirectory(runtime.operatingSystem);
      const installMarkerPath = path.join(stateDirectory, INSTALL_MARKER);

      if (yield* fileSystem.exists(installMarkerPath)) {
        return;
      }

      const executable = yield* getAgentBrowserExecutable(runtime);
      const binaryPath = path.join(
        AGENT_BROWSER_ASSETS_DIRECTORY,
        executable.name
      );

      if (!(yield* fileSystem.exists(binaryPath))) {
        return yield* new AgentBrowserSetupError({
          message: `Bundled agent-browser executable is missing: ${binaryPath}`,
        });
      }

      if (runtime.operatingSystem !== "win32") {
        yield* fileSystem.chmod(binaryPath, 0o755);
      }

      if (executable.browserInstallSupported) {
        yield* Console.log(
          "Setting up the browser for Contingency. This one-time download may take a moment..."
        );

        const exitCode = yield* spawner.exitCode(
          ChildProcess.make(binaryPath, ["install"], {
            stderr: "inherit",
            stdin: "inherit",
            stdout: "inherit",
          })
        );

        if (Number(exitCode) !== 0) {
          return yield* new AgentBrowserSetupError({
            message: `agent-browser install exited with code ${Number(exitCode)}`,
          });
        }
      } else {
        yield* Console.warn(
          "Chrome for Testing is unavailable on Linux ARM64. Install Chromium with your system package manager and set AGENT_BROWSER_EXECUTABLE_PATH to its executable."
        );
      }

      yield* fileSystem.makeDirectory(stateDirectory, { recursive: true });
      yield* fileSystem.writeFileString(
        installMarkerPath,
        `${agentBrowserPackage.version}\n`
      );
    });

    const list = Effect.fn("AgentBrowser.list")(function* list() {
      const result = yield* runJson(
        ["--namespace", namespace, "session", "list", "--json"],
        SessionListResult
      );
      const sessions: SessionId[] = [];

      for (const name of result.data.sessions) {
        const decoded = yield* Schema.decodeUnknownEffect(SessionIdSchema)(
          name
        ).pipe(Effect.option);
        if (decoded._tag === "Some") {
          sessions.push(decoded.value);
        }
      }

      return sessions;
    });

    const setViewport = Effect.fn("AgentBrowser.setViewport")(
      function* setViewport(sessionId: SessionId, viewport: Viewport) {
        yield* run(
          sessionArgs(sessionId, [
            "set",
            "viewport",
            String(viewport.width),
            String(viewport.height),
            String(viewport.deviceScaleFactor),
          ])
        );
      }
    );

    const create = Effect.fn("AgentBrowser.create")(function* create(
      name: string,
      viewport: Viewport
    ) {
      const sessionId = yield* normalizeSessionId(name);
      yield* init().pipe(
        Effect.mapError((cause) =>
          browserError("agent_browser_failed", errorMessage(cause))
        )
      );
      yield* run(sessionArgs(sessionId, ["open"]));
      yield* Ref.set(ownsSessions, true);
      sessionProfiles.set(sessionId, "default");
      yield* setViewport(sessionId, viewport);
      return sessionId;
    });

    const attach = Effect.fn("AgentBrowser.attach")(function* attach(
      sessionId: SessionId
    ) {
      const sessions = yield* list();
      if (!sessions.includes(sessionId)) {
        return yield* Effect.fail(
          browserError(
            "session_not_found",
            `Browser session ${sessionId} is no longer running.`
          )
        );
      }
      return sessionId;
    });

    const currentUrl = Effect.fn("AgentBrowser.currentUrl")(
      function* currentUrl(sessionId: SessionId) {
        yield* attach(sessionId);
        const result = yield* runJson(
          sessionArgs(sessionId, ["get", "url"]),
          CurrentUrlResult
        );
        return result.data.url;
      }
    );

    const getTabs = Effect.fn("AgentBrowser.getTabs")(function* getTabs(
      sessionId: SessionId
    ) {
      yield* attach(sessionId);
      const result = yield* runJson(
        sessionArgs(sessionId, ["tab"]),
        BrowserTabsResult
      );
      const activeTab = result.data.tabs.find(({ active }) => active);
      const sessionTabMetadata =
        tabMetadata.get(sessionId) ??
        new Map<
          BrowserTabId,
          { readonly title: string; readonly url: string }
        >();
      tabMetadata.set(sessionId, sessionTabMetadata);

      if (activeTab !== undefined) {
        activeTabIds.set(sessionId, activeTab.tabId);
        const titleResult = yield* runJson(
          sessionArgs(sessionId, ["get", "title"]),
          CurrentTitleResult
        ).pipe(Effect.option);
        const urlResult = yield* runJson(
          sessionArgs(sessionId, ["get", "url"]),
          CurrentUrlResult
        ).pipe(Effect.option);
        sessionTabMetadata.set(activeTab.tabId, {
          title:
            titleResult._tag === "Some"
              ? titleResult.value.data.title
              : activeTab.title,
          url:
            urlResult._tag === "Some"
              ? urlResult.value.data.url
              : activeTab.url,
        });
      }

      const openTabIds = new Set(result.data.tabs.map(({ tabId }) => tabId));
      for (const tabId of sessionTabMetadata.keys()) {
        if (!openTabIds.has(tabId)) {
          sessionTabMetadata.delete(tabId);
        }
      }

      return result.data.tabs.map((tab) => {
        const metadata = sessionTabMetadata.get(tab.tabId);
        return metadata === undefined ? tab : { ...tab, ...metadata };
      });
    });

    const getActiveTabId = Effect.fn("AgentBrowser.getActiveTabId")(
      function* resolveActiveBrowserTab(sessionId: SessionId) {
        const knownActiveTabId = activeTabIds.get(sessionId);
        if (knownActiveTabId !== undefined) {
          return knownActiveTabId;
        }

        const tabs = yield* getTabs(sessionId);
        const activeTab = tabs.find(({ active }) => active);
        if (activeTab !== undefined) {
          activeTabIds.set(sessionId, activeTab.tabId);
        }
        return activeTab?.tabId;
      }
    );

    const newTab = Effect.fn("AgentBrowser.newTab")(function* newTab(
      sessionId: SessionId
    ) {
      yield* attach(sessionId);
      yield* run(sessionArgs(sessionId, ["tab", "new"]));
    });

    const withTabCommandPermit = <A, E>(
      sessionId: SessionId,
      effect: Effect.Effect<A, E>
    ) => {
      const semaphore =
        tabCommandSemaphores.get(sessionId) ?? Semaphore.makeUnsafe(1);
      tabCommandSemaphores.set(sessionId, semaphore);
      return semaphore.withPermit(effect);
    };

    const switchTab = Effect.fn("AgentBrowser.switchTab")(
      (sessionId: SessionId, tabId: BrowserTabId) =>
        withTabCommandPermit(
          sessionId,
          Effect.gen(function* switchBrowserTab() {
            yield* attach(sessionId);
            yield* run(sessionArgs(sessionId, ["tab", tabId]));
            activeTabIds.set(sessionId, tabId);
          })
        )
    );

    const closeTab = Effect.fn("AgentBrowser.closeTab")(function* closeTab(
      sessionId: SessionId,
      tabId: BrowserTabId
    ) {
      yield* attach(sessionId);
      yield* run(sessionArgs(sessionId, ["tab", "close", tabId]));
    });

    const getNetworkRequests = Effect.fn("AgentBrowser.getNetworkRequests")(
      (sessionId: SessionId, tabId: BrowserTabId) =>
        withTabCommandPermit(
          sessionId,
          Effect.gen(function* readTabNetworkRequests() {
            yield* attach(sessionId);
            const tabs = yield* getTabs(sessionId);
            if (!tabs.some((tab) => tab.active && tab.tabId === tabId)) {
              return [];
            }
            const result = yield* runJson(
              sessionArgs(sessionId, ["network", "requests"]),
              BrowserNetworkRequestsResult
            );
            return result.data.requests.map((request) => ({
              ...request,
              tabId,
            }));
          })
        )
    );

    const enableNetworkTracking = Effect.fn(
      "AgentBrowser.enableNetworkTracking"
    )(function* enableNetworkTracking(sessionId: SessionId) {
      yield* runJson(
        sessionArgs(sessionId, ["network", "requests"]),
        BrowserNetworkRequestsResult
      );
    });

    const getNetworkRequest = Effect.fn("AgentBrowser.getNetworkRequest")(
      function* getNetworkRequest(
        sessionId: SessionId,
        tabId: BrowserTabId,
        requestId: BrowserRequestId
      ) {
        yield* attach(sessionId);
        const result = yield* runJson(
          sessionArgs(sessionId, ["network", "request", requestId]),
          BrowserNetworkRequestDetailResult
        );
        return { ...result.data, tabId };
      }
    );

    const resolveUserAgent = Effect.fn("AgentBrowser.resolveUserAgent")(
      function* resolveUserAgent(
        sessionId: SessionId,
        profileId: UserAgentProfileId
      ) {
        const profile = userAgentProfiles.find(({ id }) => id === profileId);
        if (profile?.template === undefined) {
          return (sessionProfiles.get(sessionId) ?? "default") === "default"
            ? undefined
            : ((yield* Ref.get(defaultUserAgent)) ?? undefined);
        }

        let version = yield* Ref.get(chromeVersion);
        const browserDefault = yield* Ref.get(defaultUserAgent);
        if (
          browserDefault === null ||
          (version === null && profile.template.includes("%s"))
        ) {
          const result = yield* runJson(
            sessionArgs(sessionId, ["eval", "navigator.userAgent"]),
            EvalStringResult
          );
          const runtimeUserAgent = result.data.result;
          if ((sessionProfiles.get(sessionId) ?? "default") === "default") {
            yield* Ref.set(defaultUserAgent, runtimeUserAgent);
          }
          version =
            /(?:Chrome|CriOS)\/(?<version>[\d.]+)/u.exec(runtimeUserAgent)
              ?.groups?.version ?? null;
          yield* Ref.set(chromeVersion, version);
        }

        return profile.template.replaceAll("%s", version ?? "151.0.0.0");
      }
    );

    const open = Effect.fn("AgentBrowser.open")(function* open(
      selectedSessionId: SessionId | undefined,
      requestedUrl: string,
      viewport: Viewport,
      userAgentProfile: UserAgentProfileId
    ) {
      const url = yield* normalizeUrl(requestedUrl);
      const previousProfile =
        selectedSessionId === undefined
          ? "default"
          : (sessionProfiles.get(selectedSessionId) ?? "default");
      const sessionId =
        selectedSessionId === undefined
          ? yield* create(`create-${randomUUID().slice(0, 8)}`, viewport)
          : yield* attach(selectedSessionId);

      const userAgent = yield* resolveUserAgent(sessionId, userAgentProfile);
      if (previousProfile !== userAgentProfile) {
        streamConnections.get(sessionId)?.close();
        streamConnections.delete(sessionId);
        yield* run(
          sessionArgs(sessionId, [
            ...(userAgent === undefined ? [] : ["--user-agent", userAgent]),
            "open",
          ])
        );
        yield* setViewport(sessionId, viewport);
      }
      yield* enableNetworkTracking(sessionId);
      yield* run(sessionArgs(sessionId, ["open", url]));
      sessionProfiles.set(sessionId, userAgentProfile);
      yield* setViewport(sessionId, viewport);
      return { sessionId, url } as const;
    });

    const setUserAgent = Effect.fn("AgentBrowser.setUserAgent")(
      function* setUserAgent(
        sessionId: SessionId,
        url: string,
        viewport: Viewport,
        userAgentProfile: UserAgentProfileId
      ) {
        const normalizedUrl = yield* normalizeUrl(url);
        yield* attach(sessionId);
        const previousProfile = sessionProfiles.get(sessionId) ?? "default";
        if (previousProfile === userAgentProfile) {
          const result = yield* open(
            sessionId,
            normalizedUrl,
            viewport,
            userAgentProfile
          );
          return { url: result.url } as const;
        }

        const userAgent = yield* resolveUserAgent(sessionId, userAgentProfile);
        streamConnections.get(sessionId)?.close();
        streamConnections.delete(sessionId);
        activeTabIds.delete(sessionId);
        tabMetadata.delete(sessionId);
        yield* run(sessionArgs(sessionId, ["close"]));
        yield* run(
          sessionArgs(sessionId, [
            ...(userAgent === undefined ? [] : ["--user-agent", userAgent]),
            "open",
          ])
        );
        yield* setViewport(sessionId, viewport);
        yield* enableNetworkTracking(sessionId);
        yield* run(sessionArgs(sessionId, ["open", normalizedUrl]));
        sessionProfiles.set(sessionId, userAgentProfile);
        return { url: normalizedUrl } as const;
      }
    );

    const navigate = Effect.fn("AgentBrowser.navigate")(function* navigate(
      sessionId: SessionId,
      action: "back" | "forward" | "reload"
    ) {
      yield* attach(sessionId);
      yield* run(sessionArgs(sessionId, [action]));
    });

    const close = Effect.fn("AgentBrowser.close")(function* close(
      sessionId: SessionId
    ) {
      const connection = streamConnections.get(sessionId);
      connection?.close();
      streamConnections.delete(sessionId);
      inputSemaphores.delete(sessionId);
      tabCommandSemaphores.delete(sessionId);
      sessionProfiles.delete(sessionId);
      activeTabIds.delete(sessionId);
      tabMetadata.delete(sessionId);
      yield* run(sessionArgs(sessionId, ["close"]));
    });

    const streamStatus = Effect.fn("AgentBrowser.streamStatus")(
      function* streamStatus(sessionId: SessionId) {
        const result = yield* runJson(
          sessionArgs(sessionId, ["stream", "status"]),
          StreamStatusResult
        );
        if (!(result.data.enabled && result.data.connected)) {
          return yield* Effect.fail(
            browserError(
              "stream_failed",
              `Browser session ${sessionId} is not ready to stream.`
            )
          );
        }
        return result.data;
      }
    );

    const stream = (sessionId: SessionId) =>
      Stream.unwrap(
        streamStatus(sessionId).pipe(
          Effect.map(({ port }) =>
            Stream.callback<BrowserStreamEvent, BrowserRpcErrorType>((queue) =>
              Effect.acquireRelease(
                Effect.callback<WebSocket, BrowserRpcErrorType>((resume) => {
                  const socket = new WebSocket(`ws://127.0.0.1:${port}/`);
                  let opened = false;

                  const handleOpen = () => {
                    opened = true;
                    streamConnections.get(sessionId)?.close();
                    streamConnections.set(sessionId, socket);
                    resume(Effect.succeed(socket));
                  };
                  const handleError = () => {
                    const error = browserError(
                      "stream_failed",
                      `Unable to connect to browser session ${sessionId}.`
                    );
                    if (opened) {
                      Effect.runFork(Queue.fail(queue, error));
                    } else {
                      resume(Effect.fail(error));
                    }
                  };
                  const handleClose = () => {
                    if (opened) {
                      Effect.runFork(
                        Queue.fail(
                          queue,
                          browserError(
                            "stream_failed",
                            `Browser session ${sessionId} disconnected.`
                          )
                        )
                      );
                    }
                  };
                  const handleMessage = (event: MessageEvent) => {
                    if (typeof event.data !== "string") {
                      return;
                    }

                    const decodeEvent = Effect.gen(
                      function* decodeBrowserStreamEvent() {
                        const outcome = yield* Effect.result(
                          Effect.gen(function* decodeRelayedStreamEvent() {
                            const parsed = yield* Effect.try({
                              catch: (cause) =>
                                browserError(
                                  "stream_failed",
                                  `Invalid browser stream message: ${errorMessage(cause)}`
                                ),
                              try: () => JSON.parse(event.data) as unknown,
                            });
                            const envelope = yield* Schema.decodeUnknownEffect(
                              StreamMessageEnvelope
                            )(parsed);

                            if (!relayedStreamMessageTypes.has(envelope.type)) {
                              return;
                            }

                            if (
                              envelope.type === "console" ||
                              envelope.type === "page_error"
                            ) {
                              const entry = yield* Schema.decodeUnknownEffect(
                                AgentBrowserConsoleEntry
                              )(parsed);
                              const tabId = yield* getActiveTabId(sessionId);
                              if (tabId !== undefined) {
                                yield* Queue.offer(queue, { ...entry, tabId });
                              }
                              return;
                            }

                            if (envelope.type === "url") {
                              const urlEvent =
                                yield* Schema.decodeUnknownEffect(
                                  AgentBrowserUrlEvent
                                )(parsed);
                              const tabId = yield* getActiveTabId(sessionId);
                              if (tabId !== undefined) {
                                yield* Queue.offer(queue, {
                                  ...urlEvent,
                                  tabId,
                                });
                              }
                              return;
                            }

                            const message = yield* Schema.decodeUnknownEffect(
                              BrowserStreamEventSchema
                            )(parsed);
                            if (message.type === "tabs") {
                              const activeTab = message.tabs.find(
                                ({ active }) => active
                              );
                              if (activeTab !== undefined) {
                                activeTabIds.set(sessionId, activeTab.tabId);
                              }
                            }
                            yield* Queue.offer(queue, message);
                          }).pipe(
                            Effect.mapError((cause) =>
                              isBrowserRpcError(cause)
                                ? cause
                                : browserError(
                                    "stream_failed",
                                    `Unexpected browser stream message: ${errorMessage(cause)}`
                                  )
                            )
                          )
                        );

                        if (Result.isFailure(outcome)) {
                          yield* Queue.fail(queue, outcome.failure);
                        }
                      }
                    );
                    Effect.runFork(decodeEvent);
                  };

                  socket.addEventListener("open", handleOpen, { once: true });
                  socket.addEventListener("error", handleError);
                  socket.addEventListener("close", handleClose);
                  socket.addEventListener("message", handleMessage);

                  return Effect.sync(() => {
                    socket.removeEventListener("open", handleOpen);
                    socket.removeEventListener("error", handleError);
                    socket.removeEventListener("close", handleClose);
                    socket.removeEventListener("message", handleMessage);
                    socket.close();
                  });
                }),
                (socket) =>
                  Effect.sync(() => {
                    if (streamConnections.get(sessionId) === socket) {
                      streamConnections.delete(sessionId);
                    }
                    socket.close();
                  })
              )
            )
          )
        )
      );

    const writeToStream = Effect.fn("AgentBrowser.writeToStream")(
      function* writeToStream(sessionId: SessionId, message: unknown) {
        const socket = streamConnections.get(sessionId);
        if (socket?.readyState !== WebSocket.OPEN) {
          return yield* Effect.fail(
            browserError(
              "stream_failed",
              `Browser session ${sessionId} has no attached viewport.`
            )
          );
        }

        yield* Effect.try({
          catch: (cause) => browserError("stream_failed", errorMessage(cause)),
          try: () => socket.send(JSON.stringify(message)),
        });
      }
    );

    const sendInput = (sessionId: SessionId, input: BrowserInput) => {
      const semaphore =
        inputSemaphores.get(sessionId) ?? Semaphore.makeUnsafe(1);
      inputSemaphores.set(sessionId, semaphore);
      return semaphore.withPermit(writeToStream(sessionId, input));
    };

    const acknowledgeFrame = (sessionId: SessionId, sequence: number) =>
      writeToStream(sessionId, { seq: sequence, type: "ack" });

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* closeOwnedSessions() {
        for (const socket of streamConnections.values()) {
          socket.close();
        }
        streamConnections.clear();
        inputSemaphores.clear();
        tabCommandSemaphores.clear();
        sessionProfiles.clear();
        activeTabIds.clear();
        tabMetadata.clear();

        if (yield* Ref.get(ownsSessions)) {
          yield* run([
            "--namespace",
            namespace,
            "close",
            "--all",
            "--json",
          ]).pipe(Effect.ignore);
        }
      })
    );

    return AgentBrowser.of({
      acknowledgeFrame,
      attach,
      close,
      closeTab,
      create,
      currentUrl,
      getNetworkRequest,
      getNetworkRequests,
      getTabs,
      init,
      list,
      navigate,
      newTab,
      open,
      sendInput,
      setUserAgent,
      setViewport,
      stream,
      switchTab,
    });
  });

export const makeAgentBrowserLive = (
  runtime: AgentBrowserRuntime = getRuntime()
): Layer.Layer<
  AgentBrowser,
  never,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> => Layer.effect(AgentBrowser, makeAgentBrowser(runtime));

export const AgentBrowserLive = makeAgentBrowserLive();
