import type {
  AgentHistoryAction,
  AgentInspectedElement,
  AgentNavigateAction,
  AgentSessionId,
  AgentSessionSnapshot,
  BrowserInput,
  BrowserStreamEvent,
} from "@contingency/protocol";
import {
  describeFlowSkillName,
  FlowSkillName,
  flowSkillNameRule,
  OperationId,
} from "@contingency/protocol";
import {
  useAtom,
  useAtomRefresh,
  useAtomSet,
  useAtomValue,
} from "@effect/atom-react";
import { Effect, Fiber, Result, Schedule, Schema, Semaphore } from "effect";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CircleAlertIcon,
  LoaderCircleIcon,
  LockKeyholeIcon,
  RotateCwIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import type { FormEvent } from "react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import {
  adoptSessionSnapshot,
  agentViewStateAtom,
  appendConsoleEntry,
  workspaceChromeAtom,
} from "@/components/agent/agent-workspace-state";
import type { AgentViewState } from "@/components/agent/agent-workspace-state";
import { RunDock } from "@/components/agent/run-dock";
import { InspectOverlay } from "@/components/agent/teaching-inspect";
import { emptyInspectState } from "@/components/agent/teaching-inspect-state";
import type {
  FrameProjection,
  InspectComment,
} from "@/components/agent/teaching-inspect-state";
import {
  TeachingRecordingDock,
  TeachingRecordingNotices,
  WorkspaceEmptyDock,
} from "@/components/agent/teaching-recording-dock";
import type {
  TeachingClipboardAction,
  TeachingRecordingGesture,
  TeachingSecondaryAction,
} from "@/components/agent/teaching-recording-state";
import {
  flowSkillDryRunPrompt,
  flowSkillRunPrompt,
  gestureFailureMessage,
  teachingAgentPrompt,
} from "@/components/agent/teaching-recording-state";
import { WorkspaceBrowserSetup } from "@/components/agent/workspace-browser-setup";
import { DockNotices } from "@/components/agent/workspace-dock";
import {
  keyboardModifiers,
  makeBrowserInputHandlers,
  mousePosition,
  renderFrame,
} from "@/components/browser/browser-input";
import { ModeToggle } from "@/components/mode-toggle";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { failureMessage } from "@/lib/failure-message";
import { useRpcDependencies } from "@/lib/rpc-dependencies";

import { ExecutionBoundary } from "./execution-boundary";

/**
 * How long a copied button holds its confirmation. Long enough to read after
 * the eye travels back to the button, short enough that the resting label is
 * back before the user reaches for it again (#214).
 */
const COPIED_HOLD = "2 seconds";

/**
 * What the Workspace shows for a failure it has no better sentence for. It is
 * total: a failure whose `message` is not a string falls back to the
 * connection sentence rather than reaching a template as an object (#211).
 */
const errorMessage = <Failure,>(error: Failure): string =>
  failureMessage(error, "The Workspace could not connect.");

const isFrame = (
  event: BrowserStreamEvent
): event is Extract<BrowserStreamEvent, { readonly type: "frame" }> =>
  event.type === "frame";

const isStatus = (
  event: BrowserStreamEvent
): event is Extract<BrowserStreamEvent, { readonly type: "status" }> =>
  event.type === "status";

/** What the address bar means when it is not already a full URL. */
const navigationUrl = (address: string): string => {
  const trimmed = address.trim();
  return /^[a-z][\w+.-]*:/iu.test(trimmed) ? trimmed : `https://${trimmed}`;
};

/**
 * How a frame maps onto the Page viewport it was captured from. Inspect draws
 * Page rectangles over the frame, so it reads the mapping from the frame's own
 * metadata rather than assuming the frame is the viewport at 1:1. A value the
 * Page cannot have — a zero or negative zoom — is read as no zoom, so a broken
 * frame leaves the highlight where the Page put it (#212).
 */
const frameProjection = (
  metadata: Extract<BrowserStreamEvent, { readonly type: "frame" }>["metadata"]
): FrameProjection => ({
  offsetTop: Number.isFinite(metadata.offsetTop) ? metadata.offsetTop : 0,
  pageScaleFactor:
    Number.isFinite(metadata.pageScaleFactor) && metadata.pageScaleFactor > 0
      ? metadata.pageScaleFactor
      : 1,
});

/** Frames arrive many times a second; an unchanged mapping is not a render. */
const sameProjection = (left: FrameProjection, right: FrameProjection) =>
  left.offsetTop === right.offsetTop &&
  left.pageScaleFactor === right.pageScaleFactor;

const isFlowSkillName = Schema.is(FlowSkillName);

const EMPTY_AGENT_SESSIONS: readonly AgentSessionSnapshot[] = [];

/** What a Workspace-opened Teaching session is called before it is renamed. */
const DEFAULT_FLOW_SKILL_NAME = "new-flow";

/** The viewport a Workspace-opened Teaching session starts under. */
const WORKSPACE_SESSION_VIEWPORT = { height: 800, width: 1280 };

/** How much one direct user gesture adds to a ceiling. */
const CEILING_EXTENSION_MS = 120_000;

const LoadingState = () => (
  <main
    aria-busy="true"
    aria-live="polite"
    className="grid h-[calc(100svh-3.5rem)] min-h-0 place-items-center p-6"
  >
    <section className="max-w-md space-y-4 text-center">
      <LoaderCircleIcon
        aria-hidden="true"
        className="text-muted-foreground mx-auto size-8 animate-spin"
      />
      <div className="space-y-1.5">
        <h1 className="text-xl font-semibold tracking-tight">
          Loading Agent Sessions…
        </h1>
        <p className="text-muted-foreground text-sm">
          Looking for sessions owned by this local MCP process.
        </p>
      </div>
    </section>
  </main>
);

/**
 * What the Workspace says about a `?session=` id it could not resolve. It sits
 * beside a working Workspace rather than in place of one, and it names the
 * recovery that is actually on screen: the dock's session switcher when this
 * process owns sessions, and opening one when it owns none (#243).
 */
const UnresolvedSessionNotice = ({
  recovery,
  sessionId,
}: {
  readonly recovery: "open" | "switch";
  readonly sessionId: string;
}) => (
  <Alert variant="destructive">
    <CircleAlertIcon aria-hidden="true" />
    <AlertTitle>That session id did not resolve</AlertTitle>
    <AlertDescription>
      {`Agent Session ${sessionId} is not owned by this server process or is no longer running. ${
        recovery === "switch"
          ? "Pick a session from the dock to carry on."
          : "Open a browser session to carry on."
      }`}
    </AlertDescription>
  </Alert>
);

/**
 * The Workspace with no Agent Session behind it. The canvas owns the
 * invitation, and the dock beside it carries the state without repeating the
 * action: `contingency web` opens Teaching sessions itself, so the user does
 * not need an agent to start (#191).
 */
const EmptyState = ({
  error,
  onOpenSession,
  pending,
  unresolvedSessionId,
}: {
  readonly error: string | undefined;
  readonly onOpenSession: (name: string) => void;
  readonly pending: boolean;
  readonly unresolvedSessionId: string | undefined;
}) => {
  // The name is asked for here rather than generated, so the dock's session
  // label is something the user recognizes from the first frame.
  const [name, setName] = useState(DEFAULT_FLOW_SKILL_NAME);
  return (
    <main className="relative flex h-svh min-h-0 flex-col">
      <div className="bg-muted/20 grid min-h-0 flex-1 place-items-center p-6 pb-28">
        <section className="max-w-md space-y-4 text-center">
          <h1 className="text-xl font-semibold tracking-tight">
            No browser session
          </h1>
          <p className="text-muted-foreground text-sm">
            Open a session to set the browser up, then start recording when the
            journey begins.
          </p>
          <form
            className="mx-auto flex max-w-sm items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              onOpenSession(name);
            }}
          >
            <input
              aria-label="Flow skill name"
              className="bg-background focus-visible:ring-ring h-9 min-w-0 flex-1 rounded-md border px-2 text-sm outline-none focus-visible:ring-2"
              onChange={(event) => setName(event.target.value)}
              value={name}
            />
            <Button disabled={pending} type="submit">
              Open browser session
            </Button>
          </form>
          {unresolvedSessionId === undefined ? null : (
            <div className="text-left">
              <UnresolvedSessionNotice
                recovery="open"
                sessionId={unresolvedSessionId}
              />
            </div>
          )}
          {error === undefined ? null : (
            <Alert className="text-left" variant="destructive">
              <CircleAlertIcon aria-hidden="true" />
              <AlertTitle>The session did not open</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </section>
      </div>
      <WorkspaceEmptyDock />
    </main>
  );
};

const UnavailableState = ({ message }: { readonly message: string }) => (
  <main className="grid h-[calc(100svh-3.5rem)] min-h-0 place-items-center p-6">
    <section className="max-w-lg space-y-4 text-center">
      <Alert className="text-left" variant="destructive">
        <CircleAlertIcon aria-hidden="true" />
        <AlertTitle>Agent Session unavailable</AlertTitle>
        <AlertDescription>{message}</AlertDescription>
      </Alert>
      <p className="text-muted-foreground text-sm">
        The session id selects a session; it is not an authentication token.
      </p>
    </section>
  </main>
);

const SwitchingState = () => (
  <div
    aria-busy="true"
    aria-live="polite"
    className="bg-background/80 absolute inset-0 z-10 grid place-items-center p-6 backdrop-blur-[2px]"
  >
    <div className="bg-background flex items-center gap-2 rounded-lg border px-4 py-3 text-sm shadow-sm">
      <LoaderCircleIcon
        aria-hidden="true"
        className="text-muted-foreground size-4 animate-spin"
      />
      Switching Agent Session…
    </div>
  </div>
);

const AgentBrowserCanvas = ({
  canvasRef,
  dockedBelow,
  frameReady,
  input,
  inspect,
  readOnly,
  recording,
}: {
  readonly canvasRef: React.RefObject<HTMLCanvasElement | null>;
  /** Whether the floating dock overlaps the bottom of this column. */
  readonly dockedBelow: boolean;
  readonly frameReady: boolean;
  readonly input: ReturnType<typeof makeBrowserInputHandlers>;
  /** Renders inspect mode over the frame, given the canvas it is drawn on. */
  readonly inspect:
    | ((canvas: HTMLCanvasElement | null) => React.ReactNode)
    | undefined;
  readonly readOnly: boolean;
  /** A live recording draws a red inset ring around the whole frame. */
  readonly recording: boolean;
}) => {
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  return (
    <div
      /*
        The dock floats over this column, so the frame keeps a bottom margin
        wide enough that no part of the browser, and nothing inspect opens over
        it, ends up underneath the dock.
      */
      className={`bg-muted/20 relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-2${
        dockedBelow ? " pb-24" : ""
      }${recording ? " ring-2 ring-red-500 ring-inset" : ""}`}
    >
      {frameReady ? null : (
        <div className="absolute inset-0 grid place-items-center p-6">
          <div className="space-y-2 text-center">
            <LoaderCircleIcon
              aria-hidden="true"
              className="text-muted-foreground mx-auto size-6 animate-spin"
            />
            <p className="text-muted-foreground text-sm">
              Connecting to the live browser…
            </p>
          </div>
        </div>
      )}
      {/*
        The inspect overlay stretches over this box and measures the canvas
        inside it, so a Page rectangle scales onto the frame that drew it.

        The box fills the column rather than shrinking to the canvas: a
        percentage `max-height` against a shrink-to-fit parent resolves to
        `none`, so a canvas wrapped in its own size was only ever fitted by
        width and overflowed the column below (#237). A definite box gives the
        canvas both ceilings, and it keeps its own aspect ratio between them.
      */}
      <div className="relative flex h-full max-h-full min-h-0 w-full max-w-full min-w-0 items-center justify-center">
        {/*
          Watching is read-only; Takeover is not. Control is exclusive, so the
          canvas only forwards input while the user actually holds the browser.
        */}
        <canvas
          aria-label="Live browser viewport"
          aria-readonly={readOnly}
          className="focus-visible:ring-ring max-h-full max-w-full touch-none overscroll-contain bg-white outline-none focus-visible:ring-2 aria-readonly:cursor-default aria-readonly:opacity-95"
          onKeyDown={
            readOnly ? undefined : (event) => input.handleKey(event, "keyDown")
          }
          onKeyUp={
            readOnly ? undefined : (event) => input.handleKey(event, "keyUp")
          }
          onPointerCancel={readOnly ? undefined : input.handlePointerUp}
          onPointerDown={readOnly ? undefined : input.handlePointerDown}
          onPointerMove={readOnly ? undefined : input.handlePointerMove}
          onPointerUp={readOnly ? undefined : input.handlePointerUp}
          ref={(node) => {
            canvasRef.current = node;
            setCanvas(node);
          }}
          style={{ display: frameReady ? "block" : "none" }}
          tabIndex={readOnly ? undefined : 0}
        />
        {inspect?.(canvas)}
      </div>
    </div>
  );
};

const AgentBrowserToolbar = ({
  address,
  navigationError,
  navigationPending,
  onAddressChange,
  onAddressSubmit,
  onNavigate,
  onToggleSetup,
  readOnly,
  setupOpen,
}: {
  readonly address: string;
  readonly navigationError: string | undefined;
  readonly navigationPending: boolean;
  readonly onAddressChange: (address: string) => void;
  readonly onAddressSubmit: (event: FormEvent<HTMLFormElement>) => void;
  readonly onNavigate: (action: "back" | "forward" | "reload") => void;
  readonly onToggleSetup: () => void;
  readonly readOnly: boolean;
  readonly setupOpen: boolean;
}) => (
  <>
    <div className="bg-background flex h-11 shrink-0 items-center gap-1.5 border-b px-2">
      <div
        aria-label="Browser navigation"
        className="flex gap-0.5"
        role="group"
      >
        <Button
          aria-label="Go back"
          disabled={readOnly || navigationPending}
          onClick={() => onNavigate("back")}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <ArrowLeftIcon />
        </Button>
        <Button
          aria-label="Go forward"
          disabled={readOnly || navigationPending}
          onClick={() => onNavigate("forward")}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <ArrowRightIcon />
        </Button>
        <Button
          aria-label="Reload page"
          disabled={readOnly || navigationPending}
          onClick={() => onNavigate("reload")}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <RotateCwIcon />
        </Button>
      </div>
      <form className="min-w-0 flex-1" onSubmit={onAddressSubmit}>
        <InputGroup className="bg-muted/40 h-8">
          <InputGroupAddon align="inline-start">
            {navigationPending ? (
              <LoaderCircleIcon
                aria-hidden="true"
                className="size-3.5 animate-spin"
              />
            ) : (
              <LockKeyholeIcon aria-hidden="true" className="size-3.5" />
            )}
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Browser address"
            disabled={readOnly || navigationPending}
            onChange={(event) => onAddressChange(event.target.value)}
            placeholder={
              readOnly
                ? "Take control to drive the browser"
                : "Enter a URL to navigate"
            }
            spellCheck={false}
            value={address}
          />
        </InputGroup>
      </form>
      {/*
        Browser setup belongs beside the browser it configures: Emulation,
        storage, and network inspection for the MCP-owned browser this session
        holds (ADR 0038).
      */}
      <Button
        aria-label="Browser setup"
        aria-pressed={setupOpen}
        onClick={onToggleSetup}
        size="icon-sm"
        type="button"
        variant={setupOpen ? "secondary" : "ghost"}
      >
        <SlidersHorizontalIcon />
      </Button>
      {/*
        The theme control lives on the browser chrome rather than in a second
        header band: a live Workspace has no app header to hold it (#209).
      */}
      <ModeToggle />
    </div>
    {navigationError === undefined ? null : (
      <p className="text-destructive border-b px-3 py-1.5 text-xs">
        {navigationError}
      </p>
    )}
  </>
);

/**
 * The one live Workspace shell. Teaching, a Dry Run, and an Interactive Run
 * all render it: a full-bleed browser with one floating dock over it, no
 * header band, and no session status sidebar. Splitting the shell by activity
 * is what made the dock's state, next step, and single action disappear
 * exactly when the agent took over (#209).
 */
const AgentLiveView = ({
  canvasRef,
  dock,
  input,
  inspect,
  onAddressChange,
  onAddressSubmit,
  onClearConsole,
  notices,
  onNavigate,
  onToggleSetup,
  recording,
  session,
  state,
}: {
  readonly canvasRef: React.RefObject<HTMLCanvasElement | null>;
  /** The floating dock, overlaid on the canvas rather than stacked above it. */
  readonly dock: React.ReactNode;
  /** What the dock itself has to say above the browser, stacked with ours. */
  readonly notices: React.ReactNode;
  readonly input: ReturnType<typeof makeBrowserInputHandlers>;
  readonly inspect:
    | ((canvas: HTMLCanvasElement | null) => React.ReactNode)
    | undefined;
  readonly onAddressChange: (address: string) => void;
  readonly onAddressSubmit: (event: FormEvent<HTMLFormElement>) => void;
  readonly onClearConsole: () => void;
  readonly onNavigate: (action: "back" | "forward" | "reload") => void;
  readonly onToggleSetup: () => void;
  readonly recording: boolean;
  readonly session: AgentSessionSnapshot;
  readonly state: AgentViewState;
}) => {
  const readOnly = session.controller !== "user";
  const showsNotices =
    notices !== null ||
    state.unresolvedSessionId !== undefined ||
    state.browserStreamError !== undefined ||
    session.interruptedAction !== null ||
    (session.boundary !== null && session.boundary !== undefined);
  return (
    <main className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <AgentBrowserToolbar
        address={state.address}
        navigationError={state.navigationError}
        navigationPending={state.navigationPending}
        onAddressChange={onAddressChange}
        onAddressSubmit={onAddressSubmit}
        onNavigate={onNavigate}
        onToggleSetup={onToggleSetup}
        readOnly={readOnly}
        setupOpen={state.setupOpen}
      />
      {/*
        Browser setup stays available in every state, recording included: the
        device, the Emulation, and the storage a journey needs are part of the
        setup the recording runs under (ADR 0038).
      */}
      <WorkspaceBrowserSetup
        chromeOnly={!state.setupOpen}
        consoleEntries={state.consoleEntries}
        onClearConsole={onClearConsole}
        onClose={onToggleSetup}
        sessionId={session.id}
        userHoldsBrowser={!readOnly}
      />
      <AgentBrowserCanvas
        canvasRef={canvasRef}
        dockedBelow
        frameReady={state.frameReady}
        input={input}
        inspect={inspect}
        readOnly={readOnly}
        recording={recording}
      />
      {/*
        What the dock cannot hold floats over the browser instead: a stream
        failure, the action Takeover interrupted, and a paused Execution
        Boundary. The Boundary is answered in the agent conversation, so it is
        read-only here (ADR 0037). An interrupted action is disclosed rather
        than presented as a rollback: Contingency cannot undo a dispatched
        effect.
      */}
      {showsNotices ? (
        <DockNotices>
          <>
            {notices}
            {state.unresolvedSessionId === undefined ? null : (
              <UnresolvedSessionNotice
                recovery="switch"
                sessionId={state.unresolvedSessionId}
              />
            )}
            {state.browserStreamError === undefined ? null : (
              <Alert variant="destructive">
                <CircleAlertIcon aria-hidden="true" />
                <AlertTitle>Browser stream unavailable</AlertTitle>
                <AlertDescription>{state.browserStreamError}</AlertDescription>
              </Alert>
            )}
            {session.interruptedAction === null ? null : (
              <Alert variant="destructive">
                <CircleAlertIcon aria-hidden="true" />
                <AlertTitle>
                  {session.interruptedAction.description} was already dispatched
                </AlertTitle>
                <AlertDescription>
                  {session.interruptedAction.detail ??
                    "Takeover interrupted this action. The browser may already have performed it."}
                </AlertDescription>
              </Alert>
            )}
            <ExecutionBoundary session={session} />
          </>
        </DockNotices>
      ) : null}
      {dock}
      {state.phase === "switching" ? <SwitchingState /> : null}
    </main>
  );
};

const useAgentView = (
  requestedSessionId: string | undefined,
  onSelectSession: ((sessionId: AgentSessionId) => void) | undefined
) => {
  const {
    agentBrowserFrameAckMutation,
    agentBrowserInputMutation,
    agentBrowserElementInspectMutation,
    agentBrowserNavigateMutation,
    agentReturnControlMutation,
    agentRunCeilingExtendMutation,
    agentSessionStartMutation,
    agentSessionsAtom,
    agentTakeoverMutation,
    agentTeachingFlowRenameMutation,
    agentTeachingFlowRejectMutation,
    agentTeachingFlowVerifyMutation,
    agentTeachingCleanupRetryMutation,
    agentTeachingDryRunStopMutation,
    agentTeachingInstructionRecordMutation,
    agentTeachingRecordingDiscardMutation,
    agentTeachingRecordingStartMutation,
    agentTeachingRecordingStopMutation,
    runAgentBrowserStream,
    runAgentSessionStream,
  } = useRpcDependencies();
  const sessionsResult = useAtomValue(agentSessionsAtom);
  const refreshSessions = useAtomRefresh(agentSessionsAtom);
  const [state, setState] = useAtom(agentViewStateAtom);
  const { selectedSessionId } = state;
  const acknowledgeFrame = useAtomSet(agentBrowserFrameAckMutation, {
    mode: "promise",
  });
  const requestTakeover = useAtomSet(agentTakeoverMutation, {
    mode: "promise",
  });
  const sendBrowserInput = useAtomSet(agentBrowserInputMutation, {
    mode: "promise",
  });
  const requestReturnControl = useAtomSet(agentReturnControlMutation, {
    mode: "promise",
  });
  const navigateBrowser = useAtomSet(agentBrowserNavigateMutation, {
    mode: "promise",
  });
  const extendRunCeiling = useAtomSet(agentRunCeilingExtendMutation, {
    mode: "promise",
  });
  const startTeachingRecording = useAtomSet(
    agentTeachingRecordingStartMutation,
    { mode: "promise" }
  );
  const stopTeachingRecording = useAtomSet(agentTeachingRecordingStopMutation, {
    mode: "promise",
  });
  const discardTeachingRecording = useAtomSet(
    agentTeachingRecordingDiscardMutation,
    { mode: "promise" }
  );
  const recordInstruction = useAtomSet(agentTeachingInstructionRecordMutation, {
    mode: "promise",
  });
  const renameFlowSkill = useAtomSet(agentTeachingFlowRenameMutation, {
    mode: "promise",
  });
  const rejectFlowSkill = useAtomSet(agentTeachingFlowRejectMutation, {
    mode: "promise",
  });
  const verifyFlowSkill = useAtomSet(agentTeachingFlowVerifyMutation, {
    mode: "promise",
  });
  const retryTeachingCleanup = useAtomSet(agentTeachingCleanupRetryMutation, {
    mode: "promise",
  });
  const stopDryRun = useAtomSet(agentTeachingDryRunStopMutation, {
    mode: "promise",
  });
  const inspectElement = useAtomSet(agentBrowserElementInspectMutation, {
    mode: "promise",
  });
  const startSession = useAtomSet(agentSessionStartMutation, {
    mode: "promise",
  });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRenderFiberRef = useRef<Fiber.Fiber<void, unknown> | null>(null);
  const pendingFrameRef = useRef<Extract<
    BrowserStreamEvent,
    { readonly type: "frame" }
  > | null>(null);
  const activeSessionRef = useRef<AgentSessionId | null>(null);
  const [inputLock] = useState(() => Semaphore.makeUnsafe(1));
  const pendingMoveRef = useRef<{ input: BrowserInput } | null>(null);
  const controlFiberRef = useRef<Fiber.Fiber<void, never> | null>(null);
  const recordingFiberRef = useRef<Fiber.Fiber<void, never> | null>(null);
  const copiedFiberRef = useRef<Fiber.Fiber<void, never> | null>(null);
  // The address bar belongs to whoever is typing in it: a URL event never
  // overwrites what the user has not submitted yet.
  const addressEditingRef = useRef(false);
  // One inspect read at a time: a pointer moves far more often than the Page
  // can answer a Browser Snapshot, and a queue of them would outline the past.
  const inspectPendingRef = useRef(false);

  const sessions =
    sessionsResult._tag === "Success"
      ? sessionsResult.value.data.sessions
      : EMPTY_AGENT_SESSIONS;
  const queryLoading =
    sessionsResult._tag === "Initial" || sessionsResult.waiting;
  const queryError =
    sessionsResult._tag === "Failure"
      ? "This server process does not have Agent Sessions available."
      : undefined;

  useEffect(() => {
    const refreshEffect = Effect.sync(() => refreshSessions()).pipe(
      Effect.repeat(Schedule.spaced("2 seconds")),
      Effect.ignore
    );
    const fiber = Effect.runFork(refreshEffect);
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [refreshSessions]);

  useEffect(() => {
    if (queryLoading && sessionsResult._tag === "Initial") {
      return;
    }
    if (queryError !== undefined) {
      setState((current) =>
        current.phase === "unavailable" &&
        current.selectedSessionId === undefined &&
        current.session === undefined
          ? current
          : {
              ...current,
              phase: "unavailable",
              selectedSessionId: undefined,
              session: undefined,
              unresolvedSessionId: undefined,
            }
      );
      return;
    }
    const requested = sessions.find(({ id }) => id === requestedSessionId);
    /*
      A `?session=` id that does not resolve is an ordinary event: the ids are
      long and are handed between processes and agents. It names which session
      to open, so failing to resolve it demotes the request to a notice and
      leaves the rest of the Workspace — dock and session switcher included —
      standing, rather than replacing the page with a dead end (#243).
    */
    const unresolvedSessionId =
      requestedSessionId !== undefined && requested === undefined
        ? requestedSessionId
        : undefined;

    if (sessions.length === 0) {
      setState((current) =>
        current.phase === "empty" &&
        current.selectedSessionId === undefined &&
        current.session === undefined &&
        current.unresolvedSessionId === unresolvedSessionId
          ? current
          : {
              ...current,
              phase: "empty",
              selectedSessionId: undefined,
              session: undefined,
              unresolvedSessionId,
            }
      );
      return;
    }

    setState((current) => {
      const existing =
        current.selectedSessionId === undefined
          ? undefined
          : sessions.find(({ id }) => id === current.selectedSessionId);
      const selected = requested ?? existing ?? sessions[0];
      if (selected === undefined) {
        return { ...current, phase: "empty", unresolvedSessionId };
      }
      const changed = current.selectedSessionId !== selected.id;
      const phase =
        changed || current.phase === "loading" ? "switching" : current.phase;
      const session = adoptSessionSnapshot(current.session, selected);
      if (
        current.phase === phase &&
        current.selectedSessionId === selected.id &&
        current.session === session &&
        current.unresolvedSessionId === unresolvedSessionId
      ) {
        return current;
      }
      return {
        ...current,
        phase,
        selectedSessionId: selected.id,
        session,
        unresolvedSessionId,
      };
    });
  }, [
    queryError,
    queryLoading,
    requestedSessionId,
    sessions,
    sessionsResult._tag,
    setState,
  ]);

  const ackFrame = (
    sessionId: AgentSessionId,
    frame: Extract<BrowserStreamEvent, { readonly type: "frame" }>
  ) =>
    Effect.tryPromise({
      catch: (cause) => cause,
      try: () =>
        acknowledgeFrame({
          payload: {
            data: {
              frameId: frame.seq,
              sessionId,
              streamId: frame.streamId,
            },
            type: "agent.browser.frame.ack",
          },
        }),
    }).pipe(Effect.ignore);

  const enqueueFrame = (
    sessionId: AgentSessionId,
    frame: Extract<BrowserStreamEvent, { readonly type: "frame" }>,
    cancelled: () => boolean
  ) => {
    const previous = pendingFrameRef.current;
    if (previous !== null) {
      Effect.runFork(ackFrame(sessionId, previous));
    }
    pendingFrameRef.current = frame;
    if (frameRenderFiberRef.current !== null) {
      return;
    }
    const render = Effect.gen(function* renderLatestFrame() {
      while (pendingFrameRef.current !== null) {
        const latest = pendingFrameRef.current;
        pendingFrameRef.current = null;
        const canvas = canvasRef.current;
        if (canvas === null || cancelled()) {
          yield* ackFrame(sessionId, latest);
          continue;
        }
        yield* renderFrame(canvas, latest).pipe(
          Effect.ensuring(ackFrame(sessionId, latest))
        );
        if (!cancelled()) {
          const projection = frameProjection(latest.metadata);
          setState((current) => {
            const same =
              current.frameReady &&
              sameProjection(current.frameProjection, projection);
            // A drawn frame is not Workspace state. Returning a new object
            // anyway re-rendered the whole column once per frame, so a Page
            // that repainted kept the column re-rendering with it (#237).
            return same
              ? current
              : { ...current, frameProjection: projection, frameReady: true };
          });
        }
      }
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          frameRenderFiberRef.current = null;
        })
      )
    );
    frameRenderFiberRef.current = Effect.runFork(render);
  };
  const ackFrameFromEffect = useEffectEvent(ackFrame);
  const enqueueFrameFromEffect = useEffectEvent(enqueueFrame);

  useEffect(() => {
    if (selectedSessionId === undefined) {
      activeSessionRef.current = null;
      return;
    }

    let cancelled = false;
    activeSessionRef.current = selectedSessionId;
    pendingFrameRef.current = null;
    setState((current) => ({
      ...current,
      browserStreamError: undefined,
      consoleEntries: [],
      frameReady: false,
      phase: "switching",
      streamConnected: false,
      viewportHeight: 0,
      viewportWidth: 0,
    }));

    const agentFiber = Effect.runFork(
      Effect.gen(function* consumeAgentSessionStream() {
        const outcome = yield* Effect.result(
          runAgentSessionStream(selectedSessionId, (nextSession) =>
            Effect.sync(() => {
              if (cancelled || activeSessionRef.current !== selectedSessionId) {
                return;
              }
              setState((current) => ({
                ...current,
                phase: "live",
                session: nextSession,
              }));
            })
          )
        );
        if (Result.isFailure(outcome) && !cancelled) {
          setState((current) => ({
            ...current,
            browserStreamError: errorMessage(outcome.failure),
            phase: "unavailable",
          }));
        }
      })
    );
    const browserFiber = Effect.runFork(
      Effect.gen(function* consumeAgentBrowserStream() {
        const outcome = yield* Effect.result(
          runAgentBrowserStream(selectedSessionId, (event) =>
            Effect.sync(() => {
              if (cancelled || activeSessionRef.current !== selectedSessionId) {
                return;
              }
              if (isFrame(event)) {
                enqueueFrameFromEffect(
                  selectedSessionId,
                  event,
                  () => cancelled
                );
                return;
              }
              if (isStatus(event)) {
                setState((current) => ({
                  ...current,
                  phase: current.phase === "switching" ? "live" : current.phase,
                  streamConnected: event.connected && event.screencasting,
                  viewportHeight: event.viewportHeight,
                  viewportWidth: event.viewportWidth,
                }));
                return;
              }
              if (event.type === "url") {
                setState((current) => ({
                  ...current,
                  session: current.session
                    ? { ...current.session, currentUrl: event.url }
                    : current.session,
                }));
                return;
              }
              if (event.type === "console" || event.type === "page_error") {
                setState((current) => ({
                  ...current,
                  consoleEntries: appendConsoleEntry(
                    current.consoleEntries,
                    event
                  ),
                }));
              }
            })
          )
        );
        if (Result.isFailure(outcome) && !cancelled) {
          setState((current) => ({
            ...current,
            browserStreamError: errorMessage(outcome.failure),
            phase: "live",
            streamConnected: false,
          }));
        }
      })
    );

    return () => {
      cancelled = true;
      if (activeSessionRef.current === selectedSessionId) {
        activeSessionRef.current = null;
      }
      Effect.runFork(Fiber.interrupt(agentFiber));
      Effect.runFork(Fiber.interrupt(browserFiber));
      const frameFiber = frameRenderFiberRef.current;
      if (frameFiber !== null) {
        Effect.runFork(Fiber.interrupt(frameFiber));
        frameRenderFiberRef.current = null;
      }
      const pendingFrame = pendingFrameRef.current;
      pendingFrameRef.current = null;
      if (pendingFrame !== null) {
        Effect.runFork(ackFrameFromEffect(selectedSessionId, pendingFrame));
      }
    };
  }, [selectedSessionId, setState]);

  /**
   * Taking control is a direct user action from this View, and returning it is
   * another: the agent can ask, but only the user moves the boundary. Teaching
   * has no boundary to move — the user holds the browser throughout.
   */
  const changeControl = () => {
    const current = state.session;
    if (
      current === undefined ||
      state.controlPending ||
      current.activity === "teaching"
    ) {
      return;
    }
    const operationId = OperationId.make(globalThis.crypto.randomUUID());
    setState((previous) => ({
      ...previous,
      controlError: undefined,
      controlPending: true,
    }));
    const change =
      current.controller === "user"
        ? Effect.tryPromise({
            catch: (cause) => cause,
            try: () =>
              requestReturnControl({
                payload: {
                  data: { operationId, sessionId: current.id },
                  type: "agent.session.control.return",
                },
              }),
          }).pipe(Effect.asVoid)
        : Effect.tryPromise({
            catch: (cause) => cause,
            try: () =>
              requestTakeover({
                payload: {
                  data: {
                    operationId,
                    reason: "The user took control from Workspace.",
                    sessionId: current.id,
                  },
                  type: "agent.session.takeover",
                },
              }),
          }).pipe(Effect.asVoid);
    controlFiberRef.current = Effect.runFork(
      Effect.result(change).pipe(
        Effect.flatMap((outcome) =>
          Effect.sync(() => {
            setState((previous) => ({
              ...previous,
              controlError: Result.isFailure(outcome)
                ? errorMessage(outcome.failure)
                : undefined,
              controlPending: false,
            }));
          })
        ),
        Effect.ensuring(
          Effect.sync(() => {
            controlFiberRef.current = null;
          })
        )
      )
    );
  };

  // A control change outlives no View: an unmount mid-request interrupts it
  // rather than leaving a fiber to write to a component that is gone.
  useEffect(
    () => () => {
      const fiber = controlFiberRef.current;
      controlFiberRef.current = null;
      if (fiber !== null) {
        Effect.runFork(Fiber.interrupt(fiber));
      }
      const recordingFiber = recordingFiberRef.current;
      recordingFiberRef.current = null;
      if (recordingFiber !== null) {
        Effect.runFork(Fiber.interrupt(recordingFiber));
      }
      const copiedFiber = copiedFiberRef.current;
      copiedFiberRef.current = null;
      if (copiedFiber !== null) {
        Effect.runFork(Fiber.interrupt(copiedFiber));
      }
    },
    []
  );

  /**
   * Raising a ceiling from the dock. There is deliberately no MCP tool for it,
   * so this button is the only way either budget grows
   * ([ADR 0029](../../../../docs/adr/0029-contingency-owns-the-sole-runner.md)).
   */
  const extendCeiling = (scope: "run" | "step") => {
    const current = state.session;
    if (current === undefined || current.run === null) {
      return;
    }
    Effect.runFork(
      Effect.result(
        Effect.tryPromise({
          catch: (cause) => cause,
          try: () =>
            extendRunCeiling({
              payload: {
                data: {
                  additionalMs: CEILING_EXTENSION_MS,
                  operationId: OperationId.make(globalThis.crypto.randomUUID()),
                  scope,
                  sessionId: current.id,
                },
                type: "agent.run.ceiling.extend",
              },
            }),
        })
      ).pipe(
        Effect.flatMap((outcome) =>
          Effect.sync(() => {
            setState((previous) => ({
              ...previous,
              ceilingError: Result.isFailure(outcome)
                ? errorMessage(outcome.failure)
                : undefined,
            }));
          })
        )
      )
    );
  };

  /**
   * One Teaching mutation dispatched from the dock, reported where the other
   * gesture failures are: the dock is the one place a Teaching refusal is
   * readable, so a rename or a deletion does not invent a second error slot.
   */
  const runTeachingMutation = <Success,>(
    mutation: Effect.Effect<Success, unknown>
  ) => {
    setState((previous) => ({
      ...previous,
      recordingError: undefined,
      recordingPending: true,
    }));
    recordingFiberRef.current = Effect.runFork(
      Effect.result(mutation).pipe(
        Effect.tap((outcome) =>
          Effect.sync(() => {
            setState((previous) => ({
              ...previous,
              recordingError: Result.isFailure(outcome)
                ? errorMessage(outcome.failure)
                : undefined,
              recordingPending: false,
            }));
          })
        ),
        Effect.ensuring(
          Effect.sync(() => {
            recordingFiberRef.current = null;
          })
        ),
        Effect.asVoid
      )
    );
  };

  const changeRecording = (gesture: TeachingRecordingGesture) => {
    const current = state.session;
    if (
      current === undefined ||
      current.activity !== "teaching" ||
      state.recordingPending
    ) {
      return;
    }
    const operationId = OperationId.make(globalThis.crypto.randomUUID());
    setState((previous) => ({
      ...previous,
      recordingError: undefined,
      recordingPending: true,
    }));
    /*
      The failure is carried through untouched. Stringifying a refused RPC
      here is what rendered `[object Object]` in the dock: the refusal is a
      `BrowserRpcError`, not an `Error`, and its message is the only sentence
      that names the lifecycle the gesture lost to (#211).
    */
    const mutation = Effect.tryPromise({
      catch: (cause: unknown) => cause,
      try: async () => {
        if (gesture === "start" || gesture === "stop") {
          const payload = { operationId, sessionId: current.id };
          await (gesture === "start"
            ? startTeachingRecording({
                payload: {
                  data: payload,
                  type: "agent.teaching.recording.start",
                },
              })
            : stopTeachingRecording({
                payload: {
                  data: payload,
                  type: "agent.teaching.recording.stop",
                },
              }));
          return;
        }
        const data = { operationId, recordingId: current.recordingId };
        /*
          Every remaining gesture names a mutation. The union is matched
          exhaustively rather than through a default branch, so a gesture
          added later fails to compile instead of quietly landing on cleanup
          or returning with no effect at all (#210).
        */
        let response;
        switch (gesture) {
          case "stop-dry-run": {
            response = await stopDryRun({
              payload: { data, type: "agent.teaching.dry-run.stop" },
            });
            break;
          }
          case "verify-flow": {
            response = await verifyFlowSkill({
              payload: { data, type: "agent.teaching.flow.verify" },
            });
            break;
          }
          case "retry-cleanup": {
            response = await retryTeachingCleanup({
              payload: { data, type: "agent.teaching.cleanup.retry" },
            });
            break;
          }
          default: {
            throw new Error(
              `Unhandled dock gesture ${gesture satisfies never}`
            );
          }
        }
        setState((previous) => ({
          ...previous,
          session:
            previous.session?.activity === "teaching"
              ? {
                  ...previous.session,
                  captureState: response.data.captureState,
                  recordingCleanup: response.data.cleanup,
                }
              : previous.session,
        }));
      },
    });
    recordingFiberRef.current = Effect.runFork(
      Effect.result(mutation).pipe(
        Effect.tap((outcome) =>
          Effect.sync(() => {
            setState((previous) => ({
              ...previous,
              recordingError: Result.isFailure(outcome)
                ? gestureFailureMessage(gesture, outcome.failure)
                : undefined,
              recordingPending: false,
            }));
          })
        ),
        Effect.ensuring(
          Effect.sync(() => {
            recordingFiberRef.current = null;
          })
        ),
        Effect.asVoid
      )
    );
  };

  /**
   * Opening a Teaching session from the empty canvas. `contingency web` owns
   * Teaching, and refuses `run`, so the activity is named rather than left to
   * the default: the Workspace never opens an Interactive Run (ADR 0039).
   */
  const openSession = (name: string) => {
    if (state.startPending) {
      return;
    }
    const operationId = OperationId.make(globalThis.crypto.randomUUID());
    setState((current) => ({
      ...current,
      startError: undefined,
      startPending: true,
    }));
    Effect.runFork(
      Effect.result(
        Effect.tryPromise({
          catch: (cause) => cause,
          try: () =>
            startSession({
              payload: {
                data: {
                  activity: "teaching",
                  clientName: "Workspace",
                  clientVersion: "web",
                  name: name.trim() === "" ? undefined : name.trim(),
                  operationId,
                  viewport: {
                    deviceScaleFactor: 1,
                    height: WORKSPACE_SESSION_VIEWPORT.height,
                    width: WORKSPACE_SESSION_VIEWPORT.width,
                  },
                },
                type: "agent.session.start",
              },
            }),
        })
      ).pipe(
        Effect.flatMap((outcome) =>
          Effect.sync(() => {
            if (Result.isFailure(outcome)) {
              setState((current) => ({
                ...current,
                startError: errorMessage(outcome.failure),
                startPending: false,
              }));
              return;
            }
            const started = outcome.success.data.session;
            onSelectSession?.(started.id);
            setState((current) => ({
              ...current,
              phase: "switching",
              selectedSessionId: started.id,
              session: started,
              startError: undefined,
              startPending: false,
            }));
            refreshSessions();
          })
        )
      )
    );
  };

  /** The element the live Page has under a point, for the inspect outline. */
  const readInspectedElement = (
    x: number,
    y: number
  ): Effect.Effect<AgentInspectedElement, unknown> => {
    const sessionId = activeSessionRef.current;
    if (sessionId === null) {
      return Effect.fail(new Error("No Agent Session is selected."));
    }
    return Effect.tryPromise({
      catch: (cause) => cause,
      try: () =>
        inspectElement({
          payload: {
            data: { sessionId, x, y },
            type: "agent.browser.element.inspect",
          },
        }),
    }).pipe(Effect.map((answer) => answer.data.element));
  };

  const toggleInspect = () => {
    setState((current) => ({
      ...current,
      inspect: current.inspect.open
        ? { ...emptyInspectState, comments: current.inspect.comments }
        : { ...current.inspect, open: true },
    }));
  };

  const exitInspect = () => {
    setState((current) =>
      current.inspect.open
        ? {
            ...current,
            inspect: {
              ...emptyInspectState,
              comments: current.inspect.comments,
            },
          }
        : current
    );
  };

  const hoverInspect = (x: number, y: number) => {
    if (inspectPendingRef.current) {
      return;
    }
    inspectPendingRef.current = true;
    Effect.runFork(
      Effect.result(readInspectedElement(x, y)).pipe(
        Effect.flatMap((outcome) =>
          Effect.sync(() => {
            inspectPendingRef.current = false;
            setState((current) =>
              current.inspect.open && current.inspect.frozen === undefined
                ? {
                    ...current,
                    inspect: {
                      ...current.inspect,
                      hovered: Result.isFailure(outcome)
                        ? undefined
                        : outcome.success,
                    },
                  }
                : current
            );
          })
        )
      )
    );
  };

  const freezeInspect = (x: number, y: number) => {
    Effect.runFork(
      Effect.result(readInspectedElement(x, y)).pipe(
        Effect.flatMap((outcome) =>
          Effect.sync(() => {
            setState((current) =>
              current.inspect.open
                ? {
                    ...current,
                    inspect: {
                      ...current.inspect,
                      draft: "",
                      error: Result.isFailure(outcome)
                        ? errorMessage(outcome.failure)
                        : undefined,
                      frozen: Result.isFailure(outcome)
                        ? undefined
                        : outcome.success,
                    },
                  }
                : current
            );
          })
        )
      )
    );
  };

  const cancelInspectComment = () => {
    setState((current) => ({
      ...current,
      inspect: {
        ...current.inspect,
        draft: "",
        error: undefined,
        frozen: undefined,
      },
    }));
  };

  const setInspectDraft = (draft: string) => {
    setState((current) => ({
      ...current,
      inspect: { ...current.inspect, draft },
    }));
  };

  /**
   * Attaching a comment records a Teaching instruction on the live recording.
   * It is the same instruction path the agent relays over MCP, so the
   * Demonstration has one instruction stream rather than two (#191).
   */
  const attachInspectComment = () => {
    const sessionId = activeSessionRef.current;
    const { frozen } = state.inspect;
    const text = state.inspect.draft.trim();
    if (sessionId === null || frozen === undefined || text === "") {
      return;
    }
    const operationId = OperationId.make(globalThis.crypto.randomUUID());
    setState((current) => ({
      ...current,
      inspect: { ...current.inspect, error: undefined, pending: true },
    }));
    Effect.runFork(
      Effect.result(
        Effect.tryPromise({
          catch: (cause) => cause,
          try: () =>
            recordInstruction({
              payload: {
                data: {
                  operationId,
                  sessionId,
                  /*
                    The element travels beside the text rather than inside it,
                    so the dock's comment list can name what each instruction
                    landed on without parsing a prefix back out (#213).
                  */
                  target: frozen.description,
                  text,
                },
                type: "agent.teaching.instruction.record",
              },
            }),
        })
      ).pipe(
        Effect.flatMap((outcome) =>
          Effect.sync(() => {
            setState((current) => {
              if (Result.isFailure(outcome)) {
                return {
                  ...current,
                  inspect: {
                    ...current.inspect,
                    error: errorMessage(outcome.failure),
                    pending: false,
                  },
                };
              }
              const comment: InspectComment = {
                description: frozen.description,
                height: frozen.height,
                index: current.inspect.comments.length + 1,
                width: frozen.width,
                x: frozen.x,
                y: frozen.y,
              };
              return {
                ...current,
                inspect: {
                  ...current.inspect,
                  comments: [...current.inspect.comments, comment],
                  draft: "",
                  error: undefined,
                  frozen: undefined,
                  hovered: undefined,
                  pending: false,
                },
              };
            });
          })
        )
      )
    );
  };

  /**
   * Confirm one clipboard hand-off on the button that performed it. A second
   * copy interrupts the first one's timer rather than letting it clear a
   * confirmation it no longer owns.
   */
  const confirmCopied = (action: TeachingClipboardAction) => {
    const running = copiedFiberRef.current;
    copiedFiberRef.current = null;
    if (running !== null) {
      Effect.runFork(Fiber.interrupt(running));
    }
    setState((previous) => ({ ...previous, recordingCopied: action }));
    copiedFiberRef.current = Effect.runFork(
      Effect.sleep(COPIED_HOLD).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            setState((previous) =>
              previous.recordingCopied === action
                ? { ...previous, recordingCopied: undefined }
                : previous
            );
          })
        ),
        Effect.ensuring(
          Effect.sync(() => {
            copiedFiberRef.current = null;
          })
        ),
        Effect.asVoid
      )
    );
  };

  /**
   * A clipboard hand-off. It runs through the same pending-and-error path a
   * mutation does, so a copy that the browser refuses says so in the dock
   * instead of looking like it worked (#210).
   *
   * A write nothing on the page reflects is invisible otherwise, so a
   * successful one confirms itself on the button that performed it (#214).
   */
  const copyToClipboard = (
    action: TeachingClipboardAction,
    text: string,
    failure: string
  ) => {
    setState((previous) => ({ ...previous, recordingCopied: undefined }));
    runTeachingMutation(
      Effect.tryPromise({
        catch: () => new Error(failure),
        try: () => globalThis.navigator.clipboard.writeText(text),
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            confirmCopied(action);
          })
        )
      )
    );
  };

  /**
   * The dock's secondary actions. Each one either mutates the recording or
   * performs the clipboard hand-off its label names, and the union is matched
   * exhaustively so no action can be rendered with nothing behind it (#210).
   */
  const runSecondary = (action: TeachingSecondaryAction, detail?: string) => {
    const current = state.session;
    if (current === undefined || current.activity !== "teaching") {
      return;
    }
    switch (action) {
      case "copy-prompt": {
        copyToClipboard(
          action,
          teachingAgentPrompt(current.flowSkillName, current.recordingId),
          "The agent prompt could not be copied to the clipboard."
        );
        return;
      }
      case "copy-learn-again-prompt": {
        copyToClipboard(
          action,
          teachingAgentPrompt(current.flowSkillName, current.recordingId),
          "The learn again prompt could not be copied to the clipboard."
        );
        return;
      }
      case "copy-dry-run-prompt": {
        copyToClipboard(
          action,
          flowSkillDryRunPrompt(current.flowSkillName, current.recordingId),
          "The dry run prompt could not be copied to the clipboard."
        );
        return;
      }
      case "copy-run-prompt": {
        copyToClipboard(
          action,
          flowSkillRunPrompt(current.flowSkillName),
          "The run prompt could not be copied to the clipboard."
        );
        return;
      }
      case "copy-flow-skill-path": {
        copyToClipboard(
          action,
          "skillPath" in current.captureState
            ? current.captureState.skillPath
            : current.flowSkillName,
          "The flow skill path could not be copied to the clipboard."
        );
        return;
      }
      case "copy-failure": {
        copyToClipboard(
          action,
          current.captureState._tag === "dry-run-failed"
            ? current.captureState.dryRunResult.observableOutcome
            : current.flowSkillName,
          "The failure could not be copied to the clipboard."
        );
        return;
      }
      case "reject-flow": {
        runTeachingMutation(
          Effect.tryPromise({
            catch: (cause) => cause,
            try: async () => {
              const response = await rejectFlowSkill({
                payload: {
                  data: {
                    operationId: OperationId.make(
                      globalThis.crypto.randomUUID()
                    ),
                    recordingId: current.recordingId,
                  },
                  type: "agent.teaching.flow.reject",
                },
              });
              setState((previous) => ({
                ...previous,
                session:
                  previous.session?.activity === "teaching"
                    ? {
                        ...previous.session,
                        captureState: response.data.captureState,
                        recordingCleanup: response.data.cleanup,
                      }
                    : previous.session,
              }));
            },
          })
        );
        return;
      }
      case "rename-flow": {
        const name = (detail ?? "").trim();
        if (!isFlowSkillName(name)) {
          setState((previous) => ({
            ...previous,
            recordingError: describeFlowSkillName(name) ?? flowSkillNameRule,
          }));
          return;
        }
        runTeachingMutation(
          Effect.tryPromise({
            catch: (cause) => cause,
            try: () =>
              renameFlowSkill({
                payload: {
                  data: {
                    name,
                    operationId: OperationId.make(
                      globalThis.crypto.randomUUID()
                    ),
                    sessionId: current.id,
                  },
                  type: "agent.teaching.flow.rename",
                },
              }),
          })
        );
        return;
      }
      case "delete-recording": {
        runTeachingMutation(
          Effect.tryPromise({
            catch: (cause) => cause,
            try: () =>
              discardTeachingRecording({
                payload: {
                  data: {
                    operationId: OperationId.make(
                      globalThis.crypto.randomUUID()
                    ),
                    sessionId: current.id,
                  },
                  type: "agent.teaching.recording.discard",
                },
              }),
          })
        );
        return;
      }
      default: {
        throw new Error(
          `Unhandled dock secondary action ${action satisfies never}`
        );
      }
    }
  };

  const currentUrl = state.session?.currentUrl;
  useEffect(() => {
    if (addressEditingRef.current || currentUrl === undefined) {
      return;
    }
    const next = currentUrl === "about:blank" ? "" : currentUrl;
    setState((current) =>
      current.address === next ? current : { ...current, address: next }
    );
  }, [currentUrl, setState]);

  const setAddress = (address: string) => {
    addressEditingRef.current = true;
    setState((current) => ({ ...current, address }));
  };

  /**
   * Navigation during Takeover. The user drives the same browser the agent
   * does, so it goes through the Agent Session rather than the generic browser
   * RPCs: the lower-level session id never leaves the process.
   */
  const runNavigation = (action: AgentHistoryAction | AgentNavigateAction) => {
    const sessionId = activeSessionRef.current;
    if (sessionId === null) {
      return;
    }
    setState((current) => ({
      ...current,
      navigationError: undefined,
      navigationPending: true,
    }));
    Effect.runFork(
      Effect.result(
        Effect.tryPromise({
          catch: (cause) => cause,
          try: () =>
            navigateBrowser({
              payload: {
                data: { action, sessionId },
                type: "agent.browser.navigate",
              },
            }),
        })
      ).pipe(
        Effect.flatMap((outcome) =>
          Effect.sync(() => {
            setState((current) => ({
              ...current,
              navigationError: Result.isFailure(outcome)
                ? errorMessage(outcome.failure)
                : undefined,
              navigationPending: false,
            }));
          })
        )
      )
    );
  };

  const navigate = (action: "back" | "forward" | "reload") => {
    runNavigation({ action, type: "history" });
  };

  const submitAddress = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const url = navigationUrl(state.address);
    if (url === "https://") {
      return;
    }
    addressEditingRef.current = false;
    runNavigation({ type: "navigate", url });
  };

  const dispatchInput = (browserInput: BrowserInput) => {
    const sessionId = activeSessionRef.current;
    if (sessionId === null) {
      return;
    }
    let inputForDispatch: () => BrowserInput;
    if (
      browserInput.type === "input_mouse" &&
      browserInput.eventType === "mouseMoved"
    ) {
      const pending = pendingMoveRef.current;
      if (pending !== null) {
        pending.input = browserInput;
        return;
      }
      const move = { input: browserInput };
      pendingMoveRef.current = move;
      inputForDispatch = () => {
        if (pendingMoveRef.current === move) {
          pendingMoveRef.current = null;
        }
        return move.input;
      };
    } else {
      pendingMoveRef.current = null;
      inputForDispatch = () => browserInput;
    }
    Effect.runFork(
      inputLock.withPermit(
        Effect.sync(inputForDispatch).pipe(
          Effect.flatMap((input) =>
            Effect.tryPromise({
              catch: (cause) => cause,
              try: () =>
                sendBrowserInput({
                  payload: {
                    data: { input, sessionId },
                    type: "agent.browser.input.send",
                  },
                }),
            })
          ),
          Effect.ignore
        )
      )
    );
  };

  const input = makeBrowserInputHandlers(dispatchInput);

  /**
   * Scrolling is a wheel event, and React only offers it passively, so the
   * canvas listens itself to keep the page from scrolling underneath it.
   */
  const controller = state.session?.controller;
  const dispatchInputFromEffect = useEffectEvent(dispatchInput);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || controller !== "user") {
      return;
    }
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      dispatchInputFromEffect({
        ...mousePosition(canvas, event),
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        eventType: "mouseWheel",
        modifiers: keyboardModifiers(event),
        type: "input_mouse",
      });
    };
    canvas.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      canvas.removeEventListener("wheel", handleWheel);
    };
  }, [controller]);

  const selectSession = (nextSessionId: string) => {
    const nextSession = sessions.find(({ id }) => id === nextSessionId);
    if (nextSession === undefined) {
      return;
    }
    onSelectSession?.(nextSession.id);
    addressEditingRef.current = false;
    setState((current) => ({
      ...current,
      address:
        nextSession.currentUrl === "about:blank" ? "" : nextSession.currentUrl,
      browserStreamError: undefined,
      ceilingError: undefined,
      controlError: undefined,
      frameReady: false,
      navigationError: undefined,
      phase: "switching",
      selectedSessionId: nextSession.id,
      session: nextSession,
      streamConnected: false,
      unresolvedSessionId: undefined,
    }));
  };

  /*
    Every live Workspace is full-bleed: the empty canvas, a Teaching session, a
    Dry Run, and an Interactive Run all carry the wordmark and the session in
    one dock, so the app header steps aside for all of them. A Run Summary and
    an unknown route keep it, because they have no dock (#209).
  */
  const chrome = state.phase === "empty" || state.session !== undefined;
  const setChrome = useAtomSet(workspaceChromeAtom);
  useEffect(() => {
    setChrome(chrome);
    return () => {
      setChrome(false);
    };
  }, [chrome, setChrome]);

  /*
    Inspect and its pins belong to the recording they were attached to. Stop,
    a discarded bundle, or a second Start leaves inspect mode and clears the
    pins rather than carrying markers from a recording that has ended.
  */
  const recordingKey =
    state.session?.activity === "teaching" &&
    state.session.captureState._tag === "recording"
      ? state.session.recordingId
      : undefined;
  useEffect(() => {
    setState((current) =>
      current.inspect === emptyInspectState
        ? current
        : { ...current, inspect: emptyInspectState }
    );
  }, [recordingKey, setState]);

  const clearConsole = () => {
    setState((current) => ({ ...current, consoleEntries: [] }));
  };

  const toggleSetup = () => {
    setState((current) => ({ ...current, setupOpen: !current.setupOpen }));
  };

  return {
    attachInspectComment,
    cancelInspectComment,
    canvasRef,
    changeControl,
    changeRecording,
    clearConsole,
    exitInspect,
    extendCeiling,
    freezeInspect,
    hoverInspect,
    input,
    navigate,
    openSession,
    runSecondary,
    selectSession,
    sessions,
    sessionsResult,
    setAddress,
    setInspectDraft,
    state,
    submitAddress,
    toggleInspect,
    toggleSetup,
  };
};

export const AgentWorkspace = ({
  onSelectSession,
  requestedSessionId,
}: {
  readonly onSelectSession?: ((sessionId: AgentSessionId) => void) | undefined;
  readonly requestedSessionId?: string | undefined;
}) => {
  const view = useAgentView(requestedSessionId, onSelectSession);
  const { sessionsResult, state } = view;
  if (sessionsResult._tag === "Initial") {
    return <LoadingState />;
  }
  if (sessionsResult._tag === "Failure") {
    return (
      <UnavailableState message="Agent Sessions are unavailable in this server process." />
    );
  }
  if (state.phase === "unavailable") {
    return (
      <UnavailableState
        message={
          state.browserStreamError ??
          "The selected Agent Session is no longer available."
        }
      />
    );
  }
  if (state.phase === "empty") {
    return (
      <EmptyState
        error={state.startError}
        onOpenSession={view.openSession}
        pending={state.startPending}
        unresolvedSessionId={state.unresolvedSessionId}
      />
    );
  }
  if (state.session === undefined) {
    return <LoadingState />;
  }

  const { session } = state;
  const teaching = session.activity === "teaching";
  const recording = teaching && session.captureState._tag === "recording";

  return (
    <div className="flex h-svh min-h-0 flex-col">
      <AgentLiveView
        canvasRef={view.canvasRef}
        dock={
          session.activity === "teaching" ? (
            <TeachingRecordingDock
              captureState={session.captureState}
              cleanup={session.recordingCleanup}
              copied={state.recordingCopied}
              flowSkillName={session.flowSkillName}
              instructions={session.teaching.instructions}
              inspecting={state.inspect.open}
              onGesture={view.changeRecording}
              onSecondary={view.runSecondary}
              onSelectSession={view.selectSession}
              onToggleInspect={view.toggleInspect}
              pending={state.recordingPending}
              selectedSessionId={state.selectedSessionId}
              sessions={view.sessions}
            />
          ) : (
            <RunDock
              controlError={state.controlError}
              controlPending={state.controlPending}
              extendError={state.ceilingError}
              onControl={view.changeControl}
              onExtendCeiling={view.extendCeiling}
              onSelectSession={view.selectSession}
              selectedSessionId={state.selectedSessionId}
              session={session}
              sessions={view.sessions}
              streamConnected={state.streamConnected}
            />
          )
        }
        input={view.input}
        inspect={
          recording && state.inspect.open
            ? (canvas) => (
                <InspectOverlay
                  canvas={canvas}
                  onAttach={view.attachInspectComment}
                  onCancel={view.cancelInspectComment}
                  onDraftChange={view.setInspectDraft}
                  onExit={view.exitInspect}
                  onFreeze={view.freezeInspect}
                  onHover={view.hoverInspect}
                  projection={state.frameProjection}
                  state={state.inspect}
                />
              )
            : undefined
        }
        notices={
          session.activity === "teaching" ? (
            <TeachingRecordingNotices
              captureState={session.captureState}
              error={state.recordingError}
              recordingId={session.recordingId}
            />
          ) : null
        }
        onAddressChange={view.setAddress}
        onAddressSubmit={view.submitAddress}
        onClearConsole={view.clearConsole}
        onNavigate={view.navigate}
        onToggleSetup={view.toggleSetup}
        recording={recording}
        session={session}
        state={state}
      />
    </div>
  );
};
