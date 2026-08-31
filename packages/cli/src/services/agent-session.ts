import { randomUUID } from "node:crypto";

import {
  AgentProcessId,
  AgentSessionId,
  UserAgentProfileId,
} from "@contingency/protocol";
import type {
  AgentSessionActivity,
  AgentSessionSnapshot,
  AgentSessionStart,
  BrowserStreamEvent,
  BrowserRpcErrorType,
  BrowserStreamId,
  FrameSequence,
  OperationId,
  SessionId,
} from "@contingency/protocol";
import {
  Context,
  Effect,
  Exit,
  FileSystem,
  Layer,
  PubSub,
  Ref,
  Scope,
  Semaphore,
  Stream,
} from "effect";

import { CreateBrowser } from "./create-browser-contract.ts";
import type { CreateBrowserService } from "./create-browser-contract.ts";
import { isLoopbackHost } from "./web-url.ts";

/** Options for the one process-owned Agent Session registry. */
export interface AgentSessionServiceOptions {
  /** The URL at which Agent View is served, normally loopback. */
  readonly baseUrl: string;
  /** The owner marker written into every in-memory snapshot. */
  readonly processId?: string;
  /** Injectable clock for deterministic protocol tests. */
  readonly now?: () => Date;
  /** Exact process-owner directory for per-session temporary resources. */
  readonly resourceDirectory?: string;
}

export interface AgentSessionStartInput {
  readonly activity?: AgentSessionActivity | undefined;
  readonly clientName?: string | undefined;
  readonly clientVersion?: string | undefined;
  readonly name?: string | undefined;
  readonly operationId?: OperationId | string | undefined;
  readonly url?: string | undefined;
  readonly viewport: AgentSessionStart["viewport"];
}

export interface AgentSessionService {
  readonly changes: (
    sessionId: AgentSessionId
  ) => Stream.Stream<AgentSessionSnapshot, AgentSessionError>;
  readonly close: (
    sessionId: AgentSessionId,
    operationId?: OperationId | string
  ) => Effect.Effect<AgentSessionSnapshot, AgentSessionError>;
  readonly closeAll: () => Effect.Effect<void>;
  readonly get: (
    sessionId: AgentSessionId
  ) => Effect.Effect<AgentSessionSnapshot, AgentSessionError>;
  /** Stream browser events through the Agent Session boundary. */
  readonly browserStream: (
    sessionId: AgentSessionId
  ) => Stream.Stream<BrowserStreamEvent, AgentSessionError>;
  /** Acknowledge a frame without exposing the lower-level browser handle. */
  readonly acknowledgeFrame: (
    sessionId: AgentSessionId,
    sequence: FrameSequence,
    streamId: BrowserStreamId
  ) => Effect.Effect<void, AgentSessionError>;
  readonly list: () => Effect.Effect<readonly AgentSessionSnapshot[]>;
  /** Internal ownership check for generic browser RPC isolation. */
  readonly ownsBrowserSession: (sessionId: SessionId) => Effect.Effect<boolean>;
  readonly start: (
    input: AgentSessionStartInput
  ) => Effect.Effect<AgentSessionSnapshot, AgentSessionError>;
}

export const AgentSession = Context.Service<AgentSessionService>(
  "@contingency/AgentSession"
);

interface AgentSessionDomainError {
  readonly _tag: "AgentSessionError";
  readonly code:
    | "agent_session_conflict"
    | "agent_session_invalid"
    | "agent_session_not_found"
    | "agent_session_unavailable";
  readonly message: string;
}

export type AgentSessionError = BrowserRpcErrorType | AgentSessionDomainError;

const error = (
  code: AgentSessionDomainError["code"],
  message: string
): AgentSessionDomainError => ({ _tag: "AgentSessionError", code, message });

const processId = (configured: string | undefined): string =>
  configured?.trim() || `mcp-${process.pid}-${randomUUID()}`;

const viewUrl = (baseUrl: string, sessionId: AgentSessionId): string => {
  const url = new URL("/agent", baseUrl);
  url.searchParams.set("session", sessionId);
  return url.href;
};

/** Agent View is a local control surface and never receives a public URL. */
export const isAllowedAgentSessionBaseUrl = (baseUrl: string): boolean => {
  try {
    const url = new URL(baseUrl);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      isLoopbackHost(url.hostname)
    );
  } catch {
    return false;
  }
};

const normalizedStartInput = (input: AgentSessionStartInput): string =>
  JSON.stringify({
    activity: input.activity ?? "run",
    clientName: input.clientName?.trim() || "unknown",
    clientVersion: input.clientVersion?.trim() || "unknown",
    name: input.name?.trim() || null,
    url: input.url ?? null,
    viewport: {
      deviceScaleFactor: input.viewport.deviceScaleFactor,
      height: input.viewport.height,
      width: input.viewport.width,
    },
  });

const isLive = (phase: AgentSessionSnapshot["phase"]): boolean =>
  phase === "starting" || phase === "running" || phase === "takeover";

interface SessionRecord {
  /** Private Create Browser handle. Never included in protocol snapshots. */
  readonly browserSessionId: SessionId;
  readonly scope: Scope.Closeable;
  readonly snapshot: AgentSessionSnapshot;
}

type AgentOperationKind = "close" | "start";

interface ReplayRecord {
  readonly input: string;
  readonly kind: AgentOperationKind;
  readonly snapshot: AgentSessionSnapshot;
  readonly target: string;
}

const makeAgentSession = (
  browser: CreateBrowserService,
  options: AgentSessionServiceOptions,
  events: PubSub.PubSub<AgentSessionSnapshot>,
  fileSystem?: FileSystem.FileSystem,
  parentScope?: Scope.Scope
): Effect.Effect<AgentSessionService> =>
  Effect.sync(() => {
    const sessions = Ref.makeUnsafe<ReadonlyMap<AgentSessionId, SessionRecord>>(
      new Map()
    );
    const operations = Ref.makeUnsafe<ReadonlyMap<string, ReplayRecord>>(
      new Map()
    );
    const lock = Semaphore.makeUnsafe(1);
    const owner = AgentProcessId.make(processId(options.processId));
    const now = options.now ?? (() => new Date());

    const read = (
      sessionId: AgentSessionId
    ): Effect.Effect<SessionRecord, AgentSessionError> => {
      const record = Ref.getUnsafe(sessions).get(sessionId);
      return record === undefined
        ? Effect.fail(
            error(
              "agent_session_not_found",
              `Agent Session ${sessionId} was not found.`
            )
          )
        : Effect.succeed(record);
    };

    const publish = (snapshot: AgentSessionSnapshot): Effect.Effect<void> =>
      Effect.sync(() => PubSub.publishUnsafe(events, snapshot));

    const save = (
      sessionId: AgentSessionId,
      record: SessionRecord,
      snapshot: AgentSessionSnapshot
    ): Effect.Effect<void> =>
      Ref.update(sessions, (current) =>
        new Map(current).set(sessionId, { ...record, snapshot })
      ).pipe(Effect.andThen(publish(snapshot)));

    const remember = (
      operationId: OperationId | string | undefined,
      kind: AgentOperationKind,
      target: string,
      input: string,
      snapshot: AgentSessionSnapshot
    ): Effect.Effect<void> =>
      operationId === undefined
        ? Effect.void
        : Ref.update(operations, (current) =>
            new Map(current).set(String(operationId), {
              input,
              kind,
              snapshot,
              target,
            })
          );

    const replay = (
      operationId: OperationId | string | undefined,
      kind: AgentOperationKind,
      target: string,
      input: string
    ):
      | { readonly _tag: "conflict"; readonly error: AgentSessionDomainError }
      | { readonly _tag: "replay"; readonly snapshot: AgentSessionSnapshot }
      | undefined => {
      if (operationId === undefined) {
        return undefined;
      }
      const prior = Ref.getUnsafe(operations).get(String(operationId));
      if (prior === undefined) {
        return undefined;
      }
      if (
        prior.kind === kind &&
        prior.target === target &&
        prior.input === input
      ) {
        return { _tag: "replay", snapshot: prior.snapshot };
      }
      return {
        _tag: "conflict",
        error: error(
          "agent_session_conflict",
          `Operation ${String(operationId)} was already used for a different ${prior.kind} request.`
        ),
      };
    };

    const sessionResource = (
      sessionScope: Scope.Closeable,
      sessionId: AgentSessionId
    ): Effect.Effect<void, AgentSessionError> => {
      const { resourceDirectory } = options;
      if (resourceDirectory === undefined) {
        return Effect.void;
      }
      if (fileSystem === undefined) {
        return Effect.fail(
          error(
            "agent_session_invalid",
            "Agent Session resources require a FileSystem service."
          )
        );
      }
      return Effect.gen(function* acquireSessionResource() {
        const directory = yield* Scope.provide(sessionScope)(
          Effect.acquireRelease(
            fileSystem
              .makeTempDirectory({
                directory: resourceDirectory,
                prefix: "session-",
              })
              .pipe(
                Effect.mapError((cause) =>
                  error(
                    "agent_session_invalid",
                    `Could not create Agent Session resources: ${cause.message}`
                  )
                )
              ),
            (created) =>
              fileSystem
                .remove(created, { recursive: true })
                .pipe(Effect.ignore)
          )
        );
        const lockPath = `${directory}/session.lock`;
        yield* Scope.provide(sessionScope)(
          Effect.acquireRelease(
            fileSystem
              .writeFileString(lockPath, sessionId)
              .pipe(
                Effect.mapError((cause) =>
                  error(
                    "agent_session_invalid",
                    `Could not create the Agent Session lock: ${cause.message}`
                  )
                )
              ),
            () => fileSystem.remove(lockPath).pipe(Effect.ignore)
          )
        );
      });
    };

    const closeUnlocked = Effect.fn("AgentSession.close")(
      function* closeSession(
        sessionId: AgentSessionId,
        operationId?: OperationId | string
      ) {
        const requestInput = "";
        const replayed = replay(operationId, "close", sessionId, requestInput);
        if (replayed?._tag === "replay") {
          return replayed.snapshot;
        }
        if (replayed?._tag === "conflict") {
          return yield* Effect.fail(replayed.error);
        }
        const record = yield* read(sessionId);
        if (!isLive(record.snapshot.phase)) {
          yield* remember(
            operationId,
            "close",
            sessionId,
            requestInput,
            record.snapshot
          );
          return record.snapshot;
        }
        return yield* Effect.uninterruptibleMask(() =>
          Effect.gen(function* closeAtomically() {
            const at = now().toISOString();
            const closed: AgentSessionSnapshot = {
              ...record.snapshot,
              controller: "agent",
              phase: "closed",
              takeover: null,
              updatedAt: at,
            };
            // Remove it from the discovery list before closing the browser. A
            // concurrent View query therefore cannot select a session that is
            // already being torn down. The snapshot, child scope, and replay
            // record are one uninterruptible mutation.
            yield* save(sessionId, record, closed);
            yield* Scope.close(record.scope, Exit.void);
            yield* remember(
              operationId,
              "close",
              sessionId,
              requestInput,
              closed
            );
            return closed;
          })
        );
      }
    );

    const interruptUnlocked = Effect.fn("AgentSession.interrupt")(
      function* interruptSession(sessionId: AgentSessionId) {
        const record = yield* read(sessionId);
        if (!isLive(record.snapshot.phase)) {
          return record.snapshot;
        }
        const at = now().toISOString();
        const interrupted: AgentSessionSnapshot = {
          ...record.snapshot,
          controller: "agent",
          error:
            "The owning process stopped before this Agent Session completed.",
          phase: "interrupted",
          takeover: null,
          updatedAt: at,
        };
        yield* save(sessionId, record, interrupted);
        yield* Scope.close(record.scope, Exit.interrupt());
        return interrupted;
      }
    );

    const startUnlocked = Effect.fn("AgentSession.start")(
      function* startSession(input: AgentSessionStartInput) {
        const requestInput = normalizedStartInput(input);
        const replayed = replay(
          input.operationId,
          "start",
          "start",
          requestInput
        );
        if (replayed?._tag === "replay") {
          return replayed.snapshot;
        }
        if (replayed?._tag === "conflict") {
          return yield* Effect.fail(replayed.error);
        }
        if (!isAllowedAgentSessionBaseUrl(options.baseUrl)) {
          return yield* Effect.fail(
            error(
              "agent_session_invalid",
              "Agent View must be served from a loopback URL."
            )
          );
        }
        const sessionId = AgentSessionId.make(`agent-${randomUUID()}`);
        const browserName = `create-agent-${randomUUID()}`;
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* startWithChildScope() {
            const sessionScope = yield* Scope.make("sequential");
            // Register the child scope before the first acquisition. If this
            // operation is interrupted between Create Browser acquisition and
            // registry registration, the parent process scope still closes it.
            if (parentScope !== undefined) {
              yield* Scope.addFinalizer(
                parentScope,
                Scope.close(sessionScope, Exit.interrupt()).pipe(Effect.ignore)
              );
            }
            const cleanupStart = Effect.gen(function* cleanupFailedStart() {
              yield* Scope.close(sessionScope, Exit.void);
              yield* Ref.update(sessions, (current) => {
                const next = new Map(current);
                next.delete(sessionId);
                return next;
              });
            });
            const acquisitionAndSetup = Effect.gen(
              function* acquireAndSetupAgentSession() {
                yield* sessionResource(sessionScope, sessionId);
                const acquired = yield* Scope.provide(sessionScope)(
                  Effect.acquireRelease(
                    browser.create(browserName, input.viewport),
                    (browserSessionId) =>
                      browser.close(browserSessionId).pipe(Effect.ignore)
                  )
                );
                const at = now().toISOString();
                const activity = input.activity ?? "run";
                const base: AgentSessionSnapshot = {
                  activity,
                  clientName: input.clientName?.trim() || "unknown",
                  clientVersion: input.clientVersion?.trim() || "unknown",
                  controller: "agent",
                  createdAt: at,
                  currentUrl: "about:blank",
                  id: sessionId,
                  ownerProcessId: owner,
                  phase: "starting",
                  takeover: null,
                  updatedAt: at,
                  viewUrl: viewUrl(options.baseUrl, sessionId),
                };
                const record: SessionRecord = {
                  browserSessionId: acquired,
                  scope: sessionScope,
                  snapshot: base,
                };
                yield* Ref.update(sessions, (current) =>
                  new Map(current).set(sessionId, record)
                );
                yield* publish(base);
                const setup = Effect.gen(function* finishStartingSession() {
                  if (input.url !== undefined) {
                    yield* browser.open(acquired, input.url, {
                      permissions: [],
                      userAgentProfile: UserAgentProfileId.make("default"),
                      viewport: input.viewport,
                    });
                  }
                  const currentUrl = yield* browser.currentUrl(acquired);
                  const running: AgentSessionSnapshot = {
                    ...base,
                    currentUrl,
                    phase: "running",
                    updatedAt: now().toISOString(),
                  };
                  yield* save(sessionId, record, running);
                  yield* remember(
                    input.operationId,
                    "start",
                    "start",
                    requestInput,
                    running
                  );
                  return running;
                });
                return yield* setup;
              }
            );
            return yield* restore(acquisitionAndSetup).pipe(
              Effect.onExit((exit) =>
                Exit.isSuccess(exit) ? Effect.void : cleanupStart
              )
            );
          })
        );
      }
    );

    const service: AgentSessionService = {
      acknowledgeFrame: (sessionId, sequence, streamId) =>
        Effect.gen(function* acknowledgeAgentFrame() {
          const record = yield* read(sessionId);
          if (!isLive(record.snapshot.phase)) {
            return yield* Effect.fail(
              error(
                "agent_session_conflict",
                `Agent Session ${sessionId} is no longer running.`
              )
            );
          }
          return yield* browser.acknowledgeFrame(
            record.browserSessionId,
            sequence,
            streamId
          );
        }),
      browserStream: (sessionId) =>
        Stream.unwrap(
          read(sessionId).pipe(
            Effect.flatMap((record) =>
              isLive(record.snapshot.phase)
                ? Effect.succeed(browser.stream(record.browserSessionId))
                : Effect.fail(
                    error(
                      "agent_session_conflict",
                      `Agent Session ${sessionId} is no longer running.`
                    )
                  )
            )
          )
        ),
      changes: (sessionId) =>
        Stream.concat(
          Stream.fromEffect(
            read(sessionId).pipe(Effect.map(({ snapshot }) => snapshot))
          ),
          Stream.fromPubSub(events).pipe(
            Stream.filter(({ id }) => id === sessionId)
          )
        ),
      close: (sessionId, operationId) =>
        lock.withPermit(closeUnlocked(sessionId, operationId)),
      closeAll: () =>
        lock.withPermit(
          Effect.forEach(
            [...Ref.getUnsafe(sessions).entries()]
              .filter(([, record]) => isLive(record.snapshot.phase))
              .map(([sessionId]) => sessionId),
            (sessionId) => interruptUnlocked(sessionId).pipe(Effect.ignore),
            { discard: true }
          )
        ),
      get: (sessionId) =>
        read(sessionId).pipe(Effect.map(({ snapshot }) => snapshot)),
      list: () =>
        Effect.sync(() =>
          [...Ref.getUnsafe(sessions).values()]
            .map(({ snapshot }) => snapshot)
            .filter(({ phase }) => isLive(phase))
        ),
      ownsBrowserSession: (sessionId) =>
        Effect.sync(() =>
          [...Ref.getUnsafe(sessions).values()].some(
            ({ browserSessionId }) => browserSessionId === sessionId
          )
        ),
      start: (input) => lock.withPermit(startUnlocked(input)),
    };

    return service;
  });

/** Build a registry over a supplied browser service (useful at public seams). */
export const makeAgentSessionService = (
  browser: CreateBrowserService,
  options: AgentSessionServiceOptions
): Effect.Effect<AgentSessionService> =>
  PubSub.unbounded<AgentSessionSnapshot>().pipe(
    Effect.flatMap((events) => makeAgentSession(browser, options, events))
  );

export type AgentSessionLayerOptions = AgentSessionServiceOptions;

/** Build one process-owned registry for both MCP and Agent View adapters. */
export const makeAgentSessionLayer = (
  options: AgentSessionLayerOptions
): Layer.Layer<
  AgentSessionService,
  never,
  CreateBrowserService | FileSystem.FileSystem
> =>
  Layer.effect(
    AgentSession,
    Effect.gen(function* makeLiveAgentSession() {
      const browser = yield* CreateBrowser;
      const fileSystem = yield* FileSystem.FileSystem;
      const parentScope = yield* Scope.Scope;
      const service = yield* PubSub.unbounded<AgentSessionSnapshot>().pipe(
        Effect.flatMap((events) =>
          makeAgentSession(browser, options, events, fileSystem, parentScope)
        )
      );
      yield* Effect.addFinalizer(() => service.closeAll());
      return service;
    })
  );
