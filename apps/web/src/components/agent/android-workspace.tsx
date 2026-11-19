import { AgentSessionId, OperationId } from "@contingency/protocol";
import type {
  NativeInput,
  AndroidWorkspaceCommand,
  AndroidWorkspaceSelection,
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
  DockNotice,
  DockShell,
  DockStatus,
  SessionTopBar,
} from "@/components/agent/workspace-dock";
import { FlowsButton } from "@/components/catalog/flows-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { isSessionNotFound } from "@/lib/failure-message";
import { useRpcDependencies } from "@/lib/rpc-dependencies";
import { cn } from "@/lib/utils";

import { workspaceChromeAtom } from "./agent-workspace-state";
import { AndroidDevice } from "./android-device";
import {
  AndroidVariables,
  AndroidRequests,
  AndroidSessionSelect,
  AndroidStateBadges,
} from "./android-dock";
import {
  androidDockPresentation,
  hasPreparedAndroidSession,
  androidFlowsSessionView,
  isLiveAndroidSession,
} from "./android-dock-state";
import type { AndroidDockGesture } from "./android-dock-state";
import { AndroidRunSummary } from "./android-run-summary";
import { WorkspaceLayout } from "./android-workspace-layout";
import {
  androidDeviceLabel,
  deviceCleanupKey,
  deviceSummaryLabel,
  pauseCodeOf,
} from "./android-workspace-state";
import { NativeCommentComposer } from "./native-comment-composer";
import { recordingPins } from "./native-comment-state";
import { FieldVariableCard } from "./native-field-variable";
import { makeNativeInputQueue } from "./native-input";
import { commentPins } from "./screen-elements";
import type { AttachedElement } from "./screen-elements";
import {
  androidStartGestureAtom,
  sessionStartGestureAtom,
  useWorkspaceGesture,
} from "./workspace-gesture";
import type { GestureRun } from "./workspace-gesture";
import { WorkspaceHomeBar } from "./workspace-home-nav";
import { NEW_NATIVE_SESSION } from "./workspace-platform-state";

interface WorkspaceState {
  readonly session: AndroidWorkspaceSnapshot | null;
  /** The element the open comment is attached to. */
  readonly attached: AttachedElement | null;
  readonly failure: string | null;
  /** The picked field the person closed, until another one is picked. */
  readonly dismissedField: string | null;
  readonly instructing: boolean;
  /** The open comment is picking its element on the screen. */
  readonly picking: boolean;
  /** The earlier comment the card's list points at, outlined on the screen. */
  readonly highlightedComment: number | null;
  /**
   * A comment was sent and has not answered. The composer and its draft stay
   * until it saves, so a refusal leaves them for another try.
   */
  readonly instructionPending: boolean;
  /** Why the last Forwarded Input sent nothing, until more input is sent. */
  readonly inputRefusal: string | null;
  /** The input refusal was set aside when the comment tier opened. */
  readonly refusalDismissed: boolean;
  /** The route named a session this server has no record of. */
  readonly unavailable: boolean;
}
const workspaceAtom = Atom.make<WorkspaceState>({
  attached: null,
  dismissedField: null,
  failure: null,
  highlightedComment: null,
  inputRefusal: null,
  instructing: false,
  instructionPending: false,
  picking: false,
  refusalDismissed: false,
  session: null,
  unavailable: false,
});
const applySnapshot = (
  current: WorkspaceState,
  session: AndroidWorkspaceSnapshot
): WorkspaceState =>
  current.session?.id === session.id &&
  current.session.revision > session.revision
    ? current
    : { ...current, failure: null, session, unavailable: false };
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
 * The picker lists the selected live session: the session list is a separate
 * query and can lag a session that was just opened. An ended session is no
 * longer a choice, so it is never added back.
 */
const withSelected = (
  sessions: readonly AndroidWorkspaceSummary[],
  session: AndroidWorkspaceSnapshot
): readonly AndroidWorkspaceSummary[] =>
  sessions.some((entry) => entry.id === session.id) ||
  !isLiveAndroidSession(session)
    ? sessions
    : [session, ...sessions];
/** Closes the comment composer with whatever it attached. */
const closeComment = (current: WorkspaceState): WorkspaceState => ({
  ...current,
  attached: null,
  highlightedComment: null,
  instructing: false,
  picking: false,
});
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
  if (session.phase === "paused" && !hasPreparedAndroidSession(session)) {
    return "Preparation failed. Retry preparation from the dock.";
  }
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
  onSelect,
  onStartNew,
  pending = false,
  sessions,
  unavailable = false,
}: {
  readonly pending?: boolean;
  /** The link named a session that no longer exists. */
  readonly unavailable?: boolean;
  /** Opens the Android start card on the Workspace home. */
  readonly onStartNew: () => void;
  readonly onSelect: (sessionId: string) => void;
  readonly sessions: readonly AndroidWorkspaceSummary[];
}) => (
  <main aria-busy={pending} className="relative flex h-full min-h-0 flex-col">
    <WorkspaceHomeBar />
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
            {pending ? "Opening Android session" : "No Android session"}
          </h1>
          <p
            role="status"
            className="text-muted-foreground text-sm text-pretty"
          >
            {pending
              ? "Opening the session…"
              : "Start a session to pick a device and an app, then start recording when the journey begins."}
          </p>
          {unavailable && !pending ? (
            <p className="text-muted-foreground text-sm text-pretty">
              The session this link named is no longer available.
            </p>
          ) : null}
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
          <Button disabled={pending} onClick={onStartNew} size="lg">
            <SmartphoneIcon />
            Start an Android session
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
        current.session === null && !current.unavailable
          ? current
          : { ...current, session: null, unavailable: false }
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
            if (!requested) {
              return;
            }
            // An ended link to a deleted record is not a failure to answer:
            // say it is gone, and select nothing in its place.
            const missing = Cause.findErrorOption(failureCause).pipe(
              Option.exists(isSessionNotFound)
            );
            setState((current) =>
              missing
                ? { ...current, session: null, unavailable: true }
                : { ...current, failure: Cause.pretty(failureCause) }
            );
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

/** The status island's controls: the state's own tools and actions. */
const AndroidDockControls = ({
  instructing,
  mutate,
  onInstruct,
  onNewSession,
  pending,
  session,
}: {
  readonly instructing: boolean;
  readonly mutate: Mutate;
  readonly onInstruct: () => void;
  readonly onNewSession: () => void;
  readonly pending: boolean;
  readonly session: AndroidWorkspaceSnapshot;
}) => {
  const presentation = androidDockPresentation(session);
  const primary = presentation.action;
  const stops = primary?.gesture === "stop-recording";
  return (
    <>
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
          className="ml-auto"
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
  mutate,
  pending,
  session,
}: {
  readonly mutate: Mutate;
  readonly pending: boolean;
  readonly session: AndroidWorkspaceSnapshot;
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
  </>
);

/**
 * The comment card while a recording is open. It floats above the Session
 * status island, so it is not a request: the Requests island stays empty.
 */
const AndroidCommentCard = ({
  mutate,
  pending,
  session,
  setState,
  state,
}: {
  readonly mutate: Mutate;
  readonly pending: boolean;
  readonly session: AndroidWorkspaceSnapshot;
  readonly setState: SetState;
  readonly state: WorkspaceState;
}) => {
  if (session.captureState?._tag !== "recording" || !state.instructing) {
    return null;
  }
  return (
    <NativeCommentComposer
      attached={state.attached ?? undefined}
      canAttach={session.observation !== null}
      instructions={session.instructions ?? []}
      onAttach={() => setState((current) => ({ ...current, picking: true }))}
      onCancelPick={() =>
        setState((current) => ({ ...current, picking: false }))
      }
      onDetach={() => setState((current) => ({ ...current, attached: null }))}
      onDismiss={() => setState(closeComment)}
      onSubmit={(text) => {
        const { attached } = state;
        const comment = {
          _tag: "instruction" as const,
          operationId: operationId(),
          sessionId: session.id,
          text,
        };
        if (
          mutate(
            attached === null
              ? comment
              : {
                  ...comment,
                  element: {
                    observationId: attached.observationId,
                    target: attached.target,
                  },
                }
          )
        ) {
          setState((current) => ({
            ...current,
            instructionPending: true,
            picking: false,
          }));
        }
      }}
      pending={pending}
      onHighlight={(index) =>
        setState((current) => ({
          ...current,
          highlightedComment: index ?? null,
        }))
      }
      picking={state.picking}
      pins={commentPins(session.observation, session.instructions ?? [])}
      startedAt={session.captureState.startedAt}
    />
  );
};

type InputAction = Extract<
  AndroidWorkspaceCommand,
  { readonly _tag: "input" }
>["action"];

/**
 * The password field the session is typing into, which takes a Variable.
 * Teaching offers it only while recording.
 */
const typingField = (
  session: AndroidWorkspaceSnapshot,
  dismissedField: string | null
) =>
  (session.kind !== "teaching" || session.captureState?._tag === "recording") &&
  session.field !== null &&
  session.field.password === true &&
  fieldKey(session.field) !== dismissedField
    ? session.field
    : null;

const androidLockedReason = (session: AndroidWorkspaceSnapshot) =>
  session.controller === "agent" && session.phase === "running"
    ? "The agent is driving. Take control to use the device."
    : undefined;

const AndroidFieldVariable = ({
  disabled,
  field,
  input,
  mutate,
  session,
  setState,
}: {
  readonly disabled: boolean;
  readonly field: NonNullable<ReturnType<typeof typingField>>;
  readonly input: (action: InputAction, observationId: string) => void;
  readonly mutate: Mutate;
  readonly session: AndroidWorkspaceSnapshot;
  readonly setState: SetState;
}) => (
  <FieldVariableCard
    disabled={disabled}
    field={field.name || field.role}
    onEnter={(name) =>
      input(
        { _tag: "variable", name, target: field.target },
        field.observationId
      )
    }
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
    onStop={() => {
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
    variables={session.variables ?? []}
  />
);

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
    canAct && !pending ? typingField(session, state.dismissedField) : null;
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
      summaryKey={session.id}
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
        data-vt="stage"
        className={cn(
          // The device leaves room above for notices and below for the dock.
          "workspace-canvas relative flex min-h-0 flex-1 justify-center px-6 pt-16",
          "pb-[calc(var(--dock-height,6.5rem)+1.5rem)]"
        )}
      >
        <SessionTopBar
          className="absolute inset-x-0 top-0"
          flows={<FlowsButton session={androidFlowsSessionView(session)} />}
          picker={
            <AndroidSessionSelect
              onSelect={(value) => {
                if (Schema.is(AgentSessionId)(value)) {
                  mutate({ _tag: "read", sessionId: value });
                }
              }}
              // An ended session is not a choice; the picker shows its placeholder.
              selectedSessionId={
                isLiveAndroidSession(session) ? session.id : undefined
              }
              sessions={withSelected(
                AsyncResult.isSuccess(sessions) ? sessions.value : [],
                session
              )}
            />
          }
        />
        {notices}
        <AndroidDevice
          agentDriving={session.controller === "agent"}
          comments={recordingPins(session, state.highlightedComment)}
          canAct={canAct}
          cleanup={deviceCleanupKey(session.cleanup)}
          device={androidDeviceLabel(session.selection.device)}
          leading={
            field === null ? null : (
              <AndroidFieldVariable
                disabled={pending}
                field={field}
                input={input}
                key={fieldKey(field)}
                mutate={mutate}
                session={session}
                setState={setState}
              />
            )
          }
          lockedReason={androidLockedReason(session)}
          observation={session.observation}
          pick={
            session.captureState?._tag === "recording" && state.instructing
              ? {
                  attached: state.attached ?? undefined,
                  onCancel: () =>
                    setState((current) => ({ ...current, picking: false })),
                  onPick: (element) =>
                    setState((current) => ({
                      ...current,
                      attached: element,
                      picking: false,
                    })),
                  picking: state.picking,
                }
              : undefined
          }
          ended={!isLiveAndroidSession(session)}
          live={
            hasPreparedAndroidSession(session) &&
            (session.phase === "running" || session.phase === "paused")
          }
          emulation={session.emulation}
          onEmulate={(change) =>
            mutate({
              _tag: "emulate",
              change,
              operationId: operationId(),
              sessionId: session.id,
            })
          }
          onDeviceKey={(key) => {
            for (const action of ["down", "up"] as const) {
              onInput({
                _tag: "key",
                action,
                at: performance.now(),
                code: "",
                key,
                modifiers: 0,
              });
            }
          }}
          onInput={onInput}
          paused={
            session.phase === "paused" && hasPreparedAndroidSession(session)
          }
          pauseCode={pauseCodeOf(session.captureGaps)}
          pending={pending}
          sessionId={session.id}
          takeover={
            session.kind !== "teaching" && session.controller === "user"
          }
          unavailable={glassText(session)}
        />
        <DockShell
          notice={
            // Why the last input sent nothing, said just above the dock so it
            // never resizes the device. Opening the comment tier sets it
            // aside; the next input clears it.
            state.inputRefusal === null || state.refusalDismissed ? null : (
              <DockNotice>{state.inputRefusal}</DockNotice>
            )
          }
          requests={
            <AndroidDockRequests
              mutate={mutate}
              pending={pending}
              session={session}
            />
          }
          status={
            <DockStatus badges={<AndroidStateBadges session={session} />}>
              {androidDockPresentation(session).nextStep}
            </DockStatus>
          }
        >
          <AndroidDockControls
            instructing={state.instructing}
            mutate={mutate}
            onInstruct={() =>
              setState((current) =>
                current.instructing
                  ? closeComment(current)
                  : { ...current, instructing: true, refusalDismissed: true }
              )
            }
            // Leaving the session opens the Android start card on the home.
            onNewSession={() =>
              setState((current) => ({ ...current, session: null }))
            }
            pending={pending}
            session={session}
          />
        </DockShell>
        <AndroidCommentCard
          mutate={mutate}
          pending={pending}
          session={session}
          setState={setState}
          state={state}
        />
      </main>
    </WorkspaceLayout>
  );
};

/**
 * Prepares and opens an Android Teaching session, as the start card asks once
 * the person confirms preparation. The started session becomes the one the
 * Android Workspace shows, so it opens on the session rather than a read.
 * The gesture is its own: a refusal shows on the card, never on Web's. A
 * start that finishes after the person moved on only refreshes the shelf.
 */
export const useAndroidSessionStart = () => {
  const { androidSessionsAtom, runAndroidWorkspaceCommand } =
    useRpcDependencies();
  const refresh = useAtomRefresh(androidSessionsAtom);
  const setState = useAtomSet(workspaceAtom);
  const gesture = useWorkspaceGesture(androidStartGestureAtom);
  const start = (
    flowName: FlowName,
    selection: AndroidWorkspaceSelection,
    opening: {
      readonly onStarted: (sessionId: AgentSessionId) => void;
      /** Whether the person is still waiting on this start to open. */
      readonly owns: () => boolean;
    }
  ): boolean =>
    gesture.dispatch(
      runAndroidWorkspaceCommand({
        _tag: "start",
        flowName,
        kind: "teaching",
        operationId: operationId(),
        prepareAndOpen: true,
        recordingId: null,
        selection,
      }).pipe(
        Effect.tap((session) =>
          Effect.sync(() => {
            refresh();
            if (opening.owns()) {
              setState((current) => applySnapshot(current, session));
              opening.onStarted(session.id);
            }
          })
        ),
        Effect.mapError(message),
        Effect.asVoid
      )
    );
  return { error: gesture.error, pending: gesture.pending, start };
};

/**
 * The Android Workspace on the browser Workspace's own dock, state names,
 * Flows page, and Run Summary. The device shows only
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
      ...(gesture.error === undefined ? closeComment(current) : current),
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
        <WorkspaceLayout summary={undefined}>
          <AndroidEmptyState
            onStartNew={() => onSessionChange?.(NEW_NATIVE_SESSION)}
            pending={gesture.pending}
            onSelect={(value) => {
              if (Schema.is(AgentSessionId)(value)) {
                mutate({ _tag: "read", sessionId: value });
              }
            }}
            sessions={AsyncResult.isSuccess(sessions) ? sessions.value : []}
            unavailable={state.unavailable}
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
    </div>
  );
};
