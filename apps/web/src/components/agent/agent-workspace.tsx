import type {
  AgentHistoryAction,
  AgentInspectedElement,
  AgentNavigateAction,
  AgentSessionId,
  AgentSessionSnapshot,
  BrowserInput,
  BrowserStreamEvent,
  TeachingProgress,
} from "@contingency/protocol";
import {
  FlowSkillName,
  isBrowserRpcError,
  OperationId,
} from "@contingency/protocol";
import {
  useAtom,
  useAtomRefresh,
  useAtomSet,
  useAtomValue,
} from "@effect/atom-react";
import { Effect, Fiber, Result, Schedule, Schema } from "effect";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDotIcon,
  LoaderCircleIcon,
  LockKeyholeIcon,
  RotateCwIcon,
  SlidersHorizontalIcon,
  UserRoundIcon,
} from "lucide-react";
import type { FormEvent } from "react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import {
  agentControlPresentation,
  agentSessionLabel,
  agentStatusLabel,
  agentViewStateAtom,
  appendConsoleEntry,
  workspaceChromeAtom,
} from "@/components/agent/agent-workspace-state";
import type { AgentViewState } from "@/components/agent/agent-workspace-state";
import { RunDetails, RunSummaryPanel } from "@/components/agent/run-view";
import { InspectOverlay } from "@/components/agent/teaching-inspect";
import { emptyInspectState } from "@/components/agent/teaching-inspect-state";
import type { InspectComment } from "@/components/agent/teaching-inspect-state";
import {
  TeachingRecordingDock,
  WorkspaceEmptyDock,
} from "@/components/agent/teaching-recording-dock";
import type {
  TeachingRecordingGesture,
  TeachingSecondaryAction,
} from "@/components/agent/teaching-recording-state";
import {
  flowSkillDryRunPrompt,
  flowSkillRunPrompt,
  teachingAgentPrompt,
} from "@/components/agent/teaching-recording-state";
import { WorkspaceBrowserSetup } from "@/components/agent/workspace-browser-setup";
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
import { useRpcDependencies } from "@/lib/rpc-dependencies";

import { ExecutionBoundary } from "./execution-boundary";

const errorMessage = <Failure,>(error: Failure): string =>
  error instanceof Error || isBrowserRpcError(error)
    ? error.message
    : "The Workspace could not connect.";

const isFrame = (
  event: BrowserStreamEvent
): event is Extract<BrowserStreamEvent, { readonly type: "frame" }> =>
  event.type === "frame";

const isStatus = (
  event: BrowserStreamEvent
): event is Extract<BrowserStreamEvent, { readonly type: "status" }> =>
  event.type === "status";

const statusIcon = (status: string) => {
  if (status === "Live") {
    return <CircleCheckIcon aria-hidden="true" className="size-4" />;
  }
  if (status === "Failed" || status === "Interrupted") {
    return <CircleAlertIcon aria-hidden="true" className="size-4" />;
  }
  if (status === "Waiting for your control") {
    return <UserRoundIcon aria-hidden="true" className="size-4" />;
  }
  return <CircleDotIcon aria-hidden="true" className="size-4" />;
};

/** What the address bar means when it is not already a full URL. */
const navigationUrl = (address: string): string => {
  const trimmed = address.trim();
  return /^[a-z][\w+.-]*:/iu.test(trimmed) ? trimmed : `https://${trimmed}`;
};

const isFlowSkillName = Schema.is(FlowSkillName);

const EMPTY_AGENT_SESSIONS: readonly AgentSessionSnapshot[] = [];

/** What a Workspace-opened Teaching session is called before it is renamed. */
const DEFAULT_FLOW_SKILL_NAME = "new-flow";

/** The viewport a Workspace-opened Teaching session starts under. */
const WORKSPACE_SESSION_VIEWPORT = { height: 800, width: 1280 };

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
 * The Workspace with no Agent Session behind it. The canvas owns the
 * invitation, and the dock beside it carries the state without repeating the
 * action: `contingency web` opens Teaching sessions itself, so the user does
 * not need an agent to start (#191).
 */
const EmptyState = ({
  error,
  onOpenSession,
  pending,
}: {
  readonly error: string | undefined;
  readonly onOpenSession: (name: string) => void;
  readonly pending: boolean;
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
      className={`bg-muted/20 relative grid min-h-0 flex-1 place-items-center overflow-hidden p-2${
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
        The inspect overlay shares the canvas box so a Page rectangle scales
        onto the frame that drew it, instead of onto the padded column around
        it.
      */}
      <div className="relative max-h-full max-w-full">
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
  showThemeToggle,
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
  /** Only the chrome layout carries the theme control; the navbar owns it otherwise. */
  readonly showThemeToggle: boolean;
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
        header band: the Teaching Workspace has no app header to hold it.
      */}
      {showThemeToggle ? <ModeToggle /> : null}
    </div>
    {navigationError === undefined ? null : (
      <p className="text-destructive border-b px-3 py-1.5 text-xs">
        {navigationError}
      </p>
    )}
  </>
);

/**
 * What this recording has captured so far, and the disclosure ADR 0039
 * requires: the recording stays on this machine, and a learning agent reads a
 * bounded projection of it only after Stop.
 */
const TeachingDetails = ({
  teaching,
}: {
  readonly teaching: TeachingProgress;
}) => (
  <section aria-labelledby="agent-teaching" className="space-y-2">
    <h2 className="text-sm font-semibold" id="agent-teaching">
      Teaching
    </h2>
    <div className="space-y-3 rounded-lg border p-3 text-sm">
      <dl className="grid grid-cols-2 gap-3">
        <div>
          <dt className="text-muted-foreground text-xs">Captured actions</dt>
          <dd className="font-medium">{teaching.actionCount}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs">Instructions</dt>
          <dd className="font-medium">{teaching.instructionCount}</dd>
        </div>
      </dl>
      <p className="text-muted-foreground text-xs">
        A learning agent reads this recording's actions, your instructions, and
        masked keyframes after you stop. The video, the Trace, cookies, and
        network traffic stay on this machine, and every raw artifact is deleted
        once you verify the flow skill.
      </p>
    </div>
  </section>
);

const SessionDetails = ({
  controlError,
  controlPending,
  onControl,
  session,
  status,
}: {
  readonly controlError: string | undefined;
  readonly controlPending: boolean;
  readonly onControl: () => void;
  readonly session: AgentSessionSnapshot;
  readonly status: string;
}) => {
  const control = agentControlPresentation(session);
  return (
    <aside className="min-h-0 min-w-0 overflow-y-auto border-t lg:border-t-0 lg:border-l">
      <div className="space-y-5 p-4">
        <section aria-labelledby="agent-session-status" className="space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold" id="agent-session-status">
                Session status
              </h2>
              <p className="text-muted-foreground mt-1 text-xs">
                {session.activity === "teaching"
                  ? "Teaching"
                  : "Interactive Run"}
              </p>
            </div>
            <span className="bg-muted inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium">
              {statusIcon(status)}
              {status}
            </span>
          </div>
          <dl className="divide-y rounded-lg border text-sm">
            <div className="flex items-start justify-between gap-3 p-3">
              <dt className="text-muted-foreground shrink-0">Client</dt>
              <dd className="min-w-0 text-right font-medium break-words">
                {session.clientName}
              </dd>
            </div>
            <div className="flex items-start justify-between gap-3 p-3">
              <dt className="text-muted-foreground shrink-0">Controller</dt>
              <dd className="font-medium capitalize">{session.controller}</dd>
            </div>
            <div className="flex items-start justify-between gap-3 p-3">
              <dt className="text-muted-foreground shrink-0">Current URL</dt>
              <dd className="min-w-0 truncate text-right font-mono text-xs">
                {session.currentUrl === "about:blank"
                  ? "New browser page"
                  : session.currentUrl}
              </dd>
            </div>
          </dl>
        </section>

        <section aria-labelledby="agent-control" className="space-y-2">
          <h2 className="text-sm font-semibold" id="agent-control">
            Control
          </h2>
          <div className="space-y-3 rounded-lg border p-3 text-sm">
            <p className="font-medium">{control.holder}</p>
            {control.reason === undefined ? null : (
              <p className="text-muted-foreground text-xs">{control.reason}</p>
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
            {control.action === null ? null : (
              <Button
                disabled={controlPending}
                onClick={onControl}
                size="sm"
                type="button"
                variant={session.controller === "user" ? "outline" : "default"}
              >
                {control.action}
              </Button>
            )}
            {controlError === undefined ? null : (
              <p className="text-destructive text-xs">{controlError}</p>
            )}
          </div>
        </section>

        {session.boundary === null || session.boundary === undefined ? null : (
          <ExecutionBoundary session={session} />
        )}

        {session.teaching === null ? null : (
          <TeachingDetails teaching={session.teaching} />
        )}

        {/*
          The live Run beside the browser, and the persisted Run Summary once
          the Run has ended and the browser has been closed.
        */}
        <RunDetails session={session} />
        <RunSummaryPanel session={session} />

        <section aria-labelledby="agent-timeline" className="space-y-2">
          <h2 className="text-sm font-semibold" id="agent-timeline">
            Action timeline
          </h2>
          {session.timeline.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              No actions have been attempted yet.
            </p>
          ) : (
            <ul
              aria-label="Action timeline"
              className="divide-y rounded-lg border"
            >
              {session.timeline.map((entry) => (
                <li className="min-w-0 space-y-1 p-3 text-sm" key={entry.id}>
                  <div className="flex items-baseline justify-between gap-2">
                    {/*
                      A description can be a whole URL, so it wraps inside its
                      own column instead of pushing the outcome out of the card.
                    */}
                    <span className="min-w-0 font-medium wrap-anywhere">
                      {entry.description}
                    </span>
                    <span className="text-muted-foreground shrink-0 text-xs capitalize">
                      {entry.outcome}
                    </span>
                  </div>
                  <p className="text-muted-foreground text-xs">
                    {entry.actor === "user" ? "You" : "The agent"} ·{" "}
                    {new Date(entry.at).toLocaleTimeString()}
                    {entry.dispatched ? " · dispatched to the browser" : ""}
                  </p>
                  {entry.detail === undefined ? null : (
                    <p className="text-muted-foreground text-xs wrap-anywhere">
                      {entry.detail}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
        <p className="text-muted-foreground text-xs">
          Closing this View never pauses the session.
        </p>
      </div>
    </aside>
  );
};

const AgentLiveView = ({
  canvasRef,
  chrome,
  dock,
  input,
  inspect,
  onAddressChange,
  onAddressSubmit,
  onClearConsole,
  onControl,
  onNavigate,
  onToggleSetup,
  recording,
  session,
  state,
}: {
  readonly canvasRef: React.RefObject<HTMLCanvasElement | null>;
  /**
   * Whether this View is the full-bleed Teaching chrome. The chrome has no app
   * header and no in-flow heading: the dock carries the wordmark, the session,
   * and the state, so the browser gets every pixel the dock does not (#185).
   */
  readonly chrome: boolean;
  /** The floating dock, overlaid on the canvas column rather than stacked. */
  readonly dock: React.ReactNode;
  readonly input: ReturnType<typeof makeBrowserInputHandlers>;
  readonly inspect:
    | ((canvas: HTMLCanvasElement | null) => React.ReactNode)
    | undefined;
  readonly onAddressChange: (address: string) => void;
  readonly onAddressSubmit: (event: FormEvent<HTMLFormElement>) => void;
  readonly onClearConsole: () => void;
  readonly onControl: () => void;
  readonly onNavigate: (action: "back" | "forward" | "reload") => void;
  readonly onToggleSetup: () => void;
  readonly recording: boolean;
  readonly session: AgentSessionSnapshot;
  readonly state: AgentViewState;
}) => {
  const status = agentStatusLabel(session, state.streamConnected);
  const readOnly = session.controller !== "user";
  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {chrome ? null : (
        <div className="border-b px-4 py-3 sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-lg font-semibold tracking-tight">
                Workspace
              </h1>
              <p className="text-muted-foreground text-xs">
                Watch the browser and session status in real time.
              </p>
            </div>
            <output
              aria-live="polite"
              className="text-muted-foreground text-xs"
            >
              {state.streamConnected
                ? "Browser stream connected"
                : "Browser stream disconnected"}
              {state.viewportWidth > 0 && state.viewportHeight > 0
                ? ` · ${state.viewportWidth} × ${state.viewportHeight}`
                : ""}
            </output>
          </div>
        </div>
      )}
      {state.browserStreamError === undefined ? null : (
        <Alert className="m-3" variant="destructive">
          <CircleAlertIcon aria-hidden="true" />
          <AlertTitle>Browser stream unavailable</AlertTitle>
          <AlertDescription>{state.browserStreamError}</AlertDescription>
        </Alert>
      )}
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <div className="relative flex min-h-0 flex-col">
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
            showThemeToggle={chrome}
          />
          {/*
            Browser setup stays available in every Teaching state, recording
            included: the device, the Emulation, and the storage a journey needs
            are part of the setup the recording runs under (ADR 0038).
          */}
          {chrome ? (
            <WorkspaceBrowserSetup
              chromeOnly={!state.setupOpen}
              consoleEntries={state.consoleEntries}
              onClearConsole={onClearConsole}
              onClose={onToggleSetup}
              sessionId={session.id}
              userHoldsBrowser={!readOnly}
            />
          ) : null}
          <AgentBrowserCanvas
            canvasRef={canvasRef}
            dockedBelow={chrome}
            frameReady={state.frameReady}
            input={input}
            inspect={inspect}
            readOnly={readOnly}
            recording={recording}
          />
          {chrome || !state.setupOpen ? null : (
            <WorkspaceBrowserSetup
              chromeOnly={false}
              consoleEntries={state.consoleEntries}
              onClearConsole={onClearConsole}
              onClose={onToggleSetup}
              sessionId={session.id}
              userHoldsBrowser={!readOnly}
            />
          )}
          {dock}
          {state.phase === "switching" ? <SwitchingState /> : null}
        </div>
        <SessionDetails
          controlError={state.controlError}
          controlPending={state.controlPending}
          onControl={onControl}
          session={session}
          status={status}
        />
      </div>
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
  const controlFiberRef = useRef<Fiber.Fiber<void, never> | null>(null);
  const recordingFiberRef = useRef<Fiber.Fiber<void, never> | null>(null);
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
            }
      );
      return;
    }
    if (sessions.length === 0 && requestedSessionId === undefined) {
      setState((current) =>
        current.phase === "empty" &&
        current.selectedSessionId === undefined &&
        current.session === undefined
          ? current
          : {
              ...current,
              phase: "empty",
              selectedSessionId: undefined,
              session: undefined,
            }
      );
      return;
    }

    if (sessions.length === 0) {
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
            }
      );
      return;
    }

    const requested = sessions.find(({ id }) => id === requestedSessionId);
    if (requestedSessionId !== undefined && requested === undefined) {
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
        return { ...current, phase: "empty" };
      }
      const changed = current.selectedSessionId !== selected.id;
      const phase =
        changed || current.phase === "loading" ? "switching" : current.phase;
      const session =
        current.session?.id === selected.id ? current.session : selected;
      if (
        current.phase === phase &&
        current.selectedSessionId === selected.id &&
        current.session === session
      ) {
        return current;
      }
      return {
        ...current,
        phase,
        selectedSessionId: selected.id,
        session,
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
          setState((current) => ({ ...current, frameReady: true }));
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
    },
    []
  );

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
    const mutation = Effect.tryPromise({
      catch: (cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
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
                  text: `${frozen.description}: ${text}`,
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
   * A clipboard hand-off. It runs through the same pending-and-error path a
   * mutation does, so a copy that the browser refuses says so in the dock
   * instead of looking like it worked (#210).
   */
  const copyToClipboard = (text: string, failure: string) => {
    runTeachingMutation(
      Effect.tryPromise({
        catch: () => new Error(failure),
        try: () => globalThis.navigator.clipboard.writeText(text),
      })
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
          teachingAgentPrompt(current.flowSkillName, current.recordingId),
          "The agent prompt could not be copied to the clipboard."
        );
        return;
      }
      case "copy-learn-again-prompt": {
        copyToClipboard(
          teachingAgentPrompt(current.flowSkillName, current.recordingId),
          "The learn again prompt could not be copied to the clipboard."
        );
        return;
      }
      case "copy-dry-run-prompt": {
        copyToClipboard(
          flowSkillDryRunPrompt(current.flowSkillName, current.recordingId),
          "The dry run prompt could not be copied to the clipboard."
        );
        return;
      }
      case "copy-run-prompt": {
        copyToClipboard(
          flowSkillRunPrompt(current.flowSkillName),
          "The run prompt could not be copied to the clipboard."
        );
        return;
      }
      case "copy-flow-skill-path": {
        copyToClipboard(
          "skillPath" in current.captureState
            ? current.captureState.skillPath
            : current.flowSkillName,
          "The flow skill path could not be copied to the clipboard."
        );
        return;
      }
      case "copy-failure": {
        copyToClipboard(
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
            recordingError:
              "A flow skill name uses letters, numbers, spaces, dots, dashes, and underscores.",
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
    Effect.runFork(
      Effect.tryPromise({
        catch: (cause) => cause,
        try: () =>
          sendBrowserInput({
            payload: {
              data: { input: browserInput, sessionId },
              type: "agent.browser.input.send",
            },
          }),
      }).pipe(Effect.ignore)
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
      frameReady: false,
      navigationError: undefined,
      phase: "switching",
      selectedSessionId: nextSession.id,
      session: nextSession,
      streamConnected: false,
    }));
  };

  /*
    The full-bleed chrome belongs to the recorded Flow Skill journey: the empty
    Workspace and a Teaching session. An Interactive Run and a Run Summary keep
    the app header, so they keep their navigation (#191).
  */
  const chrome =
    state.phase === "empty" || state.session?.activity === "teaching";
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
          (requestedSessionId === undefined
            ? "The selected Agent Session is no longer available."
            : `Agent Session ${requestedSessionId} is not owned by this server process or is no longer running.`)
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
      />
    );
  }
  if (state.session === undefined) {
    return <LoadingState />;
  }

  const teaching = state.session.activity === "teaching";
  const recording = teaching && state.session.captureState._tag === "recording";

  /*
    An Interactive Run and a Run Summary keep the app header: they are not the
    recorded Flow Skill journey, and hiding the wordmark there would leave them
    with no navigation and no replacement (#191).
  */
  if (!teaching) {
    return (
      <div className="flex h-[calc(100svh-3.5rem)] min-h-0 flex-col">
        <div className="flex shrink-0 items-center gap-3 border-b px-4 py-2 sm:px-6">
          <label className="text-sm font-medium" htmlFor="agent-session-select">
            Agent Session
          </label>
          <select
            aria-label="Agent Session"
            className="bg-background focus-visible:ring-ring h-8 max-w-full min-w-0 rounded-md border px-2 text-sm outline-none focus-visible:ring-2"
            id="agent-session-select"
            onChange={(event) => view.selectSession(event.target.value)}
            value={state.selectedSessionId ?? ""}
          >
            {view.sessions.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {agentSessionLabel(candidate)}
              </option>
            ))}
          </select>
        </div>
        <AgentLiveView
          canvasRef={view.canvasRef}
          chrome={false}
          dock={null}
          input={view.input}
          inspect={undefined}
          onAddressChange={view.setAddress}
          onAddressSubmit={view.submitAddress}
          onClearConsole={view.clearConsole}
          onControl={view.changeControl}
          onNavigate={view.navigate}
          onToggleSetup={view.toggleSetup}
          recording={false}
          session={state.session}
          state={state}
        />
      </div>
    );
  }

  const teachingSession = state.session;
  return (
    <div className="flex h-svh min-h-0 flex-col">
      <AgentLiveView
        canvasRef={view.canvasRef}
        chrome
        dock={
          <TeachingRecordingDock
            captureState={teachingSession.captureState}
            cleanup={teachingSession.recordingCleanup}
            commentCount={state.inspect.comments.length}
            error={state.recordingError}
            flowSkillName={teachingSession.flowSkillName}
            inspecting={state.inspect.open}
            onGesture={view.changeRecording}
            onSecondary={view.runSecondary}
            onSelectSession={view.selectSession}
            onToggleInspect={view.toggleInspect}
            pending={state.recordingPending}
            recordingId={teachingSession.recordingId}
            selectedSessionId={state.selectedSessionId}
            sessions={view.sessions}
          />
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
                  state={state.inspect}
                />
              )
            : undefined
        }
        onAddressChange={view.setAddress}
        onAddressSubmit={view.submitAddress}
        onClearConsole={view.clearConsole}
        onControl={view.changeControl}
        onNavigate={view.navigate}
        onToggleSetup={view.toggleSetup}
        recording={recording}
        session={teachingSession}
        state={state}
      />
    </div>
  );
};
