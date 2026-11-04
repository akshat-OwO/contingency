/* oxlint-disable eslint/no-await-in-loop -- Decode each transport packet in order and release its reader on cancellation. */
import { AgentSessionId, FlowName, OperationId } from "@contingency/protocol";
import type {
  IosWorkspaceCommand,
  IosObservationRefusal,
  IosWorkspaceSnapshot,
  IosWorkspaceSelection,
  IosWorkspaceSummary,
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
  CircleAlertIcon,
  CircleIcon,
  CircleSlashIcon,
  CornerDownLeftIcon,
  KeyRoundIcon,
  MessageSquareTextIcon,
  MonitorIcon,
  PowerIcon,
  RefreshCwIcon,
  RotateCwIcon,
  ShieldAlertIcon,
  SmartphoneIcon,
  SquareIcon,
  TextCursorInputIcon,
  UnplugIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  RequestHeader,
  requestIconClassName,
} from "@/components/agent/dock-request-parts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOptGroup,
  NativeSelectOption,
} from "@/components/ui/native-select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  iosDevicesAtom,
  iosSessionsAtom,
  iosEnabledAtom,
  iosStreamAccess,
  runIosWorkspaceCommand,
} from "@/lib/rpc";
import { cn } from "@/lib/utils";

import { workspaceChromeAtom } from "./agent-workspace-state";
import { DeviceFrame, DeviceUnavailable } from "./android-device";
import { AndroidVariables } from "./android-dock";
import { DeviceRunSummary } from "./android-run-summary";
import { WorkspaceLayout } from "./android-workspace-layout";
import { DeviceElements } from "./device-elements";
import {
  iosDockPresentation,
  iosFlowsSessionView,
  iosSessionLabel,
  isLiveIosSession,
} from "./ios-dock-state";
import type { IosDockGesture, IosDockPresentation } from "./ios-dock-state";
import {
  DockShell,
  DockSpacer,
  DockStatus,
  DockWordmark,
} from "./workspace-dock";
import { useWorkspaceGesture } from "./workspace-gesture";

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
const text = (data: FormData, key: string) => String(data.get(key) ?? "");
/** A refusal's sentence; its leading code is for agents, not people. */
const errorMessage = (cause: unknown) =>
  Schema.is(Schema.Struct({ message: Schema.String }))(cause)
    ? cause.message.replace(/^[a-z][a-z0-9_]*:\s*/u, "")
    : "The iOS session is unavailable.";

/** Whether this process offers iOS sessions at all. */
export const useIosEntryEnabled = () => {
  const enabled = useAtomValue(iosEnabledAtom);
  return AsyncResult.isSuccess(enabled) && enabled.value;
};

const openIosEntry = () => globalThis.location.assign("/?ios=new");

export const IosEntry = ({ className }: { readonly className?: string }) =>
  useIosEntryEnabled() ? (
    <Button
      className={className}
      onClick={openIosEntry}
      size="sm"
      variant="outline"
    >
      iOS
    </Button>
  ) : null;

const IosMirror = ({
  session,
  onPick,
  unavailable,
}: {
  readonly session: IosWorkspaceSnapshot;
  readonly unavailable: string;
  readonly onPick: (
    point: { x: number; y: number },
    frame: { width: number; height: number }
  ) => void;
}) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const pointer = useRef<{
    readonly id: number;
    readonly x: number;
    readonly y: number;
  } | null>(null);
  const [gestureError, setGestureError] = useState<string | null>(null);
  const [transport, setTransport] = useState("connecting");
  const [frame, setFrame] = useState(DEFAULT_IOS_FRAME);
  const live = session.phase === "running" || session.phase === "paused";
  useEffect(() => {
    if (!live) {
      return;
    }
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
              let pending = "";
              try {
                while (!signal.aborted) {
                  const chunk = await reader.read();
                  if (chunk.done) {
                    break;
                  }
                  pending += decoder.decode(chunk.value, { stream: true });
                  let newline = pending.indexOf("\n");
                  while (newline !== -1) {
                    const value: unknown = JSON.parse(
                      pending.slice(0, newline)
                    );
                    pending = pending.slice(newline + 1);
                    if (
                      Schema.is(
                        Schema.Struct({
                          _tag: Schema.Literal("jpeg"),
                          data: Schema.String,
                          height: Schema.Number,
                          width: Schema.Number,
                        })
                      )(value)
                    ) {
                      const image = new Image();
                      image.src = `data:image/jpeg;base64,${value.data}`;
                      await image.decode();
                      const target = canvas.current;
                      if (target && !signal.aborted) {
                        target.width = value.width;
                        target.height = value.height;
                        setFrame((current) =>
                          current.width === value.width &&
                          current.height === value.height
                            ? current
                            : { height: value.height, width: value.width }
                        );
                        target.getContext("2d")?.drawImage(image, 0, 0);
                        setTransport("live");
                      }
                    } else {
                      setTransport("transport_lost");
                    }
                    newline = pending.indexOf("\n");
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
  }, [session.id, session.phase, live]);
  const paused = transport === "transport_lost" && live;
  if (!live && session.phase !== "pending") {
    return <DeviceUnavailable message={unavailable} />;
  }
  return (
    <div className="relative flex h-full min-h-0 items-center justify-center gap-5">
      <div aria-hidden="true" className="hidden w-56 shrink-0 lg:block" />
      <div className="h-full min-h-0 min-w-0 flex-1 lg:flex-none lg:basis-[min(100%,28rem)]">
        <DeviceFrame frame={frame}>
          {live ? (
            <canvas
              aria-label="Live iOS viewport"
              className={cn(
                "absolute inset-0 size-full touch-none",
                session.controller === "user" && !paused
                  ? "cursor-pointer"
                  : "cursor-default",
                paused && "opacity-40"
              )}
              data-observation-id={session.observation?.id}
              ref={canvas}
              role="img"
              onPointerDown={(event) => {
                pointer.current = {
                  id: event.pointerId,
                  x: event.clientX,
                  y: event.clientY,
                };
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerCancel={() => {
                pointer.current = null;
              }}
              onPointerUp={(event) => {
                const down = pointer.current;
                pointer.current = null;
                if (!down || down.id !== event.pointerId) {
                  return;
                }
                if (
                  Math.hypot(event.clientX - down.x, event.clientY - down.y) > 8
                ) {
                  setGestureError(
                    "capability_missing: iOS swipes, including edge swipes, are unsupported. No input was sent."
                  );
                  return;
                }
                setGestureError(null);
                if (
                  transport !== "live" ||
                  !canvas.current ||
                  session.controller !== "user"
                ) {
                  return;
                }
                const box = event.currentTarget.getBoundingClientRect();
                onPick(
                  {
                    x: (event.clientX - box.left) / box.width,
                    y: (event.clientY - box.top) / box.height,
                  },
                  { height: canvas.current.height, width: canvas.current.width }
                );
              }}
            />
          ) : (
            <div className="absolute inset-0 grid place-items-center p-8 text-center text-sm text-neutral-400">
              {unavailable}
            </div>
          )}
          {paused ? (
            <div className="absolute inset-0 grid place-items-center p-6 text-center">
              <div className="bg-background max-w-56 space-y-1 rounded-2xl border p-4 shadow-lg">
                <UnplugIcon
                  aria-hidden="true"
                  className="mx-auto size-6 text-amber-600"
                />
                <p className="text-sm font-medium">Mirror paused</p>
                <p className="text-muted-foreground text-xs">
                  Input waits until the transport is restored.
                </p>
              </div>
            </div>
          ) : null}
        </DeviceFrame>
      </div>
      <div
        aria-live="polite"
        className="space-y-2 max-lg:absolute max-lg:inset-x-2 max-lg:top-0 max-lg:z-10 lg:w-56 lg:shrink-0"
      >
        <p className="sr-only" role="status">
          {paused
            ? "iOS mirror paused. No input is sent until transport is restored."
            : ""}
        </p>
        {gestureError === null ? null : (
          <p
            className="bg-background flex items-start gap-2 rounded-xl border px-3 py-2 text-xs shadow-sm"
            role="alert"
          >
            <CircleSlashIcon
              aria-hidden="true"
              className="text-muted-foreground mt-0.5 size-3.5 shrink-0"
            />
            <span>
              Swipes, including edge swipes, are not supported on iOS. No input
              was sent.
              <span className="sr-only"> {gestureError}</span>
            </span>
          </p>
        )}
      </div>
    </div>
  );
};

const SetupGroup = ({
  children,
  description,
  title,
}: {
  readonly children: React.ReactNode;
  readonly description?: string | undefined;
  readonly title: string;
}) => (
  <fieldset className="min-w-0 space-y-3">
    <div className="space-y-0.5">
      <legend className="text-sm font-medium">{title}</legend>
      {description === undefined ? null : (
        <p className="text-muted-foreground text-xs text-pretty">
          {description}
        </p>
      )}
    </div>
    {children}
  </fieldset>
);

const SetupField = ({
  children,
  help,
  htmlFor,
  label,
}: {
  readonly children: React.ReactNode;
  readonly help?: { readonly id: string; readonly text: string };
  readonly htmlFor: string;
  readonly label: string;
}) => (
  <div className="min-w-0 space-y-1.5">
    <Label htmlFor={htmlFor}>{label}</Label>
    {children}
    {help === undefined ? null : (
      <p className="text-muted-foreground text-xs" id={help.id}>
        {help.text}
      </p>
    )}
  </div>
);

const ROLE_OPTIONS = ["text", "group", "heading", "button", "image"] as const;

const IosSetupSheet = ({
  onClose,
  open,
  pending,
  send,
}: {
  readonly onClose: () => void;
  readonly open: boolean;
  readonly pending: boolean;
  readonly send: (command: IosWorkspaceCommand) => boolean;
}) => {
  const devices = useAtomValue(iosDevicesAtom);
  const refresh = useAtomRefresh(iosDevicesAtom);
  const listed = AsyncResult.isSuccess(devices) ? devices.value : [];
  const running = listed.filter((device) => device.state === "Booted");
  const stopped = listed.filter((device) => device.state !== "Booted");
  const [completeAtom] = useState(() => Atom.make(false));
  const [complete, setComplete] = useAtom(completeAtom);
  return (
    <Sheet
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
      open={open}
    >
      <SheetContent
        aria-label="New iOS session"
        className="w-full data-[side=right]:w-full data-[side=right]:sm:max-w-xl"
      >
        <SheetHeader className="border-b">
          <SheetTitle>New iOS session</SheetTitle>
          <SheetDescription>
            Pick a running iPhone simulator and the Target App. Each journey
            restarts the app on that simulator with its existing data.
          </SheetDescription>
        </SheetHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onInput={(event) => setComplete(event.currentTarget.checkValidity())}
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const device = listed.find(
              (entry) => entry.udid === text(data, "device")
            );
            if (!device || device.state !== "Booted") {
              return;
            }
            const selection: IosWorkspaceSelection = {
              device,
              environment: {
                build: text(data, "build"),
                bundleId: text(data, "bundle"),
                deviceType: device.deviceType,
                runtimeVersion: device.runtimeVersion,
              },
              outcomes: [
                {
                  name: text(data, "outcome"),
                  role: text(data, "outcomeRole"),
                },
              ],
              setup: {
                conditions: [
                  {
                    name: text(data, "starting"),
                    role: text(data, "startingRole"),
                  },
                ],
                kind: "restart-app",
              },
            };
            const appPath = text(data, "path");
            send({
              _tag: "start",
              flowName: FlowName.make(text(data, "flow")),
              kind: "teaching",
              operationId: operationId(),
              recordingId: null,
              selection: appPath === "" ? selection : { ...selection, appPath },
            });
          }}
        >
          <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
            <SetupField htmlFor="ios-flow" label="Flow name">
              <Input
                className="font-mono"
                id="ios-flow"
                name="flow"
                required
                spellCheck={false}
              />
            </SetupField>
            <SetupGroup
              description={
                running.length === 0
                  ? "No simulator is running. Start one in Simulator, then refresh."
                  : undefined
              }
              title="Simulator"
            >
              <div className="flex min-w-0 items-end gap-2">
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Label htmlFor="ios-device">Device</Label>
                  <NativeSelect
                    className="w-full min-w-0"
                    id="ios-device"
                    name="device"
                    required
                  >
                    {running.map((device) => (
                      <NativeSelectOption key={device.udid} value={device.udid}>
                        {device.name} · iOS {device.runtimeVersion}
                      </NativeSelectOption>
                    ))}
                    {stopped.length === 0 ? null : (
                      <NativeSelectOptGroup label="Stopped · start in Simulator">
                        {stopped.map((device) => (
                          <NativeSelectOption
                            disabled
                            key={device.udid}
                            value={device.udid}
                          >
                            {device.name} · iOS {device.runtimeVersion}
                          </NativeSelectOption>
                        ))}
                      </NativeSelectOptGroup>
                    )}
                  </NativeSelect>
                </div>
                <Button
                  aria-label="Refresh devices"
                  onClick={refresh}
                  size="icon"
                  title="Refresh devices"
                  type="button"
                  variant="outline"
                >
                  <RefreshCwIcon />
                </Button>
              </div>
            </SetupGroup>
            <SetupGroup title="Target App">
              <SetupField
                help={{
                  id: "ios-app-path-help",
                  text: "Optional. Installing a named build asks for a separate decision.",
                }}
                htmlFor="ios-path"
                label="Simulator app path"
              >
                <Input
                  aria-describedby="ios-app-path-help"
                  className="font-mono text-xs md:text-xs"
                  id="ios-path"
                  name="path"
                  placeholder="/path/to/App.app"
                  spellCheck={false}
                />
              </SetupField>
              <div className="grid min-w-0 gap-3 sm:grid-cols-[1fr_7rem]">
                <SetupField
                  help={{
                    id: "ios-bundle-help",
                    text: "CFBundleIdentifier and CFBundleVersion from the app's Info.plist.",
                  }}
                  htmlFor="ios-bundle"
                  label="Bundle identifier"
                >
                  <Input
                    aria-describedby="ios-bundle-help"
                    className="font-mono"
                    id="ios-bundle"
                    name="bundle"
                    placeholder="com.example.app"
                    required
                    spellCheck={false}
                  />
                </SetupField>
                <SetupField htmlFor="ios-build" label="App build">
                  <Input
                    className="font-mono"
                    id="ios-build"
                    name="build"
                    placeholder="1"
                    required
                  />
                </SetupField>
              </div>
            </SetupGroup>
            <SetupGroup
              description="An element on screen when the app opens, and one that shows the journey worked."
              title="Starting screen"
            >
              <div className="grid min-w-0 gap-2 sm:grid-cols-[8rem_1fr]">
                <SetupField htmlFor="ios-start-role" label="Role">
                  <NativeSelect
                    className="w-full min-w-0"
                    defaultValue="text"
                    aria-label="Starting screen role"
                    id="ios-start-role"
                    name="startingRole"
                  >
                    {ROLE_OPTIONS.map((role) => (
                      <NativeSelectOption key={role} value={role}>
                        {role}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </SetupField>
                <SetupField htmlFor="ios-start" label="Element">
                  <Input
                    aria-label="Starting screen element"
                    id="ios-start"
                    name="starting"
                    placeholder="Sign in"
                    required
                  />
                </SetupField>
                <SetupField htmlFor="ios-done-role" label="Role">
                  <NativeSelect
                    className="w-full min-w-0"
                    defaultValue="text"
                    aria-label="Done when role"
                    id="ios-done-role"
                    name="outcomeRole"
                  >
                    {ROLE_OPTIONS.map((role) => (
                      <NativeSelectOption key={role} value={role}>
                        {role}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </SetupField>
                <SetupField htmlFor="ios-done" label="Element">
                  <Input
                    aria-label="Done when element"
                    id="ios-done"
                    name="outcome"
                    placeholder="Signed in"
                    required
                  />
                </SetupField>
              </div>
            </SetupGroup>
          </div>
          <SheetFooter className="flex-row items-center justify-end gap-2 border-t">
            {complete ? null : (
              <p
                className="text-muted-foreground mr-auto text-xs"
                id="ios-setup-missing"
              >
                {running.length === 0
                  ? "Start a simulator, then refresh."
                  : "Fill in the required fields to continue."}
              </p>
            )}
            <Button onClick={onClose} type="button" variant="outline">
              Cancel
            </Button>
            <Button
              aria-describedby={complete ? undefined : "ios-setup-missing"}
              disabled={pending}
              type="submit"
            >
              Open session
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
};

const DECISION_TITLE = {
  "app-installation": "App installation",
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
    <div className="bg-muted-surface space-y-3 border-b px-3 py-2.5">
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
                ? `Install build ${environment.build} of ${environment.bundleId} on ${session.selection.device.name}?`
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

/**
 * Typing into the picked field. A public field takes text; a secure field
 * only takes a Variable, requested here and entered by name, so a private
 * value never passes through this form.
 */
const IosFieldEntry = ({
  field,
  onDismiss,
  pending,
  send,
  session,
}: {
  readonly field: IosField;
  readonly onDismiss: () => void;
  readonly pending: boolean;
  readonly send: (command: IosWorkspaceCommand) => boolean;
  readonly session: IosWorkspaceSnapshot;
}) => {
  const fields = () => ({ operationId: operationId(), sessionId: session.id });
  const secure = field.password === true || field.role === "secure-text-field";
  const label = field.name || field.role;
  const supplied = (session.variables ?? []).filter(
    (variable) => variable.status === "supplied"
  );
  const header = (title: string) => (
    <RequestHeader
      action={
        <Button
          aria-label="Stop typing"
          onClick={onDismiss}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <XIcon />
        </Button>
      }
      icon={
        secure ? (
          <KeyRoundIcon aria-hidden="true" className={requestIconClassName} />
        ) : (
          <TextCursorInputIcon
            aria-hidden="true"
            className={requestIconClassName}
          />
        )
      }
      title={title}
    />
  );
  if (secure) {
    return (
      <form
        aria-label="Field Variable"
        className="bg-muted-surface space-y-1.5 border-b px-3 py-2.5"
        onSubmit={(event) => {
          event.preventDefault();
          const name = text(new FormData(event.currentTarget), "variable");
          send({
            _tag: "variable-request",
            ...fields(),
            name,
            purpose: `Input for ${field.name}`,
            replace: false,
          });
        }}
      >
        {header(`Enter a Variable into ${label}`)}
        <p className="text-muted-foreground text-xs">
          Secure fields take a named Variable, never typed text.
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          <Input
            aria-label="Variable name"
            className="h-8 w-40 font-mono"
            defaultValue="PASSWORD"
            name="variable"
            required
          />
          <Button disabled={pending} size="sm" type="submit" variant="outline">
            Request Variable
          </Button>
          {supplied.map((variable) => (
            <Button
              disabled={pending}
              key={variable.name}
              onClick={() =>
                send({
                  _tag: "input",
                  ...fields(),
                  action: {
                    _tag: "variable",
                    name: variable.name,
                    target: field.target,
                  },
                  observationId: field.observationId,
                })
              }
              size="sm"
              type="button"
            >
              <KeyRoundIcon />
              Enter {variable.name}
            </Button>
          ))}
        </div>
      </form>
    );
  }
  return (
    <form
      aria-label={`Type into ${field.name}`}
      className="bg-muted-surface space-y-1.5 border-b px-3 py-2.5"
      onSubmit={(event) => {
        event.preventDefault();
        send({
          _tag: "input",
          ...fields(),
          action: {
            _tag: "fill",
            target: field.target,
            text: text(new FormData(event.currentTarget), "text"),
          },
          observationId: field.observationId,
        });
      }}
    >
      {header(`Type into ${label}`)}
      <div className="flex items-center gap-1.5">
        <Input
          aria-label={`Text for ${field.name}`}
          autoFocus
          className="h-8 flex-1"
          name="text"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              onDismiss();
            }
          }}
          placeholder="Public text"
          required
        />
        <Button disabled={pending} size="sm" type="submit">
          <CornerDownLeftIcon />
          Type
        </Button>
      </div>
    </form>
  );
};

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
    case "return-to-target-app": {
      return { _tag: "return-to-target-app", ...fields };
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
    case "start-recording": {
      return <CircleIcon className="fill-current text-red-500" />;
    }
    case "stop-recording": {
      return <SquareIcon className="fill-current" />;
    }
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

const BADGE_VARIANT = {
  default: "secondary",
  failed: "destructive",
  recording: "default",
} as const;

const IosStateBadge = ({
  presentation,
}: {
  readonly presentation: IosDockPresentation;
}) => (
  <Badge variant={BADGE_VARIANT[presentation.tone]}>
    {presentation.tone === "recording" ? (
      <CircleIcon aria-hidden="true" className="fill-current text-red-500" />
    ) : null}
    {presentation.tone === "failed" ? (
      <CircleAlertIcon aria-hidden="true" />
    ) : null}
    {presentation.badge}
  </Badge>
);

const IosSessionSelect = ({
  session,
  sessions,
}: {
  readonly session: IosWorkspaceSnapshot | null;
  readonly sessions: readonly IosWorkspaceSummary[];
}) => (
  <NativeSelect
    aria-label="iOS Agent Session"
    className="max-w-56 min-w-24 flex-1 @md:flex-none"
    onChange={(event) =>
      globalThis.location.assign(`/?ios=${event.currentTarget.value || "new"}`)
    }
    size="sm"
    value={session?.id ?? ""}
  >
    <NativeSelectOption value="">New iOS session</NativeSelectOption>
    {sessions.map((entry) => (
      <NativeSelectOption key={entry.id} value={entry.id}>
        {iosSessionLabel(entry)}
      </NativeSelectOption>
    ))}
  </NativeSelect>
);

/** Recovery a paused iOS session offers outside the dock, kept for callers. */
export const IosRecovery = ({
  refusal,
  pending,
  onRecover,
}: {
  readonly refusal: IosObservationRefusal | null | undefined;
  readonly pending: boolean;
  readonly onRecover: (command: "recover" | "return-to-target-app") => void;
}) => (
  <Button
    disabled={pending}
    onClick={() => onRecover(refusal?.recovery ?? "recover")}
  >
    {refusal?.recovery === "return-to-target-app"
      ? "Return to Target App"
      : "Recover selected simulator"}
  </Button>
);

/** The dock's controls row: navigation first, then the state's own actions. */
const IosDockControls = ({
  commenting,
  elements,
  gesture,
  onComment,
  onNewSession,
  presentation,
  send,
  session,
  sessions,
}: {
  readonly commenting: boolean;
  /** The keyboard's way onto the simulator screen. */
  readonly elements: React.ReactNode;
  readonly gesture: { readonly pending: boolean };
  readonly onComment: () => void;
  readonly onNewSession: () => void;
  readonly presentation: IosDockPresentation;
  readonly send: (command: IosWorkspaceCommand) => boolean;
  readonly session: IosWorkspaceSnapshot;
  readonly sessions: readonly IosWorkspaceSummary[];
}) => {
  const primary = presentation.action;
  return (
    <>
      <DockWordmark />
      <IosSessionSelect session={session} sessions={sessions} />
      <Button
        aria-label="Browser Workspace"
        onClick={() => globalThis.location.assign("/")}
        size="icon-sm"
        title="Browser Workspace"
        variant="ghost"
      >
        <MonitorIcon />
      </Button>
      {elements}
      <DockSpacer />
      {presentation.showsComment ? (
        <Button
          aria-label="Comment"
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
      {isLiveIosSession(session) ? (
        <Button
          disabled={gesture.pending}
          onClick={() =>
            send({
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
          <PowerIcon className="@md:hidden" />
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
          disabled={
            gesture.pending ||
            (primary.gesture === "prepare" &&
              session.preparation.pending.length > 0)
          }
          onClick={() => send(gestureCommand(primary.gesture, session))}
          variant={
            primary.gesture === "stop-recording" ? "destructive" : "default"
          }
        >
          <PrimaryIcon gesture={primary.gesture} />
          {primary.label}
        </Button>
      )}
    </>
  );
};

/**
 * The field the person can type into now: only while they hold a running
 * session (and, when teaching, while recording), never after a refused pick,
 * and not once they dismissed it.
 */
const typingField = (
  session: IosWorkspaceSnapshot,
  pickRefused: boolean,
  dismissedField: string | null
): IosField | null => {
  const canType =
    !pickRefused &&
    session.phase === "running" &&
    session.controller === "user" &&
    (session.kind !== "teaching" || session.captureState?._tag === "recording");
  return canType &&
    session.field !== null &&
    session.field.observationId !== dismissedField
    ? session.field
    : null;
};

const IosDock = ({
  gesture,
  pickRefused,
  onNewSession,
  send,
  session,
}: {
  readonly gesture: {
    readonly pending: boolean;
    readonly error: string | undefined;
  };
  readonly onNewSession: () => void;
  /** The last pick was refused, so no field stays picked. */
  readonly pickRefused: boolean;
  readonly send: (command: IosWorkspaceCommand) => boolean;
  readonly session: IosWorkspaceSnapshot;
}) => {
  const [commentingAtom] = useState(() => Atom.make(false));
  const [commenting, setCommenting] = useAtom(commentingAtom);
  const [submittingAtom] = useState(() => Atom.make(false));
  const [submitting, setSubmitting] = useAtom(submittingAtom);
  useEffect(() => {
    if (!submitting || gesture.pending) {
      return;
    }
    setSubmitting(false);
    if (gesture.error === undefined) {
      setCommenting(false);
    }
  }, [
    gesture.error,
    gesture.pending,
    setCommenting,
    setSubmitting,
    submitting,
  ]);
  const [dismissedAtom] = useState(() => Atom.make<string | null>(null));
  const [dismissedField, setDismissedField] = useAtom(dismissedAtom);
  const listed = useAtomValue(iosSessionsAtom);
  const sessions = AsyncResult.isSuccess(listed) ? listed.value : [];
  const choices = sessions.some((entry) => entry.id === session.id)
    ? sessions
    : [session, ...sessions];
  const presentation = iosDockPresentation(session);
  const recording = session.captureState?._tag === "recording";
  const field = typingField(session, pickRefused, dismissedField);
  return (
    <DockShell
      footer={
        <>
          {gesture.error === undefined ? null : (
            <p
              className="text-destructive border-t px-3 py-1.5 text-xs"
              role="alert"
            >
              {gesture.error}
            </p>
          )}
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
          {field === null ? null : (
            <IosFieldEntry
              field={field}
              key={field.observationId}
              onDismiss={() => setDismissedField(field.observationId)}
              pending={gesture.pending}
              send={send}
              session={session}
            />
          )}
          {commenting && recording ? (
            <form
              aria-label="Comment"
              className="flex items-center gap-1.5 border-b px-3 py-2"
              onSubmit={(event) => {
                event.preventDefault();
                send({
                  _tag: "instruction",
                  operationId: operationId(),
                  sessionId: session.id,
                  text: text(new FormData(event.currentTarget), "instruction"),
                });
                // The composer and its draft stay until the instruction is
                // saved; a refusal leaves them for another try.
                setSubmitting(true);
              }}
            >
              <Input
                aria-label="Instruction"
                autoFocus
                className="h-8 flex-1"
                name="instruction"
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setCommenting(false);
                  }
                }}
                placeholder="Tell the agent what matters on this screen"
                required
              />
              <Button disabled={gesture.pending} size="sm" type="submit">
                Add
              </Button>
            </form>
          ) : null}
        </>
      }
      status={
        <DockStatus badges={<IosStateBadge presentation={presentation} />}>
          {session.error !== null && session.phase !== "paused"
            ? session.error
            : presentation.nextStep}
        </DockStatus>
      }
    >
      <IosDockControls
        commenting={commenting}
        elements={
          <DeviceElements
            disabled={
              gesture.pending ||
              session.phase !== "running" ||
              session.controller !== "user"
            }
            observation={session.observation}
            onPick={({ frame, point }) => {
              if (session.observation !== null) {
                send({
                  _tag: "pick",
                  frame,
                  observationId: session.observation.id,
                  operationId: operationId(),
                  point,
                  sessionId: session.id,
                });
              }
            }}
          />
        }
        gesture={gesture}
        onComment={() => setCommenting(!commenting)}
        onNewSession={onNewSession}
        presentation={presentation}
        send={send}
        session={session}
        sessions={choices}
      />
    </DockShell>
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

export const IosWorkspace = ({
  requestedSessionId,
}: {
  readonly requestedSessionId: string;
}) => {
  const [session, setSession] = useAtom(snapshotAtom);
  const setChrome = useAtomSet(workspaceChromeAtom);
  useEffect(() => {
    setChrome(true);
    return () => setChrome(false);
  }, [setChrome]);
  const enabled = useAtomValue(iosEnabledAtom);
  const gesture = useWorkspaceGesture(commandAtom);
  const [sheet, setSheet] = useState(requestedSessionId === "new");
  const apply = (next: IosWorkspaceSnapshot) =>
    setSession((current) =>
      current?.id === next.id && current.revision > next.revision
        ? current
        : next
    );
  const [lastCommandAtom] = useState(() => Atom.make<string | null>(null));
  const [lastCommand, setLastCommand] = useAtom(lastCommandAtom);
  const send = (command: IosWorkspaceCommand) => {
    setLastCommand(command._tag);
    return gesture.dispatch(
      runIosWorkspaceCommand(command).pipe(
        Effect.tap((next) =>
          Effect.sync(() => {
            apply(next);
            if (command._tag === "start") {
              setSheet(false);
            }
          })
        ),
        Effect.asVoid,
        Effect.mapError(errorMessage)
      )
    );
  };
  useEffect(() => {
    if (!Schema.is(AgentSessionId)(requestedSessionId)) {
      return;
    }
    const fiber = Effect.runFork(
      runIosWorkspaceCommand({
        _tag: "read",
        sessionId: requestedSessionId,
      }).pipe(
        Effect.tap((next) => Effect.sync(() => setSession(next))),
        Effect.ignore
      )
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [requestedSessionId, setSession]);
  const id = session?.id;
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
      <main className="text-muted-foreground grid h-full place-items-center p-6 text-sm">
        <p>iOS Workspace is unlisted.</p>
      </main>
    );
  }
  const setup = (
    <IosSetupSheet
      onClose={() => setSheet(false)}
      open={sheet}
      pending={gesture.pending}
      send={send}
    />
  );
  if (session === null) {
    return (
      <main
        aria-busy={gesture.pending}
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
            <h1 className="text-xl font-semibold tracking-tight">
              No iOS session
            </h1>
            <p className="text-muted-foreground text-sm text-pretty">
              Mirror a running iPhone simulator, then record a journey through
              its Target App.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setSheet(true)} size="lg">
              Open iOS session
            </Button>
            <Button
              onClick={() => globalThis.location.assign("/")}
              size="lg"
              variant="outline"
            >
              Browser Workspace
            </Button>
          </div>
        </section>
        {setup}
      </main>
    );
  }
  const live = isLiveIosSession(session);
  return (
    <WorkspaceLayout
      flowsSession={iosFlowsSessionView(session)}
      sessionId={session.id}
      summary={
        live
          ? null
          : {
              label: "Run Summary",
              summary: (
                <DeviceRunSummary
                  device={`${session.selection.device.name}${session.selection.device.kind === "simulator" ? ` · iOS ${session.selection.device.runtimeVersion}` : ""}`}
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
        className={cn(
          "bg-muted/30 relative flex min-h-0 flex-1 justify-center px-6 pt-6",
          // The dock grows over the stage; the device keeps clear of it.
          "pb-[calc(var(--dock-height,6.5rem)+1.5rem)]"
        )}
      >
        <IosMirror
          onPick={(point, frame) => {
            if (session.observation) {
              send({
                _tag: "pick",
                frame,
                observationId: session.observation.id,
                operationId: operationId(),
                point,
                sessionId: session.id,
              });
            }
          }}
          session={session}
          unavailable={glassText(session)}
        />
        <IosDock
          gesture={gesture}
          pickRefused={lastCommand === "pick" && gesture.error !== undefined}
          onNewSession={() => setSheet(true)}
          send={send}
          session={session}
        />
        {setup}
      </main>
    </WorkspaceLayout>
  );
};
