import { randomUUID } from "node:crypto";

import {
  AgentProcessId,
  AgentSessionId,
  describeAgentAction,
  makeBrowserRpcError,
  UserAgentProfileId,
} from "@contingency/protocol";
import type {
  AgentActionResult,
  DraftEmulation,
  AgentHistoryAction,
  AgentNavigateAction,
  BrowserInput,
  AgentBrowserAction,
  AgentBrowserSnapshot,
  AgentScreenshot,
  AgentSessionActivity,
  AgentTimelineEntry,
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
  Cause,
  Context,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Layer,
  Option,
  PubSub,
  Ref,
  Result,
  Schedule,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import type { Page } from "playwright-core";

import {
  captureAgentScreenshot,
  makeAgentElementRegistry,
  performAgentAction,
  snapshotAfterAction,
} from "./agent-browser.ts";
import type { AgentElementRegistry } from "./agent-browser.ts";
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
  /** The whole Emulation to run under, viewport included. */
  readonly emulation?: DraftEmulation | undefined;
  readonly clientName?: string | undefined;
  readonly clientVersion?: string | undefined;
  readonly name?: string | undefined;
  readonly operationId?: OperationId | string | undefined;
  readonly url?: string | undefined;
  readonly viewport: AgentSessionStart["viewport"];
}

export interface AgentSessionService {
  /**
   * Perform one agent browser action. The action is dispatched on a child
   * fiber so a user Takeover can interrupt it and wait for its cleanup; a
   * repeated operation id answers with the recorded result instead.
   */
  readonly act: (
    sessionId: AgentSessionId,
    action: AgentBrowserAction,
    operationId?: OperationId | string
  ) => Effect.Effect<AgentActionResult, AgentSessionError>;
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
  /** Ask the user to take control, and answer immediately with the link. */
  readonly requestTakeover: (
    sessionId: AgentSessionId,
    reason: string,
    operationId?: OperationId | string
  ) => Effect.Effect<AgentSessionSnapshot, AgentSessionError>;
  /** Hand control back to the agent. Only the user may do this. */
  readonly returnControl: (
    sessionId: AgentSessionId,
    operationId?: OperationId | string
  ) => Effect.Effect<AgentSessionSnapshot, AgentSessionError>;
  readonly screenshot: (
    sessionId: AgentSessionId
  ) => Effect.Effect<AgentScreenshot, AgentSessionError>;
  /**
   * Drive the browser as the user during Takeover. Control is exclusive, so
   * this is refused unless the user actually holds it.
   */
  readonly sendInput: (
    sessionId: AgentSessionId,
    input: BrowserInput
  ) => Effect.Effect<void, AgentSessionError>;
  /**
   * Address-bar and history navigation during Takeover. The user drives the
   * same browser the agent does, so navigation is refused for the same reason
   * raw input is: control is exclusive.
   */
  readonly userNavigate: (
    sessionId: AgentSessionId,
    action: AgentNavigateAction | AgentHistoryAction
  ) => Effect.Effect<AgentSessionSnapshot, AgentSessionError>;
  readonly snapshot: (
    sessionId: AgentSessionId
  ) => Effect.Effect<AgentBrowserSnapshot, AgentSessionError>;
  /** Internal ownership check for generic browser RPC isolation. */
  readonly ownsBrowserSession: (sessionId: SessionId) => Effect.Effect<boolean>;
  readonly start: (
    input: AgentSessionStartInput
  ) => Effect.Effect<AgentSessionSnapshot, AgentSessionError>;
  /**
   * Take control away from the agent. User initiation has priority: the
   * in-flight action is interrupted, its cleanup is awaited, and agent action
   * tools stay disabled until control is explicitly returned.
   */
  readonly takeover: (
    sessionId: AgentSessionId,
    reason: string,
    operationId?: OperationId | string
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

/**
 * What the session actually runs under. An Emulation is one whole value, so a
 * supplied one is used as it stands — its viewport included — rather than
 * merged field by field with the shorthand viewport.
 */
const sessionEmulation = (input: AgentSessionStartInput): DraftEmulation =>
  input.emulation ?? {
    permissions: [],
    userAgentProfile: UserAgentProfileId.make("default"),
    viewport: input.viewport,
  };

const normalizedStartInput = (input: AgentSessionStartInput): string =>
  JSON.stringify({
    activity: input.activity ?? "run",
    clientName: input.clientName?.trim() || "unknown",
    clientVersion: input.clientVersion?.trim() || "unknown",
    emulation: input.emulation ?? null,
    name: input.name?.trim() || null,
    url: input.url ?? null,
    viewport: {
      deviceScaleFactor: input.viewport.deviceScaleFactor,
      height: input.viewport.height,
      width: input.viewport.width,
    },
  });

/**
 * Whether agent action tools are disabled. They are while the user holds the
 * browser, and also while a Takeover the agent itself asked for is pending: an
 * agent that asked for help does not keep acting while it waits.
 */
const agentIsPaused = (snapshot: AgentSessionSnapshot): boolean =>
  snapshot.controller === "user" || snapshot.phase === "takeover";

/** Agent action tools are disabled while the user holds the browser. */
const takenOver = (description: string): BrowserRpcErrorType =>
  makeBrowserRpcError(
    "agent_control_unavailable",
    `${description} The user holds the browser; agent actions resume when the user returns control.`
  );

const isLive = (phase: AgentSessionSnapshot["phase"]): boolean =>
  phase === "starting" || phase === "running" || phase === "takeover";

/** How many attempts one Agent Session keeps in its action timeline. */
const TIMELINE_LIMIT = 200;

/**
 * The action the agent has dispatched to the browser right now, if any. A user
 * Takeover interrupts this fiber and reports the attempt as dispatched: the
 * browser may already have performed it, and Contingency cannot undo it.
 */
interface InFlightAction {
  readonly description: string;
  readonly fiber: Fiber.Fiber<AgentActionResult, AgentSessionError>;
  readonly id: string;
}

interface ActionControl {
  inFlight: InFlightAction | undefined;
  /** One agent action at a time, so Takeover always has one fiber to stop. */
  readonly lock: Semaphore.Semaphore;
}

/** What one snapshot write answers with, and the map it leaves behind. */
type SnapshotWrite = readonly [
  {
    readonly changed: boolean;
    readonly snapshot: AgentSessionSnapshot | undefined;
  },
  ReadonlyMap<AgentSessionId, SessionRecord>,
];

interface SessionRecord {
  /** Private Create Browser handle. Never included in protocol snapshots. */
  readonly browserSessionId: SessionId;
  readonly control: ActionControl;
  /** The Browser Snapshot references this session has minted. */
  readonly registry: AgentElementRegistry;
  readonly scope: Scope.Closeable;
  readonly snapshot: AgentSessionSnapshot;
}

type AgentOperationKind = "act" | "close" | "control" | "start" | "takeover";

/** What a replayed operation answers with, discriminated so no cast is needed. */
type AgentOperationResult =
  | { readonly kind: "act"; readonly result: AgentActionResult }
  /**
   * A dispatched action whose outcome Contingency does not know. The browser
   * may already have performed it, so the id answers with the same refusal
   * rather than performing it a second time.
   */
  | { readonly error: BrowserRpcErrorType; readonly kind: "act-unresolved" }
  | { readonly kind: "session"; readonly result: AgentSessionSnapshot };

interface ReplayRecord {
  readonly input: string;
  readonly kind: AgentOperationKind;
  readonly result: AgentOperationResult;
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

    /**
     * Every incremental snapshot write is a read-modify-write over the record
     * as it stands when the write lands, not as it stood when its caller read
     * it. Takeover runs under the session lock and actions under the record's
     * own, so a writer that suspended — a URL read, a dispatched action — must
     * not save state built before a control change it never saw.
     */
    const mutate = (
      sessionId: AgentSessionId,
      change: (snapshot: AgentSessionSnapshot) => AgentSessionSnapshot
    ): Effect.Effect<AgentSessionSnapshot | undefined> =>
      Ref.modify(sessions, (current): SnapshotWrite => {
        const record = current.get(sessionId);
        if (record === undefined) {
          return [{ changed: false, snapshot: undefined }, current];
        }
        const next = change(record.snapshot);
        if (next === record.snapshot) {
          return [{ changed: false, snapshot: next }, current];
        }
        return [
          { changed: true, snapshot: next },
          new Map(current).set(sessionId, { ...record, snapshot: next }),
        ];
      }).pipe(
        Effect.tap(({ changed, snapshot }) =>
          changed && snapshot !== undefined ? publish(snapshot) : Effect.void
        ),
        Effect.map(({ snapshot }) => snapshot)
      );

    /**
     * The browser is the authority on where it is. The user drives it directly
     * during Takeover — a click that navigates goes through raw input and no
     * action path at all — so the session re-reads the Page's URL whenever it
     * hands a snapshot out rather than trusting the last write.
     *
     * `currentUrl` is a local read on the active Page, not a browser round
     * trip, and the state is only written when the URL actually changed, so a
     * change reaches Agent View through the same stream every other change
     * does. No timeline entry is invented for it: the moment a read notices a
     * navigation is not the moment the user made it.
     */
    const refreshedSnapshot = (
      sessionId: AgentSessionId,
      record: SessionRecord
    ): Effect.Effect<AgentSessionSnapshot> =>
      browser.currentUrl(record.browserSessionId).pipe(
        Effect.flatMap((currentUrl) =>
          mutate(sessionId, (snapshot) =>
            snapshot.currentUrl === currentUrl
              ? snapshot
              : { ...snapshot, currentUrl, updatedAt: now().toISOString() }
          )
        ),
        Effect.map((next) => next ?? record.snapshot),
        Effect.orElseSucceed(() => record.snapshot)
      );

    const remember = (
      operationId: OperationId | string | undefined,
      kind: AgentOperationKind,
      target: string,
      input: string,
      result: AgentOperationResult
    ): Effect.Effect<void> =>
      operationId === undefined
        ? Effect.void
        : Ref.update(operations, (current) =>
            new Map(current).set(String(operationId), {
              input,
              kind,
              result,
              target,
            })
          );

    const rememberSession = (
      operationId: OperationId | string | undefined,
      kind: AgentOperationKind,
      target: string,
      input: string,
      snapshot: AgentSessionSnapshot
    ): Effect.Effect<void> =>
      remember(operationId, kind, target, input, {
        kind: "session",
        result: snapshot,
      });

    /**
     * What a repeated operation id means. An identical request answers with
     * the recorded result and performs no effect; a different request under a
     * used id is a conflict rather than a second effect.
     */
    const replay = (
      operationId: OperationId | string | undefined,
      kind: AgentOperationKind,
      target: string,
      input: string
    ):
      | { readonly _tag: "conflict"; readonly error: AgentSessionDomainError }
      | { readonly _tag: "replay"; readonly result: AgentOperationResult }
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
        return { _tag: "replay", result: prior.result };
      }
      return {
        _tag: "conflict",
        error: error(
          "agent_session_conflict",
          `Operation ${String(operationId)} was already used for a different ${prior.kind} request.`
        ),
      };
    };

    /** The replayed snapshot of a session mutation, if this id replays one. */
    const replaySession = (
      operationId: OperationId | string | undefined,
      kind: AgentOperationKind,
      target: string,
      input: string
    ):
      | { readonly _tag: "conflict"; readonly error: AgentSessionDomainError }
      | { readonly _tag: "replay"; readonly snapshot: AgentSessionSnapshot }
      | undefined => {
      const replayed = replay(operationId, kind, target, input);
      if (replayed === undefined || replayed._tag === "conflict") {
        return replayed;
      }
      return replayed.result.kind === "session"
        ? { _tag: "replay", snapshot: replayed.result.result }
        : {
            _tag: "conflict",
            error: error(
              "agent_session_conflict",
              `Operation ${String(operationId)} was already used for a browser action.`
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
        const replayed = replaySession(
          operationId,
          "close",
          sessionId,
          requestInput
        );
        if (replayed?._tag === "replay") {
          return replayed.snapshot;
        }
        if (replayed?._tag === "conflict") {
          return yield* Effect.fail(replayed.error);
        }
        const record = yield* read(sessionId);
        if (!isLive(record.snapshot.phase)) {
          yield* rememberSession(
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
            yield* rememberSession(
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
        const replayed = replaySession(
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
                // One Emulation for the session: the browser is created at the
                // viewport it will navigate under, so the first document is
                // laid out for the device rather than resized into it.
                const emulation = sessionEmulation(input);
                const acquired = yield* Scope.provide(sessionScope)(
                  Effect.acquireRelease(
                    browser.create(browserName, emulation.viewport),
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
                  interruptedAction: null,
                  ownerProcessId: owner,
                  phase: "starting",
                  takeover: null,
                  timeline: [],
                  updatedAt: at,
                  viewUrl: viewUrl(options.baseUrl, sessionId),
                };
                const registry = makeAgentElementRegistry(now);
                yield* Scope.addFinalizer(sessionScope, registry.clear());
                const record: SessionRecord = {
                  browserSessionId: acquired,
                  control: {
                    inFlight: undefined,
                    lock: Semaphore.makeUnsafe(1),
                  },
                  registry,
                  scope: sessionScope,
                  snapshot: base,
                };
                yield* Ref.update(sessions, (current) =>
                  new Map(current).set(sessionId, record)
                );
                yield* publish(base);
                const setup = Effect.gen(function* finishStartingSession() {
                  // An Emulation reaches a document at its navigation, so the
                  // session always opens one — `about:blank` when the caller
                  // named no URL. Otherwise an identity asked for here would
                  // never apply to the pages the agent later visits.
                  yield* browser.open(
                    acquired,
                    input.url ?? "about:blank",
                    emulation
                  );
                  const currentUrl = yield* browser.currentUrl(acquired);
                  const running: AgentSessionSnapshot = {
                    ...base,
                    currentUrl,
                    phase: "running",
                    updatedAt: now().toISOString(),
                  };
                  yield* save(sessionId, record, running);
                  yield* rememberSession(
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

    const requireLiveRecord = (
      sessionId: AgentSessionId
    ): Effect.Effect<SessionRecord, AgentSessionError> =>
      read(sessionId).pipe(
        Effect.flatMap((record) =>
          isLive(record.snapshot.phase)
            ? Effect.succeed(record)
            : Effect.fail(
                error(
                  "agent_session_conflict",
                  `Agent Session ${sessionId} is no longer running.`
                )
              )
        )
      );

    /** Append one attempt to the timeline and publish the new state. */
    const recordEntry = (
      sessionId: AgentSessionId,
      entry: AgentTimelineEntry,
      patch: Partial<AgentSessionSnapshot> = {}
    ): Effect.Effect<AgentSessionSnapshot, AgentSessionError> =>
      Effect.gen(function* appendTimelineEntry() {
        // The entry joins the timeline as it stands now: an action that ran
        // while control changed hands records what it did without undoing the
        // change it raced.
        const next = yield* mutate(sessionId, (snapshot) => ({
          ...snapshot,
          ...patch,
          timeline: [...snapshot.timeline, entry].slice(-TIMELINE_LIMIT),
          updatedAt: now().toISOString(),
        }));
        if (next === undefined) {
          return yield* Effect.fail(
            error(
              "agent_session_not_found",
              `Agent Session ${sessionId} was not found.`
            )
          );
        }
        return next;
      });

    const observe = <A>(
      sessionId: AgentSessionId,
      read_: (
        record: SessionRecord,
        page: Page
      ) => Effect.Effect<A, AgentSessionError>
    ): Effect.Effect<A, AgentSessionError> =>
      Effect.gen(function* observeAgentBrowser() {
        const record = yield* requireLiveRecord(sessionId);
        const page = yield* browser.activePage(record.browserSessionId);
        return yield* read_(record, page);
      });

    const dispatch = Effect.fn("AgentSession.dispatch")(
      function* dispatchAgentBrowserAction(
        sessionId: AgentSessionId,
        record: SessionRecord,
        page: Page,
        action: AgentBrowserAction,
        description: string,
        id: string,
        operationId: OperationId | string | undefined,
        requestInput: string
      ) {
        const current = yield* requireLiveRecord(sessionId);
        if (agentIsPaused(current.snapshot)) {
          return yield* Effect.fail(
            takenOver("This action was not dispatched.")
          );
        }
        // The action runs on a child fiber so a user Takeover can interrupt it
        // and wait for its cleanup rather than racing it.
        const fiber = yield* Effect.forkChild(
          Effect.gen(function* dispatchAgentAction() {
            yield* performAgentAction(page, record.registry, action);
            const snapshot = yield* snapshotAfterAction(page, record.registry);
            return {
              entry: {
                actor: "agent" as const,
                at: now().toISOString(),
                description,
                dispatched: true,
                id,
                outcome: "completed" as const,
              },
              snapshot,
              url: snapshot.url,
            };
          })
        );
        record.control.inFlight = { description, fiber, id };
        const exit = yield* Fiber.await(fiber);
        record.control.inFlight = undefined;
        if (Exit.isSuccess(exit)) {
          const result = exit.value;
          yield* recordEntry(sessionId, result.entry, {
            currentUrl: result.url,
          });
          yield* remember(operationId, "act", sessionId, requestInput, {
            kind: "act",
            result,
          });
          return result;
        }
        if (Cause.hasInterrupts(exit.cause)) {
          // Takeover already recorded the dispatched attempt. The browser may
          // have performed it, so this operation id is spent: retrying it
          // answers with the same refusal instead of acting again.
          const refusal = takenOver(
            `${description} was interrupted and may already have happened.`
          );
          yield* remember(operationId, "act", sessionId, requestInput, {
            error: refusal,
            kind: "act-unresolved",
          });
          return yield* Effect.fail(refusal);
        }
        const cause = Cause.findErrorOption(exit.cause);
        // A failed action may still have moved the Page, so the session records
        // where the browser actually is rather than where it last succeeded.
        yield* recordEntry(
          sessionId,
          {
            actor: "agent",
            at: now().toISOString(),
            description,
            detail: Option.isSome(cause) ? cause.value.message : undefined,
            dispatched: true,
            id,
            outcome: "failed",
          },
          { currentUrl: page.url() }
        );
        return yield* Effect.failCause(exit.cause);
      }
    );

    const actUnlocked = Effect.fn("AgentSession.act")(
      function* performAgentBrowserAction(
        sessionId: AgentSessionId,
        action: AgentBrowserAction,
        operationId?: OperationId | string
      ) {
        const requestInput = JSON.stringify(action);
        const replayed = replay(operationId, "act", sessionId, requestInput);
        if (replayed?._tag === "conflict") {
          return yield* Effect.fail(replayed.error);
        }
        if (replayed?._tag === "replay") {
          if (replayed.result.kind === "act") {
            return replayed.result.result;
          }
          if (replayed.result.kind === "act-unresolved") {
            return yield* Effect.fail(replayed.result.error);
          }
          return yield* Effect.fail(
            error(
              "agent_session_conflict",
              `Operation ${String(operationId)} was already used for a session mutation.`
            )
          );
        }
        const record = yield* requireLiveRecord(sessionId);
        if (agentIsPaused(record.snapshot)) {
          return yield* Effect.fail(
            takenOver("This action was not dispatched.")
          );
        }
        const page = yield* browser.activePage(record.browserSessionId);
        const description = describeAgentAction(action);
        const id = `action-${randomUUID()}`;
        // Concurrent agent actions would leave a fiber Takeover cannot reach,
        // so a second action waits here and re-reads control when it wakes.
        return yield* record.control.lock.withPermit(
          dispatch(
            sessionId,
            record,
            page,
            action,
            description,
            id,
            operationId,
            requestInput
          )
        );
      }
    );

    /**
     * Enter Takeover. A user initiation takes control immediately and has
     * priority: it interrupts the in-flight agent action and waits for its
     * cleanup. An agent request only pauses agent actions and publishes the
     * reason — the agent cannot hand the user control the user has not taken,
     * and Agent View still shows a Take control action
     * ([ADR 0027](../../../../docs/adr/0027-agent-authority-has-a-user-approved-execution-boundary.md)).
     */
    const beginTakeoverUnlocked = Effect.fn("AgentSession.takeover")(
      function* beginTakeover(
        sessionId: AgentSessionId,
        reason: string,
        by: AgentSessionSnapshot["controller"],
        operationId?: OperationId | string
      ) {
        const kind = by === "user" ? "takeover" : "control";
        const requestInput = JSON.stringify({ by, reason });
        const replayed = replaySession(
          operationId,
          kind,
          sessionId,
          requestInput
        );
        if (replayed?._tag === "conflict") {
          return yield* Effect.fail(replayed.error);
        }
        if (replayed?._tag === "replay") {
          return replayed.snapshot;
        }
        const record = yield* requireLiveRecord(sessionId);
        const inFlight = by === "user" ? record.control.inFlight : undefined;
        let interruptedAction: AgentTimelineEntry | null = null;
        if (inFlight !== undefined) {
          // Interruption waits for the action fiber's finalizers, but the
          // browser may already have performed the effect, so the attempt is
          // recorded as dispatched rather than as never having happened.
          yield* Fiber.interrupt(inFlight.fiber);
          record.control.inFlight = undefined;
          interruptedAction = {
            actor: "agent",
            at: now().toISOString(),
            description: inFlight.description,
            detail:
              "Takeover interrupted this action. The browser may already have performed it.",
            dispatched: true,
            id: inFlight.id,
            outcome: "interrupted",
          };
        }
        const at = now().toISOString();
        const entry: AgentTimelineEntry = {
          actor: by,
          at,
          description:
            by === "user"
              ? "The user took control"
              : "The agent asked the user to take control",
          detail: reason,
          dispatched: false,
          id: `takeover-${randomUUID()}`,
          outcome: "completed",
        };
        const current = yield* read(sessionId);
        const timeline = [
          ...current.snapshot.timeline,
          ...(interruptedAction === null ? [] : [interruptedAction]),
          entry,
        ].slice(-TIMELINE_LIMIT);
        const next: AgentSessionSnapshot = {
          ...current.snapshot,
          controller: by === "user" ? "user" : current.snapshot.controller,
          interruptedAction,
          phase: "takeover",
          takeover: { reason, requestedAt: at, requestedBy: by },
          timeline,
          updatedAt: at,
        };
        yield* save(sessionId, current, next);
        yield* rememberSession(
          operationId,
          kind,
          sessionId,
          requestInput,
          next
        );
        return next;
      }
    );

    const returnControlUnlocked = Effect.fn("AgentSession.returnControl")(
      function* returnControl(
        sessionId: AgentSessionId,
        operationId?: OperationId | string
      ) {
        const requestInput = "";
        const replayed = replaySession(
          operationId,
          "control",
          sessionId,
          requestInput
        );
        if (replayed?._tag === "conflict") {
          return yield* Effect.fail(replayed.error);
        }
        if (replayed?._tag === "replay") {
          return replayed.snapshot;
        }
        const record = yield* requireLiveRecord(sessionId);
        // There must be something to hand back: the user holds the browser, or
        // the agent asked for help and is waiting. Without this the loopback
        // RPC would record a handover that never happened while the agent was
        // already running.
        if (!agentIsPaused(record.snapshot)) {
          return yield* Effect.fail(
            makeBrowserRpcError(
              "agent_control_unavailable",
              "The agent already holds the browser."
            )
          );
        }
        const at = now().toISOString();
        const entry: AgentTimelineEntry = {
          actor: "user",
          at,
          description: "The user returned control to the agent",
          dispatched: false,
          id: `control-${randomUUID()}`,
          outcome: "completed",
        };
        const next: AgentSessionSnapshot = {
          ...record.snapshot,
          controller: "agent",
          interruptedAction: null,
          phase: "running",
          takeover: null,
          timeline: [...record.snapshot.timeline, entry].slice(-TIMELINE_LIMIT),
          updatedAt: at,
        };
        yield* save(sessionId, record, next);
        yield* rememberSession(
          operationId,
          "control",
          sessionId,
          requestInput,
          next
        );
        return next;
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
      act: (sessionId, action, operationId) =>
        actUnlocked(sessionId, action, operationId),
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
        Stream.unwrap(
          lock.withPermit(
            Effect.gen(function* subscribeToSessionChanges() {
              const subscription = yield* PubSub.subscribe(events);
              const { snapshot } = yield* read(sessionId);
              return Stream.concat(
                Stream.succeed(snapshot),
                Stream.fromEffect(PubSub.take(subscription)).pipe(
                  Stream.repeat(Schedule.forever),
                  Stream.filter(({ id }) => id === sessionId)
                )
              );
            })
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
        read(sessionId).pipe(
          Effect.flatMap((record) => refreshedSnapshot(sessionId, record))
        ),
      list: () =>
        Effect.forEach(
          [...Ref.getUnsafe(sessions).values()].filter(({ snapshot }) =>
            isLive(snapshot.phase)
          ),
          (record) => refreshedSnapshot(record.snapshot.id, record)
        ),
      ownsBrowserSession: (sessionId) =>
        Effect.sync(() =>
          [...Ref.getUnsafe(sessions).values()].some(
            ({ browserSessionId }) => browserSessionId === sessionId
          )
        ),
      requestTakeover: (sessionId, reason, operationId) =>
        lock.withPermit(
          beginTakeoverUnlocked(sessionId, reason, "agent", operationId)
        ),
      returnControl: (sessionId, operationId) =>
        lock.withPermit(returnControlUnlocked(sessionId, operationId)),
      screenshot: (sessionId) =>
        observe(sessionId, (_record, page) =>
          captureAgentScreenshot(page, now)
        ),
      sendInput: (sessionId, input) =>
        Effect.gen(function* sendUserInput() {
          const record = yield* requireLiveRecord(sessionId);
          if (record.snapshot.controller !== "user") {
            return yield* Effect.fail(
              makeBrowserRpcError(
                "agent_control_unavailable",
                "The agent holds the browser. Take control before driving it yourself."
              )
            );
          }
          return yield* browser.sendInput(record.browserSessionId, input);
        }),
      snapshot: (sessionId) =>
        observe(sessionId, (record, page) => record.registry.snapshot(page)),
      start: (input) => lock.withPermit(startUnlocked(input)),
      takeover: (sessionId, reason, operationId) =>
        lock.withPermit(
          beginTakeoverUnlocked(sessionId, reason, "user", operationId)
        ),
      userNavigate: (sessionId, action) =>
        Effect.gen(function* navigateAsUser() {
          const record = yield* requireLiveRecord(sessionId);
          if (record.snapshot.controller !== "user") {
            return yield* Effect.fail(
              makeBrowserRpcError(
                "agent_control_unavailable",
                "The agent holds the browser. Take control before driving it yourself."
              )
            );
          }
          const page = yield* browser.activePage(record.browserSessionId);
          const description = describeAgentAction(action);
          const id = `user-${randomUUID()}`;
          // One browser takes one navigation at a time. Without this permit a
          // second click races the first, and Playwright cancels the pending
          // navigation: both attempts report success and the page never moves.
          const outcome = yield* record.control.lock.withPermit(
            Effect.result(performAgentAction(page, record.registry, action))
          );
          const at = now().toISOString();
          if (Result.isFailure(outcome)) {
            yield* recordEntry(sessionId, {
              actor: "user",
              at,
              description,
              detail: outcome.failure.message,
              dispatched: true,
              id,
              outcome: "failed",
            });
            return yield* Effect.fail(outcome.failure);
          }
          const url = page.url();
          return yield* recordEntry(
            sessionId,
            {
              actor: "user",
              at,
              description,
              dispatched: true,
              id,
              outcome: "completed",
            },
            { currentUrl: url }
          );
        }),
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
