/* oxlint-disable eslint/no-await-in-loop -- Decode each transport packet in order and release its reader on cancellation. */
import { AgentSessionId, OperationId } from "@contingency/protocol";
import type {
  FlowName,
  IosWorkspaceCommand,
  IosObservationRefusal,
  IosWorkspaceSnapshot,
  IosWorkspaceSelection,
  NativeEmulationChange,
  NativeInput,
} from "@contingency/protocol";
import {
  useAtom,
  useAtomValue,
  useAtomSet,
  useAtomRefresh,
} from "@effect/atom-react";
import { Effect, Fiber, Schema } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import {
  CheckIcon,
  MessageSquareTextIcon,
  RotateCwIcon,
  ShieldAlertIcon,
  SmartphoneIcon,
  UnplugIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  RequestHeader,
  requestIconClassName,
} from "@/components/agent/dock-request-parts";
import { WatcherLoader } from "@/components/brand";
import { FlowsButton } from "@/components/catalog/flows-button";
import { Button } from "@/components/ui/button";
import { decodeBase64 } from "@/lib/base64";
import { isSessionNotFound } from "@/lib/failure-message";
import {
  iosSessionsAtom,
  iosEnabledAtom,
  iosStreamAccess,
  iosWorkspaceForwardMutation,
  runIosWorkspaceCommand,
} from "@/lib/rpc";
import { useRpcDependencies } from "@/lib/rpc-dependencies";
import { cn } from "@/lib/utils";

import { DeviceUnavailable, NativeStage } from "./android-device";
import type {
  DeviceKey,
  EmulateDevice,
  NativeCommentPins,
  NativeElementPick,
} from "./android-device";
import {
  AndroidVariables,
  NativeDoneButton,
  NativeSessionSelect,
  NativeStateBadge,
  NativeTaskDetails,
} from "./android-dock";
import { isEndedNativeRun, nativeActionClassName } from "./android-dock-state";
import { DeviceLastScreen, DeviceRunSummary } from "./android-run-summary";
import { WorkspaceLayout } from "./android-workspace-layout";
import {
  deviceCleanupKey,
  deviceSummaryLabel,
} from "./android-workspace-state";
import { appInstallationQuestion } from "./app-installation";
import {
  makeFirstResponseProbe,
  probeNativeInput,
} from "./first-response-probe";
import {
  iosDockPresentation,
  iosFlowsSessionView,
  iosRailEnabled,
  iosSessionLabel,
  isLiveIosSession,
} from "./ios-dock-state";
import type { IosDockGesture, IosDockPresentation } from "./ios-dock-state";
import { NativeAgentTouch } from "./native-agent-touch";
import { NativeCommentComposer } from "./native-comment-composer";
import {
  closedComment,
  commentPick,
  recordingPins,
} from "./native-comment-state";
import type { NativeComment } from "./native-comment-state";
import { FieldVariableCard } from "./native-field-variable";
import { makeNativeInputHandlers, makeNativeInputQueue } from "./native-input";
import { clearDataQuestion } from "./native-starting-data-copy";
import {
  emptyNativeStreamStats,
  nativeFrameShown,
} from "./native-stream-status";
import type {
  NativeStreamState,
  NativeStreamStats,
} from "./native-stream-status";
import { commentPins } from "./screen-elements";
import {
  DockNotice,
  DockShell,
  DockStatus,
  SessionTopBar,
} from "./workspace-dock";
import { iosStartGestureAtom, useWorkspaceGesture } from "./workspace-gesture";
import { useWorkspaceHome } from "./workspace-home-context";
import { WorkspaceHomeBar } from "./workspace-home-nav";
import { NEW_NATIVE_SESSION } from "./workspace-platform-state";

// oxlint-disable-next-line eslint/no-redeclare
const IosStreamFrame = Schema.Struct({
  _tag: Schema.Literal("jpeg"),
  data: Schema.String,
  height: Schema.Number,
  width: Schema.Number,
});
type IosStreamFrame = typeof IosStreamFrame.Type;
const isIosStreamFrame = Schema.is(IosStreamFrame);

/** A modern iPhone's portrait pixels; the frame takes the real size once drawn. */
const DEFAULT_IOS_FRAME = { height: 2556, width: 1179 };

const snapshotAtom = Atom.make<IosWorkspaceSnapshot | null>(null);
const commandAtom = Atom.keepAlive(
  Atom.fn(
    (request: { readonly run: Effect.Effect<void, string> }) => request.run
  )
);
const operationId = () =>
  OperationId.make(`ios-workspace-${crypto.randomUUID()}`);
/** A refusal's sentence; its leading code is for agents, not people. */
const errorMessage = (cause: unknown) =>
  Schema.is(Schema.Struct({ message: Schema.String }))(cause)
    ? cause.message.replace(/^[a-z][a-z0-9_]*:\s*/u, "")
    : "The iOS session is unavailable.";

const iosDeviceName = (device: IosWorkspaceSelection["device"]) =>
  device.kind === "simulator"
    ? `${device.name} · iOS ${device.runtimeVersion}`
    : device.name;
const iosStreamState = (transport: string): NativeStreamState => {
  if (transport === "live") {
    return "live";
  }
  return transport === "transport_lost" ? "lost" : "connecting";
};
const iosLockedReason = (session: IosWorkspaceSnapshot) =>
  session.controller === "agent" && session.phase === "running"
    ? "The agent is driving. Take control to use the simulator."
    : undefined;

/** What the glass says while the mirror connects or its transport is lost. */
const IosMirrorVeil = ({
  connecting,
  onReconnect,
  paused,
}: {
  readonly connecting: boolean;
  readonly onReconnect: () => void;
  readonly paused: boolean;
}) => (
  <>
    {connecting ? (
      <div className="absolute inset-0 grid place-items-center p-8 text-center">
        <div className="grid justify-items-center gap-3">
          <WatcherLoader className="h-7" />
          <p className="text-sm text-neutral-300" role="status">
            Connecting to the simulator…
          </p>
        </div>
      </div>
    ) : null}
    {paused ? (
      <div className="absolute inset-0 grid place-items-center p-6 text-center">
        <div className="bg-background max-w-56 space-y-2 rounded-2xl border p-4 shadow-lg">
          <UnplugIcon
            aria-hidden="true"
            className="mx-auto size-6 text-amber-600"
          />
          <p className="text-sm font-medium">Mirror paused</p>
          <p className="text-muted-foreground text-xs" role="status">
            Input waits until the transport is restored.
          </p>
          <Button onClick={onReconnect} size="sm" variant="secondary">
            Reconnect device stream
          </Button>
        </div>
      </div>
    ) : null}
  </>
);

const IosMirror = ({
  comments,
  leading,
  pending,
  pick,
  session,
  onDeviceKey,
  onEmulate,
  onInput,
  unavailable,
}: {
  /** The Field Variable card, beside the frame. */
  readonly leading: React.ReactNode;
  readonly pending: boolean;
  /** A Teaching comment picking its element on the screen. */
  readonly pick: NativeElementPick | undefined;
  /** The recording's comment pins, while Teaching records. */
  readonly comments: NativeCommentPins | undefined;
  readonly session: IosWorkspaceSnapshot;
  readonly unavailable: string;
  /** Forwards the user's input to the simulator. */
  readonly onInput: (input: NativeInput) => void;
  /** Home and the App Switcher, sent through the session (ADR 0083). */
  readonly onDeviceKey: (key: DeviceKey) => void;
  readonly onEmulate: EmulateDevice;
}) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [probe] = useState(() =>
    makeFirstResponseProbe("ios", () => canvas.current)
  );
  const [transport, setTransport] = useState("connecting");
  const [frame, setFrame] = useState(DEFAULT_IOS_FRAME);
  const [reconnect, setReconnect] = useState(0);
  const stats = useRef<NativeStreamStats>(emptyNativeStreamStats);
  const live = session.phase === "running" || session.phase === "paused";
  useEffect(() => {
    if (!live) {
      return;
    }
    setTransport("connecting");
    // Decodes off the main thread and resizes the canvas only when the
    // frame size changes, since a resize clears and reallocates it.
    const drawIosFrame = async (value: IosStreamFrame, signal: AbortSignal) => {
      const bytes = decodeBase64(value.data);
      const decodeStart = performance.now();
      const bitmap = await createImageBitmap(
        new Blob([bytes], { type: "image/jpeg" })
      );
      const decodeMs = performance.now() - decodeStart;
      try {
        const target = canvas.current;
        if (!target || signal.aborted) {
          return;
        }
        if (target.width !== value.width || target.height !== value.height) {
          target.width = value.width;
          target.height = value.height;
          setFrame((current) =>
            current.width === value.width && current.height === value.height
              ? current
              : { height: value.height, width: value.width }
          );
        }
        target.getContext("2d")?.drawImage(bitmap, 0, 0);
        stats.current = nativeFrameShown(stats.current, {
          decodeMs,
          height: value.height,
          width: value.width,
        });
        probe.frame();
        setTransport("live");
      } finally {
        bitmap.close();
      }
    };
    const fiber = Effect.runFork(
      iosStreamAccess(session.id).pipe(
        Effect.flatMap((access) =>
          Effect.tryPromise({
            catch: () => new Error("iOS transport lost"),
            try: async (signal) => {
              const response = await fetch(access.path, {
                headers: { Authorization: `Bearer ${access.token}` },
                signal,
              });
              if (!response.ok || !response.body) {
                throw new Error("iOS transport unavailable");
              }
              const reader = response.body.getReader();
              const decoder = new TextDecoder();
              let buffered = "";
              try {
                while (!signal.aborted) {
                  const chunk = await reader.read();
                  if (chunk.done) {
                    break;
                  }
                  buffered += decoder.decode(chunk.value, { stream: true });
                  // Only the newest complete frame is drawn: an older one
                  // that arrived in the same read would only add delay.
                  let newest: IosStreamFrame | undefined;
                  let lost = false;
                  let newline = buffered.indexOf("\n");
                  while (newline !== -1) {
                    const value: unknown = JSON.parse(
                      buffered.slice(0, newline)
                    );
                    buffered = buffered.slice(newline + 1);
                    if (isIosStreamFrame(value)) {
                      newest = value;
                    } else {
                      lost = true;
                    }
                    newline = buffered.indexOf("\n");
                  }
                  if (lost) {
                    setTransport("transport_lost");
                  }
                  if (newest !== undefined) {
                    await drawIosFrame(newest, signal);
                  }
                }
                if (!signal.aborted) {
                  setTransport("transport_lost");
                }
              } finally {
                await reader.cancel();
              }
            },
          })
        ),
        Effect.catchCause(() =>
          Effect.sync(() => setTransport("transport_lost"))
        )
      )
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [probe, session.id, session.phase, live, reconnect]);
  const paused = transport === "transport_lost" && live;
  const interactive =
    live && !paused && transport === "live" && session.controller === "user";
  // The handlers outlive renders; they read the latest state.
  const accepting = useRef({ interactive, onInput });
  useEffect(() => {
    accepting.current = { interactive, onInput };
  }, [interactive, onInput]);
  const [handlers] = useState(() =>
    makeNativeInputHandlers(
      (input) => accepting.current.onInput(input),
      () => accepting.current.interactive,
      probeNativeInput(probe)
    )
  );
  if (!live && session.phase !== "pending") {
    return (
      <DeviceLastScreen
        cleanup={deviceCleanupKey(session.cleanup)}
        fallback={<DeviceUnavailable message={unavailable} />}
        platform="ios"
        sessionId={session.id}
      />
    );
  }
  const onReconnect = () => setReconnect((value) => value + 1);
  return (
    <NativeStage
      busy={pending}
      canAct={iosRailEnabled(session)}
      emulation={session.emulation}
      frame={frame}
      leading={leading}
      lockedReason={iosLockedReason(session)}
      observation={session.observation}
      onActivate={(inputs) => {
        for (const input of inputs) {
          onInput(input);
        }
      }}
      onEmulate={onEmulate}
      onKey={onDeviceKey}
      pick={pick}
      comments={comments}
      sessionId={session.id}
      platform="iOS"
      stream={{
        device: iosDeviceName(session.selection.device),
        format: "JPEG",
        onReconnect: live ? onReconnect : undefined,
        state: iosStreamState(transport),
        stats: () => stats.current,
      }}
      takeover={session.kind !== "teaching" && session.controller === "user"}
    >
      {live ? (
        <canvas
          aria-label={
            interactive
              ? "Live iOS viewport. Pointer, wheel, and keyboard input go to the simulator."
              : "Live iOS viewport"
          }
          aria-roledescription={interactive ? "device display" : undefined}
          className={cn(
            "absolute inset-0 size-full touch-none outline-none",
            interactive ? "cursor-pointer" : "cursor-default",
            paused && "opacity-40"
          )}
          data-observation-id={session.observation?.id}
          ref={canvas}
          role={interactive ? "application" : "img"}
          tabIndex={interactive ? 0 : -1}
          {...handlers}
        />
      ) : (
        <div className="absolute inset-0 grid place-items-center p-8 text-center text-sm text-neutral-400">
          {unavailable}
        </div>
      )}
      {live ? (
        <NativeAgentTouch
          frame={frame}
          sessionId={session.id}
          visible={session.controller === "agent"}
        />
      ) : null}
      <IosMirrorVeil
        connecting={live && transport === "connecting"}
        onReconnect={onReconnect}
        paused={paused}
      />
    </NativeStage>
  );
};

const DECISION_TITLE = {
  "app-installation": "App installation",
  "clear-app-data": "Clear app data",
  confirmation: "Confirmation",
  "run-environment-permission": "Run Environment Permission",
} as const;

/** What preparation or an action attempt waits on, in the dock's request tier. */
const IosDecisions = ({
  pending,
  send,
  session,
}: {
  readonly pending: boolean;
  readonly send: (command: IosWorkspaceCommand) => boolean;
  readonly session: IosWorkspaceSnapshot;
}) =>
  session.preparation.pending.length === 0 ? null : (
    <div className="space-y-3 border-b p-3.5">
      {session.preparation.pending.map((decision) => {
        const decide = (allow: boolean) =>
          send({
            _tag: "decide",
            allow,
            decisionId: decision.id,
            operationId: operationId(),
            sessionId: session.id,
          });
        const { environment } = session.selection;
        return (
          <section aria-label={DECISION_TITLE[decision.kind]} key={decision.id}>
            <RequestHeader
              action={
                <>
                  <Button
                    variant="primary"
                    disabled={pending}
                    onClick={() => decide(true)}
                    size="xs"
                  >
                    Allow
                  </Button>
                  <Button
                    disabled={pending}
                    onClick={() => decide(false)}
                    size="xs"
                    variant="outline"
                  >
                    Refuse
                  </Button>
                </>
              }
              icon={
                <ShieldAlertIcon
                  aria-hidden="true"
                  className={requestIconClassName}
                />
              }
              title={DECISION_TITLE[decision.kind]}
            />
            <p className="text-muted-foreground mt-1 text-xs text-pretty">
              {decision.kind === "app-installation"
                ? appInstallationQuestion({
                    app: environment.bundleId,
                    build: environment.build,
                    device: session.selection.device.name,
                    installedBuild: decision.installedBuild,
                  })
                : null}
              {decision.kind === "clear-app-data"
                ? clearDataQuestion(
                    environment.bundleId,
                    session.selection.device.name
                  )
                : null}
              {decision.kind === "confirmation"
                ? `${session.boundary?.description ?? "iOS action"}. Allow this exact attempt once; a retry needs a fresh Confirmation.`
                : null}
              {decision.kind === "run-environment-permission"
                ? `The agent wants to run on ${environment.bundleId}${session.preparation.differences.length === 0 ? "" : ` with ${session.preparation.differences.map((difference) => `${difference.field} ${difference.selected} (taught on ${difference.taught})`).join(", ")}`}.`
                : null}
            </p>
          </section>
        );
      })}
    </div>
  );

type IosField = NonNullable<IosWorkspaceSnapshot["field"]>;

/** The rail's key as a Workspace input; iOS has no Back, so it sends none. */
const railKeyCommand = (
  key: DeviceKey,
  session: IosWorkspaceSnapshot
): IosWorkspaceCommand | null =>
  key === "GoBack"
    ? null
    : {
        _tag: "input",
        action: { _tag: key === "GoHome" ? "home" : "app-switcher" },
        // The keys do not depend on the screen they leave.
        observationId: session.observation?.id ?? "rail",
        operationId: operationId(),
        sessionId: session.id,
      };

const emulateCommand = (
  change: NativeEmulationChange,
  session: IosWorkspaceSnapshot
): IosWorkspaceCommand => ({
  _tag: "emulate",
  change,
  operationId: operationId(),
  sessionId: session.id,
});

const gestureCommand = (
  gesture: IosDockGesture,
  session: IosWorkspaceSnapshot
): IosWorkspaceCommand => {
  const fields = { operationId: operationId(), sessionId: session.id };
  switch (gesture) {
    case "prepare": {
      return { _tag: "prepare", ...fields };
    }
    case "recover": {
      return { _tag: "recover", ...fields };
    }
    case "start-recording": {
      return { _tag: "record", ...fields, start: true };
    }
    case "stop-recording": {
      return { _tag: "record", ...fields, start: false };
    }
    case "take-control": {
      return { _tag: "control", ...fields, controller: "user" };
    }
    case "return-control": {
      return { _tag: "control", ...fields, controller: "agent" };
    }
    case "verify-flow": {
      return { _tag: "flow-decision", ...fields, decision: "verify" };
    }
    case "retry-cleanup": {
      return { _tag: "flow-decision", ...fields, decision: "retry-cleanup" };
    }
    default: {
      return gesture satisfies never;
    }
  }
};

const PrimaryIcon = ({ gesture }: { readonly gesture: IosDockGesture }) => {
  switch (gesture) {
    // Start and Stop are labels alone, as in the prototype.
    case "verify-flow": {
      return <CheckIcon />;
    }
    case "retry-cleanup": {
      return <RotateCwIcon />;
    }
    default: {
      return null;
    }
  }
};

const IosStateBadge = ({
  presentation,
  session,
}: {
  readonly presentation: IosDockPresentation;
  readonly session: IosWorkspaceSnapshot;
}) => (
  <NativeStateBadge
    badge={presentation.badge}
    recordingStartedAt={
      session.captureState?._tag === "recording"
        ? session.captureState.startedAt
        : undefined
    }
    tone={presentation.tone}
  />
);

/** Recovery a paused iOS session offers outside the dock, kept for callers. */
export const IosRecovery = ({
  refusal,
  pending,
  onRecover,
}: {
  readonly refusal: IosObservationRefusal | null | undefined;
  readonly pending: boolean;
  readonly onRecover: (command: "recover") => void;
}) => (
  <Button
    size="md"
    variant="primary"
    disabled={pending}
    onClick={() => onRecover("recover")}
  >
    {refusal?.recovery === "go-home" ? "Go Home" : "Recover selected simulator"}
  </Button>
);

/** The facts a native Run's Task details lists about its simulator setup. */
const iosTaskFacts = (session: IosWorkspaceSnapshot) => [
  { term: "Device", value: iosDeviceName(session.selection.device) },
  {
    term: "Target App",
    value: `${session.selection.environment.bundleId} · build ${session.selection.environment.build}`,
  },
];

/**
 * The status island's controls, as on Android and the prototype: Comment
 * while recording, a Flow decision's Reject flow, **Task details** on a Dry
 * Run or Run, **Done** once a Run has ended, and the one action. Closing a
 * live session is in the session picker, not here.
 */
const IosDockControls = ({
  commenting,
  gesture,
  onComment,
  onDone,
  onNewSession,
  presentation,
  send,
  session,
}: {
  readonly commenting: boolean;
  readonly gesture: { readonly pending: boolean };
  readonly onComment: () => void;
  readonly onDone: () => void;
  readonly onNewSession: () => void;
  readonly presentation: IosDockPresentation;
  readonly send: (command: IosWorkspaceCommand) => boolean;
  readonly session: IosWorkspaceSnapshot;
}) => {
  const primary = presentation.action;
  const ended = isEndedNativeRun(session);
  return (
    <>
      {presentation.showsComment ? (
        <Button
          aria-label="Comment"
          title="Comment"
          aria-pressed={commenting}
          onClick={onComment}
          size="sm"
          variant="ghost"
        >
          <MessageSquareTextIcon />
          <span className="hidden @md:inline">Comment</span>
        </Button>
      ) : null}
      {presentation.rejectable ? (
        <Button
          disabled={gesture.pending}
          onClick={() =>
            send({
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
      {session.kind === "teaching" ? null : (
        <NativeTaskDetails facts={iosTaskFacts(session)} session={session} />
      )}
      {ended ? (
        <NativeDoneButton onDone={onDone} quiet={primary !== null} />
      ) : null}
      {/* An ended Teaching session starts over from the start card. */}
      {isLiveIosSession(session) || ended ? null : (
        <Button onClick={onNewSession} size="sm" variant="outline">
          New session
        </Button>
      )}
      {primary === null ? null : (
        <Button
          size="md"
          variant="primary"
          className={nativeActionClassName(primary.gesture)}
          aria-label={primary.accessibleName}
          disabled={
            gesture.pending ||
            (primary.gesture === "prepare" &&
              session.preparation.pending.length > 0)
          }
          onClick={() => send(gestureCommand(primary.gesture, session))}
        >
          <PrimaryIcon gesture={primary.gesture} />
          {primary.label}
        </Button>
      )}
    </>
  );
};

/**
 * The password field whose Variables the dock offers: only while the person
 * holds a running session (and, when teaching, while recording), and not once
 * they dismissed it. Other text goes to the simulator as they type on it.
 */
const typingField = (
  session: IosWorkspaceSnapshot,
  dismissedField: string | null
): IosField | null => {
  const canType =
    session.phase === "running" &&
    session.controller === "user" &&
    (session.kind !== "teaching" || session.captureState?._tag === "recording");
  return canType &&
    session.field !== null &&
    session.field.password === true &&
    session.field.observationId !== dismissedField
    ? session.field
    : null;
};

const IosDock = ({
  comment,
  gesture,
  inputRefusal,
  onDone,
  onNewSession,
  send,
  session,
  setComment,
}: {
  /** The comment being written, shared with the stage's element picker. */
  readonly comment: NativeComment;
  readonly setComment: (
    update: (current: NativeComment) => NativeComment
  ) => void;
  readonly gesture: {
    readonly pending: boolean;
    readonly error: string | undefined;
  };
  /** Why the last Forwarded Input sent nothing, if it was refused. */
  readonly inputRefusal: string | null;
  readonly onDone: () => void;
  readonly onNewSession: () => void;
  readonly send: (command: IosWorkspaceCommand) => boolean;
  readonly session: IosWorkspaceSnapshot;
}) => {
  const commenting = comment.open;
  const presentation = iosDockPresentation(session);
  const recording = session.captureState?._tag === "recording";
  return (
    <>
      <DockShell
        notice={
          <>
            {gesture.error === undefined ? null : (
              <DockNotice>{gesture.error}</DockNotice>
            )}
            {inputRefusal === null ? null : (
              <DockNotice>{inputRefusal}</DockNotice>
            )}
          </>
        }
        footer={
          <>
            {session.cleanup?._tag === "purge-pending" ? (
              <p
                className="text-destructive border-t px-3 py-1.5 text-xs text-pretty"
                role="alert"
              >
                {session.cleanup.failure} Kept:{" "}
                {session.cleanup.retainedFiles.join(", ")}.
              </p>
            ) : null}
          </>
        }
        requests={
          <>
            <IosDecisions
              pending={gesture.pending}
              send={send}
              session={session}
            />
            <AndroidVariables
              onSupply={(name, requestId, value) =>
                send({
                  _tag: "variable-supply",
                  name,
                  operationId: operationId(),
                  requestId,
                  sessionId: session.id,
                  value,
                })
              }
              pending={gesture.pending}
              session={session}
            />
          </>
        }
        status={
          <DockStatus
            badges={
              <IosStateBadge presentation={presentation} session={session} />
            }
          >
            {session.error !== null && session.phase !== "paused"
              ? session.error
              : presentation.nextStep}
          </DockStatus>
        }
      >
        <IosDockControls
          commenting={commenting}
          gesture={gesture}
          onComment={() =>
            setComment((current) =>
              current.open ? closedComment : { ...current, open: true }
            )
          }
          onDone={onDone}
          onNewSession={onNewSession}
          presentation={presentation}
          send={send}
          session={session}
        />
      </DockShell>
      {commenting && recording ? (
        <NativeCommentComposer
          attached={comment.attached ?? undefined}
          canAttach={session.observation !== null}
          instructions={session.instructions ?? []}
          onAttach={() =>
            setComment((current) => ({ ...current, picking: true }))
          }
          onCancelPick={() =>
            setComment((current) => ({ ...current, picking: false }))
          }
          onDetach={() =>
            setComment((current) => ({ ...current, attached: null }))
          }
          onDismiss={() => setComment(() => closedComment)}
          onSubmit={(text) => {
            const { attached } = comment;
            const instruction = {
              _tag: "instruction" as const,
              operationId: operationId(),
              sessionId: session.id,
              text,
            };
            if (
              send(
                attached === null
                  ? instruction
                  : {
                      ...instruction,
                      element: {
                        observationId: attached.observationId,
                        target: attached.target,
                      },
                    }
              )
            ) {
              // The composer and its draft stay until the instruction
              // is saved; a refusal leaves them for another try.
              setComment((current) => ({
                ...current,
                picking: false,
                submitting: true,
              }));
            }
          }}
          pending={gesture.pending}
          onHighlight={(index) =>
            setComment((current) => ({
              ...current,
              highlighted: index ?? null,
            }))
          }
          picking={comment.picking}
          pins={commentPins(session.observation, session.instructions ?? [])}
          startedAt={
            session.captureState?._tag === "recording"
              ? session.captureState.startedAt
              : undefined
          }
        />
      ) : null}
    </>
  );
};

/**
 * The session's top bar: the wordmark and the session picker, then Flows.
 * It comes first in the stage, before the simulator, as on Android and in the
 * prototype. The shown session names itself even once it has ended; only a
 * live one is a choice in the list.
 */
const IosTopBar = ({
  onNewSession,
  onSelectSession,
  send,
  pending,
  session,
}: {
  readonly onNewSession: () => void;
  readonly onSelectSession: (session: string) => void;
  readonly pending: boolean;
  readonly send: (command: IosWorkspaceCommand) => boolean;
  readonly session: IosWorkspaceSnapshot;
}) => {
  const listed = useAtomValue(iosSessionsAtom);
  const sessions = AsyncResult.isSuccess(listed) ? listed.value : [];
  // A just-started session may not be listed yet; an ended one is no choice.
  const choices =
    sessions.some((entry) => entry.id === session.id) ||
    !isLiveIosSession(session)
      ? sessions
      : [session, ...sessions];
  return (
    <SessionTopBar
      className="absolute inset-x-0 top-0"
      flows={<FlowsButton session={iosFlowsSessionView(session)} />}
      picker={
        <NativeSessionSelect
          close={
            isLiveIosSession(session)
              ? {
                  onClose: () =>
                    send({
                      _tag: "close",
                      operationId: operationId(),
                      sessionId: session.id,
                    }),
                  pending,
                }
              : undefined
          }
          current={session}
          label={iosSessionLabel}
          onNew={onNewSession}
          onSelect={onSelectSession}
          platform="ios"
          sessions={choices}
        />
      }
    />
  );
};

/** What the simulator glass says while nothing is mirrored. */
const glassText = (session: IosWorkspaceSnapshot) => {
  if (session.phase === "pending") {
    return "Prepare the simulator to mirror it here.";
  }
  if (session.phase === "refused") {
    return "This session never used the simulator.";
  }
  return "This session released the simulator.";
};

/**
 * Opens an iOS Teaching session, as the home's start card asks. The started
 * session becomes the one the iOS Workspace shows, so it opens on the session
 * rather than a read. The gesture is its own: a refusal shows on the card,
 * never on Web's or Android's. A start that finishes after the person moved
 * on only refreshes the shelf.
 */
export const useIosSessionStart = () => {
  const rpc = useRpcDependencies();
  const refresh = useAtomRefresh(rpc.iosSessionsAtom);
  const setSession = useAtomSet(snapshotAtom);
  const gesture = useWorkspaceGesture(iosStartGestureAtom);
  const start = (
    flowName: FlowName,
    selection: IosWorkspaceSelection,
    opening: {
      readonly onStarted: (sessionId: AgentSessionId) => void;
      /** Whether the person is still waiting on this start to open. */
      readonly owns: () => boolean;
    }
  ): boolean =>
    gesture.dispatch(
      rpc
        .runIosWorkspaceCommand({
          _tag: "start",
          flowName,
          kind: "teaching",
          operationId: operationId(),
          recordingId: null,
          selection,
        })
        .pipe(
          Effect.tap((session) =>
            Effect.sync(() => {
              refresh();
              if (opening.owns()) {
                setSession(session);
                opening.onStarted(session.id);
              }
            })
          ),
          Effect.mapError(errorMessage),
          Effect.asVoid
        )
    );
  return { error: gesture.error, pending: gesture.pending, start };
};

/** The iOS Workspace with no session yet, or one its link no longer names. */
const IosNoSession = ({
  onStart,
  pending,
  unavailable,
}: {
  readonly onStart: () => void;
  readonly pending: boolean;
  readonly unavailable: boolean;
}) => (
  <main
    aria-busy={pending}
    aria-label="iOS Workspace"
    className="bg-muted/40 relative grid h-full min-h-0 place-items-center bg-[radial-gradient(var(--color-border)_1px,transparent_1px)] [background-size:16px_16px] p-4"
  >
    <section className="material-panel w-full max-w-md space-y-4 rounded-xl p-5 shadow-[0_24px_64px_-32px_rgb(0_0_0/0.35)] sm:p-6">
      <div
        aria-hidden="true"
        className="bg-muted text-muted-foreground grid size-10 place-items-center rounded-lg border"
      >
        <SmartphoneIcon className="size-5" />
      </div>
      <div className="space-y-1.5">
        <h1 className="text-xl font-semibold tracking-tight">No iOS session</h1>
        <p className="text-muted-foreground text-sm text-pretty">
          Start a session to mirror a running iPhone simulator, then record a
          journey through its Target App.
        </p>
        {unavailable ? (
          <p
            className="text-muted-foreground text-sm text-pretty"
            role="status"
          >
            The session this link named is no longer available.
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={onStart} size="lg">
          <SmartphoneIcon />
          Start an iOS session
        </Button>
      </div>
    </section>
    <WorkspaceHomeBar />
  </main>
);

/** The Field Variable card for the password field the session is typing into. */
const IosFieldVariable = ({
  disabled,
  field,
  onStop,
  send,
  session,
}: {
  readonly disabled: boolean;
  readonly field: NonNullable<ReturnType<typeof typingField>>;
  readonly onStop: () => void;
  readonly send: (command: IosWorkspaceCommand) => void;
  readonly session: IosWorkspaceSnapshot;
}) => (
  <FieldVariableCard
    disabled={disabled}
    field={field.name || field.role}
    onEnter={(name) =>
      send({
        _tag: "input",
        action: { _tag: "variable", name, target: field.target },
        observationId: field.observationId,
        operationId: operationId(),
        sessionId: session.id,
      })
    }
    onRequest={(name) =>
      send({
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
    onStop={onStop}
    variables={session.variables ?? []}
  />
);

export const IosWorkspace = ({
  onSessionChange,
  requestedSessionId,
}: {
  /** Shows another session, or `new`, by naming it in the route. */
  readonly onSessionChange: (session: string) => void;
  readonly requestedSessionId: string;
}) => {
  const [session, setSession] = useAtom(snapshotAtom);
  const [commentAtom] = useState(() => Atom.make(closedComment));
  const [comment, setComment] = useAtom(commentAtom);
  const enabled = useAtomValue(iosEnabledAtom);
  const gesture = useWorkspaceGesture(commandAtom);
  const home = useWorkspaceHome();
  // A sent comment closes its composer only once it saves; a refusal leaves
  // the composer and its draft for another try.
  const { submitting } = comment;
  useEffect(() => {
    if (!submitting || gesture.pending) {
      return;
    }
    setComment((current) =>
      gesture.error === undefined
        ? closedComment
        : { ...current, submitting: false }
    );
  }, [gesture.error, gesture.pending, setComment, submitting]);
  /** The route named a session this server has no record of. */
  const [unavailable, setUnavailable] = useState(false);
  const apply = (next: IosWorkspaceSnapshot) =>
    setSession((current) =>
      current?.id === next.id && current.revision > next.revision
        ? current
        : next
    );
  const [inputRefusalAtom] = useState(() => Atom.make<string | null>(null));
  const [inputRefusal, setInputRefusal] = useAtom(inputRefusalAtom);
  const [dismissedAtom] = useState(() => Atom.make<string | null>(null));
  const [dismissedField, setDismissedField] = useAtom(dismissedAtom);
  // Which session the route names, read when a command settles.
  const routeRef = useRef(requestedSessionId);
  useEffect(() => {
    routeRef.current = requestedSessionId;
  }, [requestedSessionId]);
  /** `onApplied` runs once the host accepts the command. */
  const send = (command: IosWorkspaceCommand, onApplied?: () => void) => {
    const route = routeRef.current;
    return gesture.dispatch(
      runIosWorkspaceCommand(command).pipe(
        Effect.tap((next) =>
          Effect.sync(() => {
            // The change still counts for the session that sent it, which the
            // stage keeps until the route returns there.
            onApplied?.();
            // The route moved on while this ran: it no longer shows the result.
            if (routeRef.current !== route && routeRef.current !== next.id) {
              return;
            }
            apply(next);
          })
        ),
        Effect.asVoid,
        Effect.mapError(errorMessage)
      )
    );
  };
  const forwardInput = useAtomSet(iosWorkspaceForwardMutation, {
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
  const onInput = (input: NativeInput) => {
    const forwardedSession = session?.id;
    if (forwardedSession === undefined) {
      return;
    }
    if (inputRefusal !== null) {
      setInputRefusal(null);
    }
    let forward = queues.get(forwardedSession);
    if (forward === undefined) {
      forward = makeNativeInputQueue(
        (inputs) =>
          Effect.tryPromise({
            catch: (cause) => cause,
            try: () =>
              forwardInputRef.current({
                payload: { inputs, sessionId: forwardedSession },
              }),
          }),
        (cause) => setInputRefusal(errorMessage(cause))
      );
      queues.set(forwardedSession, forward);
    }
    forward(input);
  };
  // An id reads that session; `new` is the home's iOS start card.
  useEffect(() => {
    if (!Schema.is(AgentSessionId)(requestedSessionId)) {
      return;
    }
    // A read the route has moved past must not land: interrupting the fiber
    // can lose the race with its completion.
    let requested = true;
    const fiber = Effect.runFork(
      runIosWorkspaceCommand({
        _tag: "read",
        sessionId: requestedSessionId,
      }).pipe(
        Effect.tap((next) =>
          Effect.sync(() => {
            if (requested) {
              setUnavailable(false);
              setSession(next);
            }
          })
        ),
        // An ended link to a deleted record selects nothing in its place.
        Effect.tapError((failure) =>
          Effect.sync(() => {
            if (requested && isSessionNotFound(failure)) {
              setSession(null);
              setUnavailable(true);
            }
          })
        ),
        Effect.ignore
      )
    );
    return () => {
      requested = false;
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [requestedSessionId, setSession]);
  const id = session?.id;
  // A started or selected session takes the route, so a refresh reopens it.
  const shownId = useRef(id);
  useEffect(() => {
    if (shownId.current === id) {
      return;
    }
    shownId.current = id;
    if (id !== undefined) {
      // A start and a selection reach the shown session by different
      // commands; the route follows the result rather than each one.
      // oxlint-disable-next-line react-doctor/no-pass-data-to-parent
      onSessionChange(id);
    }
  }, [id, onSessionChange]);
  useEffect(() => {
    if (!id) {
      return;
    }
    const fiber = Effect.runFork(
      Effect.forever(
        runIosWorkspaceCommand({ _tag: "read", sessionId: id }).pipe(
          Effect.tap((next) =>
            Effect.sync(() =>
              setSession((current) =>
                current?.id === id && current.revision <= next.revision
                  ? next
                  : current
              )
            )
          ),
          Effect.ignore,
          Effect.andThen(Effect.sleep("1 second"))
        )
      )
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [id, setSession]);
  if (!AsyncResult.isSuccess(enabled) || !enabled.value) {
    return (
      <main className="text-muted-foreground relative grid h-full place-items-center p-6 text-sm">
        <WorkspaceHomeBar />
        <p>iOS Workspace is unlisted.</p>
      </main>
    );
  }
  // A new session starts from the home's iOS start card.
  const startNew = () => onSessionChange(NEW_NATIVE_SESSION);
  if (session === null) {
    return (
      <IosNoSession
        onStart={startNew}
        pending={gesture.pending}
        unavailable={unavailable}
      />
    );
  }
  const live = isLiveIosSession(session);
  const field = typingField(session, dismissedField);
  return (
    <WorkspaceLayout
      summaryKey={session.id}
      summary={
        live
          ? null
          : {
              label: deviceSummaryLabel(session.kind),
              summary: (
                <DeviceRunSummary
                  platform="ios"
                  device={iosDeviceName(session.selection.device)}
                  session={session}
                  targetApp={`${session.selection.environment.bundleId} · build ${session.selection.environment.build}`}
                />
              ),
            }
      }
    >
      <main
        aria-busy={gesture.pending}
        aria-label="iOS Workspace"
        data-vt="stage"
        className={cn(
          // The device leaves room above for notices and below for the dock.
          "workspace-canvas relative flex min-h-0 flex-1 justify-center px-6 pt-16",
          "pb-[calc(var(--dock-height,6.5rem)+1.5rem)]"
        )}
      >
        <IosTopBar
          onNewSession={startNew}
          onSelectSession={onSessionChange}
          pending={gesture.pending}
          send={send}
          session={session}
        />
        <IosMirror
          leading={
            field === null ? null : (
              <IosFieldVariable
                disabled={gesture.pending}
                field={field}
                key={field.observationId}
                onStop={() => setDismissedField(field.observationId)}
                send={send}
                session={session}
              />
            )
          }
          pending={gesture.pending}
          pick={
            session.captureState?._tag === "recording"
              ? commentPick(comment, setComment)
              : undefined
          }
          comments={recordingPins(session, comment.highlighted)}
          onDeviceKey={(key) => {
            const command = railKeyCommand(key, session);
            if (command !== null) {
              send(command);
            }
          }}
          onEmulate={(change, onApplied) =>
            send(emulateCommand(change, session), onApplied)
          }
          onInput={onInput}
          session={session}
          unavailable={glassText(session)}
        />
        <IosDock
          comment={comment}
          gesture={gesture}
          inputRefusal={inputRefusal}
          onDone={home === null ? startNew : home.goHome}
          onNewSession={startNew}
          send={send}
          session={session}
          setComment={setComment}
        />
      </main>
    </WorkspaceLayout>
  );
};
