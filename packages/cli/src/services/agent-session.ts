import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  advancesAgentRun,
  AgentProcessId,
  AgentElementRef,
  AgentPendingDecisionId,
  AgentSessionId,
  AgentRunSummary,
  describeActionSubject,
  describeAgentAction,
  makeBrowserRpcError,
  UserAgentProfileId,
  TeachingCaptureState,
  TeachingRecordingCleanupState,
  TeachingRecordingId,
  describeFlowSkillName,
  FlowSkillName,
  isLiveAgentSessionPhase,
  flowSkillNameRule,
  ContentHash,
  OperationId,
  viewportForIdentity,
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
  TaskAgentRunState,
  AgentTaskAssessment,
  AgentRunTaskInput,
  AgentRunTaskVariable,
  AgentRunStep,
  AgentPendingDecision,
  AgentPendingDecisionResolution,
  AgentPendingDecisionResolve,
  DraftEmulation,
  Geolocation,
  PermissionDecision,
  Viewport,
  AgentHistoryAction,
  AgentNavigateAction,
  BrowserInput,
  AgentBrowserAction,
  AgentBrowserSnapshot,
  AgentSnapshotNode,
  AgentScreenshot,
  AgentScreenshotFile,
  AgentInspectedElement,
  AgentSessionActivity,
  AgentSessionController,
  AgentSnapshotId,
  AgentTimelineEntry,
  AgentSessionSnapshot,
  AgentSessionStart,
  AgentSessionVariableState,
  RunSessionSnapshot,
  BrowserStreamEvent,
  BrowserFailureReasonType,
  BrowserRpcErrorType,
  BrowserNetworkRequest,
  BrowserNetworkRequestDetail,
  BrowserStorageSnapshot,
  BrowserStreamId,
  BrowserTab,
  BrowserTabId,
  CapturedUserInput,
  FrameSequence,
  SessionEmulation,
  SessionId,
  StorageKind,
  TeachingInstruction,
  TeachingVariableInput,
  Variable,
  TeachingCaptureLimits,
  TeachingRecordingArtifact,
  TeachingRecordingManifest,
  TeachingStopReason,
} from "@contingency/protocol";
import {
  Cause,
  Clock,
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
  actionTarget,
  beginActionObservation,
  captureAgentScreenshot,
  makeAgentElementRegistry,
  observeAfterAction,
  performAgentAction,
  performPrivateVariableInput,
  redactAgentSnapshot,
  redactKnownValues,
  settledSnapshot,
  snapshotAfterAction,
} from "./agent-browser.ts";
import type {
  ActionObservation,
  AgentElementRegistry,
  PrivateInputTarget,
} from "./agent-browser.ts";
import { installAgentNavigationBoundary } from "./agent-navigation-boundary.ts";
import { AgentRunStore } from "./agent-run-store.ts";
import type { AgentRunStoreService } from "./agent-run-store.ts";
import { CreateBrowser } from "./create-browser-contract.ts";
import type {
  BrowserStorageDeleteInput,
  BrowserStorageSetInput,
  CreateBrowserService,
} from "./create-browser-contract.ts";
import { sanitizeTeachingUrl } from "./sensitive-data.ts";
import { makeDemonstrationCapture } from "./teaching-capture.ts";
import type { DemonstrationCapture } from "./teaching-capture.ts";
import { domainScopeCovers } from "./teaching-demonstration.ts";
import { makeTeachingRecorder } from "./teaching-recorder.ts";
import type { TeachingRecorder } from "./teaching-recorder.ts";
import { TeachingRecordingStore } from "./teaching-recording-store.ts";
import type { TeachingRecordingStoreService } from "./teaching-recording-store.ts";
import { isLoopbackHost } from "./web-url.ts";

/** Options for the one process-owned Agent Session registry. */
export interface AgentSessionServiceOptions {
  readonly allowedActivity: AgentSessionActivity | "any";
  /** The URL at which Workspace is served, normally loopback. */
  readonly baseUrl: string;
  /** Injectable capture ceilings, lowered by focused recording tests. */
  readonly captureLimits?: TeachingCaptureLimits;
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
   * Who opened the session. An agent-opened Teaching session starts in setup
   * with the agent holding the browser so it can prepare prerequisites; a
   * Workspace-opened one starts with the user
   * ([ADR 0042](../../../../docs/adr/0042-agent-controlled-teaching-setup.md)).
   * Only the MCP adapter sets this: it never crosses the Workspace RPC.
   */
  readonly openedBy?: AgentSessionController | undefined;
  /**
   * The Interactive Run this session performs, already resolved from a
   * requested task or a historical ordered Flow Skill. The session owns its
   * execution state and evidence from the moment the browser opens.
   */
  readonly run?: AgentRunState | TaskAgentRunState | undefined;
  /**
   * The Dry Run this session rehearses. A Dry Run follows the saved Flow Skill
   * package rather than ordered Agent Steps, so it names the flow and the
   * Teaching Recording it came from instead of carrying a Run state.
   */
  readonly dryRun?:
    | {
        readonly flowSkillName: FlowSkillName;
        /**
         * The inputs the rehearsal runs with, already masked: a secret input
         * carries a `null` value so no literal reaches the session snapshot.
         */
        readonly inputs: readonly {
          readonly changed: boolean;
          readonly name: string;
          readonly value: string | null;
        }[];
        readonly recordingId: TeachingRecordingId;
        readonly variables?: readonly AgentSessionVariableState[];
      }
    | undefined;
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

/** The public request a prepared start is replayed and compared by. */
export interface AgentSessionStartRequest {
  readonly operationId: OperationId | string;
  /**
   * The caller's canonical encoding of every public field of the request,
   * without generated identities.
   */
  readonly request: string;
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
  /** Begin the user-controlled Teaching privacy boundary. */
  readonly startTeachingRecording: (
    sessionId: AgentSessionId,
    operationId: OperationId | string
  ) => Effect.Effect<AgentSessionSnapshot, AgentSessionError>;
  /** End capture without closing the browser setup. */
  /**
   * Discard a recording the user does not want. The captured artifacts are
   * removed and the session returns to `setup` in the same browser setup.
   */
  readonly discardTeachingRecording: (
    sessionId: AgentSessionId,
    operationId?: OperationId | string
  ) => Effect.Effect<AgentSessionSnapshot, AgentSessionError>;
  /** Rename the Flow Skill this Teaching session is about to demonstrate. */
  readonly renameFlowSkill: (
    sessionId: AgentSessionId,
    name: FlowSkillName,
    operationId?: OperationId | string
  ) => Effect.Effect<AgentSessionSnapshot, AgentSessionError>;
  /**
   * The element the live Page has under a viewport point, read through the
   * Browser Snapshot. Inspect hit-tests the Page, never the screencast frame
   * the Workspace happens to be drawing.
   */
  readonly inspectPoint: (
    sessionId: AgentSessionId,
    x: number,
    y: number
  ) => Effect.Effect<AgentInspectedElement, AgentSessionError>;
  readonly stopTeachingRecording: (
    sessionId: AgentSessionId,
    operationId: OperationId | string
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
  readonly supplyDryRunVariable: (
    sessionId: AgentSessionId,
    name: string,
    value: string
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
  /** Mirror relayed consent state into this session's read-only Workspace. */
  readonly recordPendingDecisionState: (
    sessionId: AgentSessionId,
    pendingDecisions: readonly AgentPendingDecision[],
    decisionHistory: readonly AgentPendingDecisionResolution[]
  ) => Effect.Effect<AgentSessionSnapshot, AgentSessionError>;
  /**
   * Record what the user told the agent to do, as the agent relayed it. The
   * instruction joins the Teaching Recording's event stream in order, beside
   * the actions it explains.
   */
  readonly recordInstruction: (
    sessionId: AgentSessionId,
    text: string,
    operationId?: OperationId | string,
    /** The element the instruction was attached to, when it named one. */
    target?: string | undefined
  ) => Effect.Effect<AgentSessionSnapshot, AgentSessionError>;
  /** Ask the user to take control, and answer immediately with the link. */
  readonly requestTakeover: (
    sessionId: AgentSessionId,
    reason: string,
    operationId?: OperationId | string
  ) => Effect.Effect<AgentSessionSnapshot, AgentSessionError>;
  /**
   * Release an agent-prepared Teaching browser to the user. Only the agent
   * does this, once, before recording; retrying it answers with the same
   * user-held session and never hands control back.
   */
  readonly handOffTeachingSetup: (
    sessionId: AgentSessionId,
    operationId?: OperationId | string
  ) => Effect.Effect<AgentSessionSnapshot, AgentSessionError>;
  /** Hand control back to the agent. Only the user may do this. */
  readonly returnControl: (
    sessionId: AgentSessionId,
    operationId?: OperationId | string
  ) => Effect.Effect<AgentSessionSnapshot, AgentSessionError>;
  /**
   * Capture the Page and answer with the local file the PNG landed in. The
   * bytes never travel inline (ADR 0040).
   */
  readonly screenshot: (
    sessionId: AgentSessionId
  ) => Effect.Effect<AgentScreenshotFile, AgentSessionError>;
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
   * it now emulates so a learned Flow Skill runs under what was demonstrated.
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
  readonly start: (
    input: AgentSessionStartInput
  ) => Effect.Effect<AgentSessionSnapshot, AgentSessionError>;
  /**
   * Start a session whose resources the caller only creates for a new start.
   * The operation receipt compares `request`, the caller's public request,
   * before `prepare` runs, so a retry answers with the session it started and
   * a changed request under a used operation id fails without side effects.
   */
  readonly startPrepared: <E>(
    request: AgentSessionStartRequest,
    prepare: Effect.Effect<AgentSessionStartInput, E>
  ) => Effect.Effect<AgentSessionSnapshot, AgentSessionError | E>;
  /**
   * Enter a Variable the user supplied to this Run into one element. The agent
   * names the Variable, never the value.
   */
  readonly enterSuppliedVariable: (
    sessionId: AgentSessionId,
    name: string,
    ref: string,
    operationId?: OperationId | string,
    flowSkillName?: string
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
  readonly updateTask: <E>(
    sessionId: AgentSessionId,
    prepare: Effect.Effect<
      {
        readonly instruction?: string | undefined;
        readonly skills: readonly {
          readonly flowSkillName: FlowSkillName;
          readonly hosts: readonly string[];
          readonly variables: readonly AgentRunTaskVariable[];
        }[];
        readonly inputs: readonly AgentRunTaskInput[];
      },
      E
    >,
    operationId: OperationId,
    requestInput: string
  ) => Effect.Effect<AgentSessionSnapshot, AgentSessionError | E>;
  readonly assessTask: (
    sessionId: AgentSessionId,
    input: Omit<AgentTaskAssessment, "submittedAt">,
    finding: boolean,
    operationId: OperationId
  ) => Effect.Effect<AgentSessionSnapshot, AgentSessionError>;
  readonly requestTaskVariable: (
    sessionId: AgentSessionId,
    flowSkillName: string,
    name: string,
    operationId: OperationId
  ) => Effect.Effect<AgentSessionSnapshot, AgentSessionError>;
  /**
   * End the Run early and answer with its persistent Run Summary. A Run that
   * already ended finalized itself, so this answers with the Summary it wrote
   * and records the agent's closing account on it. Workspace stays alive in
   * summary mode; the browser does not.
   */
  readonly completeRun: (
    sessionId: AgentSessionId,
    agentAccount?: string,
    operationId?: OperationId | string
  ) => Effect.Effect<AgentRunSummary, AgentSessionError>;
  /**
   * Record that the agent just called a tool on this session. A live Run keeps
   * the time so Workspace can say how long the agent has been idle; nothing
   * ends a Run for being idle
   * ([ADR 0043](../../../../docs/adr/0043-agent-runs-have-no-wall-clock-ceiling.md)).
   */
  readonly noteAgentActivity: (
    sessionId: AgentSessionId
  ) => Effect.Effect<void>;
  /** The read-only Workspace link for one persisted Run. */
  readonly runViewUrl: (
    runId: AgentRunId
  ) => Effect.Effect<string, AgentSessionError>;
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
 * What a Dry Run contributes to its session snapshot. A rehearsal names the
 * Flow Skill and the Teaching Recording it runs, so a reader can tell it from
 * an Interactive Run without the tool result that started it (#202).
 */
const dryRunIdentity = (
  dryRun: AgentSessionStartInput["dryRun"],
  at: string
): Pick<RunSessionSnapshot, "dryRun" | "flowSkillName" | "recordingId"> =>
  dryRun === undefined
    ? { dryRun: null, flowSkillName: null, recordingId: null }
    : {
        dryRun: { ...dryRun, startedAt: at, variables: dryRun.variables ?? [] },
        flowSkillName: dryRun.flowSkillName,
        recordingId: dryRun.recordingId,
      };

const snapshotFromReadyManifest = (
  manifest: TeachingRecordingManifest,
  owner: AgentProcessId,
  baseUrl: string
): AgentSessionSnapshot => {
  const { lifecycle } = manifest;
  const captureState =
    lifecycle._tag === "ready"
      ? {
          _tag: "ready" as const,
          readyAt: lifecycle.readyAt,
          startedAt: lifecycle.startedAt,
          stoppedAt: lifecycle.stoppedAt,
        }
      : lifecycle;
  return {
    activity: "teaching",
    boundary: null,
    captureState,
    clientName: "unknown",
    clientVersion: "unknown",
    controller: "agent",
    createdAt: manifest.createdAt,
    currentUrl: "about:blank",
    decisionHistory: [],
    dryRun: null,
    flowSkillName: manifest.flowSkillName,
    id: manifest.sessionId,
    interruptedAction: null,
    ownerProcessId: owner,
    pendingDecisions: [],
    phase: "closed",
    recordingCleanup: manifest.cleanup,
    recordingId: manifest.recordingId,
    run: null,
    takeover: null,
    teaching: { actionCount: 0, instructionCount: 0, instructions: [] },
    timeline: [],
    updatedAt: manifest.updatedAt,
    viewUrl: viewUrl(baseUrl, manifest.sessionId),
  };
};

const teachingArtifactKind = (
  name: string
): TeachingRecordingArtifact["kind"] | undefined => {
  const lower = name.toLowerCase();
  if (lower.endsWith(".webm") || lower.endsWith(".mp4")) {
    return "video";
  }
  if (lower.endsWith(".zip")) {
    return "trace";
  }
  if (lower.endsWith(".jsonl")) {
    return "events";
  }
  if (
    lower.endsWith(".png") ||
    lower.endsWith(".jpeg") ||
    lower.endsWith(".jpg") ||
    lower.endsWith(".webp")
  ) {
    return "keyframe";
  }
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
 * during Teaching, and what the user supplied to a Run. A Run keeps no
 * Demonstration, so without the supplied literals its Snapshots would hand the
 * agent back the value the user typed privately.
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
 * Whether the agent is preparing an agent-opened Teaching browser. That is the
 * only part of Teaching the agent may drive: setup, before it hands control to
 * the user ([ADR 0042](../../../../docs/adr/0042-agent-controlled-teaching-setup.md)).
 */
const agentPreparesTeaching = (snapshot: AgentSessionSnapshot): boolean =>
  snapshot.activity === "teaching" &&
  snapshot.controller === "agent" &&
  snapshot.captureState._tag === "setup";

/**
 * Teaching is otherwise user-led: the user demonstrates the journey and the
 * agent only observes ([ADR 0038](../../../../docs/adr/0038-contingency-is-an-agent-sanity-monitor.md)).
 * Once the user holds the browser, agent browser actions are refused for the
 * rest of the session.
 */
const userLedTeaching = (snapshot: AgentSessionSnapshot): boolean =>
  snapshot.activity === "teaching" && !agentPreparesTeaching(snapshot);

/** Why an agent browser action cannot run during a Demonstration. */
const teachingIsUserLed = (description: string): BrowserRpcErrorType =>
  makeBrowserRpcError(
    "agent_control_unavailable",
    `${description} Teaching is user-led: the user drives the browser and you observe. You may act only while preparing an agent-opened Teaching session's setup, before agent_teaching_setup_handoff. Record an Instruction with agent_teaching_instruction_record and ask the user to demonstrate the step; browser actions are yours to make during an Interactive Run.`
  );

const isLive = isLiveAgentSessionPhase;

const sameCaptureState = Schema.toEquivalence(TeachingCaptureState);
const sameRecordingCleanup = Schema.toEquivalence(
  TeachingRecordingCleanupState
);

/**
 * Whether the Teaching Recording manifest says something the session snapshot
 * does not. Timestamps cannot answer that: the manifest and the snapshot are
 * stamped by separate writes, so they differ even when they agree (#268).
 */
const manifestDiverges = (
  snapshot: Extract<AgentSessionSnapshot, { readonly activity: "teaching" }>,
  manifest: TeachingRecordingManifest
): boolean =>
  !sameCaptureState(snapshot.captureState, manifest.lifecycle) ||
  snapshot.recordingCleanup === undefined ||
  snapshot.recordingCleanup === null ||
  !sameRecordingCleanup(snapshot.recordingCleanup, manifest.cleanup);

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

/**
 * One scroll gesture is one entry. Wheel events arrive in the dozens per flick
 * of a trackpad, and a learning agent reading the timeline needs "the user
 * scrolled here", not each tick of it.
 */
const SCROLL_COALESCE_KEY = "user-scroll";

const isScroll = (input: BrowserInput): boolean =>
  input.type === "input_mouse" && input.eventType === "mouseWheel";

/**
 * A pointer move is not a step. The Workspace sends one per frame while the
 * pointer travels, so recording them would bury the steps an agent follows
 * and push them out of the timeline's limit (#267).
 */
const isPointerMove = (input: BrowserInput): boolean =>
  input.type === "input_mouse" && input.eventType === "mouseMoved";

/** An observation, or nothing: failing to observe never fails the input. */
const observedOrNothing = <A, E>(
  observe: Effect.Effect<A, E>
): Effect.Effect<A | undefined> =>
  Effect.result(observe).pipe(
    Effect.map((result) =>
      Result.isSuccess(result) ? result.success : undefined
    )
  );

const describeTeachingInput = (input: BrowserInput): string => {
  if (isScroll(input)) {
    return "The user scrolled the Page";
  }
  return input.type === "input_mouse"
    ? `The user sent a ${input.eventType} browser input`
    : `The user sent a ${input.eventType} keyboard input`;
};

/**
 * A key that may edit the focused field. Tab carries text but moves focus
 * instead, so it ends a fill rather than extending it.
 */
const isTextEdit = (input: BrowserInput): boolean =>
  input.type === "input_keyboard" &&
  input.key !== "Tab" &&
  (input.eventType === "char" ||
    (input.eventType === "keyDown" &&
      (input.text !== undefined ||
        input.key === "Backspace" ||
        input.key === "Delete")));

/**
 * Keys that do nothing on their own. The combination they make is carried on
 * the next key's modifiers, so recording them would only split the fill a
 * capital letter or a symbol belongs to (#258).
 */
const MODIFIER_KEYS: ReadonlySet<string> = new Set([
  "Alt",
  "AltGraph",
  "CapsLock",
  "Control",
  "Meta",
  "Shift",
]);

const shouldCaptureRawInput = (input: BrowserInput): boolean =>
  (input.type === "input_keyboard" &&
    input.eventType !== "keyUp" &&
    !MODIFIER_KEYS.has(input.key ?? "")) ||
  (input.type === "input_mouse" && input.eventType === "mouseWheel");

/**
 * A key that types into the field a burst is typing into. Enter can submit
 * the form it is typed in, so it ends the burst and is observed on its own.
 */
const extendsTypingBurst = (input: BrowserInput): boolean =>
  isTextEdit(input) && input.type === "input_keyboard" && input.key !== "Enter";

/**
 * Input that reaches the Page during a burst without ending it: a key coming
 * back up, a modifier held for a capital or a symbol, the pointer drifting.
 */
const passesTypingBurst = (input: BrowserInput): boolean =>
  isPointerMove(input) ||
  (input.type === "input_keyboard" &&
    (input.eventType === "keyUp" || MODIFIER_KEYS.has(input.key ?? "")));

/** How long typing pauses before its burst is recorded. */
const TYPING_BURST_IDLE_MS = 750;

/** Keep public Teaching records free of credentials and sensitive URL values. */
const sanitizeTeachingAction = <A extends AgentBrowserAction>(action: A): A =>
  action.type === "navigate"
    ? ({ ...action, url: sanitizeTeachingUrl(action.url) } satisfies A)
    : action;

/** What a private control's value reads as anywhere it is recorded. */
const SENSITIVE_INPUT = "[sensitive input]";

const sanitizeSensitiveAction = (
  action: AgentBrowserAction,
  sensitive: boolean
): AgentBrowserAction => {
  if (!sensitive) {
    return sanitizeTeachingAction(action);
  }
  switch (action.type) {
    case "fill": {
      return { ...action, text: SENSITIVE_INPUT };
    }
    case "select": {
      return { ...action, values: [SENSITIVE_INPUT] };
    }
    case "press": {
      return { ...action, key: SENSITIVE_INPUT };
    }
    default: {
      return action;
    }
  }
};

/**
 * The value a user edit left in the focused control. A private control's
 * Snapshot node never carries its value, only whether it holds one, so its
 * edit reads as the redaction placeholder: the step stays a readable fill and
 * the secret never enters the record.
 */
const editedValue = (
  node: AgentSnapshotNode | undefined,
  sensitive: boolean
): string | undefined => {
  if (node === undefined || !sensitive) {
    return node?.value ?? undefined;
  }
  return node.valueWithheld === true ? SENSITIVE_INPUT : "";
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

/**
 * How a click reads when the tree recorded beside it does not describe the
 * control it hit. The bare reference is the one thing a later reader cannot
 * use — it is re-minted on every Snapshot and dies with the document — and the
 * Flow Skill contract rejects a step that names one, so an unresolved click
 * says it is unresolved rather than handing on a reference or a name no
 * recorded tree can be joined back to.
 */
export const UNRESOLVED_CLICK_DESCRIPTION = "Click an unidentified control";

/** The control an action names, as the live Snapshot generation described it. */
const actionSubject = (
  registry: AgentElementRegistry,
  action: AgentBrowserAction
): AgentActionSubject | undefined =>
  "ref" in action && action.ref !== undefined
    ? registry.describe(action.ref)
    : undefined;

/**
 * The only words a sensitive control's failure keeps. The raw browser message
 * can quote what was typed; the reason cannot, and it still separates a
 * control that went away from a value the page refused.
 */
const sensitiveFailureMessage = (
  prefix: string,
  reason: BrowserFailureReasonType | undefined
): string => `${prefix} (${reason ?? "unclassified"}).`;

const sensitiveFailure = (
  failure: BrowserRpcErrorType,
  prefix: string
): BrowserRpcErrorType =>
  makeBrowserRpcError(
    failure.code,
    sensitiveFailureMessage(prefix, failure.reason),
    failure.reason
  );

const SENSITIVE_ACTION_FAILED =
  "The browser action failed for a sensitive control";

const sanitizeActionFailure = (
  failure: AgentSessionError,
  action: AgentBrowserAction,
  sensitive: boolean
): AgentSessionError => {
  if (failure._tag !== "BrowserRpcError") {
    return failure;
  }
  if (sensitive) {
    return sensitiveFailure(failure, SENSITIVE_ACTION_FAILED);
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
  failure: AgentSessionError | undefined
): string | undefined => {
  if (sensitive) {
    return sensitiveFailureMessage(
      SENSITIVE_ACTION_FAILED,
      failure?._tag === "BrowserRpcError" ? failure.reason : undefined
    );
  }
  if (action.type === "navigate") {
    return `Could not navigate to ${sanitizeTeachingUrl(action.url)}.`;
  }
  return failure?.message;
};

/**
 * Whether the capture can take one more private Variable at this target.
 * Both the typed-into controls and the boxes a page may spread the value
 * across are checked, since the entry records whichever accepted it.
 */
const canRecordPrivateInput = (
  capture: DemonstrationCapture,
  variable: Variable,
  value: string,
  target: PrivateInputTarget
): boolean =>
  capture.canRecordVariable(variable, value, target.selector) &&
  (target.spread === undefined ||
    capture.canRecordVariable(variable, value, target.spread));

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
 * about it: coverage answers "was this checked", not "did it work".
 */
export const coverageOf = (
  steps: readonly AgentRunStep[]
): AgentRunCoverage => {
  const executed = steps.filter((step) => step.execution === "assessed").length;
  return {
    complete: executed === steps.length,
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
type LiveRun = AgentRunState | TaskAgentRunState;
const isTaskRun = (run: LiveRun): run is TaskAgentRunState =>
  "schemaVersion" in run;
const withDerivedRunTotals = (run: LiveRun): LiveRun =>
  isTaskRun(run)
    ? run
    : {
        ...run,
        assessmentCounts: assessmentCountsOf(run.steps),
        coverage: coverageOf(run.steps),
      };
const runEnded = (run: LiveRun): boolean =>
  isTaskRun(run) ? run.lifecycle.phase === "ended" : run.outcome !== null;

const endClosedRun = (run: LiveRun | null, at: string): LiveRun | null => {
  if (run === null || runEnded(run)) {
    return run;
  }
  if (isTaskRun(run)) {
    return {
      ...run,
      lifecycle: { endedAt: at, outcome: "user-closed", phase: "ended" },
    };
  }
  return withDerivedRunTotals({
    ...run,
    activeStepIndex: null,
    endedAt: at,
    outcome: "interrupted",
    steps: markRemainingUnexecuted(run.steps),
  });
};
const activateRun = (
  run: LiveRun | null,
  at: string,
  emulation: DraftEmulation
): LiveRun | null => {
  if (run === null) {
    return null;
  }
  if (isTaskRun(run)) {
    return {
      ...run,
      lastAgentActivityAt: at,
      startedAt: at,
      startingEmulation: emulation,
    };
  }
  return withDerivedRunTotals({
    ...run,
    activeStepIndex: 0,
    lastAgentActivityAt: at,
    startedAt: at,
    steps: run.steps.map((step, index) =>
      index === 0 ? { ...step, execution: "active", startedAt: at } : step
    ),
  });
};

const variableKey = (name: string, flowSkillName?: string | null): string =>
  flowSkillName === undefined || flowSkillName === null
    ? name
    : JSON.stringify([flowSkillName, name]);

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
    record.snapshot.run === null ||
    (!isTaskRun(record.snapshot.run) &&
      record.snapshot.run.activeStepIndex === null)
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
  snapshot.run !== null && runEnded(snapshot.run);

const TIMELINE_LIMIT = 200;
const VERIFIED_REFERENCE_PATTERN = /^- Verified: (?<verifiedAt>.+)$/mu;

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
  readonly dryRunControl: { hadTakeover: boolean };
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
  /**
   * The Run Summary this session finalized, and whether the Catalog Root has
   * it. A Run is finalized exactly once, however it ends, but a Summary is
   * only persisted when its write lands: a failed write leaves the Summary
   * here for `agent_run_complete` to retry rather than claiming it is stored.
   */
  readonly finalized: {
    persisted: boolean;
    summary: AgentRunSummary | undefined;
  };
  readonly scope: Scope.Closeable;
  readonly snapshot: AgentSessionSnapshot;
  /**
   * Runtime Variable values the user supplied to this Run. They live for the
   * session and are never published, persisted, or returned.
   */
  readonly supplied: Map<string, string>;
  /** Start-scoped capture resources. Absent during setup and after Stop. */
  readonly teachingRecorder: TeachingRecorder | undefined;
  /** The local sensitive-artifact retention manifest. */
  readonly retentionFile: string | undefined;
  /**
   * Where this session writes the screenshots an agent asked for. It is made
   * on the first capture and removed with the session scope, so a session that
   * never took one leaves nothing behind.
   */
  readonly screenshots: { directory: string | undefined };
  /**
   * The field the open fill is typing into, by the reference its last edit
   * left focused. Consecutive edits extend that fill only while they land on
   * the same element, however the Page reorders around it.
   */
  readonly textEdit: {
    /** The typing burst still reaching the Page, observed at its start only. */
    burst: TypingBurst | undefined;
    open: { readonly key: string; readonly ref: AgentElementRef } | undefined;
  };
  /** A scroll photograph waits for input to pause rather than blocking it. */
  readonly scroll: { burst: ScrollBurst | undefined };
}

interface ScrollBurst {
  readonly close: Effect.Effect<void>;
  readonly capture: DemonstrationCapture;
  readonly actionId: string;
  readonly page: Page;
  lastInputAt: number;
}

/**
 * Keys the user types into one field with nothing else in between. The field
 * is observed once when the burst starts and once when it ends, so a key goes
 * to the Page without waiting on a Browser Snapshot of it (#298).
 */
interface TypingBurst {
  /** When the first key landed: the moment the Fill it records began. */
  readonly at: string;
  /** Record the burst and end it. Only the control lock's holder runs it. */
  readonly close: Effect.Effect<void>;
  readonly focused: FocusedTextControl;
  readonly id: string;
  /** Every key the burst sent, in order: its record if it proves no edit. */
  readonly keys: BrowserInput[];
  /** When the latest key was sent, on the Effect clock. */
  lastKeyAt: number;
  readonly page: Page;
  readonly snapshotBefore: AgentSnapshotId | null;
  readonly urlBefore: string;
}

/** The control a keystroke was sent to, as the tree before it read it. */
interface FocusedTextControl {
  readonly node: AgentSnapshotNode;
  readonly ref: AgentElementRef;
  readonly sensitive: boolean;
  /**
   * The private control's value as a digest. Its node withholds the value, so
   * this is what shows whether a keystroke changed it.
   */
  readonly valueDigest: string | undefined;
}

/** Evidence capture exists only between the user's Start and Stop gestures. */
const recordingCapture = (
  record: SessionRecord
): DemonstrationCapture | undefined =>
  record.snapshot.activity === "teaching" &&
  record.snapshot.captureState._tag === "recording"
    ? record.capture
    : undefined;

interface AgentSessionPatch {
  readonly boundary?: AgentSessionSnapshot["boundary"];
  readonly currentUrl?: string;
  readonly decisionHistory?: AgentSessionSnapshot["decisionHistory"];
  readonly pendingDecisions?: AgentSessionSnapshot["pendingDecisions"];
  readonly run?: AgentRunState | TaskAgentRunState | null;
}

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
  const { run } = record.snapshot;
  const step =
    run === null || isTaskRun(run)
      ? undefined
      : run.steps.find((candidate) => candidate.index === run.activeStepIndex);
  const mutating = !["navigate", "hover", "scroll", "wait_for_text"].includes(
    action.type
  );
  // A Flow Skill step the agent marked as needing confirmation scopes the
  // marker to that Step. Without one, retain the conservative guard so
  // omission cannot bypass it.
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
 */
const boundaryObjective = (
  record: SessionRecord,
  intent: AgentActionIntent
): string => {
  if (intent.objective !== undefined) {
    return intent.objective;
  }
  const { run } = record.snapshot;
  if (run === null) {
    return "An action the agent did not name an objective for";
  }
  if (isTaskRun(run)) {
    return run.instructions.at(-1)?.instruction ?? run.requestedTask;
  }
  return (
    run.steps.find((step) => step.index === run.activeStepIndex)?.description ??
    "An action the agent did not name an objective for"
  );
};

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
      : "Allow this objective outside the Flow Skill's Agent Steps once";
  return `${what}: ${boundary.description} (${boundary.requested}). A retry needs another decision.`;
};

const boundaryPendingDecision = (
  snapshot: AgentSessionSnapshot,
  boundary: AgentExecutionBoundary,
  at: string
): AgentPendingDecision => ({
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
  const declaring = snapshot.run;
  if (declaring === null || isTaskRun(declaring)) {
    return [];
  }
  return declaring.variables.flatMap((variable) =>
    variable.runtime && !variable.supplied
      ? [
          {
            boundaryId: null,
            createdAt: at,
            kind: "supply_variable" as const,
            pendingDecisionId: AgentPendingDecisionId.make(
              `pending-${randomUUID()}`
            ),
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
    boundaryId: null,
    decidedAt,
    decision: input.decision,
    kind: "supply_variable",
    operationId: input.operationId,
    pendingDecisionId: pending.pendingDecisionId,
    // The name is audited; the literal the user supplied never is.
    variableName: pending.variable?.name ?? null,
  } satisfies Omit<AgentPendingDecisionResolution, "userMessage">;
  const scoped =
    pending.variable?.flowSkillName === undefined
      ? base
      : { ...base, variableFlowSkillName: pending.variable.flowSkillName };
  if (userMessage === undefined || userMessage === null) {
    return scoped;
  }
  return { ...scoped, userMessage };
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
    boundaryId: pending.boundary.id,
    decidedAt,
    decision: input.decision,
    kind: "boundary",
    operationId: input.operationId,
    pendingDecisionId: pending.decision.pendingDecisionId,
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
  | "task-update"
  | "task-assess"
  | "task-finding"
  | "variable-request"
  | "close"
  | "complete"
  | "control"
  | "handoff"
  | "instruction"
  | "private-input"
  | "recording-discard"
  | "recording-rename"
  | "recording-start"
  | "recording-stop"
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

const makeAgentSession = (
  browser: CreateBrowserService,
  options: AgentSessionServiceOptions,
  events: PubSub.PubSub<AgentSessionSnapshot>,
  fileSystem?: FileSystem.FileSystem,
  parentScope?: Scope.Scope,
  teachingRecordingStore?: TeachingRecordingStoreService,
  runStore?: AgentRunStoreService
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

    const writeTeachingRetentionManifest = (
      directory: string,
      sessionId: AgentSessionId,
      traceFile: string,
      videoFiles: readonly string[],
      /**
       * Keyframes are unredacted-by-best-effort images of the user's own
       * screen, so they are retained under the same local-only policy as the
       * Trace and the video rather than being left unnamed.
       */
      keyframeFiles: readonly string[] = []
    ): Effect.Effect<string | undefined, AgentSessionError> =>
      Effect.gen(function* writeSensitiveArtifactMetadata() {
        if (fileSystem === undefined) {
          return;
        }
        const retentionFile = path.join(
          directory,
          `${sessionId}.artifacts.json`
        );
        yield* fileSystem
          .writeFileString(
            retentionFile,
            `${JSON.stringify(
              {
                files: {
                  keyframes: keyframeFiles
                    .map((file) => path.basename(file))
                    .toSorted(),
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

    const collectTeachingArtifacts = (
      directory: string
    ): Effect.Effect<readonly TeachingRecordingArtifact[], AgentSessionError> =>
      Effect.gen(function* hashTeachingArtifacts() {
        if (fileSystem === undefined) {
          return [];
        }
        const exists = yield* fileSystem
          .exists(directory)
          .pipe(Effect.orElseSucceed(() => false));
        if (!exists) {
          return [];
        }
        const names = yield* fileSystem
          .readDirectory(directory)
          .pipe(
            Effect.mapError((cause) =>
              error(
                "agent_session_invalid",
                `Could not list Teaching artifacts: ${cause.message}`
              )
            )
          );
        const capturedAt = now().toISOString();
        const artifacts: TeachingRecordingArtifact[] = [];
        for (const name of names) {
          if (
            name === "manifest.json" ||
            name.endsWith(".tmp") ||
            name.endsWith(".artifacts.json")
          ) {
            continue;
          }
          const kind = teachingArtifactKind(name);
          if (kind === undefined) {
            continue;
          }
          const bytes = yield* fileSystem
            .readFile(path.join(directory, name))
            .pipe(
              Effect.mapError((cause) =>
                error(
                  "agent_session_invalid",
                  `Could not read Teaching artifact ${name}: ${cause.message}`
                )
              )
            );
          artifacts.push({
            capturedAt,
            hash: ContentHash.make(
              `sha256-${createHash("sha256").update(bytes).digest("hex")}`
            ),
            id: path.parse(name).name,
            kind,
            path: name,
          });
        }
        return artifacts;
      });

    /**
     * Photograph the Page one recorded action left behind. Keyframes are the
     * only visual evidence a learning agent can read — the video and the Trace
     * never reach it — so each recorded action carries one, stored among the
     * recording's artifacts and referenced from the semantic timeline by id and
     * hash alone
     * ([ADR 0039](../../../../docs/adr/0039-flow-skills-are-learned-from-temporary-teaching-recordings.md)).
     *
     * Best effort: a Page that navigated out from under the screenshot leaves
     * the action recorded without an image rather than failing the gesture the
     * user already performed.
     */
    const captureTeachingKeyframe = (
      record: SessionRecord,
      page: Page,
      actionId: string,
      at: string,
      force = false
    ): Effect.Effect<void> =>
      Effect.gen(function* photographTeachingAction() {
        const capture = recordingCapture(record);
        if (
          capture === undefined ||
          !(force || capture.needsKeyframe(actionId, at))
        ) {
          return;
        }
        const keyframe = yield* captureAgentScreenshot(
          page,
          now,
          true,
          sessionSensitiveValues(record),
          capture.sensitiveSelectors()
        ).pipe(Effect.option);
        if (Option.isSome(keyframe)) {
          capture.recordKeyframe(keyframe.value, actionId);
        }
      });

    const readyTeachingSnapshot = (
      sessionId: AgentSessionId
    ): Effect.Effect<AgentSessionSnapshot | null> =>
      teachingRecordingStore === undefined
        ? Effect.succeed(null)
        : teachingRecordingStore.listReady().pipe(
            Effect.map((ready) => {
              const [manifest] = ready
                .filter((item) => item.sessionId === sessionId)
                .toSorted((left, right) =>
                  right.updatedAt.localeCompare(left.updatedAt)
                );
              return manifest === undefined
                ? null
                : snapshotFromReadyManifest(manifest, owner, options.baseUrl);
            }),
            Effect.orElseSucceed(() => null)
          );

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

    /**
     * Run once the input the user already sent has been recorded. User input
     * holds the session's control lock from dispatch until its action is
     * captured, so a Stop that lands mid-keystroke would otherwise end the
     * recording before the key it followed reached it.
     */
    const afterUserInput = <A, E, R>(
      sessionId: AgentSessionId,
      effect: Effect.Effect<A, E, R>
    ): Effect.Effect<A, E, R> => {
      const record = Ref.getUnsafe(sessions).get(sessionId);
      return record === undefined
        ? effect
        : record.control.lock.withPermit(
            Effect.suspend(
              () => record.textEdit.burst?.close ?? Effect.void
            ).pipe(
              Effect.andThen(
                Effect.suspend(() => record.scroll.burst?.close ?? Effect.void)
              ),
              Effect.andThen(effect)
            )
          );
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

    const saveRecord = (
      sessionId: AgentSessionId,
      record: SessionRecord
    ): Effect.Effect<void> =>
      Ref.update(sessions, (current) =>
        new Map(current).set(sessionId, record)
      ).pipe(Effect.andThen(publish(record.snapshot)));

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

    /** Save a Page URL observed without inventing an action for that read. */
    const rememberCurrentUrl = (
      sessionId: AgentSessionId,
      record: SessionRecord,
      currentUrl: string
    ): Effect.Effect<AgentSessionSnapshot | undefined> =>
      mutate(sessionId, (snapshot) => {
        const safeCurrentUrl = sanitizeTeachingUrl(currentUrl);
        if (snapshot.currentUrl === safeCurrentUrl) {
          return snapshot;
        }
        const at = new Date(
          Math.max(now().getTime(), Date.parse(snapshot.updatedAt) + 1)
        ).toISOString();
        recordingCapture(record)?.recordUrl(currentUrl, at);
        return { ...snapshot, currentUrl: safeCurrentUrl, updatedAt: at };
      });

    /**
     * The browser is the authority on where it is. Takeover can navigate
     * without an action path, so session reads check the active Page. A URL
     * change reaches Workspace through the session stream.
     */
    const refreshedSnapshot = (
      sessionId: AgentSessionId,
      record: SessionRecord
    ): Effect.Effect<AgentSessionSnapshot> => {
      const browserRefresh = browser.currentUrl(record.browserSessionId).pipe(
        Effect.flatMap((currentUrl) =>
          rememberCurrentUrl(sessionId, record, currentUrl)
        ),
        Effect.map((next) => next ?? record.snapshot),
        Effect.orElseSucceed(() => record.snapshot)
      );
      if (
        record.snapshot.activity !== "teaching" ||
        teachingRecordingStore === undefined
      ) {
        return browserRefresh;
      }
      return browserRefresh.pipe(
        Effect.flatMap((snapshot) =>
          snapshot.activity === "teaching"
            ? Effect.result(
                teachingRecordingStore.read(snapshot.recordingId)
              ).pipe(
                Effect.flatMap((readResult) => {
                  if (Result.isSuccess(readResult)) {
                    const manifest = readResult.success;
                    // `updatedAt` only moves forward: a manifest written
                    // before the snapshot's last change keeps its lifecycle
                    // but not its older timestamp.
                    return mutate(sessionId, (current) =>
                      current.activity === "teaching" &&
                      manifestDiverges(current, manifest)
                        ? {
                            ...current,
                            captureState: manifest.lifecycle,
                            recordingCleanup: manifest.cleanup,
                            updatedAt:
                              manifest.updatedAt > current.updatedAt
                                ? manifest.updatedAt
                                : now().toISOString(),
                          }
                        : current
                    ).pipe(Effect.map((next) => next ?? snapshot));
                  }
                  if (
                    fileSystem === undefined ||
                    snapshot.captureState._tag !== "dry-run-passed"
                  ) {
                    return Effect.succeed(snapshot);
                  }
                  const catalogRoot = path.dirname(
                    path.dirname(
                      teachingRecordingStore.directory(snapshot.recordingId)
                    )
                  );
                  const verificationFile = path.join(
                    path.dirname(
                      path.join(catalogRoot, snapshot.captureState.skillPath)
                    ),
                    "references/verification.md"
                  );
                  return fileSystem.readFileString(verificationFile).pipe(
                    Effect.flatMap((contents) => {
                      const verifiedAt =
                        VERIFIED_REFERENCE_PATTERN.exec(contents)?.groups
                          ?.verifiedAt;
                      if (verifiedAt === undefined) {
                        return Effect.succeed(snapshot);
                      }
                      return mutate(sessionId, (current) =>
                        current.activity === "teaching" &&
                        current.captureState._tag === "dry-run-passed"
                          ? {
                              ...current,
                              captureState: {
                                ...current.captureState,
                                _tag: "verified" as const,
                                verifiedAt,
                              },
                              recordingCleanup: {
                                _tag: "purged" as const,
                                completedAt: verifiedAt,
                              },
                              updatedAt: verifiedAt,
                            }
                          : current
                      ).pipe(Effect.map((next) => next ?? snapshot));
                    }),
                    Effect.orElseSucceed(() => snapshot)
                  );
                })
              )
            : Effect.succeed(snapshot)
        )
      );
    };

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

    const requireScreenshotFileSystem = (): Effect.Effect<
      FileSystem.FileSystem,
      AgentSessionError
    > =>
      fileSystem === undefined
        ? Effect.fail(
            error(
              "agent_session_invalid",
              "Writing a screenshot requires a FileSystem service."
            )
          )
        : Effect.succeed(fileSystem);

    /**
     * The directory this session's screenshots are written into, made on
     * first use and removed with the session scope.
     */
    const screenshotDirectory = (
      record: SessionRecord,
      files: FileSystem.FileSystem
    ): Effect.Effect<string, AgentSessionError> => {
      const existing = record.screenshots.directory;
      if (existing !== undefined) {
        return Effect.succeed(existing);
      }
      return Scope.provide(record.scope)(
        Effect.acquireRelease(
          files.makeTempDirectory({
            directory: options.resourceDirectory ?? tmpdir(),
            prefix: "screenshots-",
          }),
          (created) =>
            files.remove(created, { recursive: true }).pipe(Effect.ignore)
        )
      ).pipe(
        Effect.mapError((cause) =>
          error(
            "agent_session_invalid",
            `Could not create a screenshot directory: ${cause.message}`
          )
        ),
        Effect.tap((directory) =>
          Effect.sync(() => {
            record.screenshots.directory = directory;
          })
        )
      );
    };

    /**
     * Land one capture in a local PNG and answer with its path. A full-density
     * mobile screenshot is around a megabyte of base64, which no agent can read
     * as a tool result, so the bytes stay on disk and the agent opens the file
     * with its own tools (ADR 0040).
     */
    const writeScreenshotFile = (
      record: SessionRecord,
      screenshot: AgentScreenshot
    ): Effect.Effect<AgentScreenshotFile, AgentSessionError> =>
      Effect.gen(function* writeScreenshot() {
        const files = yield* requireScreenshotFileSystem();
        const directory = yield* screenshotDirectory(record, files);
        const bytes = Buffer.from(screenshot.image, "base64");
        const file = path.join(directory, `screenshot-${randomUUID()}.png`);
        yield* files
          .writeFile(file, bytes)
          .pipe(
            Effect.mapError((cause) =>
              error(
                "agent_session_invalid",
                `Could not write the screenshot: ${cause.message}`
              )
            )
          );
        return {
          bytes: bytes.byteLength,
          capturedAt: screenshot.capturedAt,
          format: screenshot.format,
          path: file,
          url: screenshot.url,
        };
      });

    const finishTeachingClose = (
      sessionId: AgentSessionId,
      record: SessionRecord,
      finalizing: Extract<
        AgentSessionSnapshot,
        { readonly activity: "teaching" }
      > & {
        readonly captureState: {
          readonly _tag: "finalizing";
          readonly startedAt: string;
          readonly stoppedAt: string;
        };
      },
      operationId?: OperationId | string
    ): Effect.Effect<AgentSessionSnapshot, AgentSessionError> =>
      Effect.gen(function* finishTeachingRecording() {
        if (teachingRecordingStore !== undefined) {
          const artifacts = yield* collectTeachingArtifacts(
            teachingRecordingStore.directory(finalizing.recordingId)
          );
          yield* teachingRecordingStore
            .stop({
              artifacts,
              operationId: OperationId.make(
                operationId ?? `close-${sessionId}`
              ),
              recordingId: finalizing.recordingId,
            })
            .pipe(
              Effect.mapError((cause) =>
                error("agent_session_invalid", cause.message)
              )
            );
        }
        const readyAt = now().toISOString();
        const ready: AgentSessionSnapshot = {
          ...finalizing,
          captureState: {
            _tag: "ready",
            readyAt,
            startedAt: finalizing.captureState.startedAt,
            stoppedAt: finalizing.captureState.stoppedAt,
          },
          updatedAt: readyAt,
        };
        yield* save(sessionId, record, ready);
        return ready;
      });

    const stopTeachingRecordingUnlocked = Effect.fn(
      "AgentSession.stopTeachingRecording"
    )(function* stopTeachingRecording(
      sessionId: AgentSessionId,
      operationId: OperationId | string,
      reason: TeachingStopReason = "user"
    ) {
      const requestInput = "";
      const replayed = replaySession(
        operationId,
        "recording-stop",
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
      if (
        record.snapshot.activity !== "teaching" ||
        record.snapshot.captureState._tag !== "recording" ||
        record.capture === undefined ||
        record.teachingRecorder === undefined ||
        teachingRecordingStore === undefined ||
        record.artifactDirectory === undefined
      ) {
        return yield* Effect.fail(
          error(
            "agent_session_conflict",
            `Agent Session ${sessionId} has no active Teaching recording.`
          )
        );
      }
      // A gesture the user was still making when they stopped has no action
      // after it to observe the Page it left behind, so it is closed here.
      // Best effort: a browser already gone must not fail the Stop.
      const { capture } = record;
      // Closing the gesture forgets it, so its identity is read first: the
      // same reasoning covers its keyframe, which still holds a state the user
      // was moving through rather than the one they left on the screen.
      const openActionId = capture.openActionId();
      yield* browser.activePage(record.browserSessionId).pipe(
        Effect.flatMap((page) =>
          snapshotAfterAction(page, record.registry, page.url()).pipe(
            Effect.tap((snapshot) =>
              Effect.sync(() =>
                capture.closeCoalescedAction(
                  redactCapturedSnapshot(record, snapshot)
                )
              )
            ),
            Effect.flatMap(() =>
              openActionId === undefined
                ? Effect.void
                : captureTeachingKeyframe(
                    record,
                    page,
                    openActionId,
                    now().toISOString(),
                    true
                  )
            )
          )
        ),
        Effect.ignore
      );
      // Read only once the open gesture is photographed, and on the capture's
      // own clock, so no event the recording holds reads later than its Stop.
      const stoppedAt = capture.stopTime(now().toISOString());
      const { startedAt } = record.snapshot.captureState;
      const finalizing: AgentSessionSnapshot = {
        ...record.snapshot,
        captureState: {
          _tag: "finalizing",
          startedAt,
          stoppedAt,
        },
        updatedAt: stoppedAt,
      };
      // Publish `finalizing` first: `recordingCapture` gates on `recording`, so
      // this is what actually ends semantic capture on the same timestamp as the
      // video and the trace, instead of letting it run through encoder drain.
      yield* save(sessionId, record, finalizing);
      const recorderResult = yield* record.teachingRecorder.stop(
        record.capture.current(),
        reason,
        stoppedAt
      );
      const { failure } = recorderResult;
      // Hashing comes first so the retention manifest names the keyframes that
      // actually reached the directory rather than the ones capture held.
      const artifacts = yield* collectTeachingArtifacts(
        record.artifactDirectory
      );
      const retentionFile = yield* writeTeachingRetentionManifest(
        record.artifactDirectory,
        sessionId,
        recorderResult.traceFile,
        [recorderResult.videoFile],
        artifacts.flatMap((artifact) =>
          artifact.kind === "keyframe" ? [artifact.path] : []
        )
      );
      const manifest = yield* teachingRecordingStore
        .stop({
          artifacts,
          failure,
          operationId: OperationId.make(operationId),
          recordingId: record.snapshot.recordingId,
        })
        .pipe(
          Effect.mapError((cause) =>
            error("agent_session_invalid", cause.message)
          )
        );
      const captureState =
        manifest.lifecycle._tag === "failed"
          ? manifest.lifecycle
          : {
              _tag: "ready" as const,
              readyAt:
                manifest.lifecycle._tag === "ready"
                  ? manifest.lifecycle.readyAt
                  : now().toISOString(),
              startedAt,
              stoppedAt,
            };
      const finished: AgentSessionSnapshot = {
        ...finalizing,
        captureState,
        teaching: record.capture.progress(),
        updatedAt:
          captureState._tag === "failed"
            ? captureState.failedAt
            : captureState.readyAt,
      };
      yield* saveRecord(sessionId, {
        ...record,
        retentionFile,
        snapshot: finished,
        teachingRecorder: undefined,
      });
      yield* rememberSession(
        operationId,
        "recording-stop",
        sessionId,
        requestInput,
        finished
      );
      return finished;
    });

    /**
     * Throwing away a recording the user does not want to keep. Deletion is a
     * user gesture, never an agent one: the Workspace is the only caller, and
     * it returns the session to `setup` so the same browser setup records
     * again without carrying the discarded evidence (ADR 0039).
     */
    const discardTeachingRecordingUnlocked = Effect.fn(
      "AgentSession.discardTeachingRecording"
    )(function* discardTeachingRecording(
      sessionId: AgentSessionId,
      operationId: OperationId | string
    ) {
      const requestInput = "";
      const replayed = replaySession(
        operationId,
        "recording-discard",
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
      if (
        record.snapshot.activity !== "teaching" ||
        !isLive(record.snapshot.phase)
      ) {
        return yield* Effect.fail(
          error(
            "agent_session_conflict",
            `Agent Session ${sessionId} is not a live Teaching session.`
          )
        );
      }
      if (
        record.snapshot.captureState._tag !== "ready" &&
        record.snapshot.captureState._tag !== "failed"
      ) {
        return yield* Effect.fail(
          error(
            "agent_session_conflict",
            `A Teaching Recording cannot be discarded from ${record.snapshot.captureState._tag}.`
          )
        );
      }
      if (teachingRecordingStore === undefined) {
        return yield* Effect.fail(
          error(
            "agent_session_unavailable",
            "Teaching recording storage is unavailable in this process."
          )
        );
      }
      // The retention manifest names the Trace and the video this recording
      // wrote. Discarding removes those files, so the note that points at them
      // goes with them rather than outliving what it describes.
      if (record.retentionFile !== undefined && fileSystem !== undefined) {
        yield* fileSystem
          .remove(record.retentionFile, { force: true })
          .pipe(Effect.ignore);
      }
      const manifest = yield* teachingRecordingStore
        .discard({
          operationId: OperationId.make(operationId),
          recordingId: record.snapshot.recordingId,
        })
        .pipe(
          Effect.mapError((cause) =>
            error("agent_session_invalid", cause.message)
          )
        );
      if (manifest.lifecycle._tag !== "setup") {
        return yield* Effect.fail(
          error(
            "agent_session_conflict",
            `Teaching Recording ${record.snapshot.recordingId} did not return to setup.`
          )
        );
      }
      // The timeline describes the discarded Demonstration, so it goes with
      // it: `setup` after a deletion is a clean bundle, not one that still
      // lists actions whose evidence is gone.
      const discarded: AgentSessionSnapshot = {
        ...record.snapshot,
        captureState: manifest.lifecycle,
        teaching: { actionCount: 0, instructionCount: 0, instructions: [] },
        timeline: [],
        updatedAt: manifest.lifecycle.requestedAt,
      };
      yield* saveRecord(sessionId, {
        ...record,
        artifactDirectory: undefined,
        capture: undefined,
        retentionFile: undefined,
        snapshot: discarded,
        traceFile: undefined,
        videoFile: undefined,
      });
      yield* rememberSession(
        operationId,
        "recording-discard",
        sessionId,
        requestInput,
        discarded
      );
      return discarded;
    });

    /**
     * Renaming the Flow Skill before anything is captured. The name is only
     * changeable in `setup`: once a recording exists the bundle on disk is
     * already filed under the name it was begun with.
     */
    const renameFlowSkillUnlocked = Effect.fn("AgentSession.renameFlowSkill")(
      function* renameFlowSkill(
        sessionId: AgentSessionId,
        name: FlowSkillName,
        operationId: OperationId | string
      ) {
        const requestInput = JSON.stringify({ name });
        const replayed = replaySession(
          operationId,
          "recording-rename",
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
        if (
          record.snapshot.activity !== "teaching" ||
          !isLive(record.snapshot.phase)
        ) {
          return yield* Effect.fail(
            error(
              "agent_session_conflict",
              `Agent Session ${sessionId} is not a live Teaching session.`
            )
          );
        }
        if (record.snapshot.captureState._tag !== "setup") {
          return yield* Effect.fail(
            error(
              "agent_session_conflict",
              `A Flow Skill cannot be renamed from ${record.snapshot.captureState._tag}.`
            )
          );
        }
        if (teachingRecordingStore !== undefined) {
          yield* teachingRecordingStore
            .rename({
              flowSkillName: name,
              operationId: OperationId.make(operationId),
              recordingId: record.snapshot.recordingId,
            })
            .pipe(
              Effect.mapError((cause) =>
                error("agent_session_invalid", cause.message)
              )
            );
        }
        const renamed: AgentSessionSnapshot = {
          ...record.snapshot,
          flowSkillName: name,
          updatedAt: now().toISOString(),
        };
        yield* save(sessionId, record, renamed);
        yield* rememberSession(
          operationId,
          "recording-rename",
          sessionId,
          requestInput,
          renamed
        );
        return renamed;
      }
    );

    const startTeachingRecordingUnlocked = Effect.fn(
      "AgentSession.startTeachingRecording"
    )(function* startTeachingRecording(
      sessionId: AgentSessionId,
      operationId: OperationId | string
    ) {
      const requestInput = "";
      const replayed = replaySession(
        operationId,
        "recording-start",
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
      if (
        record.snapshot.activity !== "teaching" ||
        !isLive(record.snapshot.phase)
      ) {
        return yield* Effect.fail(
          error(
            "agent_session_conflict",
            `Agent Session ${sessionId} is not a live Teaching session.`
          )
        );
      }
      if (
        record.snapshot.captureState._tag !== "setup" &&
        record.snapshot.captureState._tag !== "ready" &&
        record.snapshot.captureState._tag !== "failed"
      ) {
        return yield* Effect.fail(
          error(
            "agent_session_conflict",
            `Teaching cannot start from ${record.snapshot.captureState._tag}.`
          )
        );
      }
      // Recording is user-led: the user takes responsibility for the
      // demonstrated journey at the handoff, so Start waits for it.
      if (record.snapshot.controller !== "user") {
        return yield* Effect.fail(
          makeBrowserRpcError(
            "agent_control_unavailable",
            "The agent is preparing the browser. Start recording becomes available once it hands you control."
          )
        );
      }
      if (teachingRecordingStore === undefined || fileSystem === undefined) {
        return yield* Effect.fail(
          error(
            "agent_session_unavailable",
            "Teaching recording storage is unavailable in this process."
          )
        );
      }
      const operation = OperationId.make(operationId);
      const recordingId =
        record.snapshot.captureState._tag === "setup"
          ? record.snapshot.recordingId
          : TeachingRecordingId.make(
              `recording-${createHash("sha256")
                .update(`${sessionId}:${String(operationId)}`)
                .digest("hex")
                .slice(0, 32)}`
            );
      if (record.snapshot.captureState._tag !== "setup") {
        yield* teachingRecordingStore
          .begin({
            emulation: record.emulation,
            flowSkillName: record.snapshot.flowSkillName,
            operationId: operation,
            recordingId,
            sessionId,
          })
          .pipe(
            Effect.mapError((cause) =>
              error("agent_session_invalid", cause.message)
            )
          );
      }
      const directory = teachingRecordingStore.directory(recordingId);
      yield* fileSystem
        .makeDirectory(directory, { recursive: true })
        .pipe(
          Effect.mapError((cause) =>
            error(
              "agent_session_invalid",
              `Could not create the Teaching recording directory: ${cause.message}`
            )
          )
        );
      const manifest = yield* teachingRecordingStore
        .start({ operationId: operation, recordingId })
        .pipe(
          Effect.mapError((cause) =>
            error("agent_session_invalid", cause.message)
          )
        );
      if (manifest.lifecycle._tag !== "recording") {
        return yield* Effect.fail(
          error(
            "agent_session_conflict",
            `Teaching Recording ${recordingId} did not enter recording.`
          )
        );
      }
      const capture = makeDemonstrationCapture(record.snapshot.currentUrl);
      const recorderScope = yield* Scope.make("sequential");
      yield* Scope.addFinalizer(
        record.scope,
        Scope.close(recorderScope, Exit.interrupt()).pipe(Effect.ignore)
      );
      const recorderResult = yield* Effect.result(
        Scope.provide(recorderScope)(
          makeTeachingRecorder({
            browser,
            browserSessionId: record.browserSessionId,
            counts: capture.counts,
            demonstration: capture.current,
            directory,
            emulation: record.emulation,
            fileSystem,
            limits: options.captureLimits,
            startedAt: manifest.lifecycle.startedAt,
          })
        )
      );
      if (Result.isFailure(recorderResult)) {
        const { message } = recorderResult.failure;
        yield* Scope.close(recorderScope, Exit.void);
        yield* teachingRecordingStore
          .stop({
            artifacts: [],
            failure: message,
            operationId: operation,
            recordingId,
          })
          .pipe(Effect.ignore);
        const failedAt = now().toISOString();
        const failed: AgentSessionSnapshot = {
          ...record.snapshot,
          captureState: { _tag: "failed", error: message, failedAt },
          recordingId,
          updatedAt: failedAt,
        };
        yield* saveRecord(sessionId, {
          ...record,
          artifactDirectory: directory,
          capture,
          snapshot: failed,
        });
        yield* rememberSession(
          operationId,
          "recording-start",
          sessionId,
          requestInput,
          failed
        );
        return failed;
      }
      const recorder = recorderResult.success;
      // A capture ceiling ends the recording on its own. The recorder only
      // detects the breach; driving `captureState` out of `recording` belongs
      // to the session, so this fiber waits on the signal and takes the lock
      // the same way the user's Stop does. It lives in the session scope, not
      // the recorder scope, because `stop` closes the recorder scope and would
      // otherwise interrupt the very fiber running it; a Stop that lands first
      // simply leaves this fiber parked on a signal that never comes.
      yield* recorder.limitReached.pipe(
        Effect.flatMap(() =>
          lock.withPermit(
            afterUserInput(
              sessionId,
              stopTeachingRecordingUnlocked(
                sessionId,
                `limit-recording-${recordingId}`,
                "limit-reached"
              )
            )
          )
        ),
        Effect.ignore,
        Effect.forkIn(record.scope)
      );
      const recording: AgentSessionSnapshot = {
        ...record.snapshot,
        captureState: {
          _tag: "recording",
          startedAt: manifest.lifecycle.startedAt,
        },
        recordingId,
        teaching: capture.progress(),
        updatedAt: manifest.lifecycle.startedAt,
      };
      yield* saveRecord(sessionId, {
        ...record,
        artifactDirectory: directory,
        capture,
        retentionFile: undefined,
        snapshot: recording,
        teachingRecorder: recorder,
        traceFile: recorder.traceFile,
        videoFile: recorder.videoFile,
      });
      yield* rememberSession(
        operationId,
        "recording-start",
        sessionId,
        requestInput,
        recording
      );
      return recording;
    });

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
        const target = yield* browser.activeTarget(browserSessionId).pipe(
          Effect.map(Option.some),
          Effect.orElseSucceed(() => Option.none())
        );
        if (Option.isNone(target)) {
          return {
            retentionFile: undefined,
            traceFile: undefined,
            videoFile: undefined,
          };
        }
        const rememberVideo = (page: Page): void => {
          const video = page.video();
          if (video !== null) {
            videoPaths.add(video.path());
          }
        };
        rememberVideo(target.value.page);
        target.value.context.on("page", rememberVideo);
        yield* Scope.provide(sessionScope)(
          Effect.acquireRelease(
            Effect.tryPromise({
              catch: (cause) =>
                error(
                  "agent_session_invalid",
                  `Could not start the Teaching Trace: ${cause instanceof Error ? cause.message : String(cause)}`
                ),
              try: () =>
                target.value.context.tracing.start({
                  screenshots: true,
                  snapshots: true,
                }),
            }),
            () =>
              Effect.tryPromise({
                catch: () => null,
                try: () =>
                  target.value.context.tracing.stop({ path: traceFile }),
              }).pipe(Effect.ignore)
          )
        );
        const videoFile = yield* teachingVideoFile(target.value.page);
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

    const notDeclaringVariables = (sessionId: AgentSessionId) =>
      error(
        "agent_session_invalid",
        `Agent Session ${sessionId} declares no Variables.`
      );

    /**
     * The Variable this Run declares under this name. A Run may only be asked
     * for the inputs its Flow Skill declares, so a name the Flow Skill never
     * mentioned is refused rather than invented.
     */
    const requireDeclaredVariable = (
      record: SessionRecord,
      name: string,
      flowSkillName?: string | null
    ):
      | { readonly _tag: "error"; readonly error: AgentSessionError }
      | { readonly _tag: "ok"; readonly variable: Variable } => {
      const declaring = record.snapshot.dryRun ?? record.snapshot.run;
      if (declaring === null) {
        return {
          _tag: "error",
          error: notDeclaringVariables(record.snapshot.id),
        };
      }
      const declared = declaring.variables.find(
        (variable) =>
          variable.name === name &&
          (!("schemaVersion" in declaring) ||
            ("flowSkillName" in variable &&
              variable.flowSkillName === flowSkillName))
      );
      return declared === undefined
        ? {
            _tag: "error",
            error: error(
              "agent_session_invalid",
              `No Variable ${name} is declared for ${flowSkillName ?? ("flowSkillName" in declaring ? declaring.flowSkillName : "the requested skill")}.`
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
     * What the session now emulates, kept beside the record so the Teaching
     * Recording declares the Emulation the user actually demonstrated under
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
      patch: AgentSessionPatch = {}
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
        const next = yield* mutate(sessionId, (snapshot) => {
          const common = {
            boundary:
              safePatch.boundary === undefined
                ? snapshot.boundary
                : safePatch.boundary,
            currentUrl: safePatch.currentUrl ?? snapshot.currentUrl,
            decisionHistory:
              safePatch.decisionHistory ?? snapshot.decisionHistory,
            pendingDecisions:
              safePatch.pendingDecisions ?? snapshot.pendingDecisions,
            timeline: [...snapshot.timeline, entry].slice(-TIMELINE_LIMIT),
            updatedAt: now().toISOString(),
          };
          if (snapshot.activity === "teaching") {
            return {
              ...snapshot,
              ...common,
              activity: "teaching" as const,
              recordingId: snapshot.recordingId,
              run: null,
              teaching:
                record?.capture === undefined
                  ? snapshot.teaching
                  : record.capture.progress(),
            };
          }
          return {
            ...snapshot,
            ...common,
            activity: "run" as const,
            recordingId: snapshot.recordingId,
            run: (() => {
              const patched = safePatch.run ?? snapshot.run;
              return patched === null ||
                isTaskRun(patched) ||
                patched.activeStepIndex === null ||
                !entry.dispatched
                ? patched
                : {
                    ...patched,
                    steps: patched.steps.map((step) =>
                      step.index === patched.activeStepIndex
                        ? { ...step, attempts: step.attempts + 1 }
                        : step
                    ),
                  };
            })(),
            teaching: null,
          };
        });
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

    /**
     * The settled read after an agent action, with what the action was seen
     * to change. A wait asks the Page nothing, so it reports no effect.
     */
    const observedAfter = (
      record: SessionRecord,
      page: Page,
      action: AgentBrowserAction,
      observation: ActionObservation
    ) =>
      observeAfterAction(page, record.registry, observation).pipe(
        Effect.map(({ effect, snapshot }) => ({
          effect:
            action.type === "wait_for_text" ? undefined : (effect ?? undefined),
          snapshot: redactCapturedSnapshot(record, snapshot),
        })),
        Effect.tap(({ snapshot }) =>
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

    const adoptExistingTeaching = (
      begun: TeachingRecordingManifest,
      startOperationId: OperationId | string | undefined,
      startRequestInput: string
    ): Effect.Effect<AgentSessionSnapshot | null, AgentSessionError> => {
      if (
        teachingRecordingStore === undefined ||
        begun.lifecycle._tag === "setup"
      ) {
        return Effect.succeed(null);
      }
      const store = teachingRecordingStore;
      return Effect.gen(function* finishExistingTeaching() {
        const operationId = OperationId.make(
          startOperationId ?? `start-${begun.sessionId}`
        );
        const stopped =
          begun.lifecycle._tag === "recording" ||
          begun.lifecycle._tag === "finalizing"
            ? yield* store
                .stop({
                  artifacts: yield* collectTeachingArtifacts(
                    store.directory(begun.recordingId)
                  ),
                  operationId,
                  recordingId: begun.recordingId,
                })
                .pipe(
                  Effect.mapError((cause) =>
                    error("agent_session_invalid", cause.message)
                  )
                )
            : begun;
        const durable = snapshotFromReadyManifest(
          stopped,
          owner,
          options.baseUrl
        );
        yield* rememberSession(
          startOperationId,
          "start",
          "start",
          startRequestInput,
          durable
        );
        return durable;
      });
    };

    const resolveTeachingStart = (
      activity: AgentSessionActivity,
      emulation: DraftEmulation,
      startInput: AgentSessionStartInput,
      startSessionId: AgentSessionId,
      startRequestInput: string
    ): Effect.Effect<
      | {
          readonly _tag: "durable";
          readonly snapshot: AgentSessionSnapshot;
        }
      | {
          readonly _tag: "fresh";
          readonly identity: {
            readonly flowSkillName: FlowSkillName;
            readonly recordingId: TeachingRecordingId;
            /**
             * When the capture was requested. With recording storage it is
             * the manifest's instant, so reading the manifest back never
             * moves it (#268).
             */
            readonly requestedAt: string;
          };
        }
      | { readonly _tag: "none" },
      AgentSessionError
    > =>
      Effect.gen(function* resolveTeachingCapture() {
        if (activity !== "teaching") {
          return { _tag: "none" as const };
        }
        const requestedName = startInput.name?.trim() || `flow-${randomUUID()}`;
        const identity = {
          flowSkillName: yield* Schema.decodeUnknownEffect(FlowSkillName)(
            requestedName
          ).pipe(
            Effect.mapError(() =>
              error(
                "agent_session_invalid",
                describeFlowSkillName(requestedName) ?? flowSkillNameRule
              )
            )
          ),
          recordingId: TeachingRecordingId.make(
            `recording-${createHash("sha256")
              .update(String(startInput.operationId ?? startSessionId))
              .digest("hex")
              .slice(0, 32)}`
          ),
        };
        if (teachingRecordingStore === undefined) {
          return {
            _tag: "fresh" as const,
            identity: { ...identity, requestedAt: now().toISOString() },
          };
        }
        const begun = yield* teachingRecordingStore
          .begin({
            emulation,
            flowSkillName: identity.flowSkillName,
            operationId: OperationId.make(
              startInput.operationId ?? `start-${startSessionId}`
            ),
            recordingId: identity.recordingId,
            sessionId: startSessionId,
          })
          .pipe(
            Effect.mapError((cause) =>
              error("agent_session_invalid", cause.message)
            )
          );
        const durable = yield* adoptExistingTeaching(
          begun,
          startInput.operationId,
          startRequestInput
        );
        if (durable !== null) {
          return { _tag: "durable" as const, snapshot: durable };
        }
        const requestedAt =
          begun.lifecycle._tag === "setup"
            ? begun.lifecycle.requestedAt
            : begun.updatedAt;
        return {
          _tag: "fresh" as const,
          identity: { ...identity, requestedAt },
        };
      });

    /**
     * What the live Page has under one viewport point. The Workspace draws a
     * screencast, so hit-testing its bitmap would outline a picture; this
     * resolves the point through a fresh Browser Snapshot instead. It records
     * nothing into the Demonstration: hovering is not a demonstrated action.
     */
    const inspectPointUnlocked = (
      sessionId: AgentSessionId,
      x: number,
      y: number
    ): Effect.Effect<AgentInspectedElement, AgentSessionError> =>
      observe(sessionId, (record, page) =>
        Effect.gen(function* inspectPointedElement() {
          const snapshot = redactCapturedSnapshot(
            record,
            yield* record.registry.snapshot(page)
          );
          const located = yield* record.registry.pointElement(x, y);
          const node = snapshot.nodes.find(
            (candidate) => candidate.ref === located.ref
          );
          const subject = node ?? record.registry.describe(located.ref);
          return {
            description:
              subject === undefined
                ? "element"
                : `${subject.role}${
                    subject.name === "" ? "" : `: ${subject.name}`
                  }`,
            height: located.rectangle.height,
            ref: located.ref,
            width: located.rectangle.width,
            x: located.rectangle.x,
            y: located.rectangle.y,
          };
        })
      );

    const startUnlocked = Effect.fn("AgentSession.start")(
      function* startSession(
        input: AgentSessionStartInput,
        publicRequest?: string
      ) {
        const requestInput = publicRequest ?? normalizedStartInput(input);
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
        const activity = input.activity ?? "run";
        if (
          options.allowedActivity !== "any" &&
          activity !== options.allowedActivity
        ) {
          return yield* Effect.fail(
            error(
              "agent_session_invalid",
              `This process only owns ${options.allowedActivity} Agent Sessions.`
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
                const teachingStart = yield* resolveTeachingStart(
                  activity,
                  emulation,
                  input,
                  sessionId,
                  requestInput
                );
                if (teachingStart._tag === "durable") {
                  return teachingStart.snapshot;
                }
                const teachingIdentity =
                  teachingStart._tag === "fresh"
                    ? teachingStart.identity
                    : null;
                const artifactDirectory =
                  teachingRecordingStore !== undefined &&
                  teachingIdentity !== null
                    ? teachingRecordingStore.directory(
                        teachingIdentity.recordingId
                      )
                    : yield* prepareArtifactDirectory(
                        activity,
                        input.artifactDirectory
                      );
                if (
                  teachingRecordingStore !== undefined &&
                  teachingIdentity !== null &&
                  artifactDirectory !== undefined &&
                  fileSystem !== undefined
                ) {
                  yield* fileSystem
                    .makeDirectory(artifactDirectory, { recursive: true })
                    .pipe(
                      Effect.mapError((cause) =>
                        error(
                          "agent_session_invalid",
                          `Could not create the artifact directory: ${cause.message}`
                        )
                      )
                    );
                }
                const videoPaths = new Set<Promise<string>>();
                const acquired = yield* Scope.provide(sessionScope)(
                  Effect.acquireRelease(
                    browser.create(
                      browserName,
                      emulation.viewport,
                      activity === "teaching" ? undefined : artifactDirectory,
                      input.domainScope !== undefined
                    ),
                    (browserSessionId) =>
                      browser.close(browserSessionId).pipe(Effect.ignore)
                  )
                );
                const { retentionFile, traceFile, videoFile } =
                  yield* startTeachingArtifacts(
                    activity === "teaching" ? undefined : artifactDirectory,
                    acquired,
                    sessionId,
                    sessionScope,
                    videoPaths,
                    activity === "teaching"
                  );
                const at = now().toISOString();
                const common = {
                  boundary: null,
                  clientName: input.clientName?.trim() || "unknown",
                  clientVersion: input.clientVersion?.trim() || "unknown",
                  createdAt: at,
                  currentUrl: "about:blank",
                  decisionHistory: [],
                  id: sessionId,
                  interruptedAction: null,
                  ownerProcessId: owner,
                  pendingDecisions: [],
                  phase: "starting" as const,
                  takeover: null,
                  timeline: [],
                  updatedAt: at,
                  viewUrl: viewUrl(options.baseUrl, sessionId),
                };
                const opening: AgentSessionSnapshot =
                  teachingIdentity === null
                    ? {
                        ...common,
                        activity: "run" as const,
                        captureState: null,
                        controller: "agent" as const,
                        ...dryRunIdentity(input.dryRun, at),
                        run: input.run ?? null,
                        teaching: null,
                      }
                    : {
                        ...common,
                        activity: "teaching" as const,
                        captureState: {
                          _tag: "setup",
                          requestedAt: teachingIdentity.requestedAt,
                        },
                        controller: input.openedBy ?? "user",
                        dryRun: null,
                        flowSkillName: teachingIdentity.flowSkillName,
                        recordingCleanup: { _tag: "pending" as const },
                        recordingId: teachingIdentity.recordingId,
                        run: null,
                        teaching: {
                          actionCount: 0,
                          instructionCount: 0,
                          instructions: [],
                        },
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
                  dryRunControl: { hadTakeover: false },
                  emulation,
                  finalized: { persisted: false, summary: undefined },
                  registry,
                  retentionFile,
                  runEvidence: { attempts: new Set(), snapshots: new Set() },
                  scope: sessionScope,
                  screenshots: { directory: undefined },
                  scroll: { burst: undefined },
                  snapshot: base,
                  supplied: new Map<string, string>(),
                  teachingRecorder: undefined,
                  textEdit: { burst: undefined, open: undefined },
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
                    const target = yield* browser.activeTarget(acquired);
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
                  // The Run starts when the browser is actually ready, not
                  // when the request arrived, so browser acquisition never
                  // reads as the agent being idle.
                  const run = activateRun(base.run, startedAt, emulation);
                  const running: AgentSessionSnapshot =
                    base.activity === "teaching"
                      ? {
                          ...base,
                          currentUrl,
                          phase: "running",
                          updatedAt: startedAt,
                        }
                      : {
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
        recordingCapture(record)?.recordSnapshot(snapshot);
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
        const sensitive = yield* record.registry.isSensitive(ref);
        return {
          node,
          ref,
          sensitive,
          snapshot,
          valueDigest: sensitive
            ? yield* record.registry.valueDigest(ref)
            : undefined,
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
        recordingCapture(record)?.recordSnapshot(snapshot);
        return {
          ref: yield* record.registry.pointRef(x, y),
          snapshot,
        };
      });

    /**
     * Whether an edit changed the focused control. A private control is
     * compared by digest, since its placeholder reads the same after every
     * keystroke; a digest that cannot be read counts as no change.
     */
    const valueChanged = (
      record: SessionRecord,
      focused: FocusedTextControl,
      refAfter: AgentElementRef,
      value: string
    ): Effect.Effect<boolean> =>
      focused.sensitive
        ? observedOrNothing(record.registry.valueDigest(refAfter)).pipe(
            Effect.map(
              (digest) => digest !== undefined && digest !== focused.valueDigest
            )
          )
        : Effect.succeed(value !== focused.node.value);

    const semanticUserEdit = (
      record: SessionRecord,
      page: Page,
      urlBefore: string,
      focused: FocusedTextControl
    ) =>
      Effect.gen(function* captureSemanticUserEdit() {
        const capture = recordingCapture(record);
        if (capture === undefined) {
          return;
        }
        const observed = yield* snapshotAfter(record, page, urlBefore);
        capture.recordSnapshot(observed);
        const focusedAfter = yield* Effect.result(record.registry.focusedRef());
        // The last key typed may have moved focus on — a phone number field
        // that submits at its tenth digit — and the field still holds what was
        // typed into it, so it is read wherever focus went.
        const refAfter =
          Result.isSuccess(focusedAfter) &&
          (yield* record.registry.sameElement(
            focused.ref,
            focusedAfter.success
          ))
            ? focusedAfter.success
            : yield* observedOrNothing(record.registry.currentRef(focused.ref));
        if (refAfter === undefined) {
          return;
        }
        const value = editedValue(
          observed.nodes.find((candidate) => candidate.ref === refAfter),
          focused.sensitive
        );
        // A fill is the field's value changing. Keys that left the value as it
        // was — Enter in a single-line field, a Backspace in an empty one — are
        // not an edit, so they end the fill and are recorded as the key presses
        // they were.
        if (
          value === undefined ||
          !(yield* valueChanged(record, focused, refAfter, value))
        ) {
          return;
        }
        const action = { ref: focused.ref, text: value, type: "fill" as const };
        // The same description the agent-driven path produces, so a recording
        // reads in roles, accessible names and the value that landed whoever
        // typed it. References are re-minted on every Snapshot, so the subject
        // comes from the tree the reference was read in — the one recorded
        // before the edit, which a later reader joins the entry back to.
        return {
          action,
          description: describeCapturedAction(
            { name: focused.node.name, role: focused.node.role },
            action,
            {},
            capture.sensitiveValues()
          ),
          focusedAfter: refAfter,
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
          Effect.sync(() => recordingCapture(record)?.recordSnapshot(snapshot))
        )
      );

    /**
     * The Page a scroll gesture started from. A wheel notch names no element,
     * so nothing else on this path observes the tree — without this the gesture
     * has no `before` to be credited against, and a Teaching session that
     * scrolls before it does anything else has no observation at all.
     */
    const observeScrollOrigin = (record: SessionRecord, page: Page) =>
      Effect.gen(function* observeScrollOriginTree() {
        const snapshot = redactCapturedSnapshot(
          record,
          yield* record.registry.snapshot(page)
        );
        recordingCapture(record)?.recordSnapshot(snapshot);
        return snapshot;
      });

    /**
     * The state a user input acted on, observed only where the input can name
     * it: the focused control for an edit, the pointed control for a click, the
     * whole tree for the first notch of a scroll. A failed observation leaves
     * the action without a `before` rather than failing the input.
     */
    const observeUserInputTarget = (
      record: SessionRecord,
      page: Page,
      input: BrowserInput
    ) =>
      Effect.gen(function* observeSemanticInputTarget() {
        const capture = recordingCapture(record);
        if (capture === undefined) {
          return {
            focused: undefined,
            pointed: undefined,
            snapshotBefore: null,
          };
        }
        const focused = isTextEdit(input)
          ? yield* observedOrNothing(observeFocusedTextControl(record, page))
          : undefined;
        const pointed =
          input.type === "input_mouse" && input.eventType === "mouseReleased"
            ? yield* observedOrNothing(
                observePointedControl(record, page, input.x, input.y)
              )
            : undefined;
        // Only the first notch: the rest of the gesture coalesces into it and
        // keeps the state the user actually scrolled away from.
        const scrolled =
          isScroll(input) && capture.openCoalesceKey() !== SCROLL_COALESCE_KEY
            ? yield* observedOrNothing(observeScrollOrigin(record, page))
            : undefined;
        return {
          focused,
          pointed,
          snapshotBefore:
            focused?.snapshot.snapshotId ??
            pointed?.snapshot.snapshotId ??
            scrolled?.snapshotId ??
            capture.latestSnapshotId() ??
            null,
        };
      });

    const closeScrollBurst = (
      sessionId: AgentSessionId,
      opened: SessionRecord,
      burst: ScrollBurst
    ): Effect.Effect<void> =>
      Effect.gen(function* photographSettledScroll() {
        if (opened.scroll.burst !== burst) {
          return;
        }
        opened.scroll.burst = undefined;
        const record = Ref.getUnsafe(sessions).get(sessionId) ?? opened;
        if (recordingCapture(record) !== burst.capture) {
          return;
        }
        yield* captureTeachingKeyframe(
          record,
          burst.page,
          burst.actionId,
          now().toISOString()
        );
      });

    const watchScrollBurst = (
      sessionId: AgentSessionId,
      record: SessionRecord,
      burst: ScrollBurst
    ): Effect.Effect<void> =>
      Effect.gen(function* photographWhenScrollingPauses() {
        while (record.scroll.burst === burst) {
          const paused = (yield* Clock.currentTimeMillis) - burst.lastInputAt;
          if (paused < 200) {
            yield* Effect.sleep(200 - paused);
            continue;
          }
          yield* record.control.lock.withPermit(
            Effect.gen(function* recheckScrollPause() {
              if ((yield* Clock.currentTimeMillis) - burst.lastInputAt >= 200) {
                yield* closeScrollBurst(sessionId, record, burst);
              }
            })
          );
        }
      });

    const deferScrollKeyframe = (
      sessionId: AgentSessionId,
      record: SessionRecord,
      page: Page,
      actionId: string
    ): Effect.Effect<void> =>
      Effect.gen(function* rememberScrollPhotograph() {
        const capture = recordingCapture(record);
        if (capture === undefined) {
          return;
        }
        const lastInputAt = yield* Clock.currentTimeMillis;
        const existing = record.scroll.burst;
        if (
          existing?.capture === capture &&
          existing.actionId === actionId &&
          existing.page === page
        ) {
          existing.lastInputAt = lastInputAt;
          return;
        }
        if (existing !== undefined) {
          yield* existing.close;
        }
        const burst: ScrollBurst = {
          actionId,
          capture,
          close: Effect.suspend(() =>
            closeScrollBurst(sessionId, record, burst)
          ),
          lastInputAt,
          page,
        };
        record.scroll.burst = burst;
        yield* Effect.forkIn(
          watchScrollBurst(sessionId, record, burst),
          record.scope
        );
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
        const capture = recordingCapture(input.record);
        if (input.pointed === undefined || capture === undefined) {
          return false;
        }
        const observed = yield* semanticUserClick(
          input.record,
          input.page,
          input.urlBefore
        );
        const action = { ref: input.pointed.ref, type: "click" as const };
        // The same description the agent-driven path produces, so a recording
        // reads in roles and accessible names whoever performed the click. The
        // subject comes from the tree recorded beside the click rather than
        // from the registry, which keeps a role and name for every reference it
        // ever minted: reading it there would describe a named control for a
        // reference the recorded tree cannot resolve, leaving a confident
        // description over a null target.
        const { pointed } = input;
        const subject = pointed.snapshot.nodes.find(
          (node) => node.ref === pointed.ref
        );
        const description =
          subject === undefined
            ? UNRESOLVED_CLICK_DESCRIPTION
            : describeCapturedAction(
                { name: subject.name, role: subject.role },
                action,
                {},
                capture.sensitiveValues()
              );
        const captured = capture.recordAction({
          action,
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
        yield* captureTeachingKeyframe(
          input.record,
          input.page,
          captured.id,
          input.at
        );
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
      readonly focused: FocusedTextControl | undefined;
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
        const capture = recordingCapture(input.record);
        if (semantic === undefined || capture === undefined) {
          return false;
        }
        // Consecutive edits are one fill while they type into one element.
        // Its position among its siblings is no identity: pages insert ads and
        // hints around a field as it is typed into (#258).
        const { textEdit } = input.record;
        const { open } = textEdit;
        const continues =
          open !== undefined &&
          capture.openCoalesceKey() === open.key &&
          (yield* input.record.registry.sameElement(
            open.ref,
            input.focused.ref
          ));
        const coalesceKey = continues ? open.key : `text-edit-${input.id}`;
        textEdit.open = { key: coalesceKey, ref: semantic.focusedAfter };
        const captured = capture.recordAction({
          action: semantic.action,
          actor: "user",
          at: input.at,
          coalesceKey,
          description: semantic.description,
          id: input.id,
          outcome: "completed",
          snapshotAfter: semantic.observed,
          snapshotBefore: input.snapshotBefore,
          urlAfter: input.urlAfter,
          urlBefore: input.urlBefore,
        });
        yield* captureTeachingKeyframe(
          input.record,
          input.page,
          captured.id,
          input.at
        );
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

    /** Record a user input the browser refused, then fail with its reason. */
    const failUserInput = (input: {
      readonly at: string;
      readonly failure: BrowserRpcErrorType;
      readonly id: string;
      readonly input: BrowserInput;
      readonly page: Page;
      readonly record: SessionRecord;
      readonly sessionId: AgentSessionId;
      readonly snapshotBefore: AgentSnapshotId | null;
      readonly urlBefore: string;
    }): Effect.Effect<never, AgentSessionError> =>
      Effect.gen(function* recordFailedUserInput() {
        const description = describeTeachingInput(input.input);
        const failed = recordingCapture(input.record)?.recordAction({
          action: { input: teachingInput(input.input), type: "input" },
          actor: "user",
          at: input.at,
          description,
          detail: input.failure.message,
          id: input.id,
          outcome: "failed",
          snapshotAfter: null,
          snapshotBefore: input.snapshotBefore,
          urlAfter: input.page.url(),
          urlBefore: input.urlBefore,
        });
        if (failed !== undefined) {
          yield* captureTeachingKeyframe(
            input.record,
            input.page,
            failed.id,
            input.at
          );
        }
        yield* recordEntry(input.sessionId, {
          actor: "user",
          at: input.at,
          description,
          detail: input.failure.message,
          dispatched: true,
          id: input.id,
          outcome: "failed",
        });
        return yield* Effect.fail(input.failure);
      });

    /**
     * End the open typing burst: observe its field once more and record what
     * the burst typed — one Fill when it changed the field's value, otherwise
     * each key as the raw input it was. It runs under the control lock before
     * whatever ended the burst is recorded, so the Timeline keeps their order.
     * Best effort, like Stop closing an open gesture: a Page gone from under
     * it costs the burst its evidence, never the input that ended it.
     */
    const closeTypingBurst = (
      sessionId: AgentSessionId,
      opened: SessionRecord
    ): Effect.Effect<void> =>
      Effect.gen(function* recordTypingBurst() {
        const { burst } = opened.textEdit;
        opened.textEdit.burst = undefined;
        // Records are copied on every write, so capture is judged by the one
        // the session holds now rather than the one the burst opened under.
        const record = Ref.getUnsafe(sessions).get(sessionId) ?? opened;
        const capture = recordingCapture(record);
        if (burst === undefined || capture === undefined) {
          return;
        }
        const urlAfter = burst.page.url();
        const common = {
          at: burst.at,
          page: burst.page,
          record,
          sessionId,
          snapshotBefore: burst.snapshotBefore,
          urlAfter,
          urlBefore: burst.urlBefore,
        };
        if (
          yield* completeSemanticUserEdit({
            ...common,
            focused: burst.focused,
            id: burst.id,
          })
        ) {
          return;
        }
        let lastId: string | undefined;
        for (const [index, key] of burst.keys.entries()) {
          const id = index === 0 ? burst.id : `user-input-${randomUUID()}`;
          const description = describeTeachingInput(key);
          lastId = capture.recordAction({
            action: { input: teachingInput(key), type: "input" },
            actor: "user",
            at: burst.at,
            description,
            id,
            outcome: "completed",
            snapshotAfter: null,
            snapshotBefore: burst.snapshotBefore,
            urlAfter,
            urlBefore: burst.urlBefore,
          }).id;
          yield* recordEntry(
            sessionId,
            {
              actor: "user",
              at: burst.at,
              description,
              dispatched: true,
              id,
              outcome: "completed",
            },
            { currentUrl: urlAfter }
          );
        }
        // One Page state follows the whole burst, so one photograph of it.
        if (lastId !== undefined) {
          yield* captureTeachingKeyframe(
            record,
            burst.page,
            lastId,
            now().toISOString()
          );
        }
      }).pipe(Effect.ignore);

    /**
     * Close a burst once typing pauses, so the Fill is on the Timeline while
     * the user looks at it rather than only once they do something else.
     */
    const watchTypingBurst = (
      sessionId: AgentSessionId,
      record: SessionRecord,
      burst: TypingBurst
    ): Effect.Effect<void> =>
      Effect.gen(function* closeWhenTypingPauses() {
        while (record.textEdit.burst === burst) {
          const paused = (yield* Clock.currentTimeMillis) - burst.lastKeyAt;
          if (paused >= TYPING_BURST_IDLE_MS) {
            break;
          }
          yield* Effect.sleep(TYPING_BURST_IDLE_MS - paused);
        }
        yield* record.control.lock.withPermit(
          Effect.suspend(() =>
            record.textEdit.burst === burst
              ? closeTypingBurst(sessionId, record)
              : Effect.void
          )
        );
      });

    const openTypingBurst = (
      sessionId: AgentSessionId,
      record: SessionRecord,
      opened: Omit<TypingBurst, "close">
    ): Effect.Effect<void> =>
      Effect.gen(function* startTypingBurst() {
        const burst = { ...opened, close: closeTypingBurst(sessionId, record) };
        record.textEdit.burst = burst;
        yield* Effect.forkIn(
          watchTypingBurst(sessionId, record, burst),
          record.scope
        );
      });

    /**
     * Send an input that continues the open typing burst straight to the Page,
     * and close the burst ahead of one that does not. A key continues it only
     * while the field it types into still holds focus in the same document,
     * which one round trip answers without a Browser Snapshot. Answers whether
     * the input was delivered here.
     */
    const continueTypingBurst = (
      sessionId: AgentSessionId,
      record: SessionRecord,
      page: Page,
      input: BrowserInput
    ): Effect.Effect<boolean, AgentSessionError> =>
      Effect.gen(function* typeIntoBurst() {
        const { burst } = record.textEdit;
        if (burst === undefined) {
          return false;
        }
        const continues =
          passesTypingBurst(input) ||
          (extendsTypingBurst(input) &&
            page === burst.page &&
            page.url() === burst.urlBefore &&
            (yield* record.registry.hasFocus(burst.focused.ref)));
        if (!continues) {
          yield* closeTypingBurst(sessionId, record);
          return false;
        }
        const outcome = yield* Effect.result(
          browser.sendInput(record.browserSessionId, input)
        );
        if (Result.isFailure(outcome)) {
          yield* closeTypingBurst(sessionId, record);
          return yield* failUserInput({
            at: now().toISOString(),
            failure: outcome.failure,
            id: `user-input-${randomUUID()}`,
            input,
            page,
            record,
            sessionId,
            snapshotBefore:
              recordingCapture(record)?.latestSnapshotId() ?? null,
            urlBefore: page.url(),
          });
        }
        if (extendsTypingBurst(input)) {
          burst.keys.push(input);
          burst.lastKeyAt = yield* Clock.currentTimeMillis;
        }
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
            record.snapshot.run === null || isTaskRun(record.snapshot.run)
              ? null
              : record.snapshot.run.activeStepIndex,
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
          readonly target: PrivateInputTarget;
          readonly value: string;
          readonly variable: Variable;
        }
      ) {
        const current = yield* requireLiveRecord(sessionId);
        // A handoff can land while this action waits for the control lock.
        if (userLedTeaching(current.snapshot)) {
          return yield* Effect.fail(
            teachingIsUserLed("This action was not dispatched.")
          );
        }
        if (agentIsPaused(current.snapshot)) {
          return yield* Effect.fail(
            takenOver("This action was not dispatched.")
          );
        }
        // A waiter on the control lock can wake after the Run ended ahead of
        // it, so the Run's state is
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
        const snapshotBefore =
          recordingCapture(record)?.latestSnapshotId() ?? null;
        // The action runs on a child fiber so a user Takeover can interrupt it
        // and wait for its cleanup rather than racing it.
        const fiber = yield* Effect.forkChild(
          Effect.gen(function* dispatchAgentAction() {
            const observation = yield* beginActionObservation(
              page,
              yield* actionTarget(record.registry, action)
            );
            if (privateRegistration === undefined) {
              yield* performAgentAction(
                page,
                record.registry,
                action,
                (pointer) =>
                  browser.pointAgent(record.browserSessionId, pointer)
              );
            } else {
              const accepted = yield* performPrivateVariableInput(
                page,
                privateRegistration.target,
                privateRegistration.value,
                (pointer) =>
                  browser.pointAgent(record.browserSessionId, pointer)
              );
              recordingCapture(record)?.recordVariable(
                privateRegistration.variable,
                privateRegistration.value,
                accepted
              );
            }
            const { effect, snapshot } = yield* observedAfter(
              record,
              page,
              action,
              observation
            );
            const entry: AgentTimelineEntry = {
              actor: "agent",
              at: now().toISOString(),
              description,
              dispatched: true,
              id,
              outcome: "completed",
            };
            return {
              entry: effect === undefined ? entry : { ...entry, effect },
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
          recordingCapture(record)?.recordAction({
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
          Option.isSome(cause) ? cause.value : undefined
        );
        const failedAt = now().toISOString();
        // A failed action may still have moved the Page, so the session records
        // where the browser actually is rather than where it last succeeded.
        const urlAfter = page.url();
        recordingCapture(record)?.recordAction({
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
            // A Run that ended on a terminal assessment or was completed is
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
                          target: yield* record.registry.privateSelector(
                            action.ref,
                            [...privateCapture.value].length
                          ),
                          value: privateCapture.value,
                          variable: privateCapture.variable,
                        };
                  if (
                    privateRegistration !== undefined &&
                    record.capture !== undefined &&
                    !canRecordPrivateInput(
                      record.capture,
                      privateRegistration.variable,
                      privateRegistration.value,
                      privateRegistration.target
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
        const declared = requireDeclaredVariable(
          record,
          pending.variable.name,
          pending.variable.flowSkillName
        );
        if (declared._tag === "error") {
          return yield* Effect.fail(declared.error);
        }
        const { name } = pending.variable;
        if (supply && value !== null) {
          record.supplied.set(
            variableKey(name, pending.variable.flowSkillName),
            value
          );
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
                  variable.name === name &&
                  (pending.variable?.flowSkillName === undefined ||
                    pending.variable.flowSkillName === null ||
                    ("flowSkillName" in variable &&
                      variable.flowSkillName ===
                        pending.variable.flowSkillName))
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
          if (
            record.snapshot.activity !== "teaching" ||
            record.snapshot.captureState._tag !== "recording"
          ) {
            return yield* Effect.fail(
              error(
                "agent_session_conflict",
                "Start recording before entering a Teaching Variable."
              )
            );
          }
          if (record.snapshot.controller !== "user") {
            return yield* Effect.fail(
              makeBrowserRpcError(
                "agent_control_unavailable",
                "The agent holds the browser. Take control before entering a private Variable."
              )
            );
          }
          yield* afterUserInput(sessionId, Effect.void);
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
          const subject = actionSubject(record.registry, action);
          const target =
            subject === undefined
              ? "an unidentified control"
              : describeActionSubject(subject);
          const description = `Enter Variable ${input.variable.name} in ${target}`;
          const id = `user-variable-${randomUUID()}`;
          const urlBefore = page.url();
          const snapshotBefore = capture.latestSnapshotId();
          const executed = yield* record.control.lock.withPermit(
            Effect.gen(function* fillPrivateValue() {
              const privateTarget = yield* record.registry.privateSelector(
                ref,
                [...input.value].length
              );
              if (
                !canRecordPrivateInput(
                  capture,
                  input.variable,
                  input.value,
                  privateTarget
                )
              ) {
                return yield* Effect.fail(
                  error(
                    "agent_session_invalid",
                    `Variable ${input.variable.name} conflicts with the Demonstration or its private-input limit.`
                  )
                );
              }
              const accepted = yield* performPrivateVariableInput(
                page,
                privateTarget,
                input.value
              );
              capture.recordVariable(input.variable, input.value, accepted);
              const observed = yield* Effect.result(
                snapshotAfter(record, page, urlBefore)
              );
              if (Result.isFailure(observed)) {
                const failed = capture.recordAction({
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
                yield* captureTeachingKeyframe(
                  record,
                  page,
                  failed.id,
                  failed.at
                );
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
          const captured = capture.recordAction({
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
          yield* captureTeachingKeyframe(record, page, captured.id, at);
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
          ? sensitiveFailure(
              outcome.failure,
              "Could not enter the private Variable"
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
        if (record.snapshot.activity === "teaching") {
          return yield* Effect.fail(
            makeBrowserRpcError(
              "agent_control_unavailable",
              "Teaching has no Takeover: the user holds the browser for the whole Demonstration. Takeover belongs to Interactive Runs."
            )
          );
        }
        if (by === "user" && record.snapshot.dryRun !== null) {
          record.dryRunControl.hadTakeover = true;
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
          recordingCapture(record)?.recordAction({
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
        const next: AgentSessionSnapshot =
          current.snapshot.activity === "teaching"
            ? {
                ...current.snapshot,
                controller:
                  by === "user" ? "user" : current.snapshot.controller,
                interruptedAction,
                phase: "takeover",
                takeover: { reason, requestedAt: at, requestedBy: by },
                teaching:
                  current.capture === undefined
                    ? current.snapshot.teaching
                    : current.capture.progress(),
                timeline,
                updatedAt: at,
              }
            : {
                ...current.snapshot,
                controller:
                  by === "user" ? "user" : current.snapshot.controller,
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
        if (record.snapshot.activity === "teaching") {
          return yield* Effect.fail(
            makeBrowserRpcError(
              "agent_control_unavailable",
              "Teaching control stays with the user: there is nothing to return. Stop recording to hand the agent a Teaching Recording to learn from."
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
          // The agent was waiting on the user, not idle: its idle time starts
          // again from the moment it has the browser back.
          run:
            record.snapshot.run === null || runEnded(record.snapshot.run)
              ? record.snapshot.run
              : { ...record.snapshot.run, lastAgentActivityAt: at },
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

    /**
     * The agent releases an agent-prepared Teaching browser to the user. It
     * runs behind the control lock, so an agent action already dispatched
     * finishes first and a queued one re-reads the controller and is refused.
     * A session the user already holds answers as it is: a retry can neither
     * hand control back to the agent nor dispatch anything.
     */
    const handOffTeachingSetupUnlocked = Effect.fn(
      "AgentSession.handOffTeachingSetup"
    )(function* handOffTeachingSetup(
      sessionId: AgentSessionId,
      operationId?: OperationId | string
    ) {
      const requestInput = "";
      const replayed = replaySession(
        operationId,
        "handoff",
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
      if (record.snapshot.activity !== "teaching") {
        return yield* Effect.fail(
          error(
            "agent_session_conflict",
            `Agent Session ${sessionId} is not a Teaching session. Use agent_session_takeover_request to ask for help during a Run.`
          )
        );
      }
      if (record.snapshot.controller === "user") {
        yield* rememberSession(
          operationId,
          "handoff",
          sessionId,
          requestInput,
          record.snapshot
        );
        return record.snapshot;
      }
      if (!agentPreparesTeaching(record.snapshot)) {
        return yield* Effect.fail(
          error(
            "agent_session_conflict",
            `Teaching setup cannot be handed off from ${record.snapshot.captureState._tag}.`
          )
        );
      }
      const at = now().toISOString();
      const entry: AgentTimelineEntry = {
        actor: "agent",
        at,
        description: "The agent handed control to the user",
        detail: "Setup is prepared. The user can start recording.",
        dispatched: false,
        id: `handoff-${randomUUID()}`,
        outcome: "completed",
      };
      const next: AgentSessionSnapshot = {
        ...record.snapshot,
        controller: "user",
        timeline: [...record.snapshot.timeline, entry].slice(-TIMELINE_LIMIT),
        updatedAt: at,
      };
      yield* save(sessionId, record, next);
      yield* rememberSession(
        operationId,
        "handoff",
        sessionId,
        requestInput,
        next
      );
      return next;
    });

    const recordInstructionUnlocked = Effect.fn(
      "AgentSession.recordInstruction"
    )(function* recordInstruction(
      sessionId: AgentSessionId,
      text: string,
      operationId?: OperationId | string,
      target?: string | undefined
    ) {
      const requestInput = JSON.stringify({ target: target ?? null, text });
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
      if (
        record.snapshot.activity !== "teaching" ||
        record.snapshot.captureState._tag !== "recording"
      ) {
        return yield* Effect.fail(
          error(
            "agent_session_conflict",
            "Start recording before adding a Teaching instruction."
          )
        );
      }
      const at = now().toISOString();
      const instruction: TeachingInstruction = capture.recordInstruction(
        text,
        at,
        target
      );
      const next = yield* recordEntry(sessionId, {
        actor: "user",
        at,
        description: "The user gave an instruction",
        /*
          The timeline entry still reads as one sentence, so an instruction
          attached to an element names it where a reader sees it (#213).
        */
        detail:
          instruction.target === null
            ? instruction.text
            : `${instruction.target}: ${instruction.text}`,
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
        snapshot.run === null || isTaskRun(snapshot.run)
          ? snapshot
          : {
              ...snapshot,
              run: withDerivedRunTotals(change(snapshot.run, at)),
              updatedAt: at,
            }
      );
    };

    /**
     * Write the Run Summary under the Catalog Root. A Run's evidence is worth
     * nothing the caller cannot reach, so persistence is part of ending a Run
     * rather than of the tool that reports it ended.
     */
    const persistRunSummary = (
      record: SessionRecord,
      summary: AgentRunSummary
    ): Effect.Effect<AgentRunSummary, AgentSessionError> => {
      if (record.snapshot.dryRun !== null) {
        return Effect.gen(function* persistDryRunSummary() {
          const { dryRun } = record.snapshot;
          const directory = record.artifactDirectory;
          if (
            dryRun === null ||
            directory === undefined ||
            fileSystem === undefined ||
            teachingRecordingStore === undefined
          ) {
            return yield* Effect.fail(
              error(
                "agent_session_unavailable",
                "The Dry Run has no Teaching evidence store."
              )
            );
          }
          yield* fileSystem
            .writeFileString(
              path.join(directory, "summary.json"),
              `${JSON.stringify(Schema.encodeSync(AgentRunSummary)(summary), null, 2)}\n`,
              { mode: 0o600 }
            )
            .pipe(
              Effect.mapError((cause) =>
                error(
                  "agent_session_unavailable",
                  `Could not save the Dry Run Summary: ${cause.message}`
                )
              )
            );
          const passed =
            summary.schemaVersion !== 3 &&
            summary.coverage.complete &&
            summary.steps.every(
              (step) => step.assessment?.outcome === "working"
            ) &&
            !record.dryRunControl.hadTakeover;
          const lastAssessed =
            summary.schemaVersion === 3
              ? undefined
              : summary.steps.findLast((step) => step.assessment !== null);
          const observableOutcome =
            lastAssessed === undefined
              ? "No Agent Step was assessed."
              : `Done when: ${lastAssessed.doneWhen} ${lastAssessed.assessment?.explanation ?? ""}`.trim();
          const mutation = {
            observableOutcome,
            operationId: OperationId.make(
              `dry-run-finish-${summary.sessionId}`
            ),
            recordingId: dryRun.recordingId,
            summary,
          };
          const manifest = yield* teachingRecordingStore
            .read(dryRun.recordingId)
            .pipe(
              Effect.mapError((cause) =>
                error(
                  "agent_session_unavailable",
                  `Could not read the Dry Run: ${cause.message}`
                )
              )
            );
          if (manifest.lifecycle._tag === "dry-running") {
            yield* (
              passed
                ? teachingRecordingStore.passDryRun(mutation)
                : teachingRecordingStore.failDryRun(mutation)
            ).pipe(
              Effect.mapError((cause) =>
                error(
                  "agent_session_unavailable",
                  `Could not finish the Dry Run: ${cause.message}`
                )
              )
            );
          } else if (
            manifest.lifecycle._tag === "dry-run-failed" &&
            manifest.lifecycle.dryRunSummary === undefined
          ) {
            yield* teachingRecordingStore
              .attachDryRunSummary({
                operationId: OperationId.make(
                  `dry-run-summary-${summary.sessionId}`
                ),
                recordingId: dryRun.recordingId,
                summary,
              })
              .pipe(
                Effect.mapError((cause) =>
                  error(
                    "agent_session_unavailable",
                    `Could not attach the Dry Run Summary: ${cause.message}`
                  )
                )
              );
          }
          record.finalized.persisted = true;
          return summary;
        });
      }
      if (runStore === undefined) {
        return Effect.sync(() => {
          record.finalized.persisted = true;
          return summary;
        });
      }
      return runStore.write(summary).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            record.finalized.persisted = true;
          })
        ),
        Effect.mapError((cause) =>
          error(
            "agent_session_unavailable",
            `Run ${summary.runId} ended but its Run Summary could not be written: ${cause.message}`
          )
        )
      );
    };

    /**
     * Finalize a Run exactly once: close the browser, seal the Trace and the
     * video, and persist the Run Summary. Every way a Run can end goes through
     * here — the last Agent Step assessed, a terminal Agent Assessment, or an
     * explicit `agent_run_complete` — so a Summary exists for
     * every ended Run and a second call answers with the first one's Summary
     * rather than writing another.
     */
    const finalizeRunUnlocked = Effect.fn("AgentSession.finalizeRun")(
      function* finalizeInteractiveRun(
        sessionId: AgentSessionId,
        summaryText?: string
      ) {
        const record = yield* read(sessionId);
        if (record.snapshot.run === null) {
          return yield* Effect.fail(notRunning(sessionId));
        }
        const already = record.finalized.summary;
        if (already !== undefined) {
          // A closing account that arrives after the Run already ended is
          // recorded on the Summary it belongs to; nothing else is rewritten.
          const amended =
            summaryText === undefined ||
            ("agentAccount" in already && already.agentAccount !== undefined)
              ? already
              : { ...already, agentAccount: summaryText };
          // A Run whose write never landed is not a persisted Run. This is the
          // path a caller retries, so it writes rather than answering with a
          // Summary the Catalog Root has never seen.
          if (record.finalized.persisted && amended === already) {
            return already;
          }
          // The amended Summary joins the session only once its write lands.
          // A failed amend leaves memory on the last persisted Summary, so the
          // next retry still sees a closing account the Catalog Root lacks.
          const written = yield* persistRunSummary(record, amended);
          record.finalized.summary = written;
          return written;
        }
        return yield* Effect.uninterruptibleMask(() =>
          Effect.gen(function* finalizeRun() {
            const at = now().toISOString();
            // A read-modify-write over the Run as it stands when the write
            // lands: an outcome already recorded is kept, never clobbered by a
            // snapshot this call built earlier.
            const completed = yield* mutate(sessionId, (snapshot) => {
              if (snapshot.run === null) {
                return snapshot;
              }
              if (isTaskRun(snapshot.run)) {
                return {
                  ...snapshot,
                  boundary: null,
                  controller: "agent",
                  pendingDecisions: [],
                  phase: "completed",
                  run: {
                    ...snapshot.run,
                    lifecycle:
                      snapshot.run.lifecycle.phase === "ended"
                        ? snapshot.run.lifecycle
                        : { endedAt: at, outcome: "completed", phase: "ended" },
                  },
                  takeover: null,
                  updatedAt: at,
                };
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
            const commonSummary = {
              attribution: finished.attribution,
              runId: finished.runId,
              sessionId,
              startedAt: finished.startedAt,
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
            const ended: AgentRunSummary = isTaskRun(finished)
              ? {
                  ...finished,
                  ...commonSummary,
                  endedAt:
                    finished.lifecycle.phase === "ended"
                      ? finished.lifecycle.endedAt
                      : at,
                  outcome:
                    finished.lifecycle.phase === "ended"
                      ? finished.lifecycle.outcome
                      : "completed",
                }
              : {
                  assessmentCounts: finished.assessmentCounts,
                  attribution: finished.attribution,
                  coverage: finished.coverage,
                  endedAt: finished.endedAt ?? at,
                  flowSkillName: finished.flowSkillName,
                  inputs: finished.inputs,
                  outcome: finished.outcome ?? "ended-early",
                  runId: finished.runId,
                  schemaVersion: 2,
                  sessionId,
                  startedAt: finished.startedAt,
                  steps: finished.steps,
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
            const summary =
              summaryText === undefined
                ? ended
                : { ...ended, agentAccount: summaryText };
            record.finalized.summary = Schema.decodeUnknownSync(
              AgentRunSummary
            )(Schema.encodeSync(AgentRunSummary)(summary));
            record.supplied.clear();
            return yield* persistRunSummary(record, record.finalized.summary);
          })
        );
      }
    );

    /**
     * End a Run that has just reached a terminal state on its own. The Run is
     * already over either way, so a Summary that could not be written is
     * reported and the transition stands: `agent_run_complete` still writes
     * it, which is what the caller would retry anyway.
     */
    const finalizeEndedRun = (sessionId: AgentSessionId): Effect.Effect<void> =>
      Effect.gen(function* persistEndedRun() {
        const finalized = yield* Effect.result(finalizeRunUnlocked(sessionId));
        if (finalized._tag === "Failure") {
          yield* Effect.logWarning(
            `The Run in Agent Session ${sessionId} ended but its Run Summary was not persisted: ${finalized.failure.message}`
          );
        }
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
        if (run === null || isTaskRun(run)) {
          return yield* Effect.fail(
            error(
              "agent_session_invalid",
              "Task Runs use agent_run_assess or agent_run_finding, not Agent Steps."
            )
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
        // made ([ADR 0034](../../../../docs/adr/0034-agent-assessments-do-not-create-regressions.md)).
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
        // The Run is over the moment its last ordered Step is assessed, or the
        // moment a terminal Agent Assessment stops the rest. Its evidence is
        // sealed and its Summary written here rather than waiting for a call
        // the agent has no reason to make.
        if (!hasNext) {
          yield* finalizeEndedRun(sessionId);
        }
        const ended = hasNext ? withEntry : (yield* read(sessionId)).snapshot;
        yield* rememberSession(
          operationId,
          "assess",
          sessionId,
          requestInput,
          ended
        );
        return ended;
      }
    );

    const completeRunUnlocked = Effect.fn("AgentSession.completeRun")(
      function* completeInteractiveRun(
        sessionId: AgentSessionId,
        summaryText?: string,
        operationId?: OperationId | string
      ) {
        const requestInput = JSON.stringify({
          agentAccount: summaryText ?? null,
        });
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
        const summary = yield* finalizeRunUnlocked(sessionId, summaryText);
        yield* rememberRunSummary(
          operationId,
          sessionId,
          requestInput,
          summary
        );
        return summary;
      }
    );

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
        const existing = Ref.getUnsafe(sessions).get(sessionId);
        if (existing === undefined) {
          const durable = yield* readyTeachingSnapshot(sessionId);
          if (durable !== null) {
            yield* rememberSession(
              operationId,
              "close",
              sessionId,
              requestInput,
              durable
            );
            return durable;
          }
        }
        let record = yield* read(sessionId);
        if (
          isLive(record.snapshot.phase) &&
          record.snapshot.activity === "teaching" &&
          record.snapshot.captureState._tag === "recording" &&
          record.teachingRecorder !== undefined
        ) {
          yield* stopTeachingRecordingUnlocked(
            sessionId,
            `close-recording-${String(operationId ?? sessionId)}`,
            "session-closed"
          );
          record = yield* read(sessionId);
        }
        if (!isLive(record.snapshot.phase)) {
          let { snapshot } = record;
          if (snapshot.run !== null && !record.finalized.persisted) {
            yield* finalizeRunUnlocked(sessionId);
            ({ snapshot } = yield* read(sessionId));
          }
          if (
            snapshot.activity === "teaching" &&
            (snapshot.captureState._tag === "recording" ||
              snapshot.captureState._tag === "finalizing")
          ) {
            const stoppedAt =
              snapshot.captureState._tag === "finalizing"
                ? snapshot.captureState.stoppedAt
                : now().toISOString();
            const { startedAt } = snapshot.captureState;
            const finalizing = {
              ...snapshot,
              boundary: null,
              captureState: {
                _tag: "finalizing" as const,
                startedAt,
                stoppedAt,
              },
              phase: "closed" as const,
              takeover: null,
              updatedAt: stoppedAt,
            };
            yield* save(sessionId, record, finalizing);
            snapshot = yield* finishTeachingClose(
              sessionId,
              record,
              finalizing,
              operationId
            );
          }
          yield* rememberSession(
            operationId,
            "close",
            sessionId,
            requestInput,
            snapshot
          );
          return snapshot;
        }
        return yield* Effect.uninterruptibleMask(() =>
          Effect.gen(function* closeAtomically() {
            const at = now().toISOString();
            const closed =
              record.snapshot.activity === "teaching"
                ? {
                    ...record.snapshot,
                    boundary: null,
                    phase: "closed" as const,
                    takeover: null,
                    updatedAt: at,
                  }
                : {
                    ...record.snapshot,
                    boundary: null,
                    phase: "closed" as const,
                    run: endClosedRun(record.snapshot.run, at),
                    takeover: null,
                    updatedAt: at,
                  };
            yield* save(sessionId, record, closed);
            yield* Scope.close(record.scope, Exit.void);
            if (closed.run !== null) {
              yield* finalizeRunUnlocked(sessionId);
            }
            const finished = (yield* read(sessionId)).snapshot;
            yield* rememberSession(
              operationId,
              "close",
              sessionId,
              requestInput,
              finished
            );
            return finished;
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
          error:
            "The owning process stopped before this Agent Session completed.",
          phase: "interrupted",
          takeover: null,
          updatedAt: at,
        };
        const ended =
          interrupted.run !== null && isTaskRun(interrupted.run)
            ? {
                ...interrupted,
                run: {
                  ...interrupted.run,
                  lifecycle: {
                    endedAt: at,
                    outcome: "process-exited" as const,
                    phase: "ended" as const,
                  },
                },
              }
            : interrupted;
        yield* save(sessionId, record, ended);
        yield* Scope.close(record.scope, Exit.interrupt());
        if (ended.run !== null) {
          yield* finalizeRunUnlocked(sessionId);
        }
        return interrupted;
      }
    );

    const taskMutation = <E>(
      sessionId: AgentSessionId,
      operationId: OperationId,
      kind: AgentOperationKind,
      requestInput: string,
      change: (
        record: SessionRecord,
        run: TaskAgentRunState
      ) => Effect.Effect<AgentSessionSnapshot, E>
    ) =>
      lock.withPermit(
        Effect.gen(function* mutateTask() {
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
          const { run } = record.snapshot;
          if (run === null || !isTaskRun(run) || runEnded(run)) {
            return yield* Effect.fail(
              error(
                "agent_session_conflict",
                "This session has no live task Run."
              )
            );
          }
          const next = yield* change(record, run);
          yield* rememberSession(
            operationId,
            kind,
            sessionId,
            requestInput,
            next
          );
          return next;
        })
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
      assessTask: (sessionId, input, finding, operationId) =>
        taskMutation(
          sessionId,
          operationId,
          finding ? "task-finding" : "task-assess",
          JSON.stringify(input),
          (record, run) =>
            Effect.gen(function* assessTask() {
              if (
                agentIsPaused(record.snapshot) ||
                record.boundaryControl?.pending !== undefined
              ) {
                return yield* Effect.fail(
                  error(
                    "agent_session_conflict",
                    "Return control and resolve the Execution Boundary before assessing the task."
                  )
                );
              }
              if (
                input.evidence.length === 0 ||
                input.explanation.trim().length === 0 ||
                input.evidence.some((reference) => {
                  if (reference.kind === "snapshot") {
                    return !record.runEvidence.snapshots.has(reference.id);
                  }
                  if (reference.kind === "attempt") {
                    return !record.runEvidence.attempts.has(reference.id);
                  }
                  return true;
                })
              ) {
                return yield* Effect.fail(
                  error(
                    "agent_session_invalid",
                    "Cite a Browser Snapshot or attempt produced by this Run and explain the assessment."
                  )
                );
              }
              const at = now().toISOString();
              const assessment = { ...input, submittedAt: at };
              return yield* recordEntry(
                sessionId,
                {
                  actor: "agent",
                  at,
                  description: `${finding ? "Recorded finding" : "Assessed task"} as ${input.outcome}`,
                  detail: input.explanation,
                  dispatched: false,
                  id: `assessment-${randomUUID()}`,
                  outcome: "completed",
                },
                {
                  run: {
                    ...run,
                    assessment: finding ? run.assessment : assessment,
                    findings: finding
                      ? [
                          ...run.findings,
                          { ...assessment, id: `finding-${randomUUID()}` },
                        ]
                      : run.findings,
                    lastAgentActivityAt: at,
                  },
                }
              );
            })
        ),
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
              const record = yield* read(sessionId);
              const pushed = Stream.concat(
                Stream.succeed(record.snapshot),
                Stream.fromEffect(PubSub.take(subscription)).pipe(
                  Stream.repeat(Schedule.forever),
                  Stream.filter(({ id }) => id === sessionId)
                )
              );
              if (record.snapshot.activity !== "teaching") {
                return pushed;
              }
              const durable = Stream.fromEffect(
                refreshedSnapshot(sessionId, record)
              ).pipe(
                Stream.repeat(Schedule.spaced("500 millis")),
                Stream.changesWith(
                  (left, right) => left.updatedAt === right.updatedAt
                )
              );
              return Stream.merge(pushed, durable).pipe(
                Stream.changesWith(
                  (left, right) => left.updatedAt === right.updatedAt
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
      completeRun: (sessionId, agentAccount, operationId) =>
        lock.withPermit(
          completeRunUnlocked(sessionId, agentAccount, operationId)
        ),
      deleteStorage: (sessionId, tabId, input) =>
        requireUserHeldRecord(sessionId).pipe(
          Effect.flatMap((record) =>
            browser.deleteStorage(record.browserSessionId, tabId, input)
          )
        ),
      discardTeachingRecording: (sessionId, operationId) =>
        lock.withPermit(
          discardTeachingRecordingUnlocked(
            sessionId,
            operationId ?? OperationId.make(`discard-${randomUUID()}`)
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
      enterSuppliedVariable: (
        sessionId,
        name,
        ref,
        operationId,
        flowSkillName
      ) =>
        Effect.gen(function* enterSuppliedVerificationVariable() {
          const record = yield* requireLiveRecord(sessionId);
          // Supplied Variables belong to Runs: even an agent preparing
          // Teaching setup has none to enter.
          if (record.snapshot.activity === "teaching") {
            return yield* Effect.fail(
              teachingIsUserLed("This private input was not dispatched.")
            );
          }
          const declared = requireDeclaredVariable(record, name, flowSkillName);
          if (declared._tag === "error") {
            return yield* Effect.fail(declared.error);
          }
          if (agentIsPaused(record.snapshot)) {
            return yield* Effect.fail(
              takenOver("This private input was not dispatched.")
            );
          }
          const value = record.supplied.get(variableKey(name, flowSkillName));
          if (value === undefined) {
            return yield* Effect.fail(
              error(
                "agent_session_invalid",
                `Variable ${name} has not been supplied. Ask the user to enter it in the Dry Run Workspace or resolve its Run decision.`
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
              flowSkillName: flowSkillName ?? null,
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
      get: (sessionId) =>
        read(sessionId).pipe(
          Effect.flatMap((record) => refreshedSnapshot(sessionId, record)),
          Effect.catchIf(
            (cause) => cause.code === "agent_session_not_found",
            () =>
              readyTeachingSnapshot(sessionId).pipe(
                Effect.flatMap((snapshot) =>
                  snapshot === null
                    ? Effect.fail(
                        error(
                          "agent_session_not_found",
                          `Agent Session ${sessionId} was not found.`
                        )
                      )
                    : Effect.succeed(snapshot)
                )
              )
          )
        ),
      handOffTeachingSetup: (sessionId, operationId) =>
        lock.withPermit(
          afterUserInput(
            sessionId,
            handOffTeachingSetupUnlocked(sessionId, operationId)
          )
        ),
      inspectPoint: inspectPointUnlocked,
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
      noteAgentActivity: (sessionId) =>
        mutate(sessionId, (snapshot) =>
          snapshot.run === null || runEnded(snapshot.run)
            ? snapshot
            : {
                ...snapshot,
                run: {
                  ...snapshot.run,
                  lastAgentActivityAt: now().toISOString(),
                },
              }
        ).pipe(Effect.asVoid),
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
      recordInstruction: (sessionId, text, operationId, target) =>
        lock.withPermit(
          afterUserInput(
            sessionId,
            recordInstructionUnlocked(sessionId, text, operationId, target)
          )
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
            // are this session's own decisions, so an external mirror must not
            // drop what the user still owes an answer to.
            pendingDecisions: [
              ...snapshot.pendingDecisions.filter(sessionOwnedDecision),
              ...pendingDecisions,
            ],
            updatedAt: now().toISOString(),
          }));
          return next ?? record.snapshot;
        }),
      renameFlowSkill: (sessionId, name, operationId) =>
        lock.withPermit(
          renameFlowSkillUnlocked(
            sessionId,
            name,
            operationId ?? OperationId.make(`rename-${randomUUID()}`)
          )
        ),
      requestTakeover: (sessionId, reason, operationId) =>
        lock.withPermit(
          beginTakeoverUnlocked(sessionId, reason, "agent", operationId)
        ),
      requestTaskVariable: (sessionId, flowSkillName, name, operationId) =>
        taskMutation(
          sessionId,
          operationId,
          "variable-request",
          JSON.stringify({ flowSkillName, name }),
          (record, run) =>
            Effect.gen(function* requestVariable() {
              const declared = requireDeclaredVariable(
                record,
                name,
                flowSkillName
              );
              if (declared._tag === "error") {
                return yield* Effect.fail(declared.error);
              }
              const variable = run.variables.find(
                (candidate) =>
                  candidate.flowSkillName === flowSkillName &&
                  candidate.name === name
              );
              if (
                variable?.supplied ||
                record.snapshot.pendingDecisions.some(
                  (decision) =>
                    decision.variable?.name === name &&
                    decision.variable.flowSkillName === flowSkillName
                )
              ) {
                return record.snapshot;
              }
              const at = now().toISOString();
              const decision: AgentPendingDecision = {
                boundaryId: null,
                createdAt: at,
                kind: "supply_variable",
                pendingDecisionId: AgentPendingDecisionId.make(
                  `pending-${randomUUID()}`
                ),
                scopeSummary: `Supply Variable ${flowSkillName}/${name}. The value stays on this machine.`,
                sessionId,
                variable: {
                  flowSkillName,
                  name,
                  secret: declared.variable.secret,
                },
              };
              const next = {
                ...record.snapshot,
                pendingDecisions: [
                  ...record.snapshot.pendingDecisions,
                  decision,
                ],
                updatedAt: at,
              };
              yield* save(sessionId, record, next);
              return next;
            })
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
        lock.withPermit(
          afterUserInput(
            sessionId,
            returnControlUnlocked(sessionId, operationId)
          )
        ),
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
                recordingCapture(record)?.recordKeyframe(screenshot);
              })
            ),
            Effect.flatMap((screenshot) =>
              writeScreenshotFile(record, screenshot)
            )
          )
        ),
      sendInput: (sessionId, input) =>
        Effect.gen(function* sendUserInput() {
          const record = yield* requireLiveRecord(sessionId);
          return yield* record.control.lock.withPermit(
            Effect.gen(function* sendOrderedUserInput() {
              if (record.snapshot.controller !== "user") {
                return yield* Effect.fail(
                  makeBrowserRpcError(
                    "agent_control_unavailable",
                    "The agent holds the browser. Take control before driving it yourself."
                  )
                );
              }
              const page = yield* browser.activePage(record.browserSessionId);
              if (!isScroll(input) && !isPointerMove(input)) {
                yield* record.scroll.burst?.close ?? Effect.void;
              }
              if (yield* continueTypingBurst(sessionId, record, page, input)) {
                return;
              }
              const urlBefore = page.url();
              const { focused, pointed, snapshotBefore } =
                yield* observeUserInputTarget(record, page, input);
              const id = `user-input-${randomUUID()}`;
              const action = {
                input: teachingInput(input),
                type: "input" as const,
              };
              const description = describeTeachingInput(input);
              const outcome = yield* Effect.result(
                browser.sendInput(record.browserSessionId, input)
              );
              const at = now().toISOString();
              if (Result.isFailure(outcome)) {
                return yield* failUserInput({
                  at,
                  failure: outcome.failure,
                  id,
                  input,
                  page,
                  record,
                  sessionId,
                  snapshotBefore,
                  urlBefore,
                });
              }
              if (isPointerMove(input)) {
                return;
              }
              if (focused !== undefined && extendsTypingBurst(input)) {
                yield* openTypingBurst(sessionId, record, {
                  at,
                  focused,
                  id,
                  keys: [input],
                  lastKeyAt: yield* Clock.currentTimeMillis,
                  page,
                  snapshotBefore,
                  urlBefore,
                });
                return;
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
                const raw = {
                  action,
                  actor: "user" as const,
                  at,
                  description,
                  id,
                  outcome: "completed" as const,
                  snapshotAfter: null,
                  snapshotBefore,
                  urlAfter,
                  urlBefore,
                };
                const captured = recordingCapture(record)?.recordAction(
                  isScroll(input)
                    ? { ...raw, coalesceKey: SCROLL_COALESCE_KEY }
                    : raw
                );
                if (captured !== undefined) {
                  yield* isScroll(input)
                    ? deferScrollKeyframe(sessionId, record, page, captured.id)
                    : captureTeachingKeyframe(record, page, captured.id, at);
                }
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
            })
          );
        }),
      setEmulation: (sessionId, patch) =>
        Effect.gen(function* configureSessionEmulation() {
          const record = yield* requireUserHeldRecord(sessionId);
          if (record.snapshot.activity !== "teaching") {
            return yield* Effect.fail(
              error(
                "agent_session_conflict",
                "An Interactive Run reproduces the Emulation the Flow Skill was demonstrated under. Configure the browser while Teaching instead."
              )
            );
          }
          const userAgentProfile =
            patch.userAgentProfile ?? record.emulation.userAgentProfile;
          // An identity moves every signal it implies together, so an
          // identity-only change is applied at that identity's own device
          // metrics rather than over the viewport the session already had
          // (ADR 0013). An explicit viewport in the same patch outranks it.
          const viewport =
            patch.viewport ??
            (patch.userAgentProfile === undefined
              ? record.emulation.viewport
              : viewportForIdentity(
                  patch.userAgentProfile,
                  record.emulation.viewport
                ));
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
          settledSnapshot(page, record.registry).pipe(
            Effect.map((snapshot) => redactCapturedSnapshot(record, snapshot)),
            Effect.tap((snapshot) =>
              rememberCurrentUrl(sessionId, record, snapshot.url)
            ),
            Effect.tap((snapshot) =>
              Effect.sync(() => {
                // An observation is the `before` state of the action that
                // follows it, so the Demonstration keeps it.
                recordingCapture(record)?.recordSnapshot(snapshot);
                noteRunEvidence(record, "snapshot", snapshot.snapshotId);
              })
            )
          )
        ),
      start: (input) => lock.withPermit(startUnlocked(input)),
      startPrepared: (request, prepare) =>
        lock.withPermit(
          Effect.gen(function* startPreparedSession() {
            const replayed = replaySession(
              request.operationId,
              "start",
              "start",
              request.request
            );
            if (replayed?._tag === "conflict") {
              return yield* Effect.fail(replayed.error);
            }
            // A retry reads the session as it is now, so a Run that has since
            // ended answers with its closed state rather than a stale start.
            if (replayed?._tag === "replay") {
              return (
                Ref.getUnsafe(sessions).get(replayed.snapshot.id)?.snapshot ??
                replayed.snapshot
              );
            }
            const input = yield* prepare;
            return yield* startUnlocked(
              { ...input, operationId: request.operationId },
              request.request
            );
          })
        ),
      startTeachingRecording: (sessionId, operationId) =>
        lock.withPermit(startTeachingRecordingUnlocked(sessionId, operationId)),
      stopTeachingRecording: (sessionId, operationId) =>
        lock.withPermit(
          afterUserInput(
            sessionId,
            stopTeachingRecordingUnlocked(sessionId, operationId)
          )
        ),
      storage: (sessionId, tabId, kind) =>
        requireLiveRecord(sessionId).pipe(
          Effect.flatMap((record) =>
            browser.getStorage(record.browserSessionId, tabId, kind)
          )
        ),
      supplyDryRunVariable: (sessionId, name, value) =>
        Effect.gen(function* supplyPrivateDryRunInput() {
          const record = yield* requireLiveRecord(sessionId);
          const { dryRun } = record.snapshot;
          if (dryRun === null) {
            return yield* Effect.fail(
              error(
                "agent_session_invalid",
                "Only a Dry Run accepts a Workspace Variable."
              )
            );
          }
          const variable = dryRun.variables.find(
            (candidate) => candidate.name === name && candidate.secret
          );
          if (variable === undefined || value.length === 0) {
            return yield* Effect.fail(
              error(
                "agent_session_invalid",
                `Secret Variable ${name} is not declared or the value is empty.`
              )
            );
          }
          record.supplied.set(name, value);
          const updated = yield* mutate(sessionId, (snapshot) => {
            if (snapshot.activity !== "run" || snapshot.dryRun === null) {
              return snapshot;
            }
            return {
              ...snapshot,
              dryRun: {
                ...snapshot.dryRun,
                variables: snapshot.dryRun.variables.map((item) =>
                  item.name === name ? { ...item, supplied: true } : item
                ),
              },
              updatedAt: now().toISOString(),
            };
          });
          if (updated === undefined) {
            return yield* Effect.fail(
              error(
                "agent_session_not_found",
                `Agent Session ${sessionId} was not found.`
              )
            );
          }
          return updated;
        }),
      tabs: (sessionId) =>
        requireLiveRecord(sessionId).pipe(
          Effect.flatMap((record) => browser.getTabs(record.browserSessionId))
        ),
      takeover: (sessionId, reason, operationId) =>
        lock.withPermit(
          beginTakeoverUnlocked(sessionId, reason, "user", operationId)
        ),
      updateTask: (sessionId, prepare, operationId, requestInput) =>
        taskMutation(
          sessionId,
          operationId,
          "task-update",
          requestInput,
          (record, run) =>
            Effect.gen(function* updateTask() {
              const input = yield* prepare;
              const at = now().toISOString();
              const referencedSkills = [...run.referencedSkills];
              const variables = [...run.variables];
              for (const skill of input.skills) {
                if (
                  !referencedSkills.some(
                    (reference) =>
                      reference.flowSkillName === skill.flowSkillName
                  )
                ) {
                  referencedSkills.push({
                    flowSkillName: skill.flowSkillName,
                    referencedAt: at,
                  });
                  variables.push(...skill.variables);
                }
              }
              const inputs = [...run.inputs];
              for (const supplied of input.inputs) {
                const existing = inputs.findIndex(
                  (value) =>
                    value.flowSkillName === supplied.flowSkillName &&
                    value.name === supplied.name
                );
                if (existing === -1) {
                  inputs.push(supplied);
                } else {
                  inputs[existing] = supplied;
                }
              }
              const nextRun = {
                ...run,
                assessment:
                  input.instruction === undefined ? run.assessment : null,
                inputs,
                instructions:
                  input.instruction === undefined
                    ? run.instructions
                    : [
                        ...run.instructions,
                        { instruction: input.instruction, receivedAt: at },
                      ],
                lastAgentActivityAt: at,
                referencedSkills,
                variables,
              };
              const next = yield* recordEntry(
                sessionId,
                {
                  actor: "user",
                  at,
                  description:
                    input.instruction ??
                    "Referenced requested Flow Skills or supplied task inputs",
                  dispatched: false,
                  id: `instruction-${randomUUID()}`,
                  outcome: "completed",
                },
                { run: nextRun }
              );
              // Admit requested hosts only after the task update has landed. No browser
              // acquisition or Emulation change occurs on this path.
              for (const skill of input.skills) {
                for (const host of skill.hosts) {
                  record.boundaryControl?.hosts.add(host);
                }
              }
              return next;
            })
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
          yield* afterUserInput(sessionId, Effect.void);
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
          const snapshotBefore =
            recordingCapture(record)?.latestSnapshotId() ?? null;
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
            const failed = recordingCapture(record)?.recordAction({
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
            if (failed !== undefined) {
              yield* captureTeachingKeyframe(record, page, failed.id, at);
            }
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
          const capture = recordingCapture(record);
          if (capture !== undefined) {
            // The user drove the browser, and the Demonstration captures the
            // user's actions with the same fidelity as the agent's: a Snapshot
            // of the Page the navigation reached.
            const after = yield* snapshotAfter(record, page, urlBefore).pipe(
              Effect.option
            );
            const captured = capture.recordAction({
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
            yield* captureTeachingKeyframe(record, page, captured.id, at);
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
      const teachingRecordingStore = Option.getOrUndefined(
        yield* Effect.serviceOption(TeachingRecordingStore)
      );
      // A Run persists its own Summary the moment it ends, so the registry
      // needs the store that owns the Catalog Root. It stays optional: a
      // Teaching-only process performs no Runs and has nothing to persist.
      const runStore = Option.getOrUndefined(
        yield* Effect.serviceOption(AgentRunStore)
      );
      const parentScope = yield* Scope.Scope;
      const service = yield* PubSub.unbounded<AgentSessionSnapshot>().pipe(
        Effect.flatMap((events) =>
          makeAgentSession(
            browser,
            options,
            events,
            fileSystem,
            parentScope,
            teachingRecordingStore,
            runStore
          )
        )
      );
      yield* Effect.addFinalizer(() => service.closeAll());
      return service;
    })
  );
