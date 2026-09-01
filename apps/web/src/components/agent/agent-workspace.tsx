import type {
  AgentSessionId,
  AgentSessionSnapshot,
  BrowserStreamEvent,
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
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDotIcon,
  LoaderCircleIcon,
  UserRoundIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";

import {
  agentControlPresentation,
  agentSessionLabel,
  agentStatusLabel,
  agentViewStateAtom,
} from "@/components/agent/agent-workspace-state";
import type { AgentViewState } from "@/components/agent/agent-workspace-state";
import {
  makeBrowserInputHandlers,
  renderFrame,
} from "@/components/create/browser-input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  agentBrowserFrameAckMutation,
  agentBrowserInputMutation,
  agentReturnControlMutation,
  agentSessionsAtom,
  agentTakeoverMutation,
  runAgentBrowserStream,
  runAgentSessionStream,
} from "@/lib/rpc";

const errorMessage = (error: unknown): string =>
  error instanceof Error || isBrowserRpcError(error)
    ? error.message
    : "The Agent View could not connect.";

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
    <aside className="min-h-0 overflow-y-auto border-t lg:border-t-0 lg:border-l">
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
            <span className="bg-muted inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium">
              {statusIcon(status)}
              {status}
            </span>
          </div>
          <dl className="divide-y rounded-lg border text-sm">
            <div className="flex items-start justify-between gap-3 p-3">
              <dt className="text-muted-foreground">Client</dt>
              <dd className="text-right font-medium">{session.clientName}</dd>
            </div>
            <div className="flex items-start justify-between gap-3 p-3">
              <dt className="text-muted-foreground">Controller</dt>
              <dd className="font-medium capitalize">{session.controller}</dd>
            </div>
            <div className="flex items-start justify-between gap-3 p-3">
              <dt className="text-muted-foreground">Current URL</dt>
              <dd className="max-w-[14rem] truncate text-right font-mono text-xs">
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
            <Button
              disabled={controlPending}
              onClick={onControl}
              size="sm"
              type="button"
              variant={session.controller === "user" ? "outline" : "default"}
            >
              {control.action}
            </Button>
            {controlError === undefined ? null : (
              <p className="text-destructive text-xs">{controlError}</p>
            )}
          </div>
        </section>

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
                <li className="space-y-1 p-3 text-sm" key={entry.id}>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-medium">{entry.description}</span>
                    <span className="text-muted-foreground text-xs capitalize">
                      {entry.outcome}
                    </span>
                  </div>
                  <p className="text-muted-foreground text-xs">
                    {entry.actor === "user" ? "You" : "The agent"} ·{" "}
                    {new Date(entry.at).toLocaleTimeString()}
                    {entry.dispatched ? " · dispatched to the browser" : ""}
                  </p>
                  {entry.detail === undefined ? null : (
                    <p className="text-muted-foreground text-xs">
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
  onControl,
  session,
  state,
}: {
  readonly canvasRef: React.RefObject<HTMLCanvasElement | null>;
  readonly input: ReturnType<typeof makeBrowserInputHandlers>;
  readonly onControl: () => void;
  readonly session: AgentSessionSnapshot;
  readonly state: AgentViewState;
}) => {
  const status = agentStatusLabel(session, state.streamConnected);
  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="border-b px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Agent View</h1>
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
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="relative flex min-h-0 flex-col">
          <AgentBrowserCanvas
            canvasRef={canvasRef}
            frameReady={state.frameReady}
            input={input}
            readOnly={session.controller !== "user"}
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
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRenderFiberRef = useRef<Fiber.Fiber<void, unknown> | null>(null);
  const pendingFrameRef = useRef<Extract<
    BrowserStreamEvent,
    { readonly type: "frame" }
  > | null>(null);
  const activeSessionRef = useRef<AgentSessionId | null>(null);
  const controlFiberRef = useRef<Fiber.Fiber<void, never> | null>(null);

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

  const ackFrame = useCallback(
    (
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
      }).pipe(Effect.ignore),
    [acknowledgeFrame]
  );

  const enqueueFrame = useCallback(
    (
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
    },
    [ackFrame, setState]
  );

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
                enqueueFrame(selectedSessionId, event, () => cancelled);
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
        Effect.runFork(ackFrame(selectedSessionId, pendingFrame));
      }
    };
  }, [ackFrame, enqueueFrame, selectedSessionId, setState]);

  /**
   * Taking control is a direct user action from this View, and returning it is
   * another: the agent can ask, but only the user moves the boundary.
   */
  const changeControl = useCallback(() => {
    const current = state.session;
    if (current === undefined || state.controlPending) {
      return;
    }
    const operationId = OperationId.make(globalThis.crypto.randomUUID());
    setState((previous) => ({
      ...previous,
      controlError: undefined,
      controlPending: true,
    }));
    const change: () => Promise<unknown> =
      current.controller === "user"
        ? () =>
            requestReturnControl({
              payload: {
                data: { operationId, sessionId: current.id },
                type: "agent.session.control.return",
              },
            })
        : () =>
            requestTakeover({
              payload: {
                data: {
                  operationId,
                  reason: "The user took control from Agent View.",
                  sessionId: current.id,
                },
                type: "agent.session.takeover",
              },
            });
    controlFiberRef.current = Effect.runFork(
      Effect.result(
        Effect.tryPromise({ catch: (cause) => cause, try: change })
      ).pipe(
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
  }, [
    requestReturnControl,
    requestTakeover,
    setState,
    state.controlPending,
    state.session,
  ]);

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

  const input = useMemo(
    () =>
      makeBrowserInputHandlers((browserInput) => {
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
      }),
    [sendBrowserInput]
  );

  const selectSession = useCallback(
    (nextSessionId: string) => {
      const nextSession = sessions.find(({ id }) => id === nextSessionId);
      if (nextSession === undefined) {
        return;
      }
      onSelectSession?.(nextSession.id);
      setState((current) => ({
        ...current,
        browserStreamError: undefined,
        frameReady: false,
        phase: "switching",
        selectedSessionId: nextSession.id,
        session: nextSession,
        streamConnected: false,
      }));
    },
    [onSelectSession, sessions, setState]
  );

  return {
    canvasRef,
    changeControl,
    input,
    selectSession,
    sessions,
    sessionsResult,
    state,
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
        onControl={view.changeControl}
        session={state.session}
        state={state}
      />
    </div>
  );
};
