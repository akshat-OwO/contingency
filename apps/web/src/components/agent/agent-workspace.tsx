import type {
  AgentHistoryAction,
  AgentNavigateAction,
  AgentSessionId,
  AgentSessionSnapshot,
  BrowserInput,
  BrowserStreamEvent,
  TeachingProgress,
} from "@contingency/protocol";
import { isBrowserRpcError, OperationId } from "@contingency/protocol";
import {
  useAtom,
  useAtomRefresh,
  useAtomSet,
  useAtomValue,
} from "@effect/atom-react";
import { Effect, Fiber, Result, Schedule } from "effect";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDotIcon,
  LoaderCircleIcon,
  LockKeyholeIcon,
  RotateCwIcon,
  UserRoundIcon,
} from "lucide-react";
import type { FormEvent } from "react";
import { useEffect, useEffectEvent, useRef } from "react";

import {
  agentControlPresentation,
  agentSessionLabel,
  agentStatusLabel,
  agentViewStateAtom,
} from "@/components/agent/agent-workspace-state";
import type { AgentViewState } from "@/components/agent/agent-workspace-state";
import {
  DraftReview,
  VerificationDetails,
} from "@/components/agent/draft-review";
import { RunDetails, RunSummaryPanel } from "@/components/agent/run-view";
import {
  keyboardModifiers,
  makeBrowserInputHandlers,
  mousePosition,
  renderFrame,
} from "@/components/create/browser-input";
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

const EMPTY_AGENT_SESSIONS: readonly AgentSessionSnapshot[] = [];

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

const EmptyState = () => (
  <main className="grid h-[calc(100svh-3.5rem)] min-h-0 place-items-center p-6">
    <section className="max-w-md space-y-2 text-center">
      <h1 className="text-xl font-semibold tracking-tight">
        No active Agent Sessions
      </h1>
      <p className="text-muted-foreground text-sm">
        Start a Teaching or Interactive Run from your MCP client to watch it
        here.
      </p>
    </section>
  </main>
);

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
  frameReady,
  input,
  readOnly,
}: {
  readonly canvasRef: React.RefObject<HTMLCanvasElement | null>;
  readonly frameReady: boolean;
  readonly input: ReturnType<typeof makeBrowserInputHandlers>;
  readonly readOnly: boolean;
}) => (
  <div className="bg-muted/20 relative grid min-h-0 flex-1 place-items-center overflow-hidden p-2">
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
      ref={canvasRef}
      style={{ display: frameReady ? "block" : "none" }}
      tabIndex={readOnly ? undefined : 0}
    />
  </div>
);

const AgentBrowserToolbar = ({
  address,
  navigationError,
  navigationPending,
  onAddressChange,
  onAddressSubmit,
  onNavigate,
  readOnly,
}: {
  readonly address: string;
  readonly navigationError: string | undefined;
  readonly navigationPending: boolean;
  readonly onAddressChange: (address: string) => void;
  readonly onAddressSubmit: (event: FormEvent<HTMLFormElement>) => void;
  readonly onNavigate: (action: "back" | "forward" | "reload") => void;
  readonly readOnly: boolean;
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
    </div>
    {navigationError === undefined ? null : (
      <p className="text-destructive border-b px-3 py-1.5 text-xs">
        {navigationError}
      </p>
    )}
  </>
);

/**
 * What Teaching has captured, and the disclosure ADR 0032 requires: the
 * Teaching Feed leaves this machine for the connected agent, and ordinary
 * visible page content can itself be sensitive.
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
      {teaching.draft === null ? (
        <p className="text-muted-foreground text-xs">
          No draft has been saved from this Demonstration yet.
        </p>
      ) : (
        <Alert>
          <CircleCheckIcon aria-hidden="true" />
          <AlertTitle>Draft saved: {teaching.draft.title}</AlertTitle>
          <AlertDescription>
            <span className="font-mono text-xs wrap-anywhere">
              {teaching.draft.agentFlowId} / {teaching.draft.revisionId}
            </span>
            <ol className="mt-2 list-decimal space-y-1 pl-4">
              {teaching.draft.steps.map((step) => (
                <li key={step.index}>
                  <span className="font-medium">{step.name}</span> —{" "}
                  {step.description}
                  <span className="block font-mono text-xs wrap-anywhere">
                    Evidence: {step.evidenceHash}
                  </span>
                  {step.confirmation ? (
                    <span className="text-muted-foreground block text-xs">
                      Confirmation required
                    </span>
                  ) : null}
                </li>
              ))}
            </ol>
          </AlertDescription>
        </Alert>
      )}
      <p className="text-muted-foreground text-xs">
        The Teaching Feed — your instructions, captured actions, Browser
        Snapshots, masked screenshots, and URL transitions — is shared with the
        connected agent so it can compile a draft. The full Trace, video,
        cookies, and network traffic stay on this machine.
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
          The draft review appears as soon as Teaching has compiled one, so the
          user reviews the proposal before authorizing anything. Corrections
          are saved through the MCP conversation.
        */}
        {session.teaching?.draft ? (
          <DraftReview
            agentFlowId={session.teaching.draft.agentFlowId}
            refreshToken={session.updatedAt}
            revisionId={session.teaching.draft.revisionId}
          />
        ) : null}

        <VerificationDetails session={session} />

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
  input,
  onAddressChange,
  onAddressSubmit,
  onControl,
  onNavigate,
  session,
  state,
}: {
  readonly canvasRef: React.RefObject<HTMLCanvasElement | null>;
  readonly input: ReturnType<typeof makeBrowserInputHandlers>;
  readonly onAddressChange: (address: string) => void;
  readonly onAddressSubmit: (event: FormEvent<HTMLFormElement>) => void;
  readonly onControl: () => void;
  readonly onNavigate: (action: "back" | "forward" | "reload") => void;
  readonly session: AgentSessionSnapshot;
  readonly state: AgentViewState;
}) => {
  const status = agentStatusLabel(session, state.streamConnected);
  const readOnly = session.controller !== "user";
  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="border-b px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Workspace</h1>
            <p className="text-muted-foreground text-xs">
              Watch the browser and session status in real time.
            </p>
          </div>
          <output aria-live="polite" className="text-muted-foreground text-xs">
            {state.streamConnected
              ? "Browser stream connected"
              : "Browser stream disconnected"}
            {state.viewportWidth > 0 && state.viewportHeight > 0
              ? ` · ${state.viewportWidth} × ${state.viewportHeight}`
              : ""}
          </output>
        </div>
      </div>
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
            readOnly={readOnly}
          />
          <AgentBrowserCanvas
            canvasRef={canvasRef}
            frameReady={state.frameReady}
            input={input}
            readOnly={readOnly}
          />
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
    agentBrowserNavigateMutation,
    agentReturnControlMutation,
    agentSessionsAtom,
    agentTakeoverMutation,
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
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRenderFiberRef = useRef<Fiber.Fiber<void, unknown> | null>(null);
  const pendingFrameRef = useRef<Extract<
    BrowserStreamEvent,
    { readonly type: "frame" }
  > | null>(null);
  const activeSessionRef = useRef<AgentSessionId | null>(null);
  const controlFiberRef = useRef<Fiber.Fiber<void, never> | null>(null);
  // The address bar belongs to whoever is typing in it: a URL event never
  // overwrites what the user has not submitted yet.
  const addressEditingRef = useRef(false);

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
    },
    []
  );

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

  return {
    canvasRef,
    changeControl,
    input,
    navigate,
    selectSession,
    sessions,
    sessionsResult,
    setAddress,
    state,
    submitAddress,
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
            : `Agent Session ${requestedSessionId} is not owned by this MCP process or is no longer running.`)
        }
      />
    );
  }
  if (state.phase === "empty") {
    return <EmptyState />;
  }
  if (state.session === undefined) {
    return <LoadingState />;
  }

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
          {view.sessions.map((session) => (
            <option key={session.id} value={session.id}>
              {agentSessionLabel(session)}
            </option>
          ))}
        </select>
      </div>
      <AgentLiveView
        canvasRef={view.canvasRef}
        input={view.input}
        onAddressChange={view.setAddress}
        onAddressSubmit={view.submitAddress}
        onControl={view.changeControl}
        onNavigate={view.navigate}
        session={state.session}
        state={state}
      />
    </div>
  );
};
