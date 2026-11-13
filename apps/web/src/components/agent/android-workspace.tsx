import { AgentSessionId, OperationId } from "@contingency/protocol";
import type {
  NativeInput,
  AndroidWorkspaceCommand,
  AndroidWorkspaceSnapshot,
  AndroidWorkspaceSummary,
  FlowName,
} from "@contingency/protocol";
import {
  useAtom,
  useAtomRefresh,
  useAtomSet,
  useAtomValue,
} from "@effect/atom-react";
import { Cause, Effect, Fiber, Option, Schema } from "effect";
import { Atom, AsyncResult } from "effect/reactivity";
import {
  CircleIcon,
  MessageSquareTextIcon,
  SmartphoneIcon,
  SquareIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  DockNotices,
  DockShell,
  DockSpacer,
  DockStatus,
  DockWordmark,
} from "@/components/agent/workspace-dock";
import { FlowsDockButton } from "@/components/catalog/flows-dock-button";
import { showsFlowsEntry } from "@/components/catalog/flows-drawer-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useRpcDependencies } from "@/lib/rpc-dependencies";
import { cn } from "@/lib/utils";

import { workspaceChromeAtom } from "./agent-workspace-state";
import { AndroidDevice } from "./android-device";
import {
  AndroidVariables,
  AndroidFieldEntry,
  AndroidInstructionEntry,
  AndroidRequests,
  AndroidSessionSelect,
  AndroidStateBadges,
} from "./android-dock";
import {
  androidDockPresentation,
  androidFlowsSessionView,
  isLiveAndroidSession,
} from "./android-dock-state";
import type { AndroidDockGesture } from "./android-dock-state";
import { AndroidRunSummary } from "./android-run-summary";
import { AndroidSetupSheet } from "./android-setup-sheet";
import { WorkspaceLayout } from "./android-workspace-layout";
import {
  deviceCleanupKey,
  deviceSummaryLabel,
} from "./android-workspace-state";
import { DeviceElements } from "./device-elements";
import { makeNativeInputQueue } from "./native-input";
import {
  sessionStartGestureAtom,
  useWorkspaceGesture,
} from "./workspace-gesture";
import type { GestureRun } from "./workspace-gesture";
import { WorkspacePlatformBar } from "./workspace-platform";
import { NEW_NATIVE_SESSION } from "./workspace-platform-state";

interface WorkspaceState {
  readonly session: AndroidWorkspaceSnapshot | null;
  readonly failure: string | null;
  /** The picked field the person closed, until another one is picked. */
  readonly dismissedField: string | null;
  readonly instructing: boolean;
  /**
   * A comment was sent and has not answered. The composer and its draft stay
   * until it saves, so a refusal leaves them for another try.
   */
  readonly instructionPending: boolean;
  /** Why the last Forwarded Input sent nothing, until more input is sent. */
  readonly inputRefusal: string | null;
  /** The input refusal was set aside when the comment tier opened. */
  readonly refusalDismissed: boolean;
  readonly setupOpen: boolean;
}
const workspaceAtom = Atom.make<WorkspaceState>({
  dismissedField: null,
  failure: null,
  inputRefusal: null,
  instructing: false,
  instructionPending: false,
  refusalDismissed: false,
  session: null,
  setupOpen: false,
});
const applySnapshot = (
  current: WorkspaceState,
  session: AndroidWorkspaceSnapshot
): WorkspaceState =>
  current.session?.id === session.id &&
  current.session.revision > session.revision
    ? current
    : { ...current, failure: null, session };
const operationId = () =>
  OperationId.make(`workspace-android-${crypto.randomUUID()}`);
const message = (cause: unknown) =>
  Schema.decodeUnknownOption(Schema.Struct({ message: Schema.String }))(
    cause
  ).pipe(
    Option.map((value) => value.message),
    Option.getOrElse(() => "Android Workspace is unavailable.")
  );
/**
 * The picker always lists the selected session: the session list is a
 * separate query and can lag a session that was just opened.
 */
const withSelected = (
  sessions: readonly AndroidWorkspaceSummary[],
  session: AndroidWorkspaceSnapshot
): readonly AndroidWorkspaceSummary[] =>
  sessions.some((entry) => entry.id === session.id)
    ? sessions
    : [session, ...sessions];
const fieldKey = (field: NonNullable<AndroidWorkspaceSnapshot["field"]>) =>
  `${field.observationId}:${field.target}`;

/** The command a dock gesture names. */
const gestureCommand = (
  gesture: AndroidDockGesture,
  session: AndroidWorkspaceSnapshot
): AndroidWorkspaceCommand => {
  const fields = { operationId: operationId(), sessionId: session.id };
  switch (gesture) {
    case "prepare":
    case "recover": {
      return { _tag: gesture, ...fields };
    }
    case "start-recording":
    case "stop-recording": {
      return {
        _tag: "record",
        ...fields,
        start: gesture === "start-recording",
      };
    }
    case "take-control":
    case "return-control": {
      return {
        _tag: "control",
        ...fields,
        controller: gesture === "take-control" ? "user" : "agent",
      };
    }
    default: {
      return {
        _tag: "flow-decision",
        ...fields,
        decision: gesture === "verify-flow" ? "verify" : "retry-cleanup",
      };
    }
  }
};

/** What the device glass says while it has no stream to show. */
const glassText = (session: AndroidWorkspaceSnapshot) => {
  if (session.phase === "pending") {
    return "Prepare the emulator from the dock to show its screen here.";
  }
  if (session.phase === "refused") {
    return "This session never used the emulator.";
  }
  // The dock says what to do next; the stage only says what became of it.
  return "Emulator released.";
};

export const AndroidEmptyState = ({
  onOpen,
  onSelect,
  sessions,
}: {
  readonly onOpen: () => void;
  readonly onSelect: (sessionId: string) => void;
  readonly sessions: readonly AndroidWorkspaceSummary[];
}) => (
  <main className="relative flex h-full min-h-0 flex-col">
    <WorkspacePlatformBar />
    <div className="bg-muted/40 grid min-h-0 flex-1 place-items-center bg-[radial-gradient(var(--color-border)_1px,transparent_1px)] [background-size:16px_16px] p-4 sm:p-6">
      <section className="material-panel w-full max-w-md space-y-4 rounded-xl p-5 shadow-[0_24px_64px_-32px_rgb(0_0_0/0.35)] sm:p-6">
        <div
          aria-hidden="true"
          className="bg-muted text-muted-foreground grid size-10 place-items-center rounded-lg border"
        >
          <SmartphoneIcon className="size-5" />
        </div>
        <div className="space-y-1.5">
          <h1 className="text-xl font-semibold tracking-tight">
            No Android session
          </h1>
          <p className="text-muted-foreground text-sm text-pretty">
            Open a session to pick a device and an app, then start recording
            when the journey begins.
          </p>
        </div>
        {sessions.length === 0 ? null : (
          <div className="flex">
            <AndroidSessionSelect
              onSelect={onSelect}
              selectedSessionId={undefined}
              sessions={sessions}
            />
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button onClick={onOpen} size="lg">
            <SmartphoneIcon />
            Open Android session
          </Button>
        </div>
      </section>
    </div>
  </main>
);

type SetState = (update: (current: WorkspaceState) => WorkspaceState) => void;
/** How often an idle session is observed. Input never waits on it. */
const IDLE_OBSERVATION = "3 seconds";
type Mutate = (command: AndroidWorkspaceCommand) => boolean;

/**
 * Reads a `?android=` session once, then refreshes the selected session's
 * observation on a slow idle cadence. The server observes each burst of the
 * user's input itself once it settles, so this only keeps an idle screen and
 * the device checks current. The stream, not this, is what the person sees.
 */
const useAndroidSessionSync = (
  requestedSessionId: string | undefined,
  session: AndroidWorkspaceSnapshot | null,
  setState: SetState
) => {
  const { runAndroidWorkspaceCommand } = useRpcDependencies();
  useEffect(() => {
    // `new` asks for the empty Workspace, whatever was shown before.
    if (requestedSessionId === NEW_NATIVE_SESSION) {
      setState((current) =>
        current.session === null ? current : { ...current, session: null }
      );
      return;
    }
    if (
      requestedSessionId === undefined ||
      !Schema.is(AgentSessionId)(requestedSessionId)
    ) {
      return;
    }
    // A read the route has moved past must not land: interrupting the fiber
    // can lose the race with its completion.
    let requested = true;
    const fiber = Effect.runFork(
      runAndroidWorkspaceCommand({
        _tag: "read",
        sessionId: requestedSessionId,
      }).pipe(
        Effect.tap((snapshot) =>
          Effect.sync(() => {
            if (requested) {
              setState((current) => applySnapshot(current, snapshot));
            }
          })
        ),
        Effect.catchCause((failureCause) =>
          Effect.sync(() => {
            if (requested) {
              setState((current) => ({
                ...current,
                failure: Cause.pretty(failureCause),
              }));
            }
          })
        )
      )
    );
    return () => {
      requested = false;
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [requestedSessionId, runAndroidWorkspaceCommand, setState]);
  const id = session?.id;
  const running = session?.phase === "running";
  useEffect(() => {
    if (id === undefined || !running) {
      return;
    }
    const reportMirrorFailure = (failureCause: Cause.Cause<unknown>) =>
      runAndroidWorkspaceCommand({ _tag: "read", sessionId: id }).pipe(
        Effect.tap((snapshot) =>
          Effect.sync(() =>
            setState((current) =>
              current.session?.id === id
                ? {
                    ...current,
                    failure:
                      snapshot.phase === "paused"
                        ? null
                        : Cause.pretty(failureCause),
                    session: snapshot,
                  }
                : current
            )
          )
        ),
        Effect.ignore
      );
    const fiber = Effect.runFork(
      Effect.forever(
        Effect.gen(function* observeSelectedDevice() {
          const snapshot = yield* runAndroidWorkspaceCommand({
            _tag: "observe",
            image: false,
            sessionId: id,
          });
          yield* Effect.sync(() =>
            setState((current) =>
              current.session?.id === id
                ? applySnapshot(current, snapshot)
                : current
            )
          );
          yield* Effect.sleep(IDLE_OBSERVATION);
        })
      ).pipe(Effect.catchCause(reportMirrorFailure))
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [id, running, runAndroidWorkspaceCommand, setState]);
};

/** The dock's controls row: navigation first, then the state's own actions. */
const AndroidDockControls = ({
  elements,
  instructing,
  mutate,
  onInstruct,
  onNewSession,
  pending,
  session,
  sessions,
}: {
  /** The keyboard's way onto the device screen. */
  readonly elements: React.ReactNode;
  readonly instructing: boolean;
  readonly mutate: Mutate;
  readonly onInstruct: () => void;
  readonly onNewSession: () => void;
  readonly pending: boolean;
  readonly session: AndroidWorkspaceSnapshot;
  readonly sessions: readonly AndroidWorkspaceSummary[];
}) => {
  const presentation = androidDockPresentation(session);
  const primary = presentation.action;
  const stops = primary?.gesture === "stop-recording";
  return (
    <>
      <DockWordmark />
      <AndroidSessionSelect
        onSelect={(value) => {
          if (Schema.is(AgentSessionId)(value)) {
            mutate({ _tag: "read", sessionId: value });
          }
        }}
        selectedSessionId={session.id}
        sessions={sessions}
      />
      {/* Hidden while capturing, as the browser dock does. */}
      {showsFlowsEntry(androidFlowsSessionView(session)) ? (
        <FlowsDockButton />
      ) : null}
      {/* An ended session has no screen to reach. */}
      {isLiveAndroidSession(session) ? elements : null}
      <DockSpacer />
      {presentation.showsComment ? (
        <Button
          aria-label="Comment"
          title="Comment"
          aria-pressed={instructing}
          onClick={onInstruct}
          size="sm"
          variant="ghost"
        >
          <MessageSquareTextIcon />
          <span className="hidden @md:inline">Comment</span>
        </Button>
      ) : null}
      {presentation.rejectable ? (
        <Button
          disabled={pending}
          onClick={() =>
            mutate({
              _tag: "flow-decision",
              decision: "reject",
              operationId: operationId(),
              sessionId: session.id,
            })
          }
          size="sm"
          variant="outline"
        >
          Reject flow
        </Button>
      ) : null}
      {isLiveAndroidSession(session) ? (
        <Button
          disabled={pending}
          onClick={() =>
            mutate({
              _tag: "close",
              operationId: operationId(),
              sessionId: session.id,
            })
          }
          aria-label="Close session"
          size="sm"
          title="Close session"
          variant="outline"
        >
          {/* A word, not a power glyph: it closes the session, not the device. */}
          <span className="@md:hidden">Close</span>
          <span className="hidden @md:inline">Close session</span>
        </Button>
      ) : (
        <Button onClick={onNewSession} size="sm" variant="outline">
          New session
        </Button>
      )}
      {primary === null ? null : (
        <Button
          aria-label={primary.accessibleName}
          disabled={pending}
          onClick={() => mutate(gestureCommand(primary.gesture, session))}
          variant={stops ? "destructive" : "default"}
        >
          {primary.gesture === "start-recording" ? (
            <CircleIcon className="fill-current" />
          ) : null}
          {stops ? <SquareIcon className="fill-current" /> : null}
          {primary.label}
        </Button>
      )}
    </>
  );
};

/** The dock's request tier: what preparation waits on, then what is typed. */
const AndroidDockRequests = ({
  field,
  input,
  mutate,
  pending,
  session,
  setState,
  state,
}: {
  readonly field: NonNullable<AndroidWorkspaceSnapshot["field"]> | null;
  readonly input: (action: InputAction, observationId: string) => void;
  readonly mutate: Mutate;
  readonly pending: boolean;
  readonly session: AndroidWorkspaceSnapshot;
  readonly setState: SetState;
  readonly state: WorkspaceState;
}) => (
  <>
    <AndroidRequests
      onDecide={(decisionId, allow) =>
        mutate({
          _tag: "decide",
          allow,
          decisionId,
          operationId: operationId(),
          sessionId: session.id,
        })
      }
      pending={pending}
      session={session}
    />
    <AndroidVariables
      session={session}
      pending={pending}
      onSupply={(name, requestId, value) =>
        mutate({
          _tag: "variable-supply",
          name,
          operationId: operationId(),
          requestId,
          sessionId: session.id,
          value,
        })
      }
    />
    {field === null ? null : (
      <AndroidFieldEntry
        disabled={pending}
        field={field}
        variables={session.variables ?? []}
        onRequest={(name) =>
          mutate({
            _tag: "variable-request",
            name,
            operationId: operationId(),
            purpose: `Private input for ${field.name || field.role}`,
            replace: (session.variables ?? []).some(
              (variable) => variable.name === name
            ),
            sessionId: session.id,
          })
        }
        onVariable={(name) =>
          input(
            { _tag: "variable", name, target: field.target },
            field.observationId
          )
        }
        key={fieldKey(field)}
        onDismiss={() => {
          setState((current) => ({
            ...current,
            dismissedField: fieldKey(field),
          }));
          mutate({
            _tag: "field-dismiss",
            operationId: operationId(),
            sessionId: session.id,
          });
        }}
        onSubmit={(text) =>
          input(
            { _tag: "fill", target: field.target, text },
            field.observationId
          )
        }
      />
    )}
    {session.captureState?._tag === "recording" && state.instructing ? (
      <AndroidInstructionEntry
        onDismiss={() =>
          setState((current) => ({ ...current, instructing: false }))
        }
        onSubmit={(text) => {
          if (
            mutate({
              _tag: "instruction",
              operationId: operationId(),
              sessionId: session.id,
              text,
            })
          ) {
            setState((current) => ({ ...current, instructionPending: true }));
          }
        }}
        pending={pending}
      />
    ) : null}
  </>
);

type InputAction = Extract<
  AndroidWorkspaceCommand,
  { readonly _tag: "input" }
>["action"];

/** One selected session: the device on the stage and the dock over it. */
export const AndroidSessionView = ({
  mutate,
  notices,
  pending,
  session,
  setState,
  state,
}: {
  readonly mutate: Mutate;
  readonly notices: React.ReactNode;
  readonly pending: boolean;
  readonly session: AndroidWorkspaceSnapshot;
  readonly setState: SetState;
  readonly state: WorkspaceState;
}) => {
  const { androidSessionsAtom, androidWorkspaceForwardMutation } =
    useRpcDependencies();
  const sessions = useAtomValue(androidSessionsAtom);
  const canAct = session.controller === "user" && session.phase === "running";
  const forwardInput = useAtomSet(androidWorkspaceForwardMutation, {
    mode: "promise",
  });
  const forwardInputRef = useRef(forwardInput);
  useEffect(() => {
    forwardInputRef.current = forwardInput;
  }, [forwardInput]);
  // One queue per session keeps each session's input in order.
  const [queues] = useState(
    () => new Map<AgentSessionId, (input: NativeInput) => void>()
  );
  const onInput = (value: NativeInput) => {
    if (state.inputRefusal !== null) {
      setState((current) => ({ ...current, inputRefusal: null }));
    }
    let forward = queues.get(session.id);
    if (forward === undefined) {
      const sessionId = session.id;
      forward = makeNativeInputQueue(
        (inputs) =>
          Effect.tryPromise({
            catch: (cause) => cause,
            try: () =>
              forwardInputRef.current({ payload: { inputs, sessionId } }),
          }),
        (cause) =>
          setState((current) => ({
            ...current,
            inputRefusal: message(cause),
            refusalDismissed: false,
          }))
      );
      queues.set(sessionId, forward);
    }
    forward(value);
  };
  // Text goes to the device as the user types on it. A password field also
  // offers its Variables, and Teaching offers them only while recording.
  const field =
    canAct &&
    !pending &&
    (session.kind !== "teaching" ||
      session.captureState?._tag === "recording") &&
    session.field !== null &&
    session.field.password === true &&
    fieldKey(session.field) !== state.dismissedField
      ? session.field
      : null;
  const input = (action: InputAction, observationId: string) =>
    mutate({
      _tag: "input",
      action,
      observationId,
      operationId: operationId(),
      sessionId: session.id,
    });
  return (
    <WorkspaceLayout
      sessionId={session.id}
      flowsSession={androidFlowsSessionView(session)}
      summary={
        isLiveAndroidSession(session)
          ? null
          : {
              label: deviceSummaryLabel(session.kind),
              summary: <AndroidRunSummary session={session} />,
            }
      }
    >
      <main
        className={cn(
          // The platform switcher floats above the device, the dock below it.
          "bg-muted/30 relative flex min-h-0 flex-1 justify-center px-6 pt-14",
          "pb-[calc(var(--dock-height,6.5rem)+1.5rem)]"
        )}
      >
        <WorkspacePlatformBar />
        {notices}
        <AndroidDevice
          canAct={canAct}
          cleanup={deviceCleanupKey(session.cleanup)}
          ended={!isLiveAndroidSession(session)}
          live={session.phase === "running" || session.phase === "paused"}
          onBack={() => {
            for (const action of ["down", "up"] as const) {
              onInput({
                _tag: "key",
                action,
                at: performance.now(),
                code: "",
                key: "GoBack",
                modifiers: 0,
              });
            }
          }}
          onInput={onInput}
          paused={session.phase === "paused"}
          secure={
            session.phase === "paused" &&
            session.captureGaps.at(-1) === "secure_window"
          }
          pending={pending}
          sessionId={session.id}
          unavailable={glassText(session)}
        />
        <DockShell
          footer={
            // Why the last input sent nothing, said in the dock as iOS says
            // it, so nothing covers the glass. Opening the comment tier sets
            // it aside; the next input clears it.
            state.inputRefusal === null || state.refusalDismissed ? null : (
              <p
                className="text-destructive border-t px-3 py-1.5 text-xs"
                role="alert"
              >
                {state.inputRefusal}
              </p>
            )
          }
          requests={
            <AndroidDockRequests
              field={field}
              input={input}
              mutate={mutate}
              pending={pending}
              session={session}
              setState={setState}
              state={state}
            />
          }
          status={
            <DockStatus badges={<AndroidStateBadges session={session} />}>
              {androidDockPresentation(session).nextStep}
            </DockStatus>
          }
        >
          <AndroidDockControls
            elements={
              <DeviceElements
                disabled={!canAct}
                observation={session.observation}
                onActivate={(inputs) => {
                  for (const value of inputs) {
                    onInput(value);
                  }
                }}
              />
            }
            instructing={state.instructing}
            mutate={mutate}
            onInstruct={() =>
              setState((current) => ({
                ...current,
                instructing: !current.instructing,
                refusalDismissed: true,
              }))
            }
            onNewSession={() =>
              setState((current) => ({
                ...current,
                session: null,
                setupOpen: true,
              }))
            }
            pending={pending}
            session={session}
            sessions={withSelected(
              AsyncResult.isSuccess(sessions) ? sessions.value : [],
              session
            )}
          />
        </DockShell>
      </main>
    </WorkspaceLayout>
  );
};

/**
 * The Android Workspace on the browser Workspace's own dock, state names,
 * Flows drawer, and Run Summary. The device shows only
 * what the device shows: a click on it is resolved by the server against a
 * fresh observation and sent as a semantic action, or refused beside the
 * device with nothing sent.
 */
export const AndroidWorkspace = ({
  onSessionChange,
  requestedSessionId,
}: {
  /** Names the shown session, or `new`, in the route. */
  readonly onSessionChange?: ((session: string) => void) | undefined;
  readonly requestedSessionId?: string | undefined;
}) => {
  const setChrome = useAtomSet(workspaceChromeAtom);
  useEffect(() => {
    setChrome(true);
    return () => setChrome(false);
  }, [setChrome]);
  const [state, setState] = useAtom(workspaceAtom);
  const { androidSessionsAtom, runAndroidWorkspaceCommand } =
    useRpcDependencies();
  const sessions = useAtomValue(androidSessionsAtom);
  const refresh = useAtomRefresh(androidSessionsAtom);
  const gesture = useWorkspaceGesture(sessionStartGestureAtom);
  useAndroidSessionSync(requestedSessionId, state.session, setState);
  // Which session the route names, read when a command settles.
  const routeRef = useRef(requestedSessionId);
  useEffect(() => {
    routeRef.current = requestedSessionId;
  }, [requestedSessionId]);
  // A started, selected, or closed session takes the route, so a refresh
  // reopens what the person was looking at.
  const id = state.session?.id;
  const shownId = useRef(id);
  useEffect(() => {
    if (shownId.current === id) {
      return;
    }
    shownId.current = id;
    // Starts, picks, and closes each change the shown session through a
    // different command; the route follows the result rather than each one.
    // oxlint-disable-next-line react-doctor/no-pass-data-to-parent
    onSessionChange?.(id ?? NEW_NATIVE_SESSION);
  }, [id, onSessionChange]);
  // A sent comment closes its composer only once it saves.
  const { instructionPending } = state;
  useEffect(() => {
    if (!instructionPending || gesture.pending) {
      return;
    }
    setState((current) => ({
      ...current,
      instructing: gesture.error === undefined ? false : current.instructing,
      instructionPending: false,
    }));
  }, [gesture.error, gesture.pending, instructionPending, setState]);
  const run = (command: AndroidWorkspaceCommand): GestureRun => {
    const route = routeRef.current;
    return runAndroidWorkspaceCommand(command).pipe(
      Effect.tap((session) =>
        Effect.sync(() => {
          // The route moved on while this ran: it no longer shows the result.
          if (routeRef.current === route || routeRef.current === session.id) {
            setState((current) => applySnapshot(current, session));
          }
          refresh();
        })
      ),
      Effect.mapError(message),
      Effect.asVoid
    );
  };
  const mutate = (command: AndroidWorkspaceCommand) =>
    gesture.dispatch(run(command));
  const setupOpen = (open: boolean) =>
    setState((current) => ({ ...current, setupOpen: open }));
  const failure = gesture.error ?? state.failure;
  const notices =
    failure === null ? null : (
      // Below the platform switcher, so the way back to Web stays reachable.
      <DockNotices className="top-11">
        <Alert variant="destructive">
          <AlertTitle>The Android session did not answer</AlertTitle>
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      </DockNotices>
    );
  return (
    <div className="relative flex h-svh min-h-0 flex-col">
      {state.session === null ? (
        <WorkspaceLayout
          sessionId={undefined}
          flowsSession={undefined}
          summary={undefined}
        >
          <AndroidEmptyState
            onOpen={() => setupOpen(true)}
            onSelect={(value) => {
              if (Schema.is(AgentSessionId)(value)) {
                mutate({ _tag: "read", sessionId: value });
              }
            }}
            sessions={AsyncResult.isSuccess(sessions) ? sessions.value : []}
          />
          {notices}
        </WorkspaceLayout>
      ) : (
        <AndroidSessionView
          mutate={mutate}
          notices={notices}
          pending={gesture.pending}
          session={state.session}
          setState={setState}
          state={state}
        />
      )}
      <AndroidSetupSheet
        onOpen={(flowName: FlowName, selection) => {
          const sent = mutate({
            _tag: "start",
            flowName,
            kind: "teaching",
            operationId: operationId(),
            recordingId: null,
            selection,
          });
          if (sent) {
            setupOpen(false);
          }
          return sent;
        }}
        onOpenChange={setupOpen}
        open={state.setupOpen}
        pending={gesture.pending}
      />
    </div>
  );
};
