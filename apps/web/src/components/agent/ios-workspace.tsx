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
import { Effect, Fiber, Result, Schema } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import {
  CheckIcon,
  CircleIcon,
  CircleSlashIcon,
  CornerDownLeftIcon,
  KeyRoundIcon,
  MessageSquareTextIcon,
  MonitorIcon,
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
import { FlowsDockButton } from "@/components/catalog/flows-dock-button";
import { showsFlowsEntry } from "@/components/catalog/flows-drawer-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
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
  bootIosSimulator,
  iosDevicesAtom,
  iosSessionsAtom,
  iosEnabledAtom,
  inspectIosApp,
  iosStreamAccess,
  runIosWorkspaceCommand,
} from "@/lib/rpc";
import { cn } from "@/lib/utils";

import { workspaceChromeAtom } from "./agent-workspace-state";
import { DeviceFrame, DeviceUnavailable } from "./android-device";
import { AndroidVariables } from "./android-dock";
import { DeviceLastScreen, DeviceRunSummary } from "./android-run-summary";
import { WorkspaceLayout } from "./android-workspace-layout";
import {
  deviceCleanupKey,
  deviceSummaryLabel,
} from "./android-workspace-state";
import { DeviceChoices, useDeviceStarts } from "./device-choices";
import { DeviceElements } from "./device-elements";
import {
  iosDockPresentation,
  iosFlowsSessionView,
  iosSessionLabel,
  isLiveIosSession,
} from "./ios-dock-state";
import type { IosDockGesture, IosDockPresentation } from "./ios-dock-state";
import { chosenSimulator, iosDeviceChoice } from "./ios-setup-state";
import {
  DockShell,
  DockSpacer,
  DockState,
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
    return (
      <DeviceLastScreen
        cleanup={deviceCleanupKey(session.cleanup)}
        fallback={<DeviceUnavailable message={unavailable} />}
        platform="ios"
        sessionId={session.id}
      />
    );
  }
  return (
    <div className="relative flex h-full min-h-0 w-full min-w-0 items-center justify-center gap-5">
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

/**
 * One numbered step of the setup sheet, read the same way as Android's: its
 * number turns into a check once its required fields are filled.
 */
const SetupGroup = ({
  children,
  description,
  done,
  index,
  title,
}: {
  readonly children: React.ReactNode;
  readonly description?: string | undefined;
  readonly done: boolean;
  readonly index: number;
  readonly title: string;
}) => (
  <fieldset className="min-w-0 space-y-3">
    <div className="space-y-0.5">
      <legend className="flex items-center gap-2 text-sm font-medium">
        <span
          aria-hidden="true"
          className={cn(
            "grid size-5 place-items-center rounded-full border text-xs tabular-nums",
            done && "bg-primary text-primary-foreground border-primary"
          )}
        >
          {done ? <CheckIcon className="size-3" /> : index}
        </span>
        {title}
      </legend>
      {description === undefined ? null : (
        <p className="text-muted-foreground pl-7 text-xs text-pretty">
          {description}
        </p>
      )}
    </div>
    <div className="space-y-3 pl-7">{children}</div>
  </fieldset>
);

const SetupField = ({
  children,
  help,
  htmlFor,
  label,
}: {
  readonly children: React.ReactNode;
  readonly help?: { readonly id: string; readonly text: string } | undefined;
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

type IdentityState =
  | { readonly _tag: "idle" }
  | { readonly _tag: "reading" }
  | { readonly _tag: "read"; readonly label: string }
  | { readonly _tag: "failed"; readonly message: string };

/**
 * Reads a `.app`'s bundle id and build when its path is entered, and fills
 * the fields the person has not typed into themselves.
 */
const MISSING_WORDS = new Map([
  ["App build", "the app build"],
  ["Bundle identifier", "the bundle identifier"],
  ["Device", "a simulator"],
  ["Done when element", "the done-when element"],
  ["Flow name", "a Flow name"],
  ["Starting screen element", "the starting-screen element"],
]);

/** The missing fields as one plain phrase: "a Flow name and a simulator". */
const missingPhrase = (missing: readonly string[]) => {
  const words = missing.map((label) => MISSING_WORDS.get(label) ?? label);
  return words.length < 2
    ? words.join("")
    : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
};

/** The labels of the form's required fields that are still invalid. */
const missingFields = (form: HTMLFormElement | null): readonly string[] =>
  form === null
    ? []
    : [...form.elements].flatMap((element) =>
        (element instanceof HTMLInputElement ||
          element instanceof HTMLSelectElement) &&
        !element.validity.valid
          ? [
              element.getAttribute("aria-label") ??
                (element.labels?.[0]?.textContent?.trim() || element.name),
            ]
          : []
      );

/**
 * Scrolls a path field to its end. A long path's start is a folder; the .app
 * name at its end is what identifies it. The browser returns an unfocused
 * field to its start as focus leaves, so the scroll waits a frame.
 */
const restOnAppName = (field: HTMLInputElement) => {
  field.title = field.value;
  requestAnimationFrame(() => {
    field.scrollLeft = field.scrollWidth;
  });
};

const useAppIdentity = (
  form: React.RefObject<HTMLFormElement | null>,
  onFilled: () => void
) => {
  const [stateAtom] = useState(() =>
    Atom.make<IdentityState>({ _tag: "idle" })
  );
  const [state, setState] = useAtom(stateAtom);
  // Only the latest path's read may fill the form: a new read, or clearing
  // the path, interrupts the one before it.
  const reading = useRef<Fiber.Fiber<unknown> | null>(null);
  useEffect(
    () => () => {
      if (reading.current !== null) {
        Effect.runFork(Fiber.interrupt(reading.current));
      }
    },
    []
  );
  const read = (value: string) => {
    const appPath = value.trim();
    if (reading.current !== null) {
      Effect.runFork(Fiber.interrupt(reading.current));
      reading.current = null;
    }
    if (appPath === "") {
      setState({ _tag: "idle" });
      return;
    }
    setState({ _tag: "reading" });
    reading.current = Effect.runFork(
      inspectIosApp(appPath).pipe(
        Effect.result,
        Effect.tap((result) =>
          Effect.sync(() => {
            if (Result.isFailure(result)) {
              setState({
                _tag: "failed",
                message: errorMessage(result.failure),
              });
              return;
            }
            const app = result.success;
            // However the path was set, it rests on the .app name.
            const pathField = form.current?.elements.namedItem("path");
            if (pathField instanceof HTMLInputElement) {
              restOnAppName(pathField);
            }
            for (const [name, filled] of [
              ["bundle", app.bundleId],
              ["build", app.build],
            ] as const) {
              const field = form.current?.elements.namedItem(name);
              // A value the person typed is theirs; only an empty or
              // previously filled field takes the app's own.
              if (
                field instanceof HTMLInputElement &&
                (field.value === "" || field.dataset.filled === "true")
              ) {
                field.value = filled;
                field.dataset.filled = "true";
              }
            }
            setState({
              _tag: "read",
              label: `${appPath.split("/").at(-1) ?? appPath} (${app.label}) · ${app.bundleId} · build ${app.build}`,
            });
            onFilled();
          })
        )
      )
    );
  };
  return { read, state };
};

/** The Target App group: a built `.app` to read, then its identity. */
const IosTargetApp = ({
  done,
  identity,
}: {
  readonly done: boolean;
  readonly identity: ReturnType<typeof useAppIdentity>;
}) => (
  <SetupGroup done={done} index={2} title="Target App">
    <SetupField
      help={{
        id: "ios-app-path-help",
        text: "Optional. Installing a named build asks for a separate decision.",
      }}
      htmlFor="ios-path"
      label="Simulator app path"
    >
      <Input
        aria-describedby="ios-app-path-help ios-app-identity"
        className="font-mono text-xs md:text-xs"
        id="ios-path"
        name="path"
        onBlur={(event) => {
          const field = event.currentTarget;
          restOnAppName(field);
          identity.read(field.value);
        }}
        placeholder="/path/to/App.app"
        spellCheck={false}
      />
    </SetupField>
    <p
      aria-live="polite"
      className={cn(
        "text-xs text-pretty empty:hidden",
        identity.state._tag === "failed"
          ? "text-destructive"
          : "text-muted-foreground"
      )}
      id="ios-app-identity"
    >
      {identity.state._tag === "reading" ? "Reading Info.plist…" : null}
      {identity.state._tag === "read"
        ? `Read from Info.plist: ${identity.state.label}. Edit the fields below to override.`
        : null}
      {identity.state._tag === "failed" ? identity.state.message : null}
    </p>
    <div className="grid min-w-0 gap-3 sm:grid-cols-[1fr_7rem]">
      <SetupField
        // Once the app's own Info.plist was read, the line above says so.
        help={
          identity.state._tag === "read"
            ? undefined
            : {
                id: "ios-bundle-help",
                text: "Without an app path, enter CFBundleIdentifier and CFBundleVersion from the installed app's Info.plist.",
              }
        }
        htmlFor="ios-bundle"
        label="Bundle identifier"
      >
        <Input
          aria-describedby={
            identity.state._tag === "read" ? undefined : "ios-bundle-help"
          }
          className="font-mono"
          id="ios-bundle"
          name="bundle"
          onInput={(event) => {
            // Typed by the person now; a later read leaves it be.
            delete event.currentTarget.dataset.filled;
          }}
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
          onInput={(event) => {
            // Typed by the person now; a later read leaves it be.
            delete event.currentTarget.dataset.filled;
          }}
          placeholder="1"
          required
        />
      </SetupField>
    </div>
  </SetupGroup>
);

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
  const [pickedAtom] = useState(() => Atom.make<string | null>(null));
  const [picked, setPicked] = useAtom(pickedAtom);
  const chosen = chosenSimulator(listed, picked);
  const { startDevice, starts } = useDeviceStarts(bootIosSimulator, refresh);
  // The required fields still empty, named as the person sees them.
  const [missingAtom] = useState(() =>
    Atom.make<readonly string[]>(["Flow name"])
  );
  const [fieldsMissing, setMissing] = useAtom(missingAtom);
  const missing =
    chosen === null ? ["Device", ...fieldsMissing] : fieldsMissing;
  const complete = missing.length === 0;
  const formRef = useRef<HTMLFormElement>(null);
  const identity = useAppIdentity(formRef, () =>
    setMissing(missingFields(formRef.current))
  );
  // The sheet's form mounts once it opens; read what it still needs then.
  useEffect(() => {
    if (!open) {
      return;
    }
    const frame = requestAnimationFrame(() =>
      setMissing(missingFields(formRef.current))
    );
    return () => cancelAnimationFrame(frame);
  }, [open, setMissing]);
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
          onInput={(event) => setMissing(missingFields(event.currentTarget))}
          ref={formRef}
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const found = listed.find((entry) => entry.udid === chosen);
            if (!found || found.state !== "Booted") {
              return;
            }
            const { state: _state, ...device } = found;
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
              done={!missing.includes("Device")}
              index={1}
              title="Simulator"
            >
              <div className="space-y-2">
                <DeviceChoices
                  devices={listed.map(iosDeviceChoice)}
                  emptyMessage="No iPhone simulator on iOS 26 through 27 exists. Add one in Xcode, then refresh."
                  onSelect={setPicked}
                  onStart={startDevice}
                  selected={chosen}
                  starts={starts}
                />
                <Button
                  onClick={refresh}
                  size="xs"
                  type="button"
                  variant="ghost"
                >
                  <RefreshCwIcon />
                  Refresh devices
                </Button>
              </div>
            </SetupGroup>
            <IosTargetApp
              done={
                !missing.includes("Bundle identifier") &&
                !missing.includes("App build")
              }
              identity={identity}
            />
            <SetupGroup
              description="An element on screen when the app opens."
              done={!missing.includes("Starting screen element")}
              index={3}
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
              </div>
            </SetupGroup>
            <SetupGroup
              description="An element that shows the journey worked."
              done={!missing.includes("Done when element")}
              index={4}
              title="Done when"
            >
              <div className="grid min-w-0 gap-2 sm:grid-cols-[8rem_1fr]">
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
                  ? "Start a simulator to continue."
                  : `Add ${missingPhrase(missing)} to continue.`}
              </p>
            )}
            <Button onClick={onClose} type="button" variant="outline">
              Cancel
            </Button>
            <Button
              aria-describedby={complete ? undefined : "ios-setup-missing"}
              // As on Android: the footer names what is missing, and the
              // button waits for it.
              disabled={pending || !complete}
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
export const IosFieldEntry = ({
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
  readonly session: Pick<IosWorkspaceSnapshot, "id" | "variables">;
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
  const variableForm = (
    <form
      aria-label="Field Variable"
      className={cn(
        "bg-muted-surface space-y-1.5 border-b px-3 py-2.5",
        !secure && "pt-0"
      )}
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
      {secure ? (
        <>
          {header(`Enter a Variable into ${label}`)}
          <p className="text-muted-foreground text-xs">
            Secure fields take a named Variable, never typed text.
          </p>
        </>
      ) : (
        <p className="text-muted-foreground text-xs">
          Or enter a named Variable, for a value that changes between runs.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <Input
          aria-label="Variable name"
          className="h-8 w-40 font-mono"
          defaultValue={secure ? "PASSWORD" : ""}
          name="variable"
          placeholder="NAME"
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
  if (secure) {
    return variableForm;
  }
  // An ordinary field takes public text, or a named Variable as before.
  return (
    <>
      <form
        aria-label={`Type into ${field.name}`}
        className="bg-muted-surface space-y-1.5 px-3 pt-2.5 pb-2"
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
      {variableForm}
    </>
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

const IosStateBadge = ({
  presentation,
}: {
  readonly presentation: IosDockPresentation;
}) => <DockState tone={presentation.tone}>{presentation.badge}</DockState>;

const IosSessionSelect = ({
  session,
  sessions,
}: {
  readonly session: IosWorkspaceSnapshot | null;
  readonly sessions: readonly IosWorkspaceSummary[];
}) => (
  <NativeSelect
    aria-label="iOS Agent Session"
    className="max-w-56 min-w-28 flex-1 @max-md:max-w-none @max-md:basis-full @md:max-w-72 @md:flex-initial @4xl:max-w-96"
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
      {/* Hidden while capturing, as the browser dock does. */}
      {showsFlowsEntry(iosFlowsSessionView(session)) ? (
        <FlowsDockButton />
      ) : null}
      <Button
        aria-label="Browser Workspace"
        onClick={() => globalThis.location.assign("/")}
        size="icon-sm"
        title="Browser Workspace"
        variant="ghost"
      >
        <MonitorIcon />
      </Button>
      {/* An ended session has no screen to reach. */}
      {isLiveIosSession(session) ? elements : null}
      <DockSpacer />
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
              label: deviceSummaryLabel(session.kind),
              summary: (
                <DeviceRunSummary
                  platform="ios"
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
