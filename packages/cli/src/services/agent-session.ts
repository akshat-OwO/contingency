import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import {
  advancesAgentRun,
  AgentProcessId,
  AgentElementRef,
  AgentPendingDecisionId,
  AgentSessionId,
  describeAgentAction,
  makeBrowserRpcError,
  UserAgentProfileId,
} from "@contingency/protocol";
import type {
  AgentActionResult,
  AgentActionIntent,
  AgentActionSubject,
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
  AgentPendingDecision,
  AgentPendingDecisionResolution,
  AgentPendingDecisionResolve,
  AgentFlowVerificationOutcome,
  AgentSessionVerification,
  DraftEmulation,
  Geolocation,
  PermissionDecision,
  Viewport,
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
  BrowserNetworkRequest,
  BrowserNetworkRequestDetail,
  BrowserStorageSnapshot,
  BrowserStreamId,
  BrowserTab,
  BrowserTabId,
  CapturedUserInput,
  FrameSequence,
  OperationId,
  SessionEmulation,
  SessionId,
  StorageKind,
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
  redactKnownValues,
  snapshotAfterAction,
} from "./agent-browser.ts";
import type { AgentElementRegistry } from "./agent-browser.ts";
import { domainScopeCovers } from "./agent-flow-compiler.ts";
import type { Demonstration } from "./agent-flow-compiler.ts";
import { installAgentNavigationBoundary } from "./agent-navigation-boundary.ts";
import { CreateBrowser } from "./create-browser-contract.ts";
import type {
  BrowserStorageDeleteInput,
  BrowserStorageSetInput,
  CreateBrowserService,
} from "./create-browser-contract.ts";
import { analyzePlayByPlay } from "./play-by-play.ts";
import type { PlayByPlayAnalyzer } from "./play-by-play.ts";
import { sanitizeTeachingUrl } from "./sensitive-data.ts";
import { makeDemonstrationCapture } from "./teaching-capture.ts";
import type { DemonstrationCapture } from "./teaching-capture.ts";
import { isLoopbackHost } from "./web-url.ts";

/** Options for the one process-owned Agent Session registry. */
export interface AgentSessionServiceOptions {
  /** The URL at which Workspace is served, normally loopback. */
  readonly baseUrl: string;
  /** The owner marker written into every in-memory snapshot. */
  readonly processId?: string;
  /** Injectable clock for deterministic protocol tests. */
  readonly now?: () => Date;
  /** Injectable local-video pass for focused session tests. */
  readonly playByPlayAnalyzer?: PlayByPlayAnalyzer;
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

/**
 * One change to the Emulation a live Agent Session browser applies. Absent
 * leaves that part unchanged and `null` clears it, matching the wire contract
 * ([ADR 0013](../../../../docs/adr/0013-emulation-belongs-to-the-flow.md)).
 * Identity and viewport have no cleared form: they are replaced or left alone.
 */
/**
 * What an Agent Session's browser emulates right now, with the identity it was
 * asked for beside the one it resolved to.
 */
export interface AgentAppliedEmulation {
  readonly emulation: SessionEmulation;
  readonly userAgentProfile: UserAgentProfileId;
}

export interface AgentEmulationPatch {
  readonly colorScheme?: "light" | "dark" | null | undefined;
  readonly geolocation?: Geolocation | null | undefined;
  readonly locale?: string | null | undefined;
  readonly permissions?: readonly PermissionDecision[] | null | undefined;
  readonly timezoneId?: string | null | undefined;
  readonly userAgentProfile?: UserAgentProfileId | undefined;
  readonly viewport?: Viewport | undefined;
}

export interface AgentSessionService {
  /**
   * Apply the user's explicit choice to a paused Execution Boundary or a
   * runtime Variable this session still needs. The agent relays the choice
   * from the MCP conversation
   * ([ADR 0037](../../../../docs/adr/0037-pending-decisions-relay-user-consent-over-mcp.md)).
   */
  readonly resolvePendingDecision: (
    input: AgentPendingDecisionResolve
  ) => Effect.Effect<AgentSessionSnapshot, AgentSessionError>;
  /** An open decision this session minted, for the MCP adapter. */
  readonly pendingDecision: (
    pendingDecisionId: AgentPendingDecisionId
  ) => Effect.Effect<AgentPendingDecision, AgentSessionError>;
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
  /** Enter one Variable into the control the user focused while teaching. */
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
   * Note the draft a Teaching session was compiled into, so Workspace can
   * show it. The catalog write itself happens elsewhere; this only records it.
   */
  readonly recordDraft: (
    sessionId: AgentSessionId,
    draft: AgentFlowDraftRef
  ) => Effect.Effect<AgentSessionSnapshot, AgentSessionError>;
  /** Mirror catalog consent state into this session's read-only Workspace. */
  readonly recordPendingDecisionState: (
    sessionId: AgentSessionId,
    pendingDecisions: readonly AgentPendingDecision[],
    decisionHistory: readonly AgentPendingDecisionResolution[]
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
  /**
   * Browser setup tooling the Workspace drives during teaching setup. The
   * Agent Session owns the browser, so these delegate to the shared runtime
   * inside the boundary rather than handing out its session id (ADR 0038).
   */
  readonly emulation: (
    sessionId: AgentSessionId
  ) => Effect.Effect<AgentAppliedEmulation, AgentSessionError>;
  /**
   * Re-apply the whole Emulation the session runs under. Identity, viewport,
   * and environment move together (ADR 0013), and the session remembers what
   * it now emulates so a compiled Agent Flow declares what was demonstrated.
   */
  readonly setEmulation: (
    sessionId: AgentSessionId,
    patch: AgentEmulationPatch
  ) => Effect.Effect<AgentAppliedEmulation, AgentSessionError>;
  readonly tabs: (
    sessionId: AgentSessionId
  ) => Effect.Effect<readonly BrowserTab[], AgentSessionError>;
  readonly networkRequests: (
    sessionId: AgentSessionId,
    tabId: BrowserTabId
  ) => Effect.Effect<readonly BrowserNetworkRequest[], AgentSessionError>;
  readonly networkRequest: (
    sessionId: AgentSessionId,
    tabId: BrowserTabId,
    requestId: string
  ) => Effect.Effect<BrowserNetworkRequestDetail, AgentSessionError>;
  readonly storage: (
    sessionId: AgentSessionId,
    tabId: BrowserTabId,
    kind: StorageKind
  ) => Effect.Effect<BrowserStorageSnapshot, AgentSessionError>;
  readonly setStorage: (
    sessionId: AgentSessionId,
    tabId: BrowserTabId,
    input: BrowserStorageSetInput
  ) => Effect.Effect<void, AgentSessionError>;
  readonly deleteStorage: (
    sessionId: AgentSessionId,
    tabId: BrowserTabId,
    input: BrowserStorageDeleteInput
  ) => Effect.Effect<void, AgentSessionError>;
  readonly clearStorage: (
    sessionId: AgentSessionId,
    tabId: BrowserTabId,
    kind: StorageKind
  ) => Effect.Effect<void, AgentSessionError>;
  /** Internal ownership check for generic browser RPC isolation. */
  readonly ownsBrowserSession: (sessionId: SessionId) => Effect.Effect<boolean>;
  readonly start: (
    input: AgentSessionStartInput
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
   * answer with the persistent Run Summary. Workspace stays alive in summary
   * mode; the browser does not.
   */
  readonly completeRun: (
    sessionId: AgentSessionId,
    summary?: string,
    operationId?: OperationId | string
  ) => Effect.Effect<AgentRunSummary, AgentSessionError>;
  /** A direct user action in Workspace raising one ceiling. */
  readonly extendCeiling: (
    sessionId: AgentSessionId,
    scope: "run" | "step",
    additionalMs: number,
    operationId?: OperationId | string
  ) => Effect.Effect<AgentSessionSnapshot, AgentSessionError>;
  /** The read-only Workspace link for one persisted Run. */
  readonly runViewUrl: (
    runId: AgentRunId
  ) => Effect.Effect<string, AgentSessionError>;
  readonly verification: (
    sessionId: AgentSessionId
  ) => Effect.Effect<AgentSessionVerification, AgentSessionError>;
  /** Note how the Verification Run ended, so Workspace can offer approval. */
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
  const url = new URL("/", baseUrl);
  url.searchParams.set("session", sessionId);
  return url.href;
};

/**
 * The read-only viewer's link. It selects a persisted Run rather than a live
 * Agent Session, so it restores no browser state
 * ([ADR 0030](../../../../docs/adr/0030-agent-view-is-separate-from-audit-view.md)).
 */
const runViewUrl = (baseUrl: string, runId: AgentRunId): string => {
  const url = new URL("/", baseUrl);
  url.searchParams.set("run", runId);
  return url.href;
};

/** Workspace is a local control surface and never receives a public URL. */
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

/**
 * The applied Emulation as the session records it. A session reports the
 * concrete identity it resolved to, so the profile the user chose is carried
 * across rather than read back off the browser.
 */
const draftFromApplied = (
  userAgentProfile: UserAgentProfileId,
  applied: SessionEmulation
): DraftEmulation => {
  let draft: DraftEmulation = {
    permissions: applied.permissions,
    userAgentProfile,
    viewport: applied.viewport,
  };
  if (applied.colorScheme !== undefined && applied.colorScheme !== null) {
    draft = { ...draft, colorScheme: applied.colorScheme };
  }
  if (applied.geolocation !== undefined && applied.geolocation !== null) {
    draft = { ...draft, geolocation: applied.geolocation };
  }
  if (applied.locale !== undefined && applied.locale !== null) {
    draft = { ...draft, locale: applied.locale };
  }
  if (applied.timezoneId !== undefined && applied.timezoneId !== null) {
    draft = { ...draft, timezoneId: applied.timezoneId };
  }
  return draft;
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
  input: Omit<PrivateVariableInput, "ref"> & { readonly ref?: string }
): string =>
  JSON.stringify({
    actor: "user",
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

/**
 * Teaching is user-led: the user demonstrates the journey and the agent only
 * observes ([ADR 0038](../../../../docs/adr/0038-contingency-is-an-agent-sanity-monitor.md)).
 * There is no control to hand over, so browser actions and Takeover are both
 * refused for the whole Demonstration.
 */
const userLedTeaching = (snapshot: AgentSessionSnapshot): boolean =>
  snapshot.activity === "teaching";

/** Why an agent browser action cannot run during a Demonstration. */
const teachingIsUserLed = (description: string): BrowserRpcErrorType =>
  makeBrowserRpcError(
    "agent_control_unavailable",
    `${description} Teaching is user-led: the user drives the browser and you observe. Record an Instruction with agent_teaching_instruction_record and ask the user to demonstrate the step; browser actions are yours to make during an Interactive Run.`
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

/** Strip private literals from every free-text field an action carries. */
const redactActionText = (
  action: AgentBrowserAction,
  redact: (text: string) => string
): AgentBrowserAction => {
  switch (action.type) {
    case "fill": {
      return { ...action, text: redact(action.text) };
    }
    case "select": {
      return { ...action, values: action.values.map(redact) };
    }
    case "wait_for_text": {
      return { ...action, text: redact(action.text) };
    }
    // `sanitizeTeachingUrl` rewrites query parameters whose names look like
    // secrets; a private value the session knows about can still sit in a path
    // segment or an unmatched parameter.
    case "navigate": {
      return { ...action, url: redact(action.url) };
    }
    default: {
      return action;
    }
  }
};

/**
 * Describe an attempt by what it acted on. The description is read long after
 * the Snapshot that minted the reference is gone, so the control's role and
 * accessible name are resolved now, while the reference still means something.
 *
 * Redaction runs field by field before the label is assembled. A description
 * is a sentence built from truncated fragments, so redacting the finished
 * sentence would look for a private literal that a length limit had already
 * cut in half, and leave its surviving prefix on the timeline.
 */
export const describeCapturedAction = (
  subject: AgentActionSubject | undefined,
  action: AgentBrowserAction,
  intent: AgentActionIntent,
  privateValues: readonly string[]
): string => {
  const redact = (text: string): string =>
    privateValues.length === 0 ? text : redactKnownValues(text, privateValues);
  return describeAgentAction(redactActionText(action, redact), {
    objective:
      intent.objective === undefined || intent.objective === null
        ? undefined
        : redact(intent.objective),
    subject:
      subject === undefined
        ? undefined
        : { name: redact(subject.name), role: subject.role },
  });
};

/** The control an action names, as the live Snapshot generation described it. */
const actionSubject = (
  registry: AgentElementRegistry,
  action: AgentBrowserAction
): AgentActionSubject | undefined =>
  "ref" in action && action.ref !== undefined
    ? registry.describe(action.ref)
    : undefined;

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
  if (
    (record.snapshot.run === null ||
      record.snapshot.run.activeStepIndex === null) &&
    (record.snapshot.verification === null ||
      record.snapshot.verification.activeStepIndex === null)
  ) {
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
        /** The pending decision the agent resolves to release this pause. */
        readonly decision: AgentPendingDecision;
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
  const step =
    record.snapshot.run?.steps.find(
      (candidate) => candidate.index === record.snapshot.run?.activeStepIndex
    ) ??
    record.snapshot.verification?.steps.find(
      (candidate) =>
        candidate.index === record.snapshot.verification?.activeStepIndex
    );
  const mutating = !["navigate", "hover", "scroll", "wait_for_text"].includes(
    action.type
  );
  // An explicit approved verification objective scopes the marker to that Step.
  // Without one, retain the conservative guard so omission cannot bypass it.
  const needsConfirmation =
    intent.irreversible === true || (mutating && step?.confirmation === true);
  // Domain Scope already decides where the session may travel, and a navigate
  // mutates nothing, so an in-scope destination is never an unknown objective
  // however the agent phrased it (ADR 0027).
  const inScopeNavigate =
    action.type === "navigate" && domainAllowed(record, action.url);
  const reasons: AgentExecutionBoundary["reason"][] = [];
  if (action.type === "navigate" && !inScopeNavigate) {
    reasons.push("domain");
  }
  if (intent.objectiveKind === "new" && !inScopeNavigate) {
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
 * Verification and Interactive Runs both have one active ordered Step, so an
 * unnamed action can use the same truthful fallback in either Run kind.
 */
const boundaryObjective = (
  record: SessionRecord,
  intent: AgentActionIntent
): string =>
  intent.objective ??
  record.snapshot.run?.steps.find(
    (step) => step.index === record.snapshot.run?.activeStepIndex
  )?.description ??
  record.snapshot.verification?.steps.find(
    (step) => step.index === record.snapshot.verification?.activeStepIndex
  )?.description ??
  "An action the agent did not name an objective for";

/**
 * What the user is being asked to release, in one line the agent can quote in
 * its conversation before asking. It names the exact host for a domain pause
 * and the exact attempt for a confirmation or new-objective pause, because a
 * boundary grant covers one host for the Run or one action attempt, never the
 * whole Run.
 */
const boundaryScopeSummary = (boundary: AgentExecutionBoundary): string => {
  if (boundary.reason === "domain") {
    return `Allow ${boundary.requested} for this Run. The saved Domain Scope stays unchanged.`;
  }
  const what =
    boundary.reason === "confirmation"
      ? "Confirm this irreversible action attempt once"
      : "Allow this objective outside the approved Agent Steps once";
  return `${what}: ${boundary.description} (${boundary.requested}). A retry needs another decision.`;
};

/**
 * The Agent Flow this session is running, when it has one. A bare session that
 * pauses at an Execution Boundary names no revision, so the decision carries
 * `null` rather than inventing an identity the catalog never issued.
 */
const boundaryDecisionTarget = (
  snapshot: AgentSessionSnapshot
): Pick<AgentPendingDecision, "agentFlowId" | "revisionId"> => ({
  agentFlowId:
    snapshot.verification?.agentFlowId ?? snapshot.run?.agentFlowId ?? null,
  revisionId:
    snapshot.verification?.revisionId ?? snapshot.run?.revisionId ?? null,
});

const boundaryPendingDecision = (
  snapshot: AgentSessionSnapshot,
  boundary: AgentExecutionBoundary,
  at: string
): AgentPendingDecision => ({
  ...boundaryDecisionTarget(snapshot),
  boundaryId: boundary.id,
  createdAt: at,
  kind: "boundary",
  pendingDecisionId: AgentPendingDecisionId.make(`pending-${randomUUID()}`),
  scopeSummary: boundaryScopeSummary(boundary),
  sessionId: snapshot.id,
  variable: null,
});

/**
 * The Variable decisions a Run opens with: one per declared runtime Variable,
 * so the user answers each by name rather than in a single bundled prompt. The
 * declaration and its secrecy travel; the literal never does.
 */
const variablePendingDecisions = (
  snapshot: AgentSessionSnapshot,
  at: string
): readonly AgentPendingDecision[] => {
  const declaring = snapshot.verification ?? snapshot.run;
  if (declaring === null) {
    return [];
  }
  return declaring.variables.flatMap((variable) =>
    variable.runtime && !variable.supplied
      ? [
          {
            agentFlowId: declaring.agentFlowId,
            boundaryId: null,
            createdAt: at,
            kind: "supply_variable" as const,
            pendingDecisionId: AgentPendingDecisionId.make(
              `pending-${randomUUID()}`
            ),
            revisionId: declaring.revisionId,
            scopeSummary: `Supply runtime Variable ${variable.name}${variable.secret ? " (secret)" : ""} for this Run. The value stays on this machine and never reaches you or the Run artifacts.`,
            sessionId: snapshot.id,
            variable: { name: variable.name, secret: variable.secret },
          },
        ]
      : []
  );
};

/** A replay key that can compare a supplied literal without retaining it. */
const variableResolveRequest = (input: AgentPendingDecisionResolve) => {
  const value = input.value ?? null;
  const userMessage =
    value === null
      ? input.userMessage
      : input.userMessage?.replaceAll(value, "[REDACTED]");
  return {
    requestInput: JSON.stringify({
      decision: input.decision,
      pendingDecisionId: input.pendingDecisionId,
      userMessage: userMessage ?? null,
      valueHash:
        value === null
          ? null
          : createHash("sha256").update(value).digest("hex"),
    }),
    userMessage,
    value,
  };
};

/**
 * Why a relayed Variable answer cannot be applied, if it cannot be. The enum
 * is the server's input: a decision this kind does not accept, or a supply
 * with nothing to supply, is refused rather than guessed at.
 */
const variableAnswerRefusal = (
  pending: AgentPendingDecision,
  input: AgentPendingDecisionResolve,
  value: string | null
): AgentSessionError | undefined => {
  if (input.decision !== "supply" && input.decision !== "refuse") {
    return error(
      "agent_session_conflict",
      `Pending decision ${input.pendingDecisionId} accepts supply or refuse, not ${input.decision}.`
    );
  }
  if (input.decision === "supply" && value === null) {
    return error(
      "agent_session_invalid",
      `Supplying Variable ${pending.variable?.name} needs the value the user gave. Ask them again rather than sending an empty supply.`
    );
  }
  return undefined;
};

/** The durable audit record of one relayed runtime Variable choice. */
const variableResolution = (
  pending: AgentPendingDecision,
  input: AgentPendingDecisionResolve,
  decidedAt: string,
  userMessage: string | null | undefined
): AgentPendingDecisionResolution => {
  const base = {
    agentFlowId: pending.agentFlowId,
    boundaryId: null,
    decidedAt,
    decision: input.decision,
    kind: "supply_variable",
    operationId: input.operationId,
    pendingDecisionId: pending.pendingDecisionId,
    revisionId: pending.revisionId,
    // The name is audited; the literal the user supplied never is.
    variableName: pending.variable?.name ?? null,
  } satisfies Omit<AgentPendingDecisionResolution, "userMessage">;
  if (userMessage === undefined || userMessage === null) {
    return base;
  }
  return { ...base, userMessage };
};

/**
 * Record what an allowed Boundary grants: an allowed host covers the Run, and
 * an allowed confirmation or new objective covers one action attempt. A
 * non-HTTP destination is refused rather than added to the host set.
 */
const grantBoundary = (
  control: BoundaryControl,
  pending: NonNullable<BoundaryControl["pending"]>
): Effect.Effect<void, AgentSessionError> => {
  if (pending.boundary.reason !== "domain") {
    control.grants.add(pending.boundary.reason + pending.fingerprint);
    return Effect.void;
  }
  const url = new URL(pending.boundary.requested);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return Effect.fail(
      error(
        "agent_session_invalid",
        "Only HTTP and HTTPS domains can be approved."
      )
    );
  }
  control.hosts.add(url.hostname.toLowerCase());
  return Effect.void;
};

/** The durable audit record of one relayed Execution Boundary choice. */
const boundaryResolution = (
  pending: NonNullable<BoundaryControl["pending"]>,
  input: AgentPendingDecisionResolve,
  decidedAt: string
): AgentPendingDecisionResolution => {
  const base = {
    agentFlowId: pending.decision.agentFlowId,
    boundaryId: pending.boundary.id,
    decidedAt,
    decision: input.decision,
    kind: "boundary",
    operationId: input.operationId,
    pendingDecisionId: pending.decision.pendingDecisionId,
    revisionId: pending.decision.revisionId,
    variableName: null,
  } satisfies Omit<AgentPendingDecisionResolution, "userMessage">;
  if (input.userMessage === undefined || input.userMessage === null) {
    return base;
  }
  return { ...base, userMessage: input.userMessage };
};

/** The decisions a session owns itself rather than mirroring from the catalog. */
const sessionOwnedDecision = (decision: AgentPendingDecision): boolean =>
  decision.kind === "boundary" || decision.kind === "supply_variable";

/** The decision resolutions a session owns rather than mirroring from the catalog. */
const sessionOwnedResolution = (
  resolution: AgentPendingDecisionResolution
): boolean =>
  resolution.kind === "boundary" || resolution.kind === "supply_variable";

/** Decisions unrelated to the session's current Execution Boundary pause. */
const withoutBoundaryDecision = (
  decisions: readonly AgentPendingDecision[]
): readonly AgentPendingDecision[] =>
  decisions.filter((decision) => decision.kind !== "boundary");

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
    const playByPlayAnalyzer = options.playByPlayAnalyzer ?? analyzePlayByPlay;

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
     * change reaches Workspace through the same stream every other change
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

    const finalizeTeachingPlayByPlay = (
      record: SessionRecord
    ): Effect.Effect<void, AgentSessionError> => {
      const { capture } = record;
      if (capture === undefined || capture.current().playByPlay !== null) {
        return Effect.void;
      }
      return playByPlayAnalyzer({
        demonstration: capture.current(),
        videoFile: record.videoFile,
      }).pipe(
        Effect.flatMap((playByPlay) => {
          const finalized = playByPlay.trim();
          if (finalized.length === 0) {
            return Effect.fail(
              new Error("Teaching video analysis produced no PlayByPlay.")
            );
          }
          capture.finalizePlayByPlay(finalized);
          return Effect.void;
        }),
        Effect.mapError((cause) =>
          error(
            "agent_session_invalid",
            `Could not finalize the Teaching PlayByPlay: ${cause.message}`
          )
        )
      );
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
          yield* finalizeTeachingPlayByPlay(record);
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
            yield* finalizeTeachingPlayByPlay(record);
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

    /**
     * Browser setup mutations. Control is exclusive, so the browser is
     * configured by whoever holds it — during Teaching that is always the
     * user, and during an Interactive Run only while they have taken over.
     */
    const requireUserHeldRecord = (
      sessionId: AgentSessionId
    ): Effect.Effect<SessionRecord, AgentSessionError> =>
      requireLiveRecord(sessionId).pipe(
        Effect.flatMap((record) =>
          record.snapshot.controller === "user"
            ? Effect.succeed(record)
            : Effect.fail(
                makeBrowserRpcError(
                  "agent_control_unavailable",
                  "The agent holds the browser. Take control before configuring it yourself."
                )
              )
        )
      );

    /**
     * What the session now emulates, kept beside the record so a compiled
     * Agent Flow declares the Emulation the Demonstration actually ran under
     * rather than the one the session opened with.
     */
    const rememberEmulation = (
      sessionId: AgentSessionId,
      emulation: DraftEmulation
    ): Effect.Effect<void> =>
      Ref.update(sessions, (current) => {
        const record = current.get(sessionId);
        return record === undefined
          ? current
          : new Map(current).set(sessionId, { ...record, emulation });
      });

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
        const at = now().toISOString();
        // Read the live snapshot rather than the caller's handle: the pause
        // must not resurrect decisions a concurrent mirror already replaced.
        const current =
          Ref.getUnsafe(sessions).get(sessionId)?.snapshot ?? record.snapshot;
        const decision = boundaryPendingDecision(current, boundary, at);
        control.pending = { boundary, decision, fingerprint };
        yield* recordEntry(
          sessionId,
          {
            actor: "agent",
            at,
            description: boundary.description,
            detail: `${boundary.reason}: ${boundary.requested}`,
            dispatched: false,
            id: boundary.id,
            outcome: "refused",
          },
          {
            boundary,
            pendingDecisions: [
              ...withoutBoundaryDecision(current.pendingDecisions),
              decision,
            ],
          }
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
              "Workspace must be served from a loopback URL."
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
                const opening: AgentSessionSnapshot = {
                  activity,
                  boundary: null,
                  clientName: input.clientName?.trim() || "unknown",
                  clientVersion: input.clientVersion?.trim() || "unknown",
                  // Teaching opens with the user holding the browser: the
                  // Demonstration is theirs from the first action, and the
                  // agent never takes control back (ADR 0038).
                  controller: activity === "teaching" ? "user" : "agent",
                  createdAt: at,
                  currentUrl: "about:blank",
                  decisionHistory: [],
                  id: sessionId,
                  interruptedAction: null,
                  ownerProcessId: owner,
                  pendingDecisions: [],
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
                // A Run asks for each runtime Variable it still needs as its
                // own Pending Decision, so the user answers them by name in
                // the agent conversation (ADR 0037).
                const base: AgentSessionSnapshot = {
                  ...opening,
                  pendingDecisions: variablePendingDecisions(opening, at),
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
          stepIndex:
            record.snapshot.run?.activeStepIndex ??
            record.snapshot.verification?.activeStepIndex,
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
        // An attempt that failed or was interrupted registered no Variable, so
        // it is recorded under a masked label rather than one that names a
        // Variable the Demonstration never accepted.
        failedDescription: string,
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
            `${failedDescription} was interrupted and may already have happened.`
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
          description: failedDescription,
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
            description: failedDescription,
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
            if (userLedTeaching(record.snapshot)) {
              return yield* Effect.fail(
                teachingIsUserLed("This action was not dispatched.")
              );
            }
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
            const privateValues =
              privateCapture === undefined
                ? (record.capture?.sensitiveValues() ?? [])
                : [
                    ...(record.capture?.sensitiveValues() ?? []),
                    privateCapture.value,
                  ];
            const description = describeCapturedAction(
              actionSubject(record.registry, capturedAction),
              capturedAction,
              intent,
              privateValues
            );
            const failedDescription =
              privateCapture === undefined
                ? description
                : describeCapturedAction(
                    actionSubject(record.registry, action),
                    sanitizeSensitiveAction(action, true),
                    intent,
                    privateValues
                  );
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
                    failedDescription,
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

    /**
     * Apply the user's answer to one runtime Variable decision. A supplied
     * literal stays in this process; a refusal is recorded and leaves the Run
     * without the value, exactly as never supplying it would
     * ([ADR 0037](../../../../docs/adr/0037-pending-decisions-relay-user-consent-over-mcp.md)).
     */
    const resolveVariableUnlocked = Effect.fn("AgentSession.resolveVariable")(
      function* resolveRuntimeVariableDecision(
        sessionId: AgentSessionId,
        input: AgentPendingDecisionResolve
      ) {
        const { requestInput, userMessage, value } =
          variableResolveRequest(input);
        const replayed = replaySession(
          input.operationId,
          "variable-supply",
          input.pendingDecisionId,
          requestInput
        );
        if (replayed?._tag === "conflict") {
          return yield* Effect.fail(replayed.error);
        }
        if (replayed?._tag === "replay") {
          return replayed.snapshot;
        }
        const record = yield* requireLiveRecord(sessionId);
        const pending = record.snapshot.pendingDecisions.find(
          (decision) =>
            decision.kind === "supply_variable" &&
            decision.pendingDecisionId === input.pendingDecisionId
        );
        if (pending === undefined || pending.variable === null) {
          return yield* Effect.fail(
            error(
              "agent_session_conflict",
              `Pending decision ${input.pendingDecisionId} is stale or unknown. Reread pendingDecisions before asking the user again.`
            )
          );
        }
        const refusal = variableAnswerRefusal(pending, input, value);
        if (refusal !== undefined) {
          return yield* Effect.fail(refusal);
        }
        const supply = input.decision === "supply";
        const declared = requireDeclaredVariable(record, pending.variable.name);
        if (declared._tag === "error") {
          return yield* Effect.fail(declared.error);
        }
        const { name } = pending.variable;
        if (supply && value !== null) {
          record.supplied.set(name, value);
        }
        const markSupplied = <
          T extends {
            readonly variables: readonly AgentSessionVariableState[];
          },
        >(
          state: T
        ): T =>
          supply
            ? {
                ...state,
                variables: state.variables.map((variable) =>
                  variable.name === name
                    ? { ...variable, supplied: true }
                    : variable
                ),
              }
            : state;
        const decidedAt = now().toISOString();
        const resolution = variableResolution(
          pending,
          input,
          decidedAt,
          userMessage
        );
        const snapshot = yield* recordEntry(
          sessionId,
          {
            actor: "user",
            at: decidedAt,
            // The Variable is named; its value never is.
            description: supply
              ? `Supplied Variable ${name}`
              : `Refused to supply Variable ${name}`,
            detail: pending.variable.secret ? "secret Variable" : name,
            dispatched: false,
            id: randomUUID(),
            outcome: supply ? "completed" : "refused",
          },
          {
            decisionHistory: [...record.snapshot.decisionHistory, resolution],
            pendingDecisions: record.snapshot.pendingDecisions.filter(
              (decision) =>
                decision.pendingDecisionId !== input.pendingDecisionId
            ),
            run:
              record.snapshot.run === null
                ? null
                : markSupplied(record.snapshot.run),
            verification:
              record.snapshot.verification === null
                ? null
                : markSupplied(record.snapshot.verification),
          }
        );
        yield* rememberSession(
          input.operationId,
          "variable-supply",
          input.pendingDecisionId,
          requestInput,
          snapshot
        );
        return snapshot;
      }
    );

    /** Resolve or replay a Variable decision, or leave a boundary id alone. */
    const resolveVariableDecisionUnlocked = Effect.fn(
      "AgentSession.resolveVariableDecision"
    )(function* resolveVariableDecision(input: AgentPendingDecisionResolve) {
      // A replay must be recognized after its first supply cleared the
      // decision. Keep only a digest of the literal in the replay key.
      const replayed = replaySession(
        input.operationId,
        "variable-supply",
        input.pendingDecisionId,
        variableResolveRequest(input).requestInput
      );
      if (replayed?._tag === "conflict") {
        return yield* Effect.fail(replayed.error);
      }
      if (replayed?._tag === "replay") {
        return replayed.snapshot;
      }
      const sessionOwner = [...Ref.getUnsafe(sessions).values()].find(
        (candidate) =>
          candidate.snapshot.pendingDecisions.some(
            (decision) =>
              decision.kind === "supply_variable" &&
              decision.pendingDecisionId === input.pendingDecisionId
          )
      );
      if (sessionOwner === undefined) {
        return null;
      }
      return yield* resolveVariableUnlocked(sessionOwner.snapshot.id, input);
    });

    const enterUserVariableUnlocked = Effect.fn(
      "AgentSession.enterUserVariable"
    )(function* enterPrivateVariableAsUser(
      sessionId: AgentSessionId,
      input: Omit<PrivateVariableInput, "ref"> & { readonly ref?: string },
      operationId?: OperationId | string
    ) {
      const requestInput = privateInputFingerprint(input);
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
     * and Workspace still shows a Take control action
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
        if (userLedTeaching(record.snapshot)) {
          return yield* Effect.fail(
            makeBrowserRpcError(
              "agent_control_unavailable",
              "Teaching has no Takeover: the user holds the browser for the whole Demonstration. Takeover belongs to Interactive Runs."
            )
          );
        }
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
        if (userLedTeaching(record.snapshot)) {
          return yield* Effect.fail(
            makeBrowserRpcError(
              "agent_control_unavailable",
              "Teaching control stays with the user: there is nothing to return. End the Demonstration to hand the agent a Teaching Feed to compile."
            )
          );
        }
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

    const assessVerificationStep = Effect.fn(
      "AgentSession.assessVerificationStep"
    )(function* assessDraftStep(
      sessionId: AgentSessionId,
      verification: AgentSessionVerification,
      input: {
        readonly evidence: readonly AgentAssessmentEvidence[];
        readonly explanation: string;
        readonly outcome: AgentAssessmentOutcome;
      },
      operationId: OperationId | string | undefined,
      requestInput: string,
      record: SessionRecord
    ) {
      if (verification.outcome !== null) {
        return yield* Effect.fail(
          error(
            "agent_session_conflict",
            `Verification Run ${verification.authorizationId} has already ended as ${verification.outcome} and accepts no further Agent Assessments.`
          )
        );
      }
      const activeIndex = verification.activeStepIndex;
      const active =
        activeIndex === null ? undefined : verification.steps[activeIndex];
      if (activeIndex === null || active === undefined) {
        return yield* Effect.fail(
          error(
            "agent_session_conflict",
            `Verification Run ${verification.authorizationId} has no active Agent Step to assess.`
          )
        );
      }
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
      const nextIndex = activeIndex + 1;
      const hasNext =
        advancesAgentRun(input.outcome) &&
        nextIndex < verification.steps.length;
      const submittedAt = now().toISOString();
      const next = yield* mutate(sessionId, (snapshot) =>
        snapshot.verification === null
          ? snapshot
          : {
              ...snapshot,
              updatedAt: submittedAt,
              verification: {
                ...snapshot.verification,
                activeStepIndex: hasNext ? nextIndex : null,
                assessments: [
                  ...snapshot.verification.assessments,
                  {
                    attempts: record.runEvidence.attempts.size,
                    evidence: input.evidence,
                    explanation: input.explanation,
                    outcome: input.outcome,
                    stepIndex: activeIndex,
                    submittedAt,
                  },
                ],
              },
            }
      );
      if (next === undefined) {
        return yield* Effect.fail(notRunning(sessionId));
      }
      record.runEvidence.attempts.clear();
      record.runEvidence.snapshots.clear();
      const withEntry = yield* recordEntry(sessionId, {
        actor: "agent",
        at: submittedAt,
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
    });

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
          const { verification } = record.snapshot;
          if (verification === null) {
            return yield* Effect.fail(notRunning(sessionId));
          }
          return yield* assessVerificationStep(
            sessionId,
            verification,
            input,
            operationId,
            requestInput,
            record
          );
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
      clearStorage: (sessionId, tabId, kind) =>
        requireUserHeldRecord(sessionId).pipe(
          Effect.flatMap((record) =>
            browser.clearStorage(record.browserSessionId, tabId, kind)
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
      deleteStorage: (sessionId, tabId, input) =>
        requireUserHeldRecord(sessionId).pipe(
          Effect.flatMap((record) =>
            browser.deleteStorage(record.browserSessionId, tabId, input)
          )
        ),
      emulation: (sessionId) =>
        requireLiveRecord(sessionId).pipe(
          Effect.flatMap((record) =>
            browser.getEmulation(record.browserSessionId).pipe(
              Effect.map((emulation) => ({
                emulation,
                userAgentProfile: record.emulation.userAgentProfile,
              }))
            )
          )
        ),
      enterSuppliedVariable: (sessionId, name, ref, operationId) =>
        Effect.gen(function* enterSuppliedVerificationVariable() {
          const record = yield* requireLiveRecord(sessionId);
          if (userLedTeaching(record.snapshot)) {
            return yield* Effect.fail(
              teachingIsUserLed("This private input was not dispatched.")
            );
          }
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
                `Variable ${name} has not been supplied for this Run. Reread pendingDecisions and ask the user for it in this conversation.`
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
      networkRequest: (sessionId, tabId, requestId) =>
        requireLiveRecord(sessionId).pipe(
          Effect.flatMap((record) =>
            browser.getNetworkRequest(record.browserSessionId, tabId, requestId)
          )
        ),
      networkRequests: (sessionId, tabId) =>
        requireLiveRecord(sessionId).pipe(
          Effect.flatMap((record) =>
            browser.getNetworkRequests(record.browserSessionId, tabId)
          )
        ),
      ownsBrowserSession: (sessionId) =>
        Effect.sync(() =>
          [...Ref.getUnsafe(sessions).values()].some(
            ({ browserSessionId }) => browserSessionId === sessionId
          )
        ),
      pendingDecision: (pendingDecisionId) =>
        Effect.gen(function* findSessionDecision() {
          for (const record of Ref.getUnsafe(sessions).values()) {
            const pending = record.boundaryControl?.pending;
            if (pending?.decision.pendingDecisionId === pendingDecisionId) {
              return pending.decision;
            }
            const variable = record.snapshot.pendingDecisions.find(
              (decision) =>
                decision.kind === "supply_variable" &&
                decision.pendingDecisionId === pendingDecisionId
            );
            if (variable !== undefined) {
              return variable;
            }
          }
          return yield* Effect.fail(
            error(
              "agent_session_conflict",
              `Pending decision ${pendingDecisionId} is stale or unknown. Reread pendingDecisions before asking the user again.`
            )
          );
        }),
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
      recordPendingDecisionState: (
        sessionId,
        pendingDecisions,
        decisionHistory
      ) =>
        Effect.gen(function* mirrorPendingDecisionState() {
          const record = yield* read(sessionId);
          const next = yield* mutate(sessionId, (snapshot) => ({
            ...snapshot,
            decisionHistory: [
              ...snapshot.decisionHistory.filter(sessionOwnedResolution),
              ...decisionHistory,
            ],
            // A paused Execution Boundary and an unsupplied runtime Variable
            // are this session's own decisions, so a catalog mirror must not
            // drop what the user still owes an answer to.
            pendingDecisions: [
              ...snapshot.pendingDecisions.filter(sessionOwnedDecision),
              ...pendingDecisions,
            ],
            updatedAt: now().toISOString(),
          }));
          return next ?? record.snapshot;
        }),
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
      resolvePendingDecision: (input) =>
        lock.withPermit(
          Effect.gen(function* resolveSessionDecision() {
            // A runtime Variable decision and a paused Execution Boundary both
            // live on the session; the id the agent relays says which.
            const variable = yield* resolveVariableDecisionUnlocked(input);
            if (variable !== null) {
              return variable;
            }
            const requestInput = JSON.stringify({
              decision: input.decision,
              pendingDecisionId: input.pendingDecisionId,
              userMessage: input.userMessage ?? null,
            });
            const replayed = replaySession(
              input.operationId,
              "boundary",
              input.pendingDecisionId,
              requestInput
            );
            if (replayed?._tag === "conflict") {
              return yield* Effect.fail(replayed.error);
            }
            if (replayed?._tag === "replay") {
              return replayed.snapshot;
            }
            // A pause names its session, so the id the agent relays is enough
            // to find it; a resolved or replaced pause names none and is a
            // conflict the agent answers by rereading pendingDecisions.
            const located = [...Ref.getUnsafe(sessions).values()].find(
              (candidate) =>
                candidate.boundaryControl?.pending?.decision
                  .pendingDecisionId === input.pendingDecisionId
            );
            if (located === undefined) {
              return yield* Effect.fail(
                error(
                  "agent_session_conflict",
                  `Pending decision ${input.pendingDecisionId} is stale or unknown. Reread pendingDecisions before asking the user again.`
                )
              );
            }
            const record = yield* requireLiveRecord(located.snapshot.id);
            const control = record.boundaryControl;
            const pending = control?.pending;
            if (
              control === undefined ||
              pending === undefined ||
              pending.decision.pendingDecisionId !== input.pendingDecisionId
            ) {
              return yield* Effect.fail(
                error(
                  "agent_session_conflict",
                  "This boundary request is no longer pending."
                )
              );
            }
            const allowed = input.decision === "allow";
            if (!(allowed || input.decision === "refuse")) {
              return yield* Effect.fail(
                error(
                  "agent_session_conflict",
                  `Pending decision ${input.pendingDecisionId} accepts allow or refuse, not ${input.decision}.`
                )
              );
            }
            // Takeover is exclusive, so only the user's refusal is meaningful
            // while they hold the browser (ADR 0027).
            if (allowed && agentIsPaused(record.snapshot)) {
              return yield* Effect.fail(
                takenOver("Return control before confirming an agent attempt.")
              );
            }
            if (allowed) {
              yield* grantBoundary(control, pending);
            }
            control.pending = undefined;
            const decidedAt = now().toISOString();
            const resolution = boundaryResolution(pending, input, decidedAt);
            const snapshot = yield* recordEntry(
              record.snapshot.id,
              {
                actor: "user",
                at: decidedAt,
                description: allowed
                  ? "Confirmed boundary request"
                  : "Refused boundary request",
                detail: `${pending.boundary.description}: ${pending.boundary.requested}`,
                dispatched: false,
                id: randomUUID(),
                outcome: allowed ? "completed" : "refused",
              },
              {
                boundary: null,
                decisionHistory: [
                  ...record.snapshot.decisionHistory,
                  resolution,
                ],
                pendingDecisions: withoutBoundaryDecision(
                  record.snapshot.pendingDecisions
                ),
              }
            );
            yield* rememberSession(
              input.operationId,
              "boundary",
              input.pendingDecisionId,
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
                "Workspace must be served from a loopback URL."
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
      setEmulation: (sessionId, patch) =>
        Effect.gen(function* configureSessionEmulation() {
          const record = yield* requireUserHeldRecord(sessionId);
          if (record.snapshot.activity !== "teaching") {
            return yield* Effect.fail(
              error(
                "agent_session_conflict",
                "An Interactive Run reproduces the Agent Flow's declared Emulation. Configure the browser while Teaching instead."
              )
            );
          }
          const userAgentProfile =
            patch.userAgentProfile ?? record.emulation.userAgentProfile;
          const viewport = patch.viewport ?? record.emulation.viewport;
          if (patch.userAgentProfile === undefined) {
            if (patch.viewport !== undefined) {
              yield* browser.setViewport(record.browserSessionId, viewport);
            }
          } else {
            // An identity only reaches a document at its navigation, so the
            // page the user is on is re-opened under it rather than left
            // claiming an identity it never sent (ADR 0013).
            const url = yield* browser.currentUrl(record.browserSessionId);
            yield* browser.setUserAgent(
              record.browserSessionId,
              url,
              viewport,
              userAgentProfile
            );
          }
          const applied = yield* browser.setEmulation(record.browserSessionId, {
            colorScheme: patch.colorScheme,
            geolocation: patch.geolocation,
            locale: patch.locale,
            permissions: patch.permissions,
            timezoneId: patch.timezoneId,
          });
          yield* rememberEmulation(
            sessionId,
            draftFromApplied(userAgentProfile, applied)
          );
          return { emulation: applied, userAgentProfile };
        }),
      setStorage: (sessionId, tabId, input) =>
        requireUserHeldRecord(sessionId).pipe(
          Effect.flatMap((record) =>
            browser.setStorage(record.browserSessionId, tabId, input)
          )
        ),
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
      storage: (sessionId, tabId, kind) =>
        requireLiveRecord(sessionId).pipe(
          Effect.flatMap((record) =>
            browser.getStorage(record.browserSessionId, tabId, kind)
          )
        ),
      tabs: (sessionId) =>
        requireLiveRecord(sessionId).pipe(
          Effect.flatMap((record) => browser.getTabs(record.browserSessionId))
        ),
      takeover: (sessionId, reason, operationId) =>
        lock.withPermit(
          beginTakeoverUnlocked(sessionId, reason, "user", operationId)
        ),
      teachingFeed: (sessionId, includeSnapshots = false) =>
        requireTeaching(sessionId).pipe(
          Effect.flatMap(({ capture, record }) => {
            if (isLive(record.snapshot.phase)) {
              return Effect.fail(
                error(
                  "agent_session_invalid",
                  "End Teaching before reading the Teaching Feed so Contingency can finalize the local video and generate its PlayByPlay."
                )
              );
            }
            const feed = capture.feed(sessionId, includeSnapshots);
            return feed === undefined
              ? Effect.fail(
                  error(
                    "agent_session_invalid",
                    "The Teaching Feed is unavailable because PlayByPlay analysis did not complete. Close the Teaching session again to retry finalization."
                  )
                )
              : Effect.succeed(feed);
          })
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
          const description = describeCapturedAction(
            actionSubject(record.registry, capturedAction),
            capturedAction,
            {},
            record.capture?.sensitiveValues() ?? []
          );
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

/** Build one process-owned registry for both MCP and Workspace adapters. */
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
