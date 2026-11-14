/* oxlint-disable eslint/no-await-in-loop -- Decode each transport packet in order and release its reader on cancellation. */
import { AgentSessionId, FlowName, OperationId } from "@contingency/protocol";
import type {
  IosDeviceSelection,
  IosInstalledApp,
  IosWorkspaceCommand,
  IosObservationRefusal,
  IosWorkspaceSnapshot,
  IosWorkspaceSelection,
  IosWorkspaceSummary,
  NativeInput,
  UploadedIosApp,
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
  CircleIcon,
  CornerDownLeftIcon,
  KeyRoundIcon,
  LoaderCircleIcon,
  MessageSquareTextIcon,
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
import { Badge } from "@/components/ui/badge";
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
import { decodeBase64 } from "@/lib/base64";
import { isSessionNotFound } from "@/lib/failure-message";
import {
  bootIosSimulator,
  discardTargetAppBuild,
  iosDevicesAtom,
  iosSessionsAtom,
  iosEnabledAtom,
  iosStreamAccess,
  listIosApps,
  iosWorkspaceForwardMutation,
  runIosWorkspaceCommand,
  uploadIosApp,
} from "@/lib/rpc";
import type { AppBundleFile } from "@/lib/rpc";
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
import { appInstallationQuestion } from "./app-installation";
import { DeviceChoices, useDeviceStarts } from "./device-choices";
import { DeviceElements } from "./device-elements";
import {
  makeFirstResponseProbe,
  probeNativeInput,
} from "./first-response-probe";
import {
  iosDockPresentation,
  iosFlowsSessionView,
  iosSessionLabel,
  isLiveIosSession,
} from "./ios-dock-state";
import type { IosDockGesture, IosDockPresentation } from "./ios-dock-state";
import { chosenSimulator, iosDeviceChoice } from "./ios-setup-state";
import { makeNativeInputHandlers, makeNativeInputQueue } from "./native-input";
import { NativeOptionalSteps } from "./native-optional-steps";
import {
  BuildPicker,
  UploadedBuild,
  useBuildUpload,
} from "./target-app-upload";
import type { BuildUploadState } from "./target-app-upload";
import {
  DockNotice,
  DockShell,
  DockSpacer,
  DockState,
  DockStatus,
  DockWordmark,
} from "./workspace-dock";
import { useWorkspaceGesture } from "./workspace-gesture";
import {
  WorkspacePlatformBar,
  WorkspacePlatformSwitcher,
} from "./workspace-platform";
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
const text = (data: FormData, key: string) => String(data.get(key) ?? "");
/** A refusal's sentence; its leading code is for agents, not people. */
const errorMessage = (cause: unknown) =>
  Schema.is(Schema.Struct({ message: Schema.String }))(cause)
    ? cause.message.replace(/^[a-z][a-z0-9_]*:\s*/u, "")
    : "The iOS session is unavailable.";

const IosMirror = ({
  session,
  onInput,
  unavailable,
}: {
  readonly session: IosWorkspaceSnapshot;
  readonly unavailable: string;
  /** Forwards the user's input to the simulator. */
  readonly onInput: (input: NativeInput) => void;
}) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [probe] = useState(() =>
    makeFirstResponseProbe("ios", () => canvas.current)
  );
  const [transport, setTransport] = useState("connecting");
  const [frame, setFrame] = useState(DEFAULT_IOS_FRAME);
  const live = session.phase === "running" || session.phase === "paused";
  useEffect(() => {
    if (!live) {
      return;
    }
    // Decodes off the main thread and resizes the canvas only when the
    // frame size changes, since a resize clears and reallocates it.
    const drawIosFrame = async (value: IosStreamFrame, signal: AbortSignal) => {
      const bytes = decodeBase64(value.data);
      const bitmap = await createImageBitmap(
        new Blob([bytes], { type: "image/jpeg" })
      );
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
              let pending = "";
              try {
                while (!signal.aborted) {
                  const chunk = await reader.read();
                  if (chunk.done) {
                    break;
                  }
                  pending += decoder.decode(chunk.value, { stream: true });
                  // Only the newest complete frame is drawn: an older one
                  // that arrived in the same read would only add delay.
                  let newest: IosStreamFrame | undefined;
                  let lost = false;
                  let newline = pending.indexOf("\n");
                  while (newline !== -1) {
                    const value: unknown = JSON.parse(
                      pending.slice(0, newline)
                    );
                    pending = pending.slice(newline + 1);
                    if (isIosStreamFrame(value)) {
                      newest = value;
                    } else {
                      lost = true;
                    }
                    newline = pending.indexOf("\n");
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
  }, [probe, session.id, session.phase, live]);
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
  return (
    <div className="relative flex h-full min-h-0 w-full min-w-0 items-center justify-center gap-5">
      <div aria-hidden="true" className="hidden w-56 shrink-0 lg:block" />
      <div className="h-full min-h-0 min-w-0 flex-1 lg:flex-none lg:basis-[min(100%,28rem)]">
        <DeviceFrame frame={frame}>
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

const MISSING_WORDS = new Map([
  ["Device", "a simulator"],
  ["Done when element", "the done-when element"],
  ["Flow name", "a Flow name"],
  ["Starting screen element", "the starting-screen element"],
  ["Target App", "the Target App"],
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

/** The Target App: an uploaded simulator build, or an installed app. */
type IosTarget =
  | { readonly _tag: "installed"; readonly app: IosInstalledApp }
  | { readonly _tag: "uploaded"; readonly upload: UploadedIosApp };

/** The bundle identifier and build the Target App carries. */
const targetIdentity = (target: IosTarget) =>
  target._tag === "installed" ? target.app : target.upload;

// An upload no session claimed is deleted as soon as it is let go of.
const releaseUpload = (target: IosTarget | null) => {
  if (target?._tag === "uploaded") {
    Effect.runFork(discardTargetAppBuild(target.upload.id));
  }
};

type InstalledApps =
  | { readonly _tag: "idle" }
  | { readonly _tag: "loading" }
  | { readonly _tag: "failed"; readonly message: string }
  | { readonly _tag: "loaded"; readonly apps: readonly IosInstalledApp[] };

/** The apps on the chosen simulator, read again when it or refresh changes. */
const useInstalledIosApps = (
  device: IosDeviceSelection | undefined,
  refresh: number
) => {
  const [stateAtom] = useState(() =>
    Atom.make<InstalledApps>({ _tag: "idle" })
  );
  const [state, setState] = useAtom(stateAtom);
  const key = device === undefined ? null : `${device.udid}-${refresh}`;
  useEffect(() => {
    if (device === undefined) {
      setState({ _tag: "idle" });
      return;
    }
    setState({ _tag: "loading" });
    const fiber = Effect.runFork(
      listIosApps(device).pipe(
        Effect.match({
          onFailure: (cause) =>
            setState({ _tag: "failed", message: errorMessage(cause) }),
          onSuccess: (apps) => setState({ _tag: "loaded", apps }),
        })
      )
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
    // The key names the read; the device object is rebuilt every render.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [key, setState]);
  return state;
};

/**
 * The Target App group: upload a simulator `.app` folder, or pick an app
 * already on the simulator. The sheet reads the bundle identifier and build
 * from the app itself, so neither is typed.
 */
const IosTargetApp = ({
  apps,
  done,
  onRemoveUpload,
  onSelect,
  onUpload,
  target,
  upload,
}: {
  readonly apps: InstalledApps;
  readonly done: boolean;
  readonly onRemoveUpload: () => void;
  readonly onSelect: (app: IosInstalledApp) => void;
  readonly onUpload: (files: readonly AppBundleFile[], name: string) => void;
  readonly target: IosTarget | null;
  readonly upload: BuildUploadState;
}) => (
  <SetupGroup done={done} index={2} title="Target App">
    {target?._tag === "uploaded" ? (
      <UploadedBuild
        detail={`${target.upload.bundleId} · build ${target.upload.build} · installs with your consent`}
        name={target.upload.name}
        onRemove={onRemoveUpload}
        title={target.upload.label || target.upload.name}
      />
    ) : (
      <BuildPicker
        describedBy="ios-app-upload-status"
        directory
        label="Upload a simulator .app"
        onFiles={onUpload}
        state={upload}
      />
    )}
    <div className="space-y-1.5">
      <p className="text-muted-foreground text-xs">
        Or pick an app already on this simulator.
      </p>
      {apps._tag === "idle" ? (
        <p className="text-muted-foreground text-xs">
          Pick a running simulator to list its apps.
        </p>
      ) : null}
      {apps._tag === "loading" ? (
        <p className="text-muted-foreground flex items-center gap-2 text-xs">
          <LoaderCircleIcon
            aria-hidden="true"
            className="size-3.5 animate-spin"
          />
          Reading installed apps…
        </p>
      ) : null}
      {apps._tag === "failed" ? (
        <p className="text-destructive text-xs">{apps.message}</p>
      ) : null}
      {apps._tag === "loaded" ? (
        <ul
          aria-label="Installed apps"
          className="max-h-44 overflow-y-auto rounded-lg border"
        >
          {apps.apps.length === 0 ? (
            <li className="text-muted-foreground px-2.5 py-2 text-xs">
              No apps are installed on this simulator yet.
            </li>
          ) : null}
          {apps.apps.map((app) => {
            const selected =
              target?._tag === "installed" &&
              target.app.bundleId === app.bundleId;
            return (
              <li key={app.bundleId}>
                <button
                  aria-pressed={selected}
                  className={cn(
                    "hover:bg-muted flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm",
                    selected && "bg-muted"
                  )}
                  onClick={() => onSelect(app)}
                  type="button"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {app.label || app.bundleId}
                    {app.label === app.bundleId ? null : (
                      <span className="text-muted-foreground ml-2 text-xs">
                        {app.bundleId}
                      </span>
                    )}
                  </span>
                  <Badge variant="outline">build {app.build}</Badge>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
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
  const formRef = useRef<HTMLFormElement>(null);
  const simulator = running.find((entry) => entry.udid === chosen);
  const [refreshAtom] = useState(() => Atom.make(0));
  const [appsRefresh, setAppsRefresh] = useAtom(refreshAtom);
  const apps = useInstalledIosApps(simulator, appsRefresh);
  const [targetAtom] = useState(() => Atom.make<IosTarget | null>(null));
  const [target, setTarget] = useAtom(targetAtom);
  // The device and Target App are chosen, not typed, so the form cannot
  // see them missing.
  const missing = [
    ...(chosen === null ? ["Device"] : []),
    ...fieldsMissing,
    ...(target === null ? ["Target App"] : []),
  ];
  const complete = missing.length === 0;
  const choose = (next: IosTarget | null) => {
    releaseUpload(target);
    setTarget(next);
  };
  const upload = useBuildUpload(uploadIosApp, (uploaded) =>
    choose({ _tag: "uploaded", upload: uploaded })
  );
  const close = () => {
    upload.reset();
    releaseUpload(target);
    setTarget(null);
    onClose();
  };
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
          close();
        }
      }}
      open={open}
    >
      <SheetContent
        aria-label="New iOS session"
        className="w-full data-[side=right]:w-full data-[side=right]:sm:max-w-xl"
      >
        <SheetHeader className="border-b">
          {/* The sheet covers the Workspace, so it carries the way out. */}
          <WorkspacePlatformSwitcher className="mb-3 self-start" />
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
            if (!found || found.state !== "Booted" || target === null) {
              return;
            }
            const { state: _state, ...device } = found;
            const { build, bundleId } = targetIdentity(target);
            const selection: IosWorkspaceSelection = {
              device,
              environment: {
                build,
                bundleId,
                deviceType: device.deviceType,
                runtimeVersion: device.runtimeVersion,
              },
              outcomes:
                text(data, "outcome") === ""
                  ? []
                  : [
                      {
                        name: text(data, "outcome"),
                        role: text(data, "outcomeRole"),
                      },
                    ],
              setup: {
                conditions:
                  text(data, "starting") === ""
                    ? []
                    : [
                        {
                          name: text(data, "starting"),
                          role: text(data, "startingRole"),
                        },
                      ],
                kind: "restart-app",
              },
            };
            const uploaded =
              target?._tag === "uploaded" ? target.upload : undefined;
            const sent = send({
              _tag: "start",
              flowName: FlowName.make(text(data, "flow")),
              kind: "teaching",
              operationId: operationId(),
              recordingId: null,
              selection:
                uploaded === undefined
                  ? selection
                  : { ...selection, appPath: uploaded.appPath },
            });
            if (sent) {
              // The session now owns the upload and deletes it when it ends.
              setTarget(null);
            }
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
                  onSelect={(udid) => {
                    setPicked(udid);
                    // An installed app belongs to the simulator it is on.
                    if (target?._tag === "installed") {
                      setTarget(null);
                    }
                  }}
                  onStart={startDevice}
                  selected={chosen}
                  starts={starts}
                />
                <Button
                  onClick={() => {
                    refresh();
                    setAppsRefresh((value) => value + 1);
                  }}
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
              apps={apps}
              done={target !== null}
              onRemoveUpload={() => choose(null)}
              onSelect={(app) => choose({ _tag: "installed", app })}
              onUpload={(files, name) => upload.start(files, name)}
              target={target}
              upload={upload.state}
            />
            <NativeOptionalSteps>
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
                    />
                  </SetupField>
                </div>
              </SetupGroup>
            </NativeOptionalSteps>
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
            <Button onClick={close} type="button" variant="outline">
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
                ? appInstallationQuestion({
                    app: environment.bundleId,
                    build: environment.build,
                    device: session.selection.device.name,
                    installedBuild: decision.installedBuild,
                  })
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
  onSelect,
  session,
  sessions,
}: {
  readonly onSelect: (session: string) => void;
  readonly session: IosWorkspaceSnapshot | null;
  readonly sessions: readonly IosWorkspaceSummary[];
}) => (
  <NativeSelect
    aria-label="iOS Agent Session"
    className="max-w-56 min-w-28 flex-1 @max-md:max-w-none @max-md:basis-full @md:max-w-72 @md:flex-initial @4xl:max-w-96"
    onChange={(event) =>
      onSelect(event.currentTarget.value || NEW_NATIVE_SESSION)
    }
    size="sm"
    value={session?.id ?? ""}
  >
    <NativeSelectOption value="">New iOS session</NativeSelectOption>
    {/* The shown ended session names itself, but is no longer a choice. */}
    {session === null ||
    sessions.some((entry) => entry.id === session.id) ? null : (
      <NativeSelectOption disabled value={session.id}>
        Ended session
      </NativeSelectOption>
    )}
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
  onSelectSession,
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
  readonly onSelectSession: (session: string) => void;
  readonly presentation: IosDockPresentation;
  readonly send: (command: IosWorkspaceCommand) => boolean;
  readonly session: IosWorkspaceSnapshot;
  readonly sessions: readonly IosWorkspaceSummary[];
}) => {
  const primary = presentation.action;
  return (
    <>
      <DockWordmark />
      <IosSessionSelect
        onSelect={onSelectSession}
        session={session}
        sessions={sessions}
      />
      {/* Hidden while capturing, as the browser dock does. */}
      {showsFlowsEntry(iosFlowsSessionView(session)) ? (
        <FlowsDockButton />
      ) : null}
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
  gesture,
  inputRefusal,
  onInput,
  onNewSession,
  onSelectSession,
  send,
  session,
}: {
  readonly gesture: {
    readonly pending: boolean;
    readonly error: string | undefined;
  };
  /** Why the last Forwarded Input sent nothing, if it was refused. */
  readonly inputRefusal: string | null;
  readonly onInput: (input: NativeInput) => void;
  readonly onNewSession: () => void;
  readonly onSelectSession: (session: string) => void;
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
  // A just-started session may not be listed yet; an ended one is no choice.
  const choices =
    sessions.some((entry) => entry.id === session.id) ||
    !isLiveIosSession(session)
      ? sessions
      : [session, ...sessions];
  const presentation = iosDockPresentation(session);
  const recording = session.captureState?._tag === "recording";
  const field = typingField(session, dismissedField);
  return (
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
            onActivate={(inputs) => {
              for (const input of inputs) {
                onInput(input);
              }
            }}
          />
        }
        gesture={gesture}
        onComment={() => setCommenting(!commenting)}
        onNewSession={onNewSession}
        onSelectSession={onSelectSession}
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
  onSessionChange,
  requestedSessionId,
}: {
  /** Shows another session, or `new`, by naming it in the route. */
  readonly onSessionChange: (session: string) => void;
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
  // Which session the route names, read when a command settles.
  const routeRef = useRef(requestedSessionId);
  useEffect(() => {
    routeRef.current = requestedSessionId;
  }, [requestedSessionId]);
  const send = (command: IosWorkspaceCommand) => {
    const route = routeRef.current;
    return gesture.dispatch(
      runIosWorkspaceCommand(command).pipe(
        Effect.tap((next) =>
          Effect.sync(() => {
            // The route moved on while this ran: it no longer shows the result.
            if (routeRef.current !== route && routeRef.current !== next.id) {
              return;
            }
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
  // `new` asks for an empty Workspace and the setup sheet, whatever was
  // shown before; an id reads that session.
  useEffect(() => {
    if (requestedSessionId === NEW_NATIVE_SESSION) {
      setSession(null);
      setUnavailable(false);
      setSheet(true);
      return;
    }
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
        <WorkspacePlatformBar />
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
            <Button onClick={() => setSheet(true)} size="lg">
              Open iOS session
            </Button>
          </div>
        </section>
        <WorkspacePlatformBar />
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
          // The platform switcher floats above the device, the dock below it.
          "bg-muted/30 relative flex min-h-0 flex-1 justify-center px-6 pt-14",
          "pb-[calc(var(--dock-height,6.5rem)+1.5rem)]"
        )}
      >
        <WorkspacePlatformBar />
        <IosMirror
          onInput={onInput}
          session={session}
          unavailable={glassText(session)}
        />
        <IosDock
          gesture={gesture}
          inputRefusal={inputRefusal}
          onInput={onInput}
          onNewSession={() => setSheet(true)}
          onSelectSession={onSessionChange}
          send={send}
          session={session}
        />
        {setup}
      </main>
    </WorkspaceLayout>
  );
};
