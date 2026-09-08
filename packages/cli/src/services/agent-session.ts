import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import {
  advancesAgentRun,
  AgentProcessId,
  AgentElementRef,
  AgentSessionId,
  describeAgentAction,
  makeBrowserRpcError,
  UserAgentProfileId,
} from "@contingency/protocol";
import type {
  AgentActionResult,
  AgentActionIntent,
  AgentBoundaryResolve,
  AgentExecutionBoundary,
  DomainScope,
  AgentAssessmentEvidence,
  AgentAssessmentOutcome,
  AgentRunAssessmentCounts,
  AgentRunCoverage,
  AgentRunId,
  AgentRunState,
  AgentRunStep,
  AgentRunSummary,
  AgentFlowDraftRef,
  AgentFlowVerificationOutcome,
  AgentSessionVerification,
  DraftEmulation,
  AgentHistoryAction,
  AgentNavigateAction,
  BrowserInput,
  AgentBrowserAction,
  AgentBrowserSnapshot,
  AgentScreenshot,
  AgentSessionActivity,
  AgentSnapshotId,
  AgentTimelineEntry,
  AgentSessionSnapshot,
  AgentSessionStart,
  AgentSessionVariableState,
  BrowserStreamEvent,
  BrowserRpcErrorType,
  BrowserStreamId,
  CapturedUserInput,
  FrameSequence,
  OperationId,
  SessionId,
  TeachingFeed,
  TeachingInstruction,
  TeachingScreenshotContent,
  TeachingVariableInput,
  Variable,
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
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import type { Page } from "playwright-core";

import {
  captureAgentScreenshot,
  makeAgentElementRegistry,
  performAgentAction,
  performPrivateVariableInput,
  redactAgentSnapshot,
  snapshotAfterAction,
} from "./agent-browser.ts";
import type { AgentElementRegistry } from "./agent-browser.ts";
import { domainScopeCovers } from "./agent-flow-compiler.ts";
import type { Demonstration } from "./agent-flow-compiler.ts";
import { installAgentNavigationBoundary } from "./agent-navigation-boundary.ts";
import { CreateBrowser } from "./create-browser-contract.ts";
import type { CreateBrowserService } from "./create-browser-contract.ts";
import { sanitizeTeachingUrl } from "./sensitive-data.ts";
import { makeDemonstrationCapture } from "./teaching-capture.ts";
import type { DemonstrationCapture } from "./teaching-capture.ts";
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
  /** Durable local directory for Teaching Trace archives, resolved at start. */
  readonly traceDirectory?: () => string;
}

export interface AgentSessionStartInput {
  readonly domainScope?: DomainScope | undefined;
  readonly activity?: AgentSessionActivity | undefined;
  /**
   * The exact draft revision this session verifies, under the authorization
   * the user already gave. Present only for a Verification Run.
   */
  readonly verification?: AgentSessionVerification | undefined;
  /**
   * The Interactive Run this session performs, already resolved from an
   * Approved Agent Flow. The session owns its ordered Agent Steps, ceilings,
   * and evidence from the moment the browser opens.
   */
  readonly run?: AgentRunState | undefined;
  /**
   * Where this session's Trace and video are written. A Run names its own Run
   * directory so its evidence is one self-contained package; Teaching falls
   * back to the configured Teaching directory.
   */
  readonly artifactDirectory?: string | undefined;
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
  readonly resolveBoundary: (
    input: AgentBoundaryResolve
  ) => Effect.Effect<AgentSessionSnapshot, AgentSessionError>;
  /**
   * Perform one agent browser action. The action is dispatched on a child
   * fiber so a user Takeover can interrupt it and wait for its cleanup; a
   * repeated operation id answers with the recorded result instead.
   */
  readonly act: (
    sessionId: AgentSessionId,
    action: AgentBrowserAction,
    operationId?: OperationId | string,
    intent?: AgentActionIntent
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
  /** Enter one conversation-supplied Variable while the agent has control. */
  readonly enterAgentVariable: (
    sessionId: AgentSessionId,
    input: PrivateVariableInput,
    operationId?: OperationId | string
  ) => Effect.Effect<AgentActionResult, AgentSessionError>;
  /** Enter one Variable into the focused control during exclusive Takeover. */
  readonly enterUserVariable: (
    sessionId: AgentSessionId,
    input: Omit<PrivateVariableInput, "ref"> & { readonly ref?: string },
    operationId?: OperationId | string
  ) => Effect.Effect<AgentActionResult, AgentSessionError>;
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
  /**
   * Note the draft a Teaching session was compiled into, so Agent View can
   * show it. The catalog write itself happens elsewhere; this only records it.
   */
  readonly recordDraft: (
    sessionId: AgentSessionId,
    draft: AgentFlowDraftRef
  ) => Effect.Effect<AgentSessionSnapshot, AgentSessionError>;
  /**
   * Record what the user told the agent to do, as the agent relayed it. The
   * instruction joins the Demonstration and the Evidence Slice of the Step it
   * falls in.
   */
  readonly recordInstruction: (
    sessionId: AgentSessionId,
    text: string,
    operationId?: OperationId | string
  ) => Effect.Effect<AgentSessionSnapshot, AgentSessionError>;
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
   * Supply one runtime Variable to a Verification Run. Only the user does
   * this, and only the declaration reaches the snapshot: the literal stays in
   * this process and never enters a Run artifact or the agent's tools.
   */
  readonly supplyVariable: (
    sessionId: AgentSessionId,
    name: string,
    value: string,
    operationId?: OperationId | string
  ) => Effect.Effect<AgentSessionSnapshot, AgentSessionError>;
  /**
   * Enter a Variable the user supplied to this Run into one element. The agent
   * names the Variable, never the value.
   */
  readonly enterSuppliedVariable: (
    sessionId: AgentSessionId,
    name: string,
    ref: string,
    operationId?: OperationId | string
  ) => Effect.Effect<AgentActionResult, AgentSessionError>;
  /** What this session is verifying, for the catalog write that follows. */
  /**
   * The agent's evidence-backed judgment of the active Agent Step. Only
   * `working` advances; anything else ends the ordered Steps and leaves the
   * rest unexecuted
   * ([ADR 0029](../../../../docs/adr/0029-contingency-owns-the-sole-runner.md)).
   */
  readonly assessStep: (
    sessionId: AgentSessionId,
    input: {
      readonly evidence: readonly AgentAssessmentEvidence[];
      readonly explanation: string;
      readonly outcome: AgentAssessmentOutcome;
    },
    operationId?: OperationId | string
  ) => Effect.Effect<AgentSessionSnapshot, AgentSessionError>;
  /**
   * End the Run: finalize the Trace and video, close the live browser, and
   * answer with the persistent Run Summary. Agent View stays alive in summary
   * mode; the browser does not.
   */
  readonly completeRun: (
    sessionId: AgentSessionId,
    summary?: string,
    operationId?: OperationId | string
  ) => Effect.Effect<AgentRunSummary, AgentSessionError>;
  /** A direct user action in Agent View raising one ceiling. */
  readonly extendCeiling: (
    sessionId: AgentSessionId,
    scope: "run" | "step",
    additionalMs: number,
    operationId?: OperationId | string
  ) => Effect.Effect<AgentSessionSnapshot, AgentSessionError>;
  /** The read-only Agent View link for one persisted Run. */
  readonly runViewUrl: (
    runId: AgentRunId
  ) => Effect.Effect<string, AgentSessionError>;
  readonly verification: (
    sessionId: AgentSessionId
  ) => Effect.Effect<AgentSessionVerification, AgentSessionError>;
  /** Note how the Verification Run ended, so Agent View can offer approval. */
  readonly recordVerificationOutcome: (
    sessionId: AgentSessionId,
    outcome: AgentFlowVerificationOutcome
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
  /**
   * The bounded Teaching Feed of a Teaching session
   * ([ADR 0032](../../../../docs/adr/0032-external-agents-receive-a-bounded-teaching-feed.md)).
   * Snapshots are included only on request; the agent already saw each one
   * when it acted.
   */
  readonly teachingFeed: (
    sessionId: AgentSessionId,
    includeSnapshots?: boolean
  ) => Effect.Effect<TeachingFeed, AgentSessionError>;
  /**
   * The bytes behind one screenshot the Teaching Feed referenced. Screenshots
   * are fetched one at a time on purpose: the feed stays readable, and the
   * agent pays for only the images it decides to look at.
   */
  readonly teachingScreenshot: (
    sessionId: AgentSessionId,
    screenshotId: string
  ) => Effect.Effect<TeachingScreenshotContent, AgentSessionError>;
  /**
   * The full Demonstration and the Emulation it ran under, for compilation.
   * This stays inside the owning process: MCP hands out the Teaching Feed and
   * never this.
   */
  readonly teachingSource: (
    sessionId: AgentSessionId
  ) => Effect.Effect<TeachingSource, AgentSessionError>;
}

/** What compilation reads from a Teaching session. */
export interface TeachingSource {
  /** Retention classification for the unredacted local artifacts. */
  readonly artifactRetention: {
    readonly location: "local";
    readonly sensitive: true;
  };
  readonly demonstration: Demonstration;
  readonly emulation: DraftEmulation;
  readonly session: AgentSessionSnapshot;
  /** Durable local metadata a retention worker can inspect without the Feed. */
  readonly retentionFile: string | undefined;
  /** Local-only trace path; never included in a Teaching Feed. */
  readonly traceFile: string | undefined;
  /** Local-only unredacted Demonstration video; never included in a Feed. */
  readonly videoFile: string | undefined;
}

export interface PrivateVariableInput {
  readonly ref: NonNullable<TeachingVariableInput["ref"]>;
  readonly value: string;
  readonly variable: Variable;
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

const teachingVideoFile = (
  page: Page
): Effect.Effect<string | undefined, AgentSessionError> =>
  Effect.gen(function* locateTeachingVideo() {
    const video = page.video();
    if (video === null) {
      return;
    }
    return yield* Effect.tryPromise({
      catch: (cause) =>
        error(
          "agent_session_invalid",
          `Could not locate the Teaching video: ${cause instanceof Error ? cause.message : String(cause)}`
        ),
      try: () => video.path(),
    });
  });

const processId = (configured: string | undefined): string =>
  configured?.trim() || `mcp-${process.pid}-${randomUUID()}`;

const viewUrl = (baseUrl: string, sessionId: AgentSessionId): string => {
  const url = new URL("/agent", baseUrl);
  url.searchParams.set("session", sessionId);
  return url.href;
};

/**
 * The read-only viewer's link. It selects a persisted Run rather than a live
 * Agent Session, so it restores no browser state
 * ([ADR 0030](../../../../docs/adr/0030-agent-view-is-separate-from-audit-view.md)).
 */
const runViewUrl = (baseUrl: string, runId: AgentRunId): string => {
  const url = new URL("/agent", baseUrl);
  url.searchParams.set("run", runId);
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
    domainScope: input.domainScope ?? null,
    emulation: input.emulation ?? null,
    name: input.name?.trim() || null,
    run: input.run?.runId ?? null,
    url: input.url ?? null,
    verification: input.verification ?? null,
    viewport: {
      deviceScaleFactor: input.viewport.deviceScaleFactor,
      height: input.viewport.height,
      width: input.viewport.width,
    },
  });

/** Compare retries without retaining a conversation-supplied private value. */
const privateInputFingerprint = (
  actor: AgentSessionSnapshot["controller"],
  input: Omit<PrivateVariableInput, "ref"> & { readonly ref?: string }
): string =>
  JSON.stringify({
    actor,
    ref: input.ref ?? null,
    valueHash: createHash("sha256").update(input.value).digest("hex"),
    variable: input.variable,
  });

const variableReference = (name: string): string => `{{${name}}}`;

/**
 * Every private value this session knows: what the Demonstration captured
 * during Teaching, and what the user supplied to a Verification Run. A Run
 * keeps no Demonstration, so without the supplied literals its Snapshots would
 * hand the agent back the value the user typed privately.
 */
const sessionSensitiveValues = (record: SessionRecord): readonly string[] => [
  ...(record.capture?.sensitiveValues() ?? []),
  ...record.supplied.values(),
];

const redactCapturedSnapshot = (
  record: SessionRecord,
  snapshot: AgentBrowserSnapshot
): AgentBrowserSnapshot =>
  redactAgentSnapshot(snapshot, sessionSensitiveValues(record));

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

/** The Teaching progress a snapshot should carry, given what was captured. */
const teachingOf = (
  record: { readonly capture: DemonstrationCapture | undefined } | undefined,
  snapshot: AgentSessionSnapshot
): AgentSessionSnapshot["teaching"] =>
  record?.capture === undefined
    ? snapshot.teaching
    : record.capture.progress(snapshot.teaching?.draft ?? null);

/** Keep the control event useful to the compiler without persisting typed text. */
const teachingInput = (input: BrowserInput): CapturedUserInput => {
  if (input.type === "input_mouse") {
    return { eventType: input.eventType, inputType: "mouse" };
  }
  const withoutKey: CapturedUserInput =
    input.text === undefined
      ? { eventType: input.eventType, inputType: "keyboard" }
      : {
          eventType: input.eventType,
          inputType: "keyboard",
          text: "[user input]",
        };
  return input.key !== undefined && input.key.length === 1
    ? { ...withoutKey, key: "[user input]" }
    : withoutKey;
};

const describeTeachingInput = (input: BrowserInput): string =>
  input.type === "input_mouse"
    ? `The user sent a ${input.eventType} browser input`
    : `The user sent a ${input.eventType} keyboard input`;

const isTextEdit = (input: BrowserInput): boolean =>
  input.type === "input_keyboard" &&
  (input.eventType === "char" ||
    (input.eventType === "keyDown" &&
      (input.text !== undefined ||
        input.key === "Backspace" ||
        input.key === "Delete")));

const shouldCaptureRawInput = (input: BrowserInput): boolean =>
  (input.type === "input_keyboard" && input.eventType !== "keyUp") ||
  (input.type === "input_mouse" && input.eventType === "mouseWheel");

/** Keep public Teaching records free of credentials and sensitive URL values. */
const sanitizeTeachingAction = <A extends AgentBrowserAction>(action: A): A =>
  action.type === "navigate"
    ? ({ ...action, url: sanitizeTeachingUrl(action.url) } satisfies A)
    : action;

const sanitizeSensitiveAction = (
  action: AgentBrowserAction,
  sensitive: boolean
): AgentBrowserAction => {
  if (!sensitive) {
    return sanitizeTeachingAction(action);
  }
  switch (action.type) {
    case "fill": {
      return { ...action, text: "[sensitive input]" };
    }
    case "select": {
      return { ...action, values: ["[sensitive input]"] };
    }
    case "press": {
      return { ...action, key: "[sensitive input]" };
    }
    default: {
      return action;
    }
  }
};

const sanitizeActionFailure = (
  failure: AgentSessionError,
  action: AgentBrowserAction,
  sensitive: boolean
): AgentSessionError => {
  if (failure._tag !== "BrowserRpcError") {
    return failure;
  }
  if (sensitive) {
    return makeBrowserRpcError(
      failure.code,
      "The browser action failed for a sensitive control."
    );
  }
  return action.type === "navigate" && failure.code === "agent_browser_failed"
    ? makeBrowserRpcError(
        failure.code,
        `Could not navigate to ${sanitizeTeachingUrl(action.url)}.`
      )
    : failure;
};

const sanitizeFailureDetail = (
  action: AgentBrowserAction,
  sensitive: boolean,
  detail: string | undefined
): string | undefined => {
  if (sensitive) {
    return "The browser action failed for a sensitive control.";
  }
  if (action.type === "navigate") {
    return `Could not navigate to ${sanitizeTeachingUrl(action.url)}.`;
  }
  return detail;
};

/** How many attempts one Agent Session keeps in its action timeline. */

// ---------------------------------------------------------------------------
// Interactive Run bookkeeping
// ---------------------------------------------------------------------------

/**
 * Assessment tallies. They are recomputed from the Agent Steps rather than
 * incremented alongside them, so a count can never drift from the Steps it
 * claims to summarize.
 */
const assessmentCountsOf = (
  steps: readonly AgentRunStep[]
): AgentRunAssessmentCounts => {
  const counts = { blocked: 0, inconclusive: 0, notWorking: 0, working: 0 };
  for (const step of steps) {
    switch (step.assessment?.outcome) {
      case "working": {
        counts.working += 1;
        break;
      }
      case "not-working": {
        counts.notWorking += 1;
        break;
      }
      case "inconclusive": {
        counts.inconclusive += 1;
        break;
      }
      case "blocked": {
        counts.blocked += 1;
        break;
      }
      default: {
        break;
      }
    }
  }
  return counts;
};

/**
 * How much of the journey the Run actually reached. An executed Step is one
 * the Runner ran to a terminal execution outcome, whatever the agent concluded
 * about it: coverage answers "was this checked", not "did it work". A
 * `timed-out` Step counts as executed — the Run spent its budget there — but
 * it was interrupted mid-check and produced no assessment, so coverage is
 * complete only when every Step was assessed.
 */
export const coverageOf = (
  steps: readonly AgentRunStep[]
): AgentRunCoverage => {
  const executed = steps.filter(
    (step) => step.execution === "assessed" || step.execution === "timed-out"
  ).length;
  return {
    complete: steps.every((step) => step.execution === "assessed"),
    executed,
    total: steps.length,
    unexecuted: steps.length - executed,
  };
};

/** Every Agent Step the Run never reached is recorded as never reached. */
const markRemainingUnexecuted = (
  steps: readonly AgentRunStep[]
): readonly AgentRunStep[] =>
  steps.map((step) =>
    step.execution === "pending" || step.execution === "active"
      ? { ...step, execution: "unexecuted" as const }
      : step
  );

/** Recompute the derived tallies after any change to the ordered Steps. */
const withDerivedRunTotals = (run: AgentRunState): AgentRunState => ({
  ...run,
  assessmentCounts: assessmentCountsOf(run.steps),
  coverage: coverageOf(run.steps),
});

/**
 * Record what the Runner produced during the active Agent Step, so an
 * assessment can be checked against real evidence.
 */
const noteRunEvidence = (
  record: SessionRecord,
  kind: "attempt" | "snapshot",
  id: string
): void => {
  if (record.snapshot.run === null) {
    return;
  }
  if (kind === "attempt") {
    record.runEvidence.attempts.add(id);
  } else {
    record.runEvidence.snapshots.add(id);
  }
};

/** How a Run that reached its last ordered Agent Step is recorded. */
const endedRunOutcome = (advanced: boolean): "completed" | "ended-early" =>
  advanced ? "completed" : "ended-early";

const runIsOver = (snapshot: AgentSessionSnapshot): boolean =>
  snapshot.run !== null && snapshot.run.outcome !== null;

const deadlineFrom = (from: Date, ms: number): string =>
  new Date(from.getTime() + ms).toISOString();

/**
 * How often the Runner re-reads the clock against a Run's ceilings. It is
 * short enough that a breach interrupts the browser promptly and long enough
 * that an idle Run costs nothing measurable.
 */
const CEILING_POLL_INTERVAL = "250 millis";

const TIMELINE_LIMIT = 200;

/**
 * The action the agent has dispatched to the browser right now, if any. A user
 * Takeover interrupts this fiber and reports the attempt as dispatched: the
 * browser may already have performed it, and Contingency cannot undo it.
 */
interface InFlightAction {
  readonly action: AgentBrowserAction;
  readonly description: string;
  readonly operationId: string;
  readonly fiber: Fiber.Fiber<AgentActionResult, AgentSessionError>;
  readonly id: string;
  /** The Page state when the action was dispatched, for the Demonstration. */
  readonly snapshotBefore: AgentSnapshotId | null;
  readonly urlBefore: string;
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

/**
 * What the Runner recorded during the currently active Agent Step. An
 * assessment may only cite these ids, so the agent cannot ground a conclusion
 * in evidence Contingency never produced. Reset at every Step boundary.
 */
interface RunStepEvidence {
  readonly attempts: Set<string>;
  readonly snapshots: Set<string>;
}

interface BoundaryControl {
  readonly hosts: Set<string>;
  readonly grants: Set<string>;
  readonly evidence: AgentTimelineEntry[];
  pending:
    | {
        readonly boundary: AgentExecutionBoundary;
        readonly fingerprint: string;
      }
    | undefined;
}

interface SessionRecord {
  readonly boundaryControl: BoundaryControl | undefined;
  /** Private Create Browser handle. Never included in protocol snapshots. */
  readonly browserSessionId: SessionId;
  /** The Demonstration recorder; only a Teaching session has one. */
  readonly capture: DemonstrationCapture | undefined;
  readonly control: ActionControl;
  readonly emulation: DraftEmulation;
  /** A local Teaching Trace, finalized by the session scope. */
  readonly traceFile: string | undefined;
  /** The sensitive local video Playwright finalizes when the session closes. */
  readonly videoFile: string | undefined;
  /** The Browser Snapshot references this session has minted. */
  readonly registry: AgentElementRegistry;
  /** The Run directory this session's Trace and video were written into. */
  readonly artifactDirectory: string | undefined;
  readonly runEvidence: RunStepEvidence;
  readonly scope: Scope.Closeable;
  readonly snapshot: AgentSessionSnapshot;
  /**
   * Runtime Variable values the user supplied to this Verification Run. They
   * live for the session and are never published, persisted, or returned.
   */
  readonly supplied: Map<string, string>;
  /** The local sensitive-artifact retention manifest. */
  readonly retentionFile: string | undefined;
}

/**
 * The URL a Verification Run should open, given where the authorizing Agent
 * View stands. Only an `http`/`https` document carries across, and only in the
 * sanitized form the rest of Contingency records; `about:blank` and anything
 * unparsable fall back to the blank opening page. No cookies or storage travel
 * with it: the Run still runs in its own fresh browser context.
 */
export const verificationStartingUrl = (currentUrl: string): string | null => {
  try {
    const parsed = new URL(currentUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return sanitizeTeachingUrl(currentUrl);
  } catch {
    return null;
  }
};

const domainAllowed = (record: SessionRecord, url: string): boolean => {
  if (record.boundaryControl === undefined) {
    return true;
  }
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      [...record.boundaryControl.hosts].some((host) =>
        domainScopeCovers(host.toLowerCase(), parsed.hostname.toLowerCase())
      )
    );
  } catch {
    return false;
  }
};

const actionBoundaryReasons = (
  record: SessionRecord,
  action: AgentBrowserAction,
  intent: AgentActionIntent
): AgentExecutionBoundary["reason"][] => {
  const step = record.snapshot.run?.steps.find(
    (candidate) => candidate.index === record.snapshot.run?.activeStepIndex
  );
  const { objective } = intent;
  const knownObjective =
    objective === undefined ||
    (step === undefined
      ? record.snapshot.verification?.steps.some(
          (candidate) =>
            candidate.description === objective || candidate.name === objective
        )
      : objective === step.description || objective === step.name);
  const mutating = !["navigate", "hover", "scroll", "wait_for_text"].includes(
    action.type
  );
  // An explicit approved verification objective scopes the marker to that Step.
  // Without one, retain the conservative guard so omission cannot bypass it.
  const verificationConfirmation =
    objective === undefined
      ? record.snapshot.verification?.steps.some(
          (candidate) => candidate.confirmation
        )
      : record.snapshot.verification?.steps.some(
          (candidate) =>
            candidate.confirmation &&
            (candidate.description === objective ||
              candidate.name === objective)
        );
  const needsConfirmation =
    intent.irreversible === true ||
    (mutating &&
      (step?.confirmation === true || (verificationConfirmation ?? false)));
  // Domain Scope already decides where the session may travel, and a navigate
  // mutates nothing, so an in-scope destination is never an unknown objective
  // however the agent phrased it (ADR 0027).
  const inScopeNavigate =
    action.type === "navigate" && domainAllowed(record, action.url);
  const reasons: AgentExecutionBoundary["reason"][] = [];
  if (action.type === "navigate" && !inScopeNavigate) {
    reasons.push("domain");
  }
  if (!(knownObjective || inScopeNavigate)) {
    reasons.push("objective");
  }
  if (needsConfirmation) {
    reasons.push("confirmation");
  }

  return reasons;
};

/**
 * What the user is being asked to confirm. The agent's own objective when it
 * named one, and the active Agent Step when it did not: during an Interactive
 * Run the ordered Step really is what the action contributes to.
 *
 * A Verification Run has no active Step, so there is nothing truthful to fall
 * back to. Naming a Confirmation Step here would put an unrelated Step's words
 * on an action that is not it — the user reads `requested` to decide, so an
 * unnamed action says so rather than borrowing a description.
 */
const boundaryObjective = (
  record: SessionRecord,
  intent: AgentActionIntent
): string =>
  intent.objective ??
  record.snapshot.run?.steps.find(
    (step) => step.index === record.snapshot.run?.activeStepIndex
  )?.description ??
  "An action the agent did not name an objective for";

interface TeachingArtifacts {
  readonly retentionFile: string | undefined;
  readonly traceFile: string | undefined;
  readonly videoFile: string | undefined;
}

type AgentOperationKind =
  | "act"
  | "boundary"
  | "assess"
  | "ceiling"
  | "close"
  | "complete"
  | "control"
  | "instruction"
  | "private-input"
  | "start"
  | "takeover"
  | "variable-supply";

/** What a replayed operation answers with, discriminated so no cast is needed. */
type AgentOperationResult =
  | { readonly kind: "act"; readonly result: AgentActionResult }
  /**
   * A dispatched action whose outcome Contingency does not know. The browser
   * may already have performed it, so the id answers with the same refusal
   * rather than performing it a second time.
   */
  | { readonly error: AgentSessionError; readonly kind: "act-failure" }
  | { readonly kind: "run-summary"; readonly result: AgentRunSummary }
  | { readonly kind: "session"; readonly result: AgentSessionSnapshot };

interface ReplayRecord {
  readonly input: string;
  readonly kind: AgentOperationKind;
  readonly result: AgentOperationResult;
  readonly target: string;
}

const CatalogTeachingRetention = Schema.Struct({
  retention: Schema.Literals(["delete-on-approval", "retain-for-days"]),
});

const catalogTeachingRetention = (
  contents: string
): "delete-on-approval" | "retain-for-days" | null => {
  const decoded = Result.try(() =>
    Schema.decodeUnknownSync(CatalogTeachingRetention)(JSON.parse(contents))
  );
  return Result.isSuccess(decoded) ? decoded.success.retention : null;
};

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

    /** A session that carries a Demonstration: a Teaching session, live or not. */
    const requireTeaching = (
      sessionId: AgentSessionId
    ): Effect.Effect<
      {
        readonly capture: DemonstrationCapture;
        readonly record: SessionRecord;
      },
      AgentSessionError
    > =>
      read(sessionId).pipe(
        Effect.flatMap((record) =>
          record.capture === undefined
            ? Effect.fail(
                error(
                  "agent_session_invalid",
                  `Agent Session ${sessionId} is an Interactive Run and has no Demonstration. Start a session with activity "teaching" to teach a journey.`
                )
              )
            : Effect.succeed({ capture: record.capture, record })
        )
      );

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
          mutate(sessionId, (snapshot) => {
            const safeCurrentUrl = sanitizeTeachingUrl(currentUrl);
            if (snapshot.currentUrl === safeCurrentUrl) {
              return snapshot;
            }
            const at = now().toISOString();
            // A URL the user drove to during Takeover is part of the
            // Demonstration even though no action path recorded it.
            record.capture?.recordUrl(currentUrl, at);
            return { ...snapshot, currentUrl: safeCurrentUrl, updatedAt: at };
          })
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

    const rememberRunSummary = (
      operationId: OperationId | string | undefined,
      target: string,
      input: string,
      summary: AgentRunSummary
    ): Effect.Effect<void> =>
      remember(operationId, "complete", target, input, {
        kind: "run-summary",
        result: summary,
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

    /**
     * Completing a Run is a mutation like any other: a transport retry answers
     * with the Run Summary the first call produced rather than finalizing a
     * second time over an already-closed browser.
     */
    const replayRunSummary = (
      operationId: OperationId | string | undefined,
      target: string,
      input: string
    ):
      | { readonly _tag: "conflict"; readonly error: AgentSessionDomainError }
      | { readonly _tag: "replay"; readonly summary: AgentRunSummary }
      | undefined => {
      const replayed = replay(operationId, "complete", target, input);
      if (replayed === undefined || replayed._tag === "conflict") {
        return replayed;
      }
      return replayed.result.kind === "run-summary"
        ? { _tag: "replay", summary: replayed.result.result }
        : {
            _tag: "conflict",
            error: error(
              "agent_session_conflict",
              `Operation ${String(operationId)} was already used for a session mutation.`
            ),
          };
    };

    /**
     * Where a finished artifact sits inside the Run's own directory. The Run
     * Summary stores the relative name so the package can be moved or read
     * from another process without rewriting absolute paths.
     */
    const finalArtifactPath = (
      record: SessionRecord,
      file: string | undefined
    ): Effect.Effect<string | null> => {
      if (file === undefined || record.artifactDirectory === undefined) {
        return Effect.succeed(null);
      }
      const relative = path.relative(record.artifactDirectory, file);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        return Effect.succeed(null);
      }
      return fileSystem === undefined
        ? Effect.succeed(relative)
        : fileSystem.exists(file).pipe(
            Effect.map((exists) => (exists ? relative : null)),
            Effect.orElseSucceed(() => null)
          );
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
              boundary: null,
              controller: "agent",
              phase: "closed",
              // A Run whose session is closed before it was completed did not
              // end on a judgment. Its remaining Agent Steps are unexecuted.
              run:
                record.snapshot.run === null ||
                record.snapshot.run.outcome !== null
                  ? record.snapshot.run
                  : withDerivedRunTotals({
                      ...record.snapshot.run,
                      activeStepIndex: null,
                      endedAt: at,
                      outcome: "interrupted",
                      stepDeadline: null,
                      steps: markRemainingUnexecuted(record.snapshot.run.steps),
                    }),
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

    /**
     * Where this session captures. A Run names its own Run directory, so its
     * Trace and video land beside the Run Summary that cites them; Teaching
     * uses the configured Teaching directory; a bare session captures nothing.
     */
    const prepareArtifactDirectory = (
      activity: AgentSessionActivity,
      requested: string | undefined
    ): Effect.Effect<string | undefined, AgentSessionError> =>
      Effect.gen(function* prepareLocalArtifactDirectory() {
        if (requested === undefined && activity !== "teaching") {
          return;
        }
        const directory = requested ?? options.traceDirectory?.();
        if (directory !== undefined && fileSystem !== undefined) {
          yield* fileSystem
            .makeDirectory(directory, { recursive: true })
            .pipe(
              Effect.mapError((cause) =>
                error(
                  "agent_session_invalid",
                  `Could not create the artifact directory: ${cause.message}`
                )
              )
            );
        }
        return directory;
      });

    const writeTeachingRetentionManifest = (
      directory: string,
      sessionId: AgentSessionId,
      traceFile: string,
      videoFiles: readonly string[]
    ): Effect.Effect<string | undefined, AgentSessionError> =>
      Effect.gen(function* writeSensitiveArtifactMetadata() {
        if (fileSystem === undefined) {
          return;
        }
        const retentionFile = path.join(
          directory,
          `${sessionId}.artifacts.json`
        );
        const existing = yield* Effect.result(
          fileSystem.readFileString(retentionFile)
        );
        const catalogRetention = Result.isSuccess(existing)
          ? catalogTeachingRetention(existing.success)
          : null;
        if (catalogRetention === "delete-on-approval") {
          yield* Effect.forEach(
            [traceFile, ...videoFiles],
            (file) => fileSystem.remove(file, { force: true }),
            { discard: true }
          ).pipe(
            Effect.mapError((cause) =>
              error(
                "agent_session_invalid",
                `Could not remove an approved Teaching artifact: ${cause.message}`
              )
            )
          );
          return retentionFile;
        }
        if (catalogRetention === "retain-for-days") {
          return retentionFile;
        }
        yield* fileSystem
          .writeFileString(
            retentionFile,
            `${JSON.stringify(
              {
                files: {
                  trace: path.basename(traceFile),
                  videos: videoFiles
                    .map((file) => path.basename(file))
                    .toSorted(),
                },
                retention: "local",
                sensitive: true,
              },
              null,
              2
            )}\n`
          )
          .pipe(
            Effect.mapError((cause) =>
              error(
                "agent_session_invalid",
                `Could not write Teaching artifact retention metadata: ${cause.message}`
              )
            )
          );
        return retentionFile;
      });

    const startTeachingArtifacts = (
      directory: string | undefined,
      browserSessionId: SessionId,
      sessionId: AgentSessionId,
      sessionScope: Scope.Closeable,
      videoPaths: Set<Promise<string>>,
      retention: boolean
    ): Effect.Effect<TeachingArtifacts, AgentSessionError> =>
      Effect.gen(function* startLocalTeachingArtifacts() {
        if (directory === undefined) {
          return {
            retentionFile: undefined,
            traceFile: undefined,
            videoFile: undefined,
          };
        }
        const traceFile = path.join(directory, `${sessionId}.trace.zip`);
        const target = yield* browser.recorderTarget(browserSessionId);
        const rememberVideo = (page: Page): void => {
          const video = page.video();
          if (video !== null) {
            videoPaths.add(video.path());
          }
        };
        rememberVideo(target.page);
        target.context.on("page", rememberVideo);
        yield* Scope.provide(sessionScope)(
          Effect.acquireRelease(
            Effect.tryPromise({
              catch: (cause) =>
                error(
                  "agent_session_invalid",
                  `Could not start the Teaching Trace: ${cause instanceof Error ? cause.message : String(cause)}`
                ),
              try: () =>
                target.context.tracing.start({
                  screenshots: true,
                  snapshots: true,
                }),
            }),
            () =>
              Effect.tryPromise({
                catch: () => null,
                try: () => target.context.tracing.stop({ path: traceFile }),
              }).pipe(Effect.ignore)
          )
        );
        const videoFile = yield* teachingVideoFile(target.page);
        // A Run's artifacts are governed by its own Run directory, not by the
        // Teaching retention policy, so no retention manifest is written for it.
        const retentionFile = retention
          ? yield* writeTeachingRetentionManifest(
              directory,
              sessionId,
              traceFile,
              videoFile === undefined ? [] : [videoFile]
            )
          : undefined;
        return { retentionFile, traceFile, videoFile };
      });

    const notVerifying = (sessionId: AgentSessionId) =>
      error(
        "agent_session_invalid",
        `Agent Session ${sessionId} is not running an Agent Flow revision, so it declares no Variables.`
      );

    /**
     * The Variable a Verification Run declares under this name. A Run may only
     * be asked for the Variables its draft revision declares, so a name the
     * draft never mentioned is refused rather than invented.
     */
    const requireDeclaredVariable = (
      record: SessionRecord,
      name: string
    ):
      | { readonly _tag: "error"; readonly error: AgentSessionError }
      | { readonly _tag: "ok"; readonly variable: Variable } => {
      // A Verification Run and an Interactive Run declare their Variables the
      // same way, because they run the same revision under the same rule: the
      // literal is supplied again and never travels.
      const declaring = record.snapshot.verification ?? record.snapshot.run;
      if (declaring === null) {
        return { _tag: "error", error: notVerifying(record.snapshot.id) };
      }
      const declared = declaring.variables.find(
        (variable) => variable.name === name
      );
      return declared === undefined
        ? {
            _tag: "error",
            error: error(
              "agent_session_invalid",
              `Agent Flow revision ${declaring.revisionId} does not declare Variable ${name}.`
            ),
          }
        : {
            _tag: "ok",
            variable: {
              name: declared.name,
              runtime: declared.runtime,
              secret: declared.secret,
            },
          };
    };

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
        const record = Ref.getUnsafe(sessions).get(sessionId);
        // The entry joins the timeline as it stands now: an action that ran
        // while control changed hands records what it did without undoing the
        // change it raced.
        const safePatch =
          patch.currentUrl === undefined
            ? patch
            : {
                ...patch,
                currentUrl: sanitizeTeachingUrl(patch.currentUrl),
              };
        if (record !== undefined && entry.dispatched) {
          noteRunEvidence(record, "attempt", entry.id);
        }
        record?.boundaryControl?.evidence.push(entry);
        if (
          record?.boundaryControl !== undefined &&
          record.artifactDirectory !== undefined &&
          fileSystem !== undefined
        ) {
          yield* fileSystem
            .writeFileString(
              path.join(
                record.artifactDirectory,
                `${sessionId}.timeline.jsonl`
              ),
              `${JSON.stringify(entry)}\n`,
              { flag: "a", mode: 0o600 }
            )
            .pipe(
              Effect.mapError((cause) =>
                error(
                  "agent_session_invalid",
                  `Could not persist Run action evidence: ${cause.message}`
                )
              )
            );
        }
        const next = yield* mutate(sessionId, (snapshot) => ({
          ...snapshot,
          ...safePatch,
          // An attempt inside an Agent Step is what the assessment's `attempts`
          // count reports, so it is counted where the attempt is recorded.
          run:
            snapshot.run === null ||
            snapshot.run.activeStepIndex === null ||
            !entry.dispatched
              ? snapshot.run
              : {
                  ...snapshot.run,
                  steps: snapshot.run.steps.map((step) =>
                    step.index === snapshot.run?.activeStepIndex
                      ? { ...step, attempts: step.attempts + 1 }
                      : step
                  ),
                },
          teaching: teachingOf(record, snapshot),
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

    const pauseBoundary = (
      sessionId: AgentSessionId,
      record: SessionRecord,
      boundary: AgentExecutionBoundary,
      fingerprint: string
    ) =>
      Effect.gen(function* pauseAtExecutionBoundary() {
        const control = record.boundaryControl;
        if (control === undefined || control.pending !== undefined) {
          return;
        }
        control.pending = { boundary, fingerprint };
        yield* recordEntry(
          sessionId,
          {
            actor: "agent",
            at: now().toISOString(),
            description: boundary.description,
            detail: `${boundary.reason}: ${boundary.requested}`,
            dispatched: false,
            id: boundary.id,
            outcome: "refused",
          },
          { boundary }
        );
      });

    const pauseNavigation = (
      sessionId: AgentSessionId,
      record: SessionRecord,
      url: string
    ) =>
      pauseBoundary(
        sessionId,
        record,
        {
          action: { type: "navigate", url: sanitizeTeachingUrl(url) },
          description: "Navigation outside the approved Domain Scope",
          id: randomUUID(),
          operationId:
            record.control.inFlight?.operationId ?? "browser-navigation",
          reason: "domain",
          requested: sanitizeTeachingUrl(url),
        },
        "navigation"
      );

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

    const snapshotAfter = (
      record: SessionRecord,
      page: Page,
      urlBefore: string
    ): Effect.Effect<AgentBrowserSnapshot, AgentSessionError> =>
      snapshotAfterAction(page, record.registry, urlBefore).pipe(
        Effect.map((snapshot) => redactCapturedSnapshot(record, snapshot)),
        Effect.tap((snapshot) =>
          Effect.sync(() =>
            noteRunEvidence(record, "snapshot", snapshot.snapshotId)
          )
        )
      );

    const boundaryResult = (
      record: SessionRecord,
      page: Page,
      boundary: AgentExecutionBoundary,
      urlBefore: string
    ) =>
      Effect.gen(function* readBoundaryResult() {
        const snapshot = yield* snapshotAfter(record, page, urlBefore);
        return {
          entry: {
            actor: "agent" as const,
            at: now().toISOString(),
            description: boundary.description,
            detail: `${boundary.reason}: ${boundary.requested}`,
            dispatched: false,
            id: boundary.id,
            outcome: "refused" as const,
          },
          intervention: boundary,
          snapshot,
          url: snapshot.url,
        };
      });

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
                const activity = input.activity ?? "run";
                // One Emulation for the session: the browser is created at the
                // viewport it will navigate under, so the first document is
                // laid out for the device rather than resized into it.
                const emulation = sessionEmulation(input);
                const artifactDirectory = yield* prepareArtifactDirectory(
                  activity,
                  input.artifactDirectory
                );
                const videoPaths = new Set<Promise<string>>();
                if (
                  artifactDirectory !== undefined &&
                  activity === "teaching"
                ) {
                  const traceFile = path.join(
                    artifactDirectory,
                    `${sessionId}.trace.zip`
                  );
                  // Registered before browser acquisition so it runs after
                  // context close has finalized every owned Page video.
                  yield* Scope.addFinalizer(
                    sessionScope,
                    Effect.gen(function* catalogueOwnedTeachingVideos() {
                      const settled = yield* Effect.promise(() =>
                        Promise.allSettled(videoPaths)
                      );
                      const owned = settled.flatMap((result) =>
                        result.status === "fulfilled" ? [result.value] : []
                      );
                      yield* writeTeachingRetentionManifest(
                        artifactDirectory,
                        sessionId,
                        traceFile,
                        owned
                      );
                    }).pipe(Effect.ignore)
                  );
                }
                const acquired = yield* Scope.provide(sessionScope)(
                  Effect.acquireRelease(
                    browser.create(
                      browserName,
                      emulation.viewport,
                      artifactDirectory,
                      input.domainScope !== undefined
                    ),
                    (browserSessionId) =>
                      browser.close(browserSessionId).pipe(Effect.ignore)
                  )
                );
                const { retentionFile, traceFile, videoFile } =
                  yield* startTeachingArtifacts(
                    artifactDirectory,
                    acquired,
                    sessionId,
                    sessionScope,
                    videoPaths,
                    activity === "teaching"
                  );
                const at = now().toISOString();
                const base: AgentSessionSnapshot = {
                  activity,
                  boundary: null,
                  clientName: input.clientName?.trim() || "unknown",
                  clientVersion: input.clientVersion?.trim() || "unknown",
                  controller: "agent",
                  createdAt: at,
                  currentUrl: "about:blank",
                  id: sessionId,
                  interruptedAction: null,
                  ownerProcessId: owner,
                  phase: "starting",
                  run: input.run ?? null,
                  takeover: null,
                  teaching:
                    activity === "teaching"
                      ? { actionCount: 0, draft: null, instructionCount: 0 }
                      : null,
                  timeline: [],
                  updatedAt: at,
                  verification: input.verification ?? null,
                  viewUrl: viewUrl(options.baseUrl, sessionId),
                };
                const registry = makeAgentElementRegistry(now);
                yield* Scope.addFinalizer(sessionScope, registry.clear());
                const record: SessionRecord = {
                  artifactDirectory,
                  boundaryControl:
                    input.domainScope === undefined
                      ? undefined
                      : {
                          evidence: [],
                          grants: new Set(),
                          hosts: new Set(input.domainScope.hosts),
                          pending: undefined,
                        },
                  browserSessionId: acquired,
                  capture:
                    activity === "teaching"
                      ? makeDemonstrationCapture(base.currentUrl)
                      : undefined,
                  control: {
                    inFlight: undefined,
                    lock: Semaphore.makeUnsafe(1),
                  },
                  emulation,
                  registry,
                  retentionFile,
                  runEvidence: { attempts: new Set(), snapshots: new Set() },
                  scope: sessionScope,
                  snapshot: base,
                  supplied: new Map<string, string>(),
                  traceFile,
                  videoFile,
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
                  if (record.boundaryControl !== undefined) {
                    const target = yield* browser.recorderTarget(acquired);
                    yield* installAgentNavigationBoundary(
                      target.context,
                      target.page,
                      {
                        allows: (url) => domainAllowed(record, url),
                        refuse: (url) =>
                          pauseNavigation(sessionId, record, url),
                      }
                    );
                  }
                  yield* browser.open(
                    acquired,
                    input.url ?? "about:blank",
                    emulation
                  );
                  const currentUrl = sanitizeTeachingUrl(
                    yield* browser.currentUrl(acquired)
                  );
                  const startedNow = now();
                  const startedAt = startedNow.toISOString();
                  // The opening navigation is the Demonstration's first URL
                  // transition: the journey starts somewhere.
                  record.capture?.recordUrl(currentUrl, startedAt);
                  // Both ceilings start when the browser is actually ready, not
                  // when the request arrived: browser acquisition must not eat
                  // the budget the user granted the agent's work.
                  const run =
                    base.run === null
                      ? null
                      : withDerivedRunTotals({
                          ...base.run,
                          activeStepIndex: 0,
                          runDeadline: deadlineFrom(
                            startedNow,
                            base.run.ceilings.runMs
                          ),
                          startedAt,
                          stepDeadline: deadlineFrom(
                            startedNow,
                            base.run.ceilings.stepMs
                          ),
                          steps: base.run.steps.map((step, index) =>
                            index === 0
                              ? {
                                  ...step,
                                  execution: "active" as const,
                                  startedAt,
                                }
                              : step
                          ),
                        });
                  const running: AgentSessionSnapshot = {
                    ...base,
                    currentUrl,
                    phase: "running",
                    run,
                    updatedAt: startedAt,
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

    const observeFocusedTextControl = (record: SessionRecord, page: Page) =>
      Effect.gen(function* observeFocusedControl() {
        const snapshot = redactCapturedSnapshot(
          record,
          yield* record.registry.snapshot(page)
        );
        record.capture?.recordSnapshot(snapshot);
        const ref = yield* record.registry.focusedRef();
        const node = snapshot.nodes.find((candidate) => candidate.ref === ref);
        if (node === undefined) {
          return yield* Effect.fail(
            makeBrowserRpcError(
              "agent_element_stale",
              "The focused control was not in the Browser Snapshot."
            )
          );
        }
        return {
          description: `${node.role}:${node.name}`,
          key: yield* record.registry.privateSelector(ref),
          ref,
          sensitive: yield* record.registry.isSensitive(ref),
          snapshot,
        };
      });

    const observePointedControl = (
      record: SessionRecord,
      page: Page,
      x: number,
      y: number
    ) =>
      Effect.gen(function* observeUserClickTarget() {
        const snapshot = redactCapturedSnapshot(
          record,
          yield* record.registry.snapshot(page)
        );
        record.capture?.recordSnapshot(snapshot);
        return {
          ref: yield* record.registry.pointRef(x, y),
          snapshot,
        };
      });

    const semanticUserEdit = (
      record: SessionRecord,
      page: Page,
      urlBefore: string,
      focused: {
        readonly description: string;
        readonly key: string;
        readonly ref: AgentElementRef;
        readonly sensitive: boolean;
      }
    ) =>
      Effect.gen(function* captureSemanticUserEdit() {
        if (focused.sensitive || record.capture === undefined) {
          return;
        }
        const observed = yield* snapshotAfter(record, page, urlBefore);
        record.capture.recordSnapshot(observed);
        const focusedAfter = yield* Effect.result(record.registry.focusedRef());
        const value = Result.isSuccess(focusedAfter)
          ? observed.nodes.find(
              (candidate) => candidate.ref === focusedAfter.success
            )?.value
          : undefined;
        return value === undefined
          ? undefined
          : {
              action: { ref: focused.ref, text: value, type: "fill" as const },
              description: `Fill ${focused.description}`,
              observed,
            };
      });

    const semanticUserClick = (
      record: SessionRecord,
      page: Page,
      urlBefore: string
    ) =>
      snapshotAfter(record, page, urlBefore).pipe(
        Effect.tap((snapshot) =>
          Effect.sync(() => record.capture?.recordSnapshot(snapshot))
        )
      );

    const observeUserInputTarget = (
      record: SessionRecord,
      page: Page,
      input: BrowserInput
    ) =>
      Effect.gen(function* observeSemanticInputTarget() {
        const focusedResult =
          record.capture === undefined || !isTextEdit(input)
            ? undefined
            : yield* Effect.result(observeFocusedTextControl(record, page));
        const pointedResult =
          record.capture === undefined ||
          input.type !== "input_mouse" ||
          input.eventType !== "mouseReleased"
            ? undefined
            : yield* Effect.result(
                observePointedControl(record, page, input.x, input.y)
              );
        const focused =
          focusedResult !== undefined && Result.isSuccess(focusedResult)
            ? focusedResult.success
            : undefined;
        const pointed =
          pointedResult !== undefined && Result.isSuccess(pointedResult)
            ? pointedResult.success
            : undefined;
        return {
          focused,
          pointed,
          snapshotBefore:
            focused?.snapshot.snapshotId ??
            pointed?.snapshot.snapshotId ??
            record.capture?.latestSnapshotId() ??
            null,
        };
      });

    const completeSemanticUserClick = (input: {
      readonly at: string;
      readonly id: string;
      readonly page: Page;
      readonly pointed:
        | {
            readonly ref: AgentElementRef;
            readonly snapshot: AgentBrowserSnapshot;
          }
        | undefined;
      readonly record: SessionRecord;
      readonly sessionId: AgentSessionId;
      readonly snapshotBefore: AgentSnapshotId | null;
      readonly urlAfter: string;
      readonly urlBefore: string;
    }): Effect.Effect<boolean, AgentSessionError> =>
      Effect.gen(function* recordSemanticUserClick() {
        if (input.pointed === undefined || input.record.capture === undefined) {
          return false;
        }
        const observed = yield* semanticUserClick(
          input.record,
          input.page,
          input.urlBefore
        );
        const description = `Click ${input.pointed.ref}`;
        input.record.capture.recordAction({
          action: { ref: input.pointed.ref, type: "click" },
          actor: "user",
          at: input.at,
          description,
          id: input.id,
          outcome: "completed",
          snapshotAfter: observed,
          snapshotBefore: input.snapshotBefore,
          urlAfter: input.urlAfter,
          urlBefore: input.urlBefore,
        });
        yield* recordEntry(
          input.sessionId,
          {
            actor: "user",
            at: input.at,
            description,
            dispatched: true,
            id: input.id,
            outcome: "completed",
          },
          { currentUrl: input.urlAfter }
        );
        return true;
      });

    const completeSemanticUserEdit = (input: {
      readonly at: string;
      readonly focused:
        | {
            readonly description: string;
            readonly key: string;
            readonly ref: AgentElementRef;
            readonly sensitive: boolean;
          }
        | undefined;
      readonly id: string;
      readonly page: Page;
      readonly record: SessionRecord;
      readonly sessionId: AgentSessionId;
      readonly snapshotBefore: AgentSnapshotId | null;
      readonly urlAfter: string;
      readonly urlBefore: string;
    }): Effect.Effect<boolean, AgentSessionError> =>
      Effect.gen(function* recordSemanticUserEdit() {
        if (input.focused === undefined) {
          return false;
        }
        const semantic = yield* semanticUserEdit(
          input.record,
          input.page,
          input.urlBefore,
          input.focused
        );
        if (semantic === undefined || input.record.capture === undefined) {
          return false;
        }
        input.record.capture.recordAction({
          action: semantic.action,
          actor: "user",
          at: input.at,
          coalesceKey: input.focused.key,
          description: semantic.description,
          id: input.id,
          outcome: "completed",
          snapshotAfter: semantic.observed,
          snapshotBefore: input.snapshotBefore,
          urlAfter: input.urlAfter,
          urlBefore: input.urlBefore,
        });
        yield* recordEntry(
          input.sessionId,
          {
            actor: "user",
            at: input.at,
            description: semantic.description,
            dispatched: true,
            id: input.id,
            outcome: "completed",
          },
          { currentUrl: input.urlAfter }
        );
        return true;
      });

    const checkActionBoundary = (
      sessionId: AgentSessionId,
      record: SessionRecord,
      page: Page,
      action: AgentBrowserAction,
      capturedAction: AgentBrowserAction,
      description: string,
      attemptId: string,
      intent: AgentActionIntent
    ) =>
      Effect.gen(function* checkBoundary() {
        const urlBefore = page.url();
        const { boundaryControl } = record;
        if (boundaryControl === undefined) {
          return;
        }
        const { pending } = boundaryControl;
        if (pending !== undefined) {
          return yield* boundaryResult(
            record,
            page,
            pending.boundary,
            urlBefore
          );
        }
        const fingerprint = JSON.stringify({
          action,
          intent,
          operationId: attemptId,
          stepIndex: record.snapshot.run?.activeStepIndex,
        });
        const reasons = actionBoundaryReasons(record, action, intent);
        for (const reason of reasons) {
          if (boundaryControl.grants.has(reason + fingerprint)) {
            continue;
          }
          const boundary: AgentExecutionBoundary = {
            action: capturedAction,
            description,
            id: randomUUID(),
            operationId: attemptId,
            reason,
            requested:
              reason === "domain" && action.type === "navigate"
                ? sanitizeTeachingUrl(action.url)
                : boundaryObjective(record, intent),
          };
          yield* pauseBoundary(sessionId, record, boundary, fingerprint);
          return yield* boundaryResult(record, page, boundary, urlBefore);
        }
        for (const reason of reasons) {
          boundaryControl.grants.delete(reason + fingerprint);
        }
      });

    const dispatch = Effect.fn("AgentSession.dispatch")(
      function* dispatchAgentBrowserAction(
        sessionId: AgentSessionId,
        record: SessionRecord,
        page: Page,
        action: AgentBrowserAction,
        capturedAction: AgentBrowserAction,
        description: string,
        id: string,
        sensitive: boolean,
        boundaryAttempt: {
          readonly operationId: string;
          readonly intent: AgentActionIntent;
        },
        privateRegistration?: {
          readonly selector: string;
          readonly value: string;
          readonly variable: Variable;
        }
      ) {
        const current = yield* requireLiveRecord(sessionId);
        if (agentIsPaused(current.snapshot)) {
          return yield* Effect.fail(
            takenOver("This action was not dispatched.")
          );
        }
        // A waiter on the control lock can wake after a ceiling ended the Run
        // and interrupted the action ahead of it, so the Run's state is
        // re-read here, beside the Takeover re-check, not only before queuing.
        if (runIsOver(current.snapshot)) {
          return yield* Effect.fail(
            error(
              "agent_session_conflict",
              `Run ${current.snapshot.run?.runId} has ended and accepts no further browser actions.`
            )
          );
        }
        const boundary = yield* checkActionBoundary(
          sessionId,
          current,
          page,
          action,
          capturedAction,
          description,
          boundaryAttempt.operationId,
          boundaryAttempt.intent
        );
        if (boundary !== undefined) {
          return boundary;
        }
        const urlBefore = page.url();
        const snapshotBefore = record.capture?.latestSnapshotId() ?? null;
        // The action runs on a child fiber so a user Takeover can interrupt it
        // and wait for its cleanup rather than racing it.
        const fiber = yield* Effect.forkChild(
          Effect.gen(function* dispatchAgentAction() {
            yield* privateRegistration === undefined
              ? performAgentAction(page, record.registry, action)
              : performPrivateVariableInput(
                  page,
                  privateRegistration.selector,
                  privateRegistration.value
                );
            if (
              privateRegistration !== undefined &&
              record.capture !== undefined
            ) {
              record.capture.recordVariable(
                privateRegistration.variable,
                privateRegistration.value,
                privateRegistration.selector
              );
            }
            const snapshot = yield* snapshotAfter(record, page, urlBefore);
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
        record.control.inFlight = {
          action:
            privateRegistration === undefined
              ? capturedAction
              : sanitizeSensitiveAction(action, true),
          description,
          fiber,
          id,
          operationId: boundaryAttempt.operationId,
          snapshotBefore,
          urlBefore,
        };
        const exit = yield* Fiber.await(fiber);
        record.control.inFlight = undefined;
        if (Exit.isSuccess(exit)) {
          const result = exit.value;
          record.capture?.recordAction({
            action: capturedAction,
            actor: "agent",
            at: result.entry.at,
            description,
            id,
            outcome: "completed",
            snapshotAfter: result.snapshot,
            snapshotBefore,
            urlAfter: result.url,
            urlBefore,
          });
          yield* recordEntry(sessionId, result.entry, {
            currentUrl: result.url,
          });
          const pending = record.boundaryControl?.pending;
          return pending === undefined
            ? result
            : { ...result, intervention: pending.boundary };
        }
        if (Cause.hasInterrupts(exit.cause)) {
          // Takeover already recorded the dispatched attempt. The browser may
          // have performed it, so this operation id is spent: retrying it
          // answers with the same refusal instead of acting again.
          const refusal = takenOver(
            `${description} was interrupted and may already have happened.`
          );
          return yield* Effect.fail(refusal);
        }
        const cause = Cause.findErrorOption(exit.cause);
        const detail = sanitizeFailureDetail(
          action,
          sensitive,
          Option.isSome(cause) ? cause.value.message : undefined
        );
        const failedAt = now().toISOString();
        // A failed action may still have moved the Page, so the session records
        // where the browser actually is rather than where it last succeeded.
        const urlAfter = page.url();
        record.capture?.recordAction({
          action:
            privateRegistration === undefined
              ? capturedAction
              : sanitizeSensitiveAction(action, true),
          actor: "agent",
          at: failedAt,
          description,
          detail,
          id,
          outcome: "failed",
          snapshotAfter: null,
          snapshotBefore,
          urlAfter,
          urlBefore,
        });
        yield* recordEntry(
          sessionId,
          {
            actor: "agent",
            at: failedAt,
            description,
            detail,
            dispatched: true,
            id,
            outcome: "failed",
          },
          { currentUrl: urlAfter }
        );
        const pending = record.boundaryControl?.pending;
        if (pending !== undefined) {
          const result = yield* boundaryResult(
            record,
            page,
            pending.boundary,
            urlBefore
          );
          return {
            ...result,
            entry: { ...result.entry, dispatched: true, id },
          };
        }
        return yield* Effect.failCause(exit.cause);
      }
    );

    const executeAction = Effect.fn("AgentSession.act")(
      function* performAgentBrowserAction(
        sessionId: AgentSessionId,
        action: AgentBrowserAction,
        operationId?: OperationId | string,
        privateCapture?: {
          readonly action: AgentBrowserAction;
          readonly requestInput: string;
          readonly value: string;
          readonly variable: Variable;
        },
        intent: AgentActionIntent = {}
      ) {
        const operationKind =
          privateCapture === undefined ? "act" : "private-input";
        const requestInput =
          privateCapture?.requestInput ?? JSON.stringify({ action, intent });
        const replayed = replay(
          operationId,
          operationKind,
          sessionId,
          requestInput
        );
        if (replayed?._tag === "conflict") {
          return yield* Effect.fail(replayed.error);
        }
        if (replayed?._tag === "replay") {
          if (replayed.result.kind === "act") {
            return replayed.result.result;
          }
          if (replayed.result.kind === "act-failure") {
            return yield* Effect.fail(replayed.result.error);
          }
          return yield* Effect.fail(
            error(
              "agent_session_conflict",
              `Operation ${String(operationId)} was already used for a session mutation.`
            )
          );
        }
        const outcome = yield* Effect.result(
          Effect.gen(function* attemptBrowserAction() {
            const record = yield* requireLiveRecord(sessionId);
            if (agentIsPaused(record.snapshot)) {
              return yield* Effect.fail(
                takenOver("This action was not dispatched.")
              );
            }
            // A Run that hit a ceiling or ended on a terminal assessment is
            // over. Its browser is still open only so the Run can be finalized.
            if (runIsOver(record.snapshot)) {
              return yield* Effect.fail(
                error(
                  "agent_session_conflict",
                  `Run ${record.snapshot.run?.runId} has ended and accepts no further browser actions.`
                )
              );
            }
            const page = yield* browser.activePage(record.browserSessionId);
            const sensitive =
              privateCapture !== undefined ||
              ("ref" in action && action.ref !== undefined
                ? yield* record.registry.isSensitive(action.ref)
                : false);
            const capturedAction =
              privateCapture?.action ??
              sanitizeSensitiveAction(action, sensitive);
            const description = describeAgentAction(capturedAction);
            const id = `action-${randomUUID()}`;
            // Concurrent agent actions would leave a fiber Takeover cannot
            // reach, so a second waits and re-reads control when it wakes.
            return yield* record.control.lock
              .withPermit(
                Effect.gen(function* dispatchSerially() {
                  const privateRegistration =
                    privateCapture === undefined ||
                    !("ref" in action) ||
                    action.ref === undefined
                      ? undefined
                      : {
                          selector: yield* record.registry.privateSelector(
                            action.ref,
                            [...privateCapture.value].length
                          ),
                          value: privateCapture.value,
                          variable: privateCapture.variable,
                        };
                  if (
                    privateRegistration !== undefined &&
                    record.capture !== undefined &&
                    !record.capture.canRecordVariable(
                      privateRegistration.variable,
                      privateRegistration.value,
                      privateRegistration.selector
                    )
                  ) {
                    return yield* Effect.fail(
                      error(
                        "agent_session_invalid",
                        `Variable ${privateRegistration.variable.name} conflicts with the Demonstration or its private-input limit.`
                      )
                    );
                  }
                  return yield* dispatch(
                    sessionId,
                    record,
                    page,
                    action,
                    capturedAction,
                    description,
                    id,
                    sensitive,
                    { intent, operationId: String(operationId ?? id) },
                    privateRegistration
                  );
                })
              )
              .pipe(
                Effect.mapError((failure) =>
                  sanitizeActionFailure(failure, action, sensitive)
                )
              );
          })
        );
        if (Result.isSuccess(outcome)) {
          if (
            "intervention" in outcome.success &&
            !outcome.success.entry.dispatched
          ) {
            return outcome.success;
          }
          yield* remember(operationId, operationKind, sessionId, requestInput, {
            kind: "act",
            result: outcome.success,
          });
          return outcome.success;
        }
        yield* remember(operationId, operationKind, sessionId, requestInput, {
          error: outcome.failure,
          kind: "act-failure",
        });
        return yield* Effect.fail(outcome.failure);
      }
    );

    const operationLocks = new Map<
      string,
      { readonly gate: Semaphore.Semaphore; readonly input: string }
    >();
    const actUnlocked = (...args: Parameters<typeof executeAction>) => {
      const [sessionId, action, operationId, privateCapture, intent] = args;
      if (operationId === undefined) {
        return executeAction(...args);
      }
      const key = String(operationId);
      const input = JSON.stringify({
        request:
          privateCapture?.requestInput ??
          JSON.stringify({ action, intent: intent ?? {} }),
        sessionId,
      });
      let entry = operationLocks.get(key);
      if (entry !== undefined && entry.input !== input) {
        return Effect.fail(
          error(
            "agent_session_conflict",
            "This operation id is already bound to a different action attempt."
          )
        );
      }
      if (entry === undefined) {
        entry = { gate: Semaphore.makeUnsafe(1), input };
        operationLocks.set(key, entry);
      }
      return entry.gate.withPermit(executeAction(...args));
    };

    const enterUserVariableUnlocked = Effect.fn(
      "AgentSession.enterUserVariable"
    )(function* enterPrivateVariableAsUser(
      sessionId: AgentSessionId,
      input: Omit<PrivateVariableInput, "ref"> & { readonly ref?: string },
      operationId?: OperationId | string
    ) {
      const requestInput = privateInputFingerprint("user", input);
      const replayed = replay(
        operationId,
        "private-input",
        sessionId,
        requestInput
      );
      if (replayed?._tag === "conflict") {
        return yield* Effect.fail(replayed.error);
      }
      if (replayed?._tag === "replay") {
        if (replayed.result.kind === "act") {
          return replayed.result.result;
        }
        if (replayed.result.kind === "act-failure") {
          return yield* Effect.fail(replayed.result.error);
        }
        return yield* Effect.fail(
          error(
            "agent_session_conflict",
            `Operation ${String(operationId)} was already used for a session mutation.`
          )
        );
      }
      const outcome = yield* Effect.result(
        Effect.gen(function* enterFocusedPrivateValue() {
          const { capture, record } = yield* requireTeaching(sessionId);
          if (record.snapshot.controller !== "user") {
            return yield* Effect.fail(
              makeBrowserRpcError(
                "agent_control_unavailable",
                "The agent holds the browser. Take control before entering a private Variable."
              )
            );
          }
          const page = yield* browser.activePage(record.browserSessionId);
          if (input.ref === undefined) {
            const observed = redactCapturedSnapshot(
              record,
              yield* record.registry.snapshot(page)
            );
            capture.recordSnapshot(observed);
          }
          const ref = AgentElementRef.make(
            input.ref ?? (yield* record.registry.focusedRef())
          );
          const action = { ref, text: input.value, type: "fill" as const };
          const capturedAction = {
            ...action,
            text: variableReference(input.variable.name),
          };
          const description = `Enter Variable ${input.variable.name} in ${ref}`;
          const id = `user-variable-${randomUUID()}`;
          const urlBefore = page.url();
          const snapshotBefore = capture.latestSnapshotId();
          const executed = yield* record.control.lock.withPermit(
            Effect.gen(function* fillPrivateValue() {
              const selector = yield* record.registry.privateSelector(
                ref,
                [...input.value].length
              );
              if (
                !capture.canRecordVariable(
                  input.variable,
                  input.value,
                  selector
                )
              ) {
                return yield* Effect.fail(
                  error(
                    "agent_session_invalid",
                    `Variable ${input.variable.name} conflicts with the Demonstration or its private-input limit.`
                  )
                );
              }
              yield* performPrivateVariableInput(page, selector, input.value);
              capture.recordVariable(input.variable, input.value, selector);
              const observed = yield* Effect.result(
                snapshotAfter(record, page, urlBefore)
              );
              if (Result.isFailure(observed)) {
                capture.recordAction({
                  action: capturedAction,
                  actor: "user",
                  at: now().toISOString(),
                  description,
                  detail:
                    "The private value was entered, but the following Browser Snapshot failed.",
                  id,
                  outcome: "failed",
                  snapshotAfter: null,
                  snapshotBefore,
                  urlAfter: page.url(),
                  urlBefore,
                });
                return yield* Effect.fail(observed.failure);
              }
              return observed.success;
            })
          );
          const at = now().toISOString();
          const entry: AgentTimelineEntry = {
            actor: "user",
            at,
            description,
            dispatched: true,
            id,
            outcome: "completed",
          };
          capture.recordAction({
            action: capturedAction,
            actor: "user",
            at,
            description,
            id,
            outcome: "completed",
            snapshotAfter: executed,
            snapshotBefore,
            urlAfter: executed.url,
            urlBefore,
          });
          yield* recordEntry(sessionId, entry, { currentUrl: executed.url });
          return { entry, snapshot: executed, url: executed.url };
        })
      );
      if (Result.isSuccess(outcome)) {
        yield* remember(operationId, "private-input", sessionId, requestInput, {
          kind: "act",
          result: outcome.success,
        });
        return outcome.success;
      }
      const safeFailure =
        outcome.failure._tag === "BrowserRpcError"
          ? makeBrowserRpcError(
              outcome.failure.code,
              "Could not enter the private Variable."
            )
          : outcome.failure;
      yield* remember(operationId, "private-input", sessionId, requestInput, {
        error: safeFailure,
        kind: "act-failure",
      });
      return yield* Effect.fail(safeFailure);
    });

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
        record.boundaryControl?.grants.clear();
        const inFlight = by === "user" ? record.control.inFlight : undefined;
        let interruptedAction: AgentTimelineEntry | null = null;
        if (inFlight !== undefined) {
          // Interruption waits for the action fiber's finalizers, but the
          // browser may already have performed the effect, so the attempt is
          // recorded as dispatched rather than as never having happened.
          yield* Fiber.interrupt(inFlight.fiber);
          record.control.inFlight = undefined;
          const interruptedAt = now().toISOString();
          const detail =
            "Takeover interrupted this action. The browser may already have performed it.";
          interruptedAction = {
            actor: "agent",
            at: interruptedAt,
            description: inFlight.description,
            detail,
            dispatched: true,
            id: inFlight.id,
            outcome: "interrupted",
          };
          // The Demonstration keeps the attempt too: a compiler that never
          // learns of it could place a Step boundary over an effect nobody
          // can account for.
          record.capture?.recordAction({
            action: inFlight.action,
            actor: "agent",
            at: interruptedAt,
            description: inFlight.description,
            detail,
            id: inFlight.id,
            outcome: "interrupted",
            snapshotAfter: null,
            snapshotBefore: inFlight.snapshotBefore,
            urlAfter: record.snapshot.currentUrl,
            urlBefore: inFlight.urlBefore,
          });
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
          teaching: teachingOf(current, current.snapshot),
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

    const recordInstructionUnlocked = Effect.fn(
      "AgentSession.recordInstruction"
    )(function* recordInstruction(
      sessionId: AgentSessionId,
      text: string,
      operationId?: OperationId | string
    ) {
      const requestInput = JSON.stringify({ text });
      const replayed = replaySession(
        operationId,
        "instruction",
        sessionId,
        requestInput
      );
      if (replayed?._tag === "conflict") {
        return yield* Effect.fail(replayed.error);
      }
      if (replayed?._tag === "replay") {
        return replayed.snapshot;
      }
      const { capture, record } = yield* requireTeaching(sessionId);
      if (!isLive(record.snapshot.phase)) {
        return yield* Effect.fail(
          error(
            "agent_session_conflict",
            `Agent Session ${sessionId} is no longer running.`
          )
        );
      }
      const at = now().toISOString();
      const instruction: TeachingInstruction = capture.recordInstruction(
        text,
        at
      );
      const next = yield* recordEntry(sessionId, {
        actor: "user",
        at,
        description: "The user gave an instruction",
        detail: instruction.text,
        dispatched: false,
        id: instruction.id,
        outcome: "completed",
      });
      yield* rememberSession(
        operationId,
        "instruction",
        sessionId,
        requestInput,
        next
      );
      return next;
    });

    // -----------------------------------------------------------------------
    // Interactive Run
    // -----------------------------------------------------------------------

    const notRunning = (sessionId: AgentSessionId) =>
      error(
        "agent_session_invalid",
        `Agent Session ${sessionId} is not performing an Interactive Run.`
      );

    /**
     * Rewrite the Run on the current snapshot under the session's own
     * read-modify-write, so a Run change never clobbers a control change it
     * did not see.
     */
    const mutateRun = (
      sessionId: AgentSessionId,
      change: (run: AgentRunState, at: string) => AgentRunState
    ): Effect.Effect<AgentSessionSnapshot | undefined> => {
      const at = now().toISOString();
      return mutate(sessionId, (snapshot) =>
        snapshot.run === null
          ? snapshot
          : {
              ...snapshot,
              run: withDerivedRunTotals(change(snapshot.run, at)),
              updatedAt: at,
            }
      );
    };

    /**
     * A hard ceiling. It interrupts whatever the browser was asked to do,
     * records `timed-out` as an execution outcome, and stops: the Runner does
     * not invent an Agent Assessment on the agent's behalf
     * ([ADR 0029](../../../../docs/adr/0029-contingency-owns-the-sole-runner.md)).
     */
    const timeOutRun = Effect.fn("AgentSession.timeOutRun")(
      function* endRunOnCeiling(sessionId: AgentSessionId, breached: string) {
        const record = Ref.getUnsafe(sessions).get(sessionId);
        if (record === undefined || runIsOver(record.snapshot)) {
          return;
        }
        const { inFlight } = record.control;
        let interrupted: AgentTimelineEntry | null = null;
        if (inFlight !== undefined) {
          yield* Fiber.interrupt(inFlight.fiber);
          record.control.inFlight = undefined;
          interrupted = {
            actor: "agent",
            at: now().toISOString(),
            description: inFlight.description,
            detail: `${breached} interrupted this action. The browser may already have performed it.`,
            dispatched: true,
            id: inFlight.id,
            outcome: "interrupted",
          };
        }
        yield* mutate(sessionId, (snapshot) => {
          if (snapshot.run === null || snapshot.run.outcome !== null) {
            return snapshot;
          }
          const at = now().toISOString();
          const steps = markRemainingUnexecuted(
            snapshot.run.steps.map((step) =>
              step.execution === "active"
                ? { ...step, endedAt: at, execution: "timed-out" as const }
                : step
            )
          );
          return {
            ...snapshot,
            interruptedAction: interrupted ?? snapshot.interruptedAction,
            run: withDerivedRunTotals({
              ...snapshot.run,
              activeStepIndex: null,
              endedAt: at,
              outcome: "timed-out",
              stepDeadline: null,
              steps,
            }),
            timeline: [
              ...snapshot.timeline,
              ...(interrupted === null ? [] : [interrupted]),
              {
                actor: "agent" as const,
                at,
                description: `${breached} was reached`,
                detail:
                  "The Runner recorded a timed-out execution outcome. No Agent Assessment was produced for the interrupted Agent Step.",
                dispatched: false,
                id: `ceiling-${randomUUID()}`,
                outcome: "interrupted" as const,
              },
            ].slice(-TIMELINE_LIMIT),
            updatedAt: at,
          };
        });
      }
    );

    /**
     * The ceilings are wall clock, so they are watched rather than raced
     * against one action: an agent that stops calling tools altogether must
     * still lose its Run rather than hold a browser open forever.
     *
     * Each tick runs under the session lock — the same one `extendCeiling`,
     * `assessStep`, and `completeRun` take — so a deadline is re-read after
     * any user extension it raced, and a breach can never interleave with a
     * Run mutation that already checked the outcome.
     */
    const watchRunCeilings = (sessionId: AgentSessionId): Effect.Effect<void> =>
      lock
        .withPermit(
          Effect.gen(function* watchCeilings() {
            const record = Ref.getUnsafe(sessions).get(sessionId);
            const run = record?.snapshot.run ?? null;
            if (record === undefined || run === null || run.outcome !== null) {
              return;
            }
            const at = now().getTime();
            if (at >= Date.parse(run.runDeadline)) {
              yield* timeOutRun(sessionId, "The Run ceiling");
              return;
            }
            if (
              run.stepDeadline !== null &&
              at >= Date.parse(run.stepDeadline) &&
              // A paused agent is not a slow agent: the user holds the
              // browser, so the Agent Step's budget is not being spent on the
              // agent's work.
              !agentIsPaused(record.snapshot)
            ) {
              yield* timeOutRun(sessionId, "The Agent Step ceiling");
            }
          })
        )
        .pipe(
          Effect.andThen(Effect.sleep(CEILING_POLL_INTERVAL)),
          Effect.forever,
          Effect.catchCause(() => Effect.void)
        );

    /**
     * Start a session and, when it is performing a Run, watch its ceilings for
     * as long as it owns a browser. The watcher lives in the session's own
     * scope, so closing the session stops it. A Run without its watcher would
     * hold a browser unbounded, so a failure to attach it fails the start
     * rather than being ignored.
     */
    const startAndWatch = (input: AgentSessionStartInput) =>
      startUnlocked(input).pipe(
        Effect.tap((snapshot) =>
          snapshot.run === null
            ? Effect.void
            : read(snapshot.id).pipe(
                Effect.flatMap((record) =>
                  Effect.forkIn(watchRunCeilings(snapshot.id), record.scope)
                )
              )
        )
      );

    const assessStepUnlocked = Effect.fn("AgentSession.assessStep")(
      function* assessAgentStep(
        sessionId: AgentSessionId,
        input: {
          readonly evidence: readonly AgentAssessmentEvidence[];
          readonly explanation: string;
          readonly outcome: AgentAssessmentOutcome;
        },
        operationId?: OperationId | string
      ) {
        const requestInput = JSON.stringify(input);
        const replayed = replaySession(
          operationId,
          "assess",
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
        if (record.boundaryControl?.pending !== undefined) {
          return yield* Effect.fail(
            error(
              "agent_session_conflict",
              "Resolve the Execution Boundary before assessing an Agent Step."
            )
          );
        }
        const { run } = record.snapshot;
        if (run === null) {
          return yield* Effect.fail(notRunning(sessionId));
        }
        if (run.outcome !== null) {
          return yield* Effect.fail(
            error(
              "agent_session_conflict",
              `Run ${run.runId} has already ended as ${run.outcome} and accepts no further Agent Assessments.`
            )
          );
        }
        const activeIndex = run.activeStepIndex;
        const active =
          activeIndex === null ? undefined : run.steps[activeIndex];
        if (activeIndex === null || active === undefined) {
          return yield* Effect.fail(
            error(
              "agent_session_conflict",
              `Run ${run.runId} has no active Agent Step to assess.`
            )
          );
        }
        // Evidence must name something this Agent Step actually produced.
        // Otherwise an explanation could cite an observation that was never
        // made ([ADR 0025](../../../../docs/adr/0025-agent-flow-is-compiled-from-a-demonstration.md)).
        const unknown = input.evidence.filter((reference) =>
          reference.kind === "snapshot"
            ? !record.runEvidence.snapshots.has(reference.id)
            : !record.runEvidence.attempts.has(reference.id)
        );
        if (unknown.length > 0) {
          return yield* Effect.fail(
            error(
              "agent_session_invalid",
              `Agent Step ${activeIndex + 1} recorded no ${unknown
                .map((reference) => `${reference.kind} ${reference.id}`)
                .join(
                  ", "
                )}. Cite a Browser Snapshot or an attempt from this Agent Step.`
            )
          );
        }
        const advance = advancesAgentRun(input.outcome);
        const nextIndex = activeIndex + 1;
        const hasNext = advance && nextIndex < run.steps.length;
        const next = yield* mutateRun(sessionId, (current, at) => {
          // Checked above under the same lock; kept here so this callback can
          // never dress a terminal outcome up as an Agent Assessment even if
          // the locking around it changes.
          if (current.outcome !== null) {
            return current;
          }
          const assessment = {
            attempts: current.steps[activeIndex]?.attempts ?? 0,
            evidence: input.evidence,
            explanation: input.explanation,
            outcome: input.outcome,
            submittedAt: at,
          };
          const assessed = current.steps.map((step, index) => {
            if (index === activeIndex) {
              return {
                ...step,
                assessment,
                endedAt: at,
                execution: "assessed" as const,
              };
            }
            if (hasNext && index === nextIndex) {
              return { ...step, execution: "active" as const, startedAt: at };
            }
            return step;
          });
          return {
            ...current,
            activeStepIndex: hasNext ? nextIndex : null,
            endedAt: hasNext ? null : at,
            // A terminal assessment ends the ordered Steps and leaves the rest
            // unexecuted; `completed` means every Step was reached.
            outcome: hasNext ? null : endedRunOutcome(advance),
            stepDeadline: hasNext
              ? deadlineFrom(now(), current.ceilings.stepMs)
              : null,
            steps: hasNext ? assessed : markRemainingUnexecuted(assessed),
          };
        });
        if (next === undefined) {
          return yield* Effect.fail(notRunning(sessionId));
        }
        // Each Agent Step is judged on its own evidence, so the record of what
        // the Runner produced starts empty at every boundary.
        record.runEvidence.attempts.clear();
        record.runEvidence.snapshots.clear();
        const withEntry = yield* recordEntry(sessionId, {
          actor: "agent",
          at: now().toISOString(),
          description: `Assessed "${active.name}" as ${input.outcome}`,
          detail: input.explanation,
          dispatched: false,
          id: `assessment-${randomUUID()}`,
          outcome: "completed",
        });
        yield* rememberSession(
          operationId,
          "assess",
          sessionId,
          requestInput,
          withEntry
        );
        return withEntry;
      }
    );

    const extendCeilingUnlocked = Effect.fn("AgentSession.extendCeiling")(
      function* extendRunCeiling(
        sessionId: AgentSessionId,
        ceilingScope: "run" | "step",
        additionalMs: number,
        operationId?: OperationId | string
      ) {
        const requestInput = JSON.stringify({ additionalMs, ceilingScope });
        const replayed = replaySession(
          operationId,
          "ceiling",
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
        if (record.snapshot.run === null) {
          return yield* Effect.fail(notRunning(sessionId));
        }
        if (record.snapshot.run.outcome !== null) {
          return yield* Effect.fail(
            error(
              "agent_session_conflict",
              `Run ${record.snapshot.run.runId} has already ended; its ceilings cannot be extended.`
            )
          );
        }
        const next = yield* mutateRun(sessionId, (current) => ({
          ...current,
          ceilings: {
            ...current.ceilings,
            extensions: current.ceilings.extensions + 1,
            ...(ceilingScope === "run"
              ? { runMs: current.ceilings.runMs + additionalMs }
              : { stepMs: current.ceilings.stepMs + additionalMs }),
          },
          ...(ceilingScope === "run"
            ? {
                runDeadline: deadlineFrom(
                  new Date(Date.parse(current.runDeadline)),
                  additionalMs
                ),
              }
            : {
                stepDeadline:
                  current.stepDeadline === null
                    ? null
                    : deadlineFrom(
                        new Date(Date.parse(current.stepDeadline)),
                        additionalMs
                      ),
              }),
        }));
        if (next === undefined) {
          return yield* Effect.fail(notRunning(sessionId));
        }
        const withEntry = yield* recordEntry(sessionId, {
          actor: "user",
          at: now().toISOString(),
          description: `The user extended the ${ceilingScope === "run" ? "Run" : "Agent Step"} ceiling`,
          detail: `by ${Math.round(additionalMs / 1000)}s`,
          dispatched: false,
          id: `ceiling-extend-${randomUUID()}`,
          outcome: "completed",
        });
        yield* rememberSession(
          operationId,
          "ceiling",
          sessionId,
          requestInput,
          withEntry
        );
        return withEntry;
      }
    );

    const completeRunUnlocked = Effect.fn("AgentSession.completeRun")(
      function* completeInteractiveRun(
        sessionId: AgentSessionId,
        summaryText?: string,
        operationId?: OperationId | string
      ) {
        const requestInput = JSON.stringify({ summary: summaryText ?? null });
        const replayedSummary = replayRunSummary(
          operationId,
          sessionId,
          requestInput
        );
        if (replayedSummary?._tag === "conflict") {
          return yield* Effect.fail(replayedSummary.error);
        }
        if (replayedSummary?._tag === "replay") {
          return replayedSummary.summary;
        }
        const record = yield* read(sessionId);
        if (record.snapshot.run === null) {
          return yield* Effect.fail(notRunning(sessionId));
        }
        return yield* Effect.uninterruptibleMask(() =>
          Effect.gen(function* finalizeRun() {
            const at = now().toISOString();
            // A read-modify-write over the Run as it stands when the write
            // lands: a `timed-out` outcome a ceiling recorded is kept, never
            // clobbered by a snapshot this call built earlier.
            const completed = yield* mutate(sessionId, (snapshot) => {
              if (snapshot.run === null) {
                return snapshot;
              }
              const steps = markRemainingUnexecuted(snapshot.run.steps);
              return {
                ...snapshot,
                boundary: null,
                controller: "agent",
                phase: "completed",
                run: withDerivedRunTotals({
                  ...snapshot.run,
                  activeStepIndex: null,
                  endedAt: snapshot.run.endedAt ?? at,
                  // A Run the agent stopped while Agent Steps remained is not
                  // a completed Run: the coverage it did not reach is visible
                  // here.
                  outcome:
                    snapshot.run.outcome ??
                    (steps.every((step) => step.execution === "assessed")
                      ? ("completed" as const)
                      : ("ended-early" as const)),
                  stepDeadline: null,
                  steps,
                }),
                takeover: null,
                updatedAt: at,
              };
            });
            const finished = completed?.run;
            if (
              completed === undefined ||
              finished === null ||
              finished === undefined
            ) {
              return yield* Effect.fail(notRunning(sessionId));
            }
            // Closing the session scope stops tracing and finalizes the video.
            // Nothing may write to the Run's artifacts after this point.
            yield* Scope.close(record.scope, Exit.void);
            const summary: AgentRunSummary = {
              agentFlowId: finished.agentFlowId,
              assessmentCounts: finished.assessmentCounts,
              attribution: finished.attribution,
              ceilings: finished.ceilings,
              coverage: finished.coverage,
              endedAt: finished.endedAt ?? at,
              outcome: finished.outcome ?? "ended-early",
              revisionId: finished.revisionId,
              runId: finished.runId,
              schemaVersion: 1,
              sessionId,
              startedAt: finished.startedAt,
              steps: finished.steps,
              summary: summaryText ?? null,
              timeline: [
                ...new Map(
                  [
                    ...(record.boundaryControl?.evidence ?? []),
                    ...completed.timeline,
                  ].map((entry) => [entry.id, entry])
                ).values(),
              ].toSorted((left, right) => left.at.localeCompare(right.at)),
              title: finished.title,
              tracePath: yield* finalArtifactPath(record, record.traceFile),
              videoPath: yield* finalArtifactPath(record, record.videoFile),
            };
            yield* mutate(sessionId, (snapshot) => ({
              ...snapshot,
              phase: "closed",
              updatedAt: now().toISOString(),
            }));
            yield* rememberRunSummary(
              operationId,
              sessionId,
              requestInput,
              summary
            );
            return summary;
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
      act: (sessionId, action, operationId, intent) =>
        actUnlocked(sessionId, action, operationId, undefined, intent),
      assessStep: (sessionId, input, operationId) =>
        lock.withPermit(assessStepUnlocked(sessionId, input, operationId)),
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
      closeAll: () => {
        const liveSessionIds: AgentSessionId[] = [];
        for (const [sessionId, record] of Ref.getUnsafe(sessions)) {
          if (isLive(record.snapshot.phase)) {
            liveSessionIds.push(sessionId);
          }
        }
        return lock.withPermit(
          Effect.forEach(
            liveSessionIds,
            (sessionId) => interruptUnlocked(sessionId).pipe(Effect.ignore),
            { discard: true }
          )
        );
      },
      completeRun: (sessionId, summaryText, operationId) =>
        lock.withPermit(
          completeRunUnlocked(sessionId, summaryText, operationId)
        ),
      enterAgentVariable: (sessionId, input, operationId) =>
        Effect.gen(function* enterPrivateVariableAsAgent() {
          const { record } = yield* requireTeaching(sessionId);
          if (agentIsPaused(record.snapshot)) {
            return yield* Effect.fail(
              takenOver("This private input was not dispatched.")
            );
          }
          const action = {
            ref: input.ref,
            text: input.value,
            type: "fill" as const,
          };
          return yield* actUnlocked(sessionId, action, operationId, {
            action: {
              ...action,
              text: variableReference(input.variable.name),
            },
            requestInput: privateInputFingerprint("agent", input),
            value: input.value,
            variable: input.variable,
          });
        }),
      enterSuppliedVariable: (sessionId, name, ref, operationId) =>
        Effect.gen(function* enterSuppliedVerificationVariable() {
          const record = yield* requireLiveRecord(sessionId);
          const declared = requireDeclaredVariable(record, name);
          if (declared._tag === "error") {
            return yield* Effect.fail(declared.error);
          }
          if (agentIsPaused(record.snapshot)) {
            return yield* Effect.fail(
              takenOver("This private input was not dispatched.")
            );
          }
          const value = record.supplied.get(name);
          if (value === undefined) {
            return yield* Effect.fail(
              error(
                "agent_session_invalid",
                `Variable ${name} has not been supplied for this Run. Ask the user to enter it in Agent View.`
              )
            );
          }
          const action = {
            ref: AgentElementRef.make(ref),
            text: value,
            type: "fill" as const,
          };
          return yield* actUnlocked(sessionId, action, operationId, {
            action: { ...action, text: variableReference(name) },
            // The fingerprint names the Variable, not its value: a retry of
            // the same request is the same request whatever the user typed.
            requestInput: JSON.stringify({
              kind: "supplied-variable",
              name,
              ref,
            }),
            value,
            variable: declared.variable,
          });
        }),
      enterUserVariable: (sessionId, input, operationId) =>
        enterUserVariableUnlocked(sessionId, input, operationId),
      extendCeiling: (sessionId, ceilingScope, additionalMs, operationId) =>
        lock.withPermit(
          extendCeilingUnlocked(
            sessionId,
            ceilingScope,
            additionalMs,
            operationId
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
      recordDraft: (sessionId, draft) =>
        Effect.gen(function* recordSavedDraft() {
          const { capture } = yield* requireTeaching(sessionId);
          const next = yield* mutate(sessionId, (snapshot) => ({
            ...snapshot,
            teaching: capture.progress(draft),
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
        }),
      recordInstruction: (sessionId, text, operationId) =>
        lock.withPermit(
          recordInstructionUnlocked(sessionId, text, operationId)
        ),
      recordVerificationOutcome: (sessionId, outcome) =>
        Effect.gen(function* noteVerificationOutcome() {
          const record = yield* read(sessionId);
          if (record.snapshot.verification === null) {
            return yield* Effect.fail(notVerifying(sessionId));
          }
          const next = yield* mutate(sessionId, (snapshot) =>
            snapshot.verification === null
              ? snapshot
              : {
                  ...snapshot,
                  updatedAt: now().toISOString(),
                  verification: { ...snapshot.verification, outcome },
                }
          );
          return next ?? record.snapshot;
        }),
      requestTakeover: (sessionId, reason, operationId) =>
        lock.withPermit(
          beginTakeoverUnlocked(sessionId, reason, "agent", operationId)
        ),
      resolveBoundary: (input) =>
        lock.withPermit(
          Effect.gen(function* resolveExecutionBoundary() {
            const requestInput = JSON.stringify(input);
            const replayed = replaySession(
              input.operationId,
              "boundary",
              input.sessionId,
              requestInput
            );
            if (replayed?._tag === "conflict") {
              return yield* Effect.fail(replayed.error);
            }
            if (replayed?._tag === "replay") {
              return replayed.snapshot;
            }
            const record = yield* requireLiveRecord(input.sessionId);
            const control = record.boundaryControl;
            const pending = control?.pending;
            if (
              control === undefined ||
              pending === undefined ||
              pending.boundary.id !== input.boundaryId
            ) {
              return yield* Effect.fail(
                error(
                  "agent_session_conflict",
                  "This boundary request is no longer pending."
                )
              );
            }
            if (input.decision === "allow" && agentIsPaused(record.snapshot)) {
              return yield* Effect.fail(
                takenOver("Return control before confirming an agent attempt.")
              );
            }
            if (input.decision === "allow") {
              if (pending.boundary.reason === "domain") {
                const url = new URL(pending.boundary.requested);
                if (url.protocol !== "http:" && url.protocol !== "https:") {
                  return yield* Effect.fail(
                    error(
                      "agent_session_invalid",
                      "Only HTTP and HTTPS domains can be approved."
                    )
                  );
                }
                control.hosts.add(url.hostname.toLowerCase());
              } else {
                control.grants.add(
                  pending.boundary.reason + pending.fingerprint
                );
              }
            }
            control.pending = undefined;
            const snapshot = yield* recordEntry(
              input.sessionId,
              {
                actor: "user",
                at: now().toISOString(),
                description:
                  input.decision === "allow"
                    ? "Confirmed boundary request"
                    : "Refused boundary request",
                detail: `${pending.boundary.description}: ${pending.boundary.requested}`,
                dispatched: false,
                id: randomUUID(),
                outcome: input.decision === "allow" ? "completed" : "refused",
              },
              { boundary: null }
            );
            yield* rememberSession(
              input.operationId,
              "boundary",
              input.sessionId,
              requestInput,
              snapshot
            );
            return snapshot;
          })
        ),
      returnControl: (sessionId, operationId) =>
        lock.withPermit(returnControlUnlocked(sessionId, operationId)),
      runViewUrl: (runId) =>
        isAllowedAgentSessionBaseUrl(options.baseUrl)
          ? Effect.sync(() => runViewUrl(options.baseUrl, runId))
          : Effect.fail(
              error(
                "agent_session_invalid",
                "Agent View must be served from a loopback URL."
              )
            ),
      screenshot: (sessionId) =>
        observe(sessionId, (record, page) =>
          captureAgentScreenshot(
            page,
            now,
            true,
            sessionSensitiveValues(record),
            record.capture?.sensitiveSelectors() ?? []
          ).pipe(
            Effect.tap((screenshot) =>
              Effect.sync(() => {
                record.capture?.recordScreenshot(screenshot);
              })
            )
          )
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
          const page = yield* browser.activePage(record.browserSessionId);
          const urlBefore = page.url();
          const { focused, pointed, snapshotBefore } =
            yield* observeUserInputTarget(record, page, input);
          const id = `user-input-${randomUUID()}`;
          const action = {
            input: teachingInput(input),
            type: "input" as const,
          };
          const description = describeTeachingInput(input);
          const outcome = yield* record.control.lock.withPermit(
            Effect.result(browser.sendInput(record.browserSessionId, input))
          );
          const at = now().toISOString();
          if (Result.isFailure(outcome)) {
            record.capture?.recordAction({
              action,
              actor: "user",
              at,
              description,
              detail: outcome.failure.message,
              id,
              outcome: "failed",
              snapshotAfter: null,
              snapshotBefore,
              urlAfter: page.url(),
              urlBefore,
            });
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
          const urlAfter = page.url();
          const common = {
            at,
            id,
            page,
            record,
            sessionId,
            snapshotBefore,
            urlAfter,
            urlBefore,
          };
          if (yield* completeSemanticUserClick({ ...common, pointed })) {
            return;
          }
          if (yield* completeSemanticUserEdit({ ...common, focused })) {
            return;
          }
          if (shouldCaptureRawInput(input)) {
            record.capture?.recordAction({
              action,
              actor: "user",
              at,
              description,
              id,
              outcome: "completed",
              snapshotAfter: null,
              snapshotBefore,
              urlAfter,
              urlBefore,
            });
          }
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
            { currentUrl: urlAfter }
          ).pipe(Effect.asVoid);
        }),
      snapshot: (sessionId) =>
        observe(sessionId, (record, page) =>
          record.registry.snapshot(page).pipe(
            Effect.map((snapshot) => redactCapturedSnapshot(record, snapshot)),
            Effect.tap((snapshot) =>
              Effect.sync(() => {
                // An observation is the `before` state of the action that
                // follows it, so the Demonstration keeps it.
                record.capture?.recordSnapshot(snapshot);
                noteRunEvidence(record, "snapshot", snapshot.snapshotId);
              })
            )
          )
        ),
      start: (input) => lock.withPermit(startAndWatch(input)),
      supplyVariable: (sessionId, name, value, operationId) =>
        Effect.gen(function* supplyRuntimeVariable() {
          const requestInput = JSON.stringify({
            name,
            valueHash: createHash("sha256").update(value).digest("hex"),
          });
          const replayed = replaySession(
            operationId,
            "variable-supply",
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
          const declared = requireDeclaredVariable(record, name);
          if (declared._tag === "error") {
            return yield* Effect.fail(declared.error);
          }
          record.supplied.set(name, value);
          const markSupplied = <
            T extends {
              readonly variables: readonly AgentSessionVariableState[];
            },
          >(
            state: T
          ): T => ({
            ...state,
            variables: state.variables.map((variable) =>
              variable.name === name
                ? { ...variable, supplied: true }
                : variable
            ),
          });
          const next = yield* mutate(sessionId, (snapshot) => ({
            ...snapshot,
            run: snapshot.run === null ? null : markSupplied(snapshot.run),
            updatedAt: now().toISOString(),
            verification:
              snapshot.verification === null
                ? null
                : markSupplied(snapshot.verification),
          }));
          const saved = next ?? record.snapshot;
          yield* rememberSession(
            operationId,
            "variable-supply",
            sessionId,
            requestInput,
            saved
          );
          return saved;
        }),
      takeover: (sessionId, reason, operationId) =>
        lock.withPermit(
          beginTakeoverUnlocked(sessionId, reason, "user", operationId)
        ),
      teachingFeed: (sessionId, includeSnapshots = false) =>
        requireTeaching(sessionId).pipe(
          Effect.map(({ capture }) => capture.feed(sessionId, includeSnapshots))
        ),
      teachingScreenshot: (sessionId, screenshotId) =>
        requireTeaching(sessionId).pipe(
          Effect.flatMap(({ capture }) => {
            const content = capture.screenshotContent(screenshotId);
            return content === undefined
              ? Effect.fail(
                  error(
                    "agent_session_invalid",
                    `This Teaching session has no screenshot ${screenshotId}. Read the Teaching Feed for the screenshot references it captured.`
                  )
                )
              : Effect.succeed(content);
          })
        ),
      teachingSource: (sessionId) =>
        requireTeaching(sessionId).pipe(
          Effect.map(({ capture, record }): TeachingSource => ({
            artifactRetention: { location: "local", sensitive: true },
            demonstration: capture.current(),
            emulation: record.emulation,
            retentionFile: record.retentionFile,
            session: record.snapshot,
            traceFile: record.traceFile,
            videoFile: record.videoFile,
          }))
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
          const capturedAction =
            action.type === "navigate"
              ? { ...action, url: sanitizeTeachingUrl(action.url) }
              : action;
          const description = describeAgentAction(capturedAction);
          const id = `user-${randomUUID()}`;
          const urlBefore = page.url();
          const snapshotBefore = record.capture?.latestSnapshotId() ?? null;
          // One browser takes one navigation at a time. Without this permit a
          // second click races the first, and Playwright cancels the pending
          // navigation: both attempts report success and the page never moves.
          const outcome = yield* record.control.lock.withPermit(
            Effect.result(performAgentAction(page, record.registry, action))
          );
          const at = now().toISOString();
          if (Result.isFailure(outcome)) {
            const safeFailure = sanitizeActionFailure(
              outcome.failure,
              action,
              false
            );
            record.capture?.recordAction({
              action: capturedAction,
              actor: "user",
              at,
              description,
              detail: safeFailure.message,
              id,
              outcome: "failed",
              snapshotAfter: null,
              snapshotBefore,
              urlAfter: page.url(),
              urlBefore,
            });
            yield* recordEntry(sessionId, {
              actor: "user",
              at,
              description,
              detail: safeFailure.message,
              dispatched: true,
              id,
              outcome: "failed",
            });
            return yield* Effect.fail(safeFailure);
          }
          const url = page.url();
          if (record.capture !== undefined) {
            // The user drove the browser, and the Demonstration captures the
            // user's actions with the same fidelity as the agent's: a Snapshot
            // of the Page the navigation reached.
            const after = yield* snapshotAfter(record, page, urlBefore).pipe(
              Effect.option
            );
            record.capture.recordAction({
              action: capturedAction,
              actor: "user",
              at,
              description,
              id,
              outcome: "completed",
              snapshotAfter: Option.getOrNull(after),
              snapshotBefore,
              urlAfter: url,
              urlBefore,
            });
          }
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
      verification: (sessionId) =>
        read(sessionId).pipe(
          Effect.flatMap((record) =>
            record.snapshot.verification === null
              ? Effect.fail(notVerifying(sessionId))
              : Effect.succeed(record.snapshot.verification)
          )
        ),
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
