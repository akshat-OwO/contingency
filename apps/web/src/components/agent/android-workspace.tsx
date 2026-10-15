import { AgentSessionId, OperationId } from "@contingency/protocol";
import type {
  AndroidWorkspaceCommand,
  AndroidWorkspaceSnapshot,
  AndroidWorkspaceSummary,
  FlowSkillName,
} from "@contingency/protocol";
import { useAtom, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Cause, Effect, Fiber, Option, Schema } from "effect";
import { Atom, AsyncResult } from "effect/reactivity";
import {
  CircleIcon,
  MessageSquareTextIcon,
  MonitorIcon,
  SmartphoneIcon,
  SquareIcon,
} from "lucide-react";
import { useEffect } from "react";

import {
  DockNotices,
  DockShell,
  DockSpacer,
  DockStatus,
  DockWordmark,
} from "@/components/agent/workspace-dock";
import { SkillsDockButton } from "@/components/catalog/skills-dock-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { androidSessionsAtom, runAndroidWorkspaceCommand } from "@/lib/rpc";
import { cn } from "@/lib/utils";

import { AndroidDevice } from "./android-device";
import {
  AndroidFieldEntry,
  AndroidInstructionEntry,
  AndroidRequests,
  AndroidSessionSelect,
  AndroidStateBadges,
} from "./android-dock";
import {
  androidDockPresentation,
  androidSkillsSessionView,
  isLiveAndroidSession,
} from "./android-dock-state";
import type { AndroidDockGesture } from "./android-dock-state";
import { AndroidRunSummary } from "./android-run-summary";
import { AndroidSetupSheet } from "./android-setup-sheet";
import { WorkspaceLayout } from "./android-workspace-layout";
import {
  sessionStartGestureAtom,
  useWorkspaceGesture,
} from "./workspace-gesture";
import type { GestureRun } from "./workspace-gesture";

interface WorkspaceState {
  readonly session: AndroidWorkspaceSnapshot | null;
  readonly failure: string | null;
  /** The picked field the person closed, until another one is picked. */
  readonly dismissedField: string | null;
  readonly instructing: boolean;
  readonly setupOpen: boolean;
}
const workspaceAtom = Atom.make<WorkspaceState>({
  dismissedField: null,
  failure: null,
  instructing: false,
  session: null,
  setupOpen: false,
});
/** A click on the stream, kept apart so a refusal never reads as a failed gesture. */
const pickGestureAtom = Atom.keepAlive(
  Atom.fn((request: { readonly run: GestureRun }) => request.run)
);
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
    return "Prepare the device from the dock to show its screen here.";
  }
  if (session.phase === "refused") {
    return "This session never used the device.";
  }
  return "This session released the device.";
};

const EmptyState = ({
  onBrowser,
  onOpen,
}: {
  readonly onBrowser: () => void;
  readonly onOpen: () => void;
}) => (
  <main className="relative flex h-full min-h-0 flex-col">
    <div className="bg-muted/20 grid min-h-0 flex-1 place-items-center p-6 pb-28">
      <section className="max-w-md space-y-4 text-center">
        <h1 className="text-xl font-semibold tracking-tight">
          No Android session
        </h1>
        <p className="text-muted-foreground text-sm text-pretty">
          Open a session to pick a device and an app, then start recording when
          the journey begins.
        </p>
        <div className="flex justify-center gap-2">
          <Button onClick={onOpen}>
            <SmartphoneIcon />
            Open Android session
          </Button>
          <Button onClick={onBrowser} variant="outline">
            <MonitorIcon />
            Browser Workspace
          </Button>
        </div>
      </section>
    </div>
  </main>
);

type SetState = (update: (current: WorkspaceState) => WorkspaceState) => void;
type Mutate = (command: AndroidWorkspaceCommand) => boolean;

/**
 * Reads a `?android=` session once, then keeps the selected session's
 * retained observation current so the server can tell a stale pick from a
 * fresh one. The stream, not this, is what the person sees.
 */
const useAndroidSessionSync = (
  requestedSessionId: string | undefined,
  session: AndroidWorkspaceSnapshot | null,
  setState: SetState
) => {
  useEffect(() => {
    if (
      requestedSessionId === undefined ||
      !Schema.is(AgentSessionId)(requestedSessionId)
    ) {
      return;
    }
    const fiber = Effect.runFork(
      runAndroidWorkspaceCommand({
        _tag: "read",
        sessionId: requestedSessionId,
      }).pipe(
        Effect.tap((snapshot) =>
          Effect.sync(() =>
            setState((current) => applySnapshot(current, snapshot))
          )
        ),
        Effect.catchCause((failureCause) =>
          Effect.sync(() =>
            setState((current) => ({
              ...current,
              failure: Cause.pretty(failureCause),
            }))
          )
        )
      )
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [requestedSessionId, setState]);
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
            setState((current) => ({
              ...current,
              failure: Cause.pretty(failureCause),
              session: snapshot,
            }))
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
          yield* Effect.sleep("1 second");
        })
      ).pipe(Effect.catchCause(reportMirrorFailure))
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [id, running, setState]);
};

/** The dock's controls row: navigation first, then the state's own actions. */
const AndroidDockControls = ({
  instructing,
  mutate,
  onBrowser,
  onInstruct,
  onNewSession,
  pending,
  session,
  sessions,
}: {
  readonly instructing: boolean;
  readonly mutate: Mutate;
  readonly onBrowser: () => void;
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
      <SkillsDockButton />
      <Button
        aria-label="Browser Workspace"
        onClick={onBrowser}
        size="icon-sm"
        title="Browser Workspace"
        variant="ghost"
      >
        <MonitorIcon />
      </Button>
      <DockSpacer />
      {presentation.showsComment ? (
        <Button
          aria-pressed={instructing}
          onClick={onInstruct}
          size="sm"
          variant="ghost"
        >
          <MessageSquareTextIcon />
          Comment
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
          size="sm"
          variant="outline"
        >
          Close session
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
    {field === null ? null : (
      <AndroidFieldEntry
        disabled={pending}
        field={field}
        key={fieldKey(field)}
        onDismiss={() =>
          setState((current) => ({
            ...current,
            dismissedField: fieldKey(field),
          }))
        }
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
          mutate({
            _tag: "instruction",
            operationId: operationId(),
            sessionId: session.id,
            text,
          });
          setState((current) => ({ ...current, instructing: false }));
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
const AndroidSessionView = ({
  mutate,
  notices,
  onBrowser,
  pending,
  run,
  session,
  setState,
  state,
}: {
  readonly mutate: Mutate;
  readonly notices: React.ReactNode;
  readonly onBrowser: () => void;
  readonly pending: boolean;
  readonly run: (command: AndroidWorkspaceCommand) => GestureRun;
  readonly session: AndroidWorkspaceSnapshot;
  readonly setState: SetState;
  readonly state: WorkspaceState;
}) => {
  const sessions = useAtomValue(androidSessionsAtom);
  const pick = useWorkspaceGesture(pickGestureAtom);
  const canAct =
    session.controller === "user" && session.phase === "running" && !pending;
  const field =
    canAct &&
    session.field !== null &&
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
      skillsSession={androidSkillsSessionView(session)}
      summary={
        isLiveAndroidSession(session)
          ? null
          : {
              label: "Run Summary",
              summary: <AndroidRunSummary session={session} />,
            }
      }
    >
      <main
        className={cn(
          "bg-muted/30 relative flex min-h-0 flex-1 justify-center px-6 pt-6 transition-[padding]",
          // The dock's request tier grows over the stage; the device makes room.
          field !== null ||
            session.preparation.pending.length > 0 ||
            (state.instructing && session.captureState?._tag === "recording")
            ? "pb-56"
            : "pb-36"
        )}
      >
        {notices}
        <AndroidDevice
          canAct={canAct}
          live={session.phase === "running" || session.phase === "paused"}
          onBack={() => {
            if (session.observation !== null) {
              input({ _tag: "back" }, session.observation.id);
            }
          }}
          onPick={(point, frame) => {
            pick.dispatch(
              run({
                _tag: "pick",
                frame,
                observationId: session.observation?.id ?? "none",
                operationId: operationId(),
                point,
                sessionId: session.id,
              })
            );
            setState((current) => ({ ...current, dismissedField: null }));
          }}
          paused={session.phase === "paused"}
          pending={pick.pending}
          refusal={pick.error ?? null}
          sessionId={session.id}
          unavailable={glassText(session)}
        />
        <DockShell
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
            instructing={state.instructing}
            mutate={mutate}
            onBrowser={onBrowser}
            onInstruct={() =>
              setState((current) => ({
                ...current,
                instructing: !current.instructing,
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
 * Skills drawer, and Run Summary, marked Experimental. The device shows only
 * what the device shows: a click on it is resolved by the server against a
 * fresh observation and sent as a semantic action, or refused beside the
 * device with nothing sent.
 */
export const AndroidWorkspace = ({
  requestedSessionId,
  onBrowser,
}: {
  readonly requestedSessionId?: string | undefined;
  readonly onBrowser: () => void;
}) => {
  const [state, setState] = useAtom(workspaceAtom);
  const refresh = useAtomRefresh(androidSessionsAtom);
  const gesture = useWorkspaceGesture(sessionStartGestureAtom);
  useAndroidSessionSync(requestedSessionId, state.session, setState);
  const run = (command: AndroidWorkspaceCommand): GestureRun =>
    runAndroidWorkspaceCommand(command).pipe(
      Effect.tap((session) =>
        Effect.sync(() => {
          setState((current) => applySnapshot(current, session));
          refresh();
        })
      ),
      Effect.mapError(message),
      Effect.asVoid
    );
  const mutate = (command: AndroidWorkspaceCommand) =>
    gesture.dispatch(run(command));
  const setupOpen = (open: boolean) =>
    setState((current) => ({ ...current, setupOpen: open }));
  const failure = gesture.error ?? state.failure;
  const notices =
    failure === null ? null : (
      <DockNotices>
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
          skillsSession={undefined}
          summary={undefined}
        >
          <EmptyState onBrowser={onBrowser} onOpen={() => setupOpen(true)} />
          {notices}
        </WorkspaceLayout>
      ) : (
        <AndroidSessionView
          mutate={mutate}
          notices={notices}
          onBrowser={onBrowser}
          pending={gesture.pending}
          run={run}
          session={state.session}
          setState={setState}
          state={state}
        />
      )}
      <AndroidSetupSheet
        onOpen={(flowSkillName: FlowSkillName, selection) => {
          if (
            mutate({
              _tag: "start",
              flowSkillName,
              kind: "teaching",
              operationId: operationId(),
              recordingId: null,
              selection,
            })
          ) {
            setupOpen(false);
          }
        }}
        onOpenChange={setupOpen}
        open={state.setupOpen}
        pending={gesture.pending}
      />
    </div>
  );
};
