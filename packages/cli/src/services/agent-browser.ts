import { randomUUID } from "node:crypto";
import { arch, platform } from "node:os";
import path from "node:path";

import {
  AgentBrowserViewEvent,
  BrowserStreamId,
  BrowserRequestId,
  BrowserTabId,
  filterCookiesForOriginHost,
  sortCookiesByIdentity,
  httpOriginFromUrl,
  isBrowserRpcError,
  makeBrowserRpcError,
  SessionId as SessionIdSchema,
  sessionPrefixes,
  userAgentProfiles,
} from "@contingency/protocol";
import type {
  BrowserCookieWrite,
  BrowserInput,
  BrowserNetworkRequest,
  BrowserNetworkRequestDetail,
  BrowserRpcErrorType,
  BrowserStorageSnapshot,
  BrowserStreamEvent,
  BrowserStreamId as BrowserStreamIdType,
  BrowserTab,
  SessionId,
  StorageKind,
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
import {
  cookieDeleteArgs,
  cookieSetArgs,
  normalizeAgentBrowserCookie,
  webStorageClearArgs,
  webStorageDeleteScript,
  webStorageGetArgs,
  webStorageSetArgs,
} from "./browser-storage";
import { dispatchKey, dispatchModifiedClick, isModifierKey } from "./cdp-input";
import { navigateWithUserAgentOverride } from "./cdp-user-agent";
import { stateDirectory } from "./state-directory";

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

export type BrowserStorageSetInput =
  | { readonly cookie: BrowserCookieWrite; readonly kind: "cookies" }
  | {
      readonly key: string;
      readonly kind: "local" | "session";
      readonly value: string;
    };

export type BrowserStorageDeleteInput =
  | {
      readonly domain: string;
      readonly kind: "cookies";
      readonly name: string;
      readonly path: string;
    }
  | { readonly key: string; readonly kind: "local" | "session" };

export interface AgentBrowser {
  readonly acknowledgeFrame: (
    sessionId: SessionId,
    sequence: number,
    streamId: BrowserStreamIdType
  ) => Effect.Effect<void, BrowserRpcErrorType>;
  readonly attach: (
    sessionId: SessionId
  ) => Effect.Effect<SessionId, BrowserRpcErrorType>;
  readonly close: (
    sessionId: SessionId
  ) => Effect.Effect<void, BrowserRpcErrorType>;
  /** Click the element a selector resolves to. Used to replay a Flow. */
  readonly clickSelector: (
    sessionId: SessionId,
    selector: string
  ) => Effect.Effect<void, BrowserRpcErrorType>;
  /** Clear a field and set its value in one command. */
  readonly fillSelector: (
    sessionId: SessionId,
    selector: string,
    value: string
  ) => Effect.Effect<void, BrowserRpcErrorType>;
  /** Type into a field with real keystrokes, leaving existing text in place. */
  readonly typeSelector: (
    sessionId: SessionId,
    selector: string,
    value: string
  ) => Effect.Effect<void, BrowserRpcErrorType>;
  /**
   * Press a key down and leave it down. A modifier held this way applies to
   * every later key and click in the session until it is released.
   */
  readonly keyDown: (
    sessionId: SessionId,
    key: string
  ) => Effect.Effect<void, BrowserRpcErrorType>;
  /** Release a key pressed with {@link keyDown}. */
  readonly keyUp: (
    sessionId: SessionId,
    key: string
  ) => Effect.Effect<void, BrowserRpcErrorType>;
  /**
   * Whether a selector resolves to a visible element. Fails when the selector
   * matches nothing, which the browser reports as an error rather than `false`.
   */
  readonly isVisible: (
    sessionId: SessionId,
    selector: string
  ) => Effect.Effect<boolean, BrowserRpcErrorType>;
  /** Wait for a selector to resolve, failing when it does not. */
  readonly waitForSelector: (
    sessionId: SessionId,
    selector: string
  ) => Effect.Effect<void, BrowserRpcErrorType>;
  /** Navigate to a URL in an already-open session. */
  readonly goto: (
    sessionId: SessionId,
    url: string
  ) => Effect.Effect<void, BrowserRpcErrorType>;
  readonly cdpUrl: (
    sessionId: SessionId
  ) => Effect.Effect<string, BrowserRpcErrorType>;
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
  readonly getStorage: (
    sessionId: SessionId,
    tabId: BrowserTabId,
    kind: StorageKind
  ) => Effect.Effect<BrowserStorageSnapshot, BrowserRpcErrorType>;
  readonly setStorage: (
    sessionId: SessionId,
    tabId: BrowserTabId,
    payload: BrowserStorageSetInput
  ) => Effect.Effect<void, BrowserRpcErrorType>;
  readonly deleteStorage: (
    sessionId: SessionId,
    tabId: BrowserTabId,
    payload: BrowserStorageDeleteInput
  ) => Effect.Effect<void, BrowserRpcErrorType>;
  readonly clearStorage: (
    sessionId: SessionId,
    tabId: BrowserTabId,
    kind: StorageKind
  ) => Effect.Effect<void, BrowserRpcErrorType>;
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
  /** Test seam: override CDP UA + navigate without a live WebSocket. */
  readonly navigateWithUserAgentOverride?: typeof navigateWithUserAgentOverride;
}

export const serializeBrowserStreamEvent = <A, E, R>(
  semaphore: Semaphore.Semaphore,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> => semaphore.withPermit(effect);

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

const BatchResults = Schema.Array(
  Schema.Struct({
    error: Schema.optional(Schema.NullOr(Schema.String)),
    result: Schema.optional(Schema.Unknown),
    success: Schema.Boolean,
  })
);

const CdpUrlResult = AgentBrowserJsonResult(
  Schema.Struct({ cdpUrl: Schema.String })
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

const AgentBrowserCookieSchema = Schema.Struct({
  domain: Schema.String,
  expires: Schema.optional(Schema.Finite),
  httpOnly: Schema.optional(Schema.Boolean),
  name: Schema.String,
  path: Schema.String,
  sameSite: Schema.optional(Schema.String),
  secure: Schema.optional(Schema.Boolean),
  session: Schema.optional(Schema.Boolean),
  size: Schema.optional(Schema.Finite),
  value: Schema.String,
});

const BrowserCookiesResult = AgentBrowserJsonResult(
  Schema.Struct({ cookies: Schema.Array(AgentBrowserCookieSchema) })
);

const BrowserWebStorageResult = AgentBrowserJsonResult(
  Schema.Struct({
    data: Schema.Record(Schema.String, Schema.String),
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

/**
 * `--json` failures carry the human-readable reason in an `error` field —
 * either on the envelope, or on the failed entry of a `batch` result array.
 * Surfacing the whole envelope instead puts a JSON blob in front of a
 * developer who only needs the sentence inside it.
 */
const agentBrowserFailureMessage = (stdout: string): string => {
  const trimmed = stdout.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) {
    return trimmed;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    for (const entry of entries) {
      const error =
        typeof entry === "object" && entry !== null && "error" in entry
          ? (entry as { readonly error: unknown }).error
          : undefined;
      if (typeof error === "string" && error.length > 0) {
        return error;
      }
    }
    return trimmed;
  } catch {
    return trimmed;
  }
};

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
  // An unprefixed name is a Create View session; the Runner passes `run-`
  // explicitly so its sessions stay distinguishable from authoring ones.
  const candidate = sessionPrefixes.some((prefix) => trimmed.startsWith(prefix))
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

const emptyStorageSnapshot = (
  tabId: BrowserTabId,
  kind: StorageKind
): BrowserStorageSnapshot =>
  kind === "cookies"
    ? { cookies: [], kind, tabId }
    : { entries: {}, kind, tabId };

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
    const streamConnections = new Map<
      SessionId,
      { readonly socket: WebSocket; readonly streamId: BrowserStreamIdType }
    >();
    const activeTabIds = new Map<SessionId, BrowserTabId>();
    // Keys a Flow pressed down and has not released. CDP does not remember a
    // held modifier between synthesized events, so every later event has to
    // carry the mask itself.
    const heldKeys = new Map<SessionId, Set<string>>();
    const streamActiveTabIds = new Map<SessionId, BrowserTabId>();
    const tabMetadata = new Map<
      SessionId,
      Map<BrowserTabId, { readonly title: string; readonly url: string }>
    >();

    const executablePath = Effect.gen(function* resolveExecutablePath() {
      const executable = yield* getAgentBrowserExecutable(runtime);
      return path.join(AGENT_BROWSER_ASSETS_DIRECTORY, executable.name);
    });

    const run = Effect.fn("AgentBrowser.run")(function* run(
      args: readonly string[],
      stdin?: string
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
        ...(stdin === undefined
          ? {}
          : {
              stdin: Stream.make(new TextEncoder().encode(stdin)),
            }),
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
              agentBrowserFailureMessage(result.stdout) ||
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

    /**
     * Run commands whose operands come from a Flow.
     *
     * `batch` reads a JSON array of pre-split argument arrays from stdin,
     * which keeps two problems out of the argument vector at once. A resolved
     * Variable never appears in argv, where `ps` would expose it to every
     * local user — the reason `--secret NAME` exists at all. And an operand is
     * not re-parsed as an option, so a Flow cannot smuggle a flag through a
     * selector: `["click", "--headed"]` is reported as `Element not found:
     * --headed` rather than switching the browser out of headless mode.
     */
    const runBatch = Effect.fn("AgentBrowser.runBatch")(function* runBatch(
      sessionId: SessionId,
      commands: readonly (readonly string[])[]
    ) {
      const output = yield* run(
        [
          "--namespace",
          namespace,
          "--session",
          sessionId,
          "batch",
          "--bail",
          "--json",
        ],
        JSON.stringify(commands)
      );

      const results = yield* Schema.decodeUnknownEffect(BatchResults)(
        yield* Effect.try({
          catch: (cause) =>
            browserError(
              "agent_browser_failed",
              `Unable to parse agent-browser output: ${errorMessage(cause)}`
            ),
          try: () => JSON.parse(output) as unknown,
        })
      ).pipe(
        Effect.mapError((cause) =>
          browserError(
            "agent_browser_failed",
            `Unexpected agent-browser response: ${errorMessage(cause)}`
          )
        )
      );

      // `--bail` stops at the first failure, so the failed entry is the last.
      const failed = results.find(({ success }) => !success);
      if (failed !== undefined) {
        return yield* Effect.fail(
          browserError(
            "agent_browser_failed",
            failed.error ?? "agent-browser batch command failed."
          )
        );
      }

      return results;
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
      const contingencyStateDirectory = stateDirectory(runtime.operatingSystem);
      const installMarkerPath = path.join(
        contingencyStateDirectory,
        INSTALL_MARKER
      );

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

      yield* fileSystem.makeDirectory(contingencyStateDirectory, {
        recursive: true,
      });
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

    const cdpUrl = Effect.fn("AgentBrowser.cdpUrl")(function* cdpUrl(
      sessionId: SessionId
    ) {
      yield* attach(sessionId);
      const result = yield* runJson(
        sessionArgs(sessionId, ["get", "cdp-url"]),
        CdpUrlResult
      );
      return result.data.cdpUrl;
    });

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

    const requireActiveTab = Effect.fn("AgentBrowser.requireActiveTab")(
      function* requireActiveTab(sessionId: SessionId, tabId: BrowserTabId) {
        yield* attach(sessionId);
        const tabs = yield* getTabs(sessionId);
        return tabs.find((tab) => tab.active && tab.tabId === tabId);
      }
    );

    const getStorage = Effect.fn("AgentBrowser.getStorage")(
      (sessionId: SessionId, tabId: BrowserTabId, kind: StorageKind) =>
        withTabCommandPermit(
          sessionId,
          Effect.gen(function* readTabStorage() {
            const activeTab = yield* requireActiveTab(sessionId, tabId);
            if (activeTab === undefined) {
              return emptyStorageSnapshot(tabId, kind);
            }
            const origin = httpOriginFromUrl(activeTab.url);
            if (origin === undefined) {
              return emptyStorageSnapshot(tabId, kind);
            }
            if (kind === "cookies") {
              const result = yield* runJson(
                sessionArgs(sessionId, ["cookies", "get"]),
                BrowserCookiesResult
              );
              return {
                cookies: sortCookiesByIdentity(
                  filterCookiesForOriginHost(
                    result.data.cookies.map(normalizeAgentBrowserCookie),
                    origin.host
                  )
                ),
                kind,
                tabId,
              };
            }
            const result = yield* runJson(
              sessionArgs(sessionId, [...webStorageGetArgs(kind)]),
              BrowserWebStorageResult
            );
            return { entries: result.data.data, kind, tabId };
          })
        )
    );

    const requireActiveStorageTab = Effect.fn(
      "AgentBrowser.requireActiveStorageTab"
    )(function* requireActiveStorageTab(
      sessionId: SessionId,
      tabId: BrowserTabId
    ) {
      const activeTab = yield* requireActiveTab(sessionId, tabId);
      if (activeTab === undefined) {
        return yield* Effect.fail(
          browserError("session_not_found", "The requested tab is not active.")
        );
      }
      return activeTab;
    });

    const setStorage = Effect.fn("AgentBrowser.setStorage")(
      (
        sessionId: SessionId,
        tabId: BrowserTabId,
        payload: BrowserStorageSetInput
      ) =>
        withTabCommandPermit(
          sessionId,
          Effect.gen(function* writeTabStorage() {
            yield* requireActiveStorageTab(sessionId, tabId);
            if (payload.kind === "cookies") {
              yield* run(
                sessionArgs(sessionId, [...cookieSetArgs(payload.cookie)])
              );
              return;
            }
            yield* run(
              sessionArgs(sessionId, [
                ...webStorageSetArgs(payload.kind, payload.key, payload.value),
              ])
            );
          })
        )
    );

    const deleteStorage = Effect.fn("AgentBrowser.deleteStorage")(
      (
        sessionId: SessionId,
        tabId: BrowserTabId,
        payload: BrowserStorageDeleteInput
      ) =>
        withTabCommandPermit(
          sessionId,
          Effect.gen(function* deleteTabStorage() {
            yield* requireActiveStorageTab(sessionId, tabId);
            if (payload.kind === "cookies") {
              yield* run(
                sessionArgs(sessionId, [
                  ...cookieDeleteArgs(
                    payload.name,
                    payload.domain,
                    payload.path
                  ),
                ])
              );
              return;
            }
            yield* runJson(
              sessionArgs(sessionId, [
                "eval",
                webStorageDeleteScript(payload.kind, payload.key),
              ]),
              EvalStringResult
            );
          })
        )
    );

    const clearStorage = Effect.fn("AgentBrowser.clearStorage")(
      (sessionId: SessionId, tabId: BrowserTabId, kind: StorageKind) =>
        withTabCommandPermit(
          sessionId,
          Effect.gen(function* clearTabStorage() {
            const activeTab = yield* requireActiveStorageTab(sessionId, tabId);
            if (kind === "cookies") {
              const origin = httpOriginFromUrl(activeTab.url);
              if (origin === undefined) {
                return;
              }
              const result = yield* runJson(
                sessionArgs(sessionId, ["cookies", "get"]),
                BrowserCookiesResult
              );
              const inScope = filterCookiesForOriginHost(
                result.data.cookies.map(normalizeAgentBrowserCookie),
                origin.host
              );
              for (const cookie of inScope) {
                yield* run(
                  sessionArgs(sessionId, [
                    ...cookieDeleteArgs(
                      cookie.name,
                      cookie.domain,
                      cookie.path
                    ),
                  ])
                );
              }
              return;
            }
            yield* run(sessionArgs(sessionId, [...webStorageClearArgs(kind)]));
          })
        )
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
      const sessionId =
        selectedSessionId === undefined
          ? yield* create(`create-${randomUUID().slice(0, 8)}`, viewport)
          : yield* attach(selectedSessionId);

      // Apply UA on the live page via CDP Emulation.setUserAgentOverride + Page.navigate.
      // agent-browser `--user-agent` is launch-config (relaunch risk) and `open` clears
      // an in-session Emulation override, which drops mobile/desktop shells mid-stream.
      const userAgent = yield* resolveUserAgent(sessionId, userAgentProfile);
      yield* enableNetworkTracking(sessionId);
      if (userAgent === undefined) {
        yield* run(sessionArgs(sessionId, ["open", url]));
      } else {
        const applyNavigation =
          runtime.navigateWithUserAgentOverride ??
          navigateWithUserAgentOverride;
        yield* applyNavigation({
          cdpUrl: yield* cdpUrl(sessionId),
          requestedTabId: activeTabIds.get(sessionId),
          url,
          userAgent,
        });
      }
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
        // Stable `browser.user-agent.set` surface; navigation + UA apply live in open.
        const result = yield* open(sessionId, url, viewport, userAgentProfile);
        return { url: result.url } as const;
      }
    );

    // Selector-level replay commands. The Create canvas drives the browser
    // with coordinates and key events; a Flow addresses elements by selector,
    // so the Runner needs these instead.
    const heldFor = (sessionId: SessionId): readonly string[] => [
      ...(heldKeys.get(sessionId) ?? []),
    ];

    const clickSelector = Effect.fn("AgentBrowser.clickSelector")(
      function* clickSelector(sessionId: SessionId, selector: string) {
        const held = heldFor(sessionId);
        if (held.length === 0) {
          yield* runBatch(sessionId, [["click", selector]]);
          return;
        }

        // The tool's own click dispatches without modifiers, which would drop
        // a Shift the Flow is holding. This path re-establishes the
        // covering-element guarantee the tool would have given.
        yield* dispatchModifiedClick({
          cdpUrl: yield* cdpUrl(sessionId),
          held,
          requestedTabId: activeTabIds.get(sessionId),
          selector,
        });
      }
    );

    const fillSelector = Effect.fn("AgentBrowser.fillSelector")(
      function* fillSelector(
        sessionId: SessionId,
        selector: string,
        value: string
      ) {
        yield* runBatch(sessionId, [["fill", selector, value]]);
      }
    );

    const typeSelector = Effect.fn("AgentBrowser.typeSelector")(
      function* typeSelector(
        sessionId: SessionId,
        selector: string,
        value: string
      ) {
        yield* runBatch(sessionId, [["type", selector, value]]);
      }
    );

    const dispatchHalfKeystroke = (
      sessionId: SessionId,
      key: string,
      type: "keyDown" | "keyUp"
    ) =>
      Effect.gen(function* sendHalfKeystroke() {
        const held = heldKeys.get(sessionId) ?? new Set<string>();
        heldKeys.set(sessionId, held);

        if (isModifierKey(key)) {
          // Tracked, never dispatched. A modifier left physically down makes
          // Chrome emit thousands of keydown events per second until it is
          // released, which floods the page for the whole time a Flow holds
          // it. Every event dispatched meanwhile carries the mask instead, so
          // the page still reads `event.shiftKey` correctly.
          if (type === "keyDown") {
            held.add(key);
          } else {
            held.delete(key);
          }
          return;
        }

        yield* dispatchKey({
          cdpUrl: yield* cdpUrl(sessionId),
          held: [...held],
          key,
          requestedTabId: activeTabIds.get(sessionId),
          type,
        });
      });

    const keyDown = Effect.fn("AgentBrowser.keyDown")(
      (sessionId: SessionId, key: string) =>
        dispatchHalfKeystroke(sessionId, key, "keyDown")
    );

    const keyUp = Effect.fn("AgentBrowser.keyUp")(
      (sessionId: SessionId, key: string) =>
        dispatchHalfKeystroke(sessionId, key, "keyUp")
    );

    const waitForSelector = Effect.fn("AgentBrowser.waitForSelector")(
      function* waitForSelector(sessionId: SessionId, selector: string) {
        yield* runBatch(sessionId, [["wait", selector]]);
      }
    );

    const isVisible = Effect.fn("AgentBrowser.isVisible")(function* isVisible(
      sessionId: SessionId,
      selector: string
    ) {
      const results = yield* runBatch(sessionId, [["is", "visible", selector]]);
      const [entry] = results;
      const result: unknown = entry?.result;
      if (
        typeof result !== "object" ||
        result === null ||
        typeof (result as { readonly visible?: unknown }).visible !== "boolean"
      ) {
        return yield* Effect.fail(
          browserError(
            "agent_browser_failed",
            `agent-browser did not report visibility for ${selector}.`
          )
        );
      }
      return (result as { readonly visible: boolean }).visible;
    });

    const goto = Effect.fn("AgentBrowser.goto")(function* goto(
      sessionId: SessionId,
      url: string
    ) {
      // `normalizeUrl` already refuses anything but http and https; the URL
      // still travels on stdin, since a Flow may interpolate a Variable into
      // it and query strings carry credentials more often than they should.
      const normalized = yield* normalizeUrl(url);
      yield* runBatch(sessionId, [["open", normalized]]);
    });

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
      connection?.socket.close();
      streamConnections.delete(sessionId);
      inputSemaphores.delete(sessionId);
      tabCommandSemaphores.delete(sessionId);
      sessionProfiles.delete(sessionId);
      activeTabIds.delete(sessionId);
      streamActiveTabIds.delete(sessionId);
      tabMetadata.delete(sessionId);
      heldKeys.delete(sessionId);
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
        Effect.gen(function* prepareBrowserStream() {
          const streamId = yield* Schema.decodeUnknownEffect(BrowserStreamId)(
            randomUUID()
          ).pipe(
            Effect.mapError((cause) =>
              browserError("stream_failed", errorMessage(cause))
            )
          );
          const { port } = yield* streamStatus(sessionId);
          return { port, streamId } as const;
        }).pipe(
          Effect.map(({ port, streamId }) =>
            Stream.callback<BrowserStreamEvent, BrowserRpcErrorType>((queue) =>
              Effect.acquireRelease(
                Effect.callback<WebSocket, BrowserRpcErrorType>((resume) => {
                  const socket = new WebSocket(
                    `ws://127.0.0.1:${port}/?pacing=ack`
                  );
                  const decodeSemaphore = Semaphore.makeUnsafe(1);
                  let opened = false;

                  const handleOpen = () => {
                    opened = true;
                    streamConnections.get(sessionId)?.socket.close();
                    streamConnections.set(sessionId, { socket, streamId });
                    const activeTabId = activeTabIds.get(sessionId);
                    if (activeTabId !== undefined) {
                      streamActiveTabIds.set(sessionId, activeTabId);
                    }
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
                        if (
                          streamConnections.get(sessionId)?.socket !== socket
                        ) {
                          return;
                        }
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
                              const tabId = streamActiveTabIds.get(sessionId);
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
                              const tabId = streamActiveTabIds.get(sessionId);
                              if (tabId !== undefined) {
                                yield* Queue.offer(queue, {
                                  ...urlEvent,
                                  tabId,
                                });
                              }
                              return;
                            }

                            const message = yield* Schema.decodeUnknownEffect(
                              AgentBrowserViewEvent
                            )(parsed);
                            if (message.type === "tabs") {
                              const activeTab = message.tabs.find(
                                ({ active }) => active
                              );
                              if (activeTab !== undefined) {
                                activeTabIds.set(sessionId, activeTab.tabId);
                                streamActiveTabIds.set(
                                  sessionId,
                                  activeTab.tabId
                                );
                              }
                            }
                            yield* Queue.offer(
                              queue,
                              message.type === "frame"
                                ? { ...message, streamId }
                                : message
                            );
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
                    Effect.runFork(
                      serializeBrowserStreamEvent(decodeSemaphore, decodeEvent)
                    );
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
                    if (streamConnections.get(sessionId)?.socket === socket) {
                      streamConnections.delete(sessionId);
                      streamActiveTabIds.delete(sessionId);
                    }
                    socket.close();
                  })
              )
            )
          )
        )
      );

    const writeToStream = Effect.fn("AgentBrowser.writeToStream")(
      function* writeToStream(
        sessionId: SessionId,
        message: unknown,
        expectedStreamId?: BrowserStreamIdType
      ) {
        const connection = streamConnections.get(sessionId);
        if (
          connection === undefined ||
          connection.socket.readyState !== WebSocket.OPEN
        ) {
          return yield* Effect.fail(
            browserError(
              "stream_failed",
              `Browser session ${sessionId} has no attached viewport.`
            )
          );
        }
        const { socket } = connection;
        if (
          expectedStreamId !== undefined &&
          connection.streamId !== expectedStreamId
        ) {
          return yield* Effect.fail(
            browserError("stream_failed", "Browser stream was replaced.")
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

    const acknowledgeFrame = (
      sessionId: SessionId,
      sequence: number,
      streamId: BrowserStreamIdType
    ) => writeToStream(sessionId, { seq: sequence, type: "ack" }, streamId);

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* closeOwnedSessions() {
        for (const { socket } of streamConnections.values()) {
          socket.close();
        }
        streamConnections.clear();
        inputSemaphores.clear();
        tabCommandSemaphores.clear();
        sessionProfiles.clear();
        activeTabIds.clear();
        streamActiveTabIds.clear();
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
      cdpUrl,
      clearStorage,
      clickSelector,
      close,
      closeTab,
      create,
      currentUrl,
      deleteStorage,
      fillSelector,
      getNetworkRequest,
      getNetworkRequests,
      getStorage,
      getTabs,
      goto,
      init,
      isVisible,
      keyDown,
      keyUp,
      list,
      navigate,
      newTab,
      open,
      sendInput,
      setStorage,
      setUserAgent,
      setViewport,
      stream,
      switchTab,
      typeSelector,
      waitForSelector,
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
