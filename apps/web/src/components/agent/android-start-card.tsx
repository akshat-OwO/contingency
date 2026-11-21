import {
  applyAndroidDiscoveredAppsEvent,
  describeFlowName,
  FlowName,
  startingDataOf,
} from "@contingency/protocol";
import type {
  AndroidDiscoveredApp,
  AndroidDiscoveredAppsEvent,
  AndroidDiscoveredDevice,
  AndroidWorkspaceSelection,
  StartingData,
  UploadedAndroidApp,
} from "@contingency/protocol";
import { useAtom } from "@effect/atom-react";
import { Effect, Fiber, Option, Schema, Stream } from "effect";
import { Atom } from "effect/reactivity";
import { LoaderCircleIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/segmented-control";
import type { TargetAppBuildUploadError } from "@/lib/rpc";
import { useRpcDependencies } from "@/lib/rpc-dependencies";

import {
  androidDeviceChoice,
  androidDeviceSerial,
  chosenSerial,
  deviceRelease,
  pickedSerial,
  preparationDescription,
  selectable,
  setupMissing,
  setupSelection,
} from "./android-setup-state";
import type {
  AndroidCondition,
  AndroidDevicePick,
} from "./android-setup-state";
import type { DeviceStart } from "./device-choice-state";
import {
  DeviceChoices,
  RefreshDevicesButton,
  useDeviceStarts,
} from "./device-choices";
import { useDeviceErase } from "./device-erase";
import type { DeviceEraseControls } from "./device-erase-state";
import { ConditionInput, Part } from "./native-setup-fields";
import { StartingDataField } from "./native-starting-data";
import {
  FlowNameField,
  StartCard,
  StartSection,
  StartSetup,
} from "./start-card";
import {
  BuildDropzone,
  InstalledAppPicker,
  UploadedBuild,
  useBuildUpload,
} from "./target-app-upload";
import type { BuildUploadState, InstalledAppsRead } from "./target-app-upload";
import type { HomePlatform } from "./workspace-home-state";

type Loaded<Value> =
  | { readonly _tag: "loading" }
  | { readonly _tag: "failed"; readonly message: string }
  | { readonly _tag: "loaded"; readonly value: readonly Value[] };

interface SetupForm {
  readonly app: string | null;
  readonly device: AndroidDevicePick | null;
  readonly privateInput: boolean;
  readonly permissions: Readonly<Record<string, "grant" | "revoke">>;
  readonly outcome: AndroidCondition;
  readonly start: AndroidCondition;
  readonly startingData: StartingData;
}

const INITIAL_FORM: SetupForm = {
  app: null,
  device: null,
  outcome: { name: "", role: "text" },
  permissions: {},
  privateInput: false,
  start: { name: "", role: "text" },
  startingData: "keep",
};

/** A new Target App starts its conditions and permissions over. */
const CLEARED_CONDITIONS = {
  outcome: INITIAL_FORM.outcome,
  permissions: {},
  start: INITIAL_FORM.start,
} as const;

const failure = (cause: unknown) =>
  Schema.decodeUnknownOption(Schema.Struct({ message: Schema.String }))(
    cause
  ).pipe(
    Option.map((value) => value.message),
    Option.getOrElse(() => "The host did not answer.")
  );

/** Streams launchable apps and merges progressive metadata updates in place. */
const useReadApps = (
  stream: Stream.Stream<AndroidDiscoveredAppsEvent, unknown> | null,
  key: string
) => {
  const [resultAtom] = useState(() =>
    Atom.make<Loaded<AndroidDiscoveredApp>>({ _tag: "loading" })
  );
  const [result, setResult] = useAtom(resultAtom);
  useEffect(() => {
    if (stream === null) {
      return;
    }
    setResult({ _tag: "loading" });
    const fiber = Effect.runFork(
      stream.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() =>
            setResult((current) => ({
              _tag: "loaded",
              value: applyAndroidDiscoveredAppsEvent(
                current._tag === "loaded" ? current.value : [],
                event
              ),
            }))
          )
        ),
        Effect.tapError((cause) =>
          Effect.sync(() =>
            setResult({ _tag: "failed", message: failure(cause) })
          )
        ),
        Effect.ignore
      )
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
    // The key names the stream; the stream value is rebuilt every render.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [key, setResult]);
  return result;
};

/** Runs a read once per key and keeps its latest answer. */
const useRead = <Value,>(
  read: Effect.Effect<readonly Value[], unknown> | null,
  key: string
) => {
  const [resultAtom] = useState(() =>
    Atom.make<Loaded<Value>>({ _tag: "loading" })
  );
  const [result, setResult] = useAtom(resultAtom);
  useEffect(() => {
    if (read === null) {
      return;
    }
    setResult({ _tag: "loading" });
    const fiber = Effect.runFork(
      read.pipe(
        Effect.match({
          onFailure: (cause) => ({
            _tag: "failed" as const,
            message: failure(cause),
          }),
          onSuccess: (value) => ({ _tag: "loaded" as const, value }),
        }),
        Effect.tap((next) => Effect.sync(() => setResult(next)))
      )
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
    // The key names the read; the effect value is rebuilt every render.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [key, setResult]);
  return result;
};

const DeviceStep = ({
  devices,
  erase,
  onRefresh,
  onSelect,
  onStart,
  selected,
  starts,
}: {
  readonly devices: Loaded<AndroidDiscoveredDevice>;
  readonly erase: DeviceEraseControls;
  readonly onRefresh: () => void;
  readonly onSelect: (serial: string) => void;
  readonly onStart: (avd: string) => void;
  readonly selected: string | null;
  readonly starts: Readonly<Record<string, DeviceStart>>;
}) =>
  devices._tag === "loaded" && devices.value.length > 0 ? (
    <DeviceChoices
      devices={devices.value.map(androidDeviceChoice)}
      emptyMessage="No emulator is running. Create one in Android Studio, then refresh."
      erase={erase}
      identify={androidDeviceSerial}
      label="Device"
      onRefresh={onRefresh}
      onSelect={onSelect}
      onStart={onStart}
      selected={selected}
      starts={starts}
    />
  ) : (
    <div className="flex min-h-7 items-center justify-between gap-3">
      {devices._tag === "loading" ? (
        <p className="text-muted-foreground flex items-center gap-2 text-xs">
          <LoaderCircleIcon
            aria-hidden="true"
            className="size-3.5 animate-spin motion-reduce:animate-none"
          />
          Asking ADB for devices…
        </p>
      ) : null}
      {devices._tag === "failed" ? (
        <p className="text-destructive text-xs">{devices.message}</p>
      ) : null}
      {devices._tag === "loaded" ? (
        <p className="text-muted-foreground text-xs">
          No devices found. Create an emulator in Android Studio.
        </p>
      ) : null}
      <RefreshDevicesButton onRefresh={onRefresh} />
    </div>
  );

/** The uploaded `.apk`, and whether installing it replaces a build. */
const UploadedApk = ({
  apps,
  onRemove,
  upload,
}: {
  readonly apps: Loaded<AndroidDiscoveredApp> | null;
  readonly onRemove: () => void;
  readonly upload: UploadedAndroidApp;
}) => {
  const installed =
    apps?._tag === "loaded"
      ? apps.value.find((entry) => entry.package === upload.app.package)
      : undefined;
  return (
    <UploadedBuild
      detail={`${upload.app.package} · build ${upload.app.versionCode} · ${
        installed === undefined
          ? "installs with your consent"
          : `replaces build ${installed.versionCode} with your consent`
      }`}
      name={upload.name}
      onRemove={onRemove}
      title={upload.app.label || upload.name}
    />
  );
};

/** The device's apps as the Target App picker lists them. */
const installedApps = (
  apps: Loaded<AndroidDiscoveredApp> | null
): InstalledAppsRead => {
  if (apps === null) {
    return { _tag: "idle" };
  }
  if (apps._tag !== "loaded") {
    return apps;
  }
  return {
    _tag: "loaded",
    apps: apps.value.map((app) => ({
      detail: `${app.package} · build ${app.versionCode}`,
      id: app.package,
      label: app.label || app.package,
    })),
  };
};

/**
 * Section 2: an installed app from the chosen device, or an uploaded `.apk`.
 * Uploading needs no device, so the `.apk` is offered before one is chosen.
 */
const AppStep = ({
  apps,
  onRemoveUpload,
  onSelect,
  onUpload,
  selected,
  upload,
  uploadState,
}: {
  readonly apps: Loaded<AndroidDiscoveredApp> | null;
  readonly onRemoveUpload: () => void;
  readonly onSelect: (appId: string) => void;
  readonly onUpload: (file: File) => void;
  readonly selected: string | null;
  readonly upload: UploadedAndroidApp | null;
  readonly uploadState: BuildUploadState;
}) => {
  const ids = useId();
  return (
    <div className="grid min-w-0 grid-cols-1 gap-2.5">
      <InstalledAppPicker
        apps={installedApps(apps)}
        emptyMessage="No launchable app matches."
        idleMessage="Choose a device to list its apps."
        onSelect={onSelect}
        selected={upload === null ? selected : null}
      />
      <div
        aria-hidden="true"
        className="text-muted-foreground before:bg-island-border after:bg-island-border flex items-center gap-3 text-xs before:h-px before:flex-1 after:h-px after:flex-1"
      >
        or
      </div>
      {upload === null ? (
        <BuildDropzone
          accept=".apk,application/vnd.android.package-archive"
          describedBy={`${ids}-apk-status`}
          label="Upload an .apk"
          onFiles={([first]) => {
            if (first !== undefined) {
              onUpload(first.file);
            }
          }}
          state={uploadState}
        />
      ) : (
        <UploadedApk apps={apps} onRemove={onRemoveUpload} upload={upload} />
      )}
    </div>
  );
};

const PERMISSIONS = [
  ["POST_NOTIFICATIONS", "Notifications"],
  ["CAMERA", "Camera"],
  ["RECORD_AUDIO", "Microphone"],
  ["ACCESS_FINE_LOCATION", "Precise location"],
  ["ACCESS_COARSE_LOCATION", "Approximate location"],
  ["READ_CONTACTS", "Contacts"],
  ["READ_CALENDAR", "Calendar"],
  ["READ_MEDIA_IMAGES", "Photos"],
  ["READ_MEDIA_VIDEO", "Videos"],
  ["BLUETOOTH_CONNECT", "Nearby devices"],
] as const;
/**
 * Each decision's segment, short on screen. Its accessible name keeps the
 * whole decision and the permission, so every segment is unique on the card.
 */
const DECISIONS = [
  { label: "Ask", long: "Ask in app", value: "unchanged" },
  { label: "Grant", long: "Grant before start", value: "grant" },
  { label: "Deny", long: "Deny before start", value: "revoke" },
] as const;
const AndroidPermissionFields = ({
  value,
  onChange,
}: {
  readonly value: SetupForm["permissions"];
  readonly onChange: (value: SetupForm["permissions"]) => void;
}) => (
  <Part
    description="Choose only permissions the app requests. Leave the others at Ask."
    title="App permissions"
  >
    <div className="grid gap-1.5">
      {PERMISSIONS.map(([name, label]) => {
        const permission = `android.permission.${name}`;
        return (
          <div
            className="flex items-center justify-between gap-3 text-[13px]"
            key={permission}
          >
            <span aria-hidden="true">{label}</span>
            <SegmentedControl
              aria-label={`${label} permission`}
              onValueChange={(decision) => {
                if (decision === "grant" || decision === "revoke") {
                  onChange({ ...value, [permission]: decision });
                  return;
                }
                onChange(
                  Object.fromEntries(
                    Object.entries(value).filter(([key]) => key !== permission)
                  )
                );
              }}
              value={value[permission] ?? "unchanged"}
            >
              {DECISIONS.map((decision) => (
                <SegmentedControlItem
                  aria-label={`${label}: ${decision.long}`}
                  key={decision.value}
                  value={decision.value}
                >
                  {decision.label}
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
          </div>
        );
      })}
    </div>
  </Part>
);

const selectedApp = (
  apps: Loaded<AndroidDiscoveredApp> | null,
  id: string | null
) =>
  apps?._tag === "loaded"
    ? apps.value.find((entry) => entry.package === id)
    : undefined;

/** The uploaded build, if any, else the installed app picked from the list. */
const targetApp = (
  uploaded: UploadedAndroidApp | null,
  apps: Loaded<AndroidDiscoveredApp> | null,
  id: string | null
) => (uploaded === null ? selectedApp(apps, id) : uploaded.app);

/**
 * What the card reads from the host, how it starts a stopped AVD, and how
 * it uploads or discards an `.apk`.
 */
export interface AndroidSetupDiscovery {
  readonly apps: (
    device: AndroidWorkspaceSelection["device"]
  ) => Stream.Stream<AndroidDiscoveredAppsEvent, unknown>;
  readonly boot: (avd: string) => Effect.Effect<unknown, unknown>;
  readonly devices: Effect.Effect<readonly AndroidDiscoveredDevice[], unknown>;
  readonly discard: (id: string) => Effect.Effect<unknown>;
  readonly upload: (
    file: File
  ) => Effect.Effect<UploadedAndroidApp, TargetAppBuildUploadError>;
}

const useAndroidSetupDiscovery = (): AndroidSetupDiscovery => {
  const rpc = useRpcDependencies();
  return {
    apps: rpc.listAndroidApps,
    boot: rpc.bootAndroidEmulator,
    devices: rpc.listAndroidDevices,
    discard: rpc.discardTargetAppBuild,
    upload: rpc.uploadAndroidApk,
  };
};

/**
 * The uploaded `.apk`, if any. An upload no session claimed is deleted as
 * soon as it is let go of, including when the card closes; one a session
 * claimed is the session's to delete.
 */
const useApkUpload = (
  discovery: AndroidSetupDiscovery,
  onUploaded: () => void
) => {
  const [uploadAtom] = useState(() =>
    Atom.make<UploadedAndroidApp | null>(null)
  );
  const [uploaded, setUploaded] = useAtom(uploadAtom);
  // What closing the card lets go of, read when it unmounts.
  const latest = useRef({ discard: discovery.discard, uploaded });
  useEffect(() => {
    latest.current = { discard: discovery.discard, uploaded };
  });
  useEffect(
    () => () => {
      const held = latest.current;
      if (held.uploaded !== null) {
        Effect.runFork(held.discard(held.uploaded.id));
      }
    },
    []
  );
  const letGo = () => {
    if (uploaded !== null) {
      Effect.runFork(discovery.discard(uploaded.id));
    }
    setUploaded(null);
  };
  const upload = useBuildUpload(discovery.upload, (next) => {
    letGo();
    setUploaded(next);
    onUploaded();
  });
  const claimed = () => {
    latest.current = { ...latest.current, uploaded: null };
    setUploaded(null);
  };
  return { claimed, letGo, upload, uploaded };
};

const appName = (app: AndroidDiscoveredApp | undefined) =>
  app === undefined ? "the app" : app.label || app.package;

interface SetupConfirmation {
  readonly flowName: FlowName;
  readonly selection: AndroidWorkspaceSelection;
  readonly appLabel: string;
  readonly deviceLabel: string;
  readonly fingerprint: string;
}
const PreparationConfirmation = ({
  confirmation,
  pending,
  fingerprint,
  onCancel,
  onConfirm,
}: {
  readonly confirmation: SetupConfirmation | null;
  readonly pending: boolean;
  readonly fingerprint: string;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) => (
  <Dialog
    open={confirmation !== null}
    onOpenChange={(next) => {
      if (!next) {
        onCancel();
      }
    }}
  >
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Prepare and open app?</DialogTitle>
        <DialogDescription>
          Prepare {confirmation?.appLabel} on {confirmation?.deviceLabel}.{" "}
          {preparationDescription(
            confirmation?.selection.apkPath,
            startingDataOf(confirmation?.selection.setup ?? {}),
            confirmation?.appLabel ?? "the app"
          )}
          {
            " Reinstall the required Contingency device helper if needed, including replacing a newer helper. Then open the Target App."
          }
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button size="md" variant="outline" onClick={() => onCancel()}>
          Cancel
        </Button>
        <Button
          size="md"
          variant="primary"
          disabled={pending || confirmation?.fingerprint !== fingerprint}
          onClick={onConfirm}
        >
          Confirm preparation
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);

/** Section 3: what preparation applies before Teaching and every Run. */
const AndroidSetupChoices = ({
  app,
  form,
  setForm,
}: {
  readonly app: AndroidDiscoveredApp | undefined;
  readonly form: SetupForm;
  readonly setForm: (update: (current: SetupForm) => SetupForm) => void;
}) => (
  <fieldset className="grid min-w-0 gap-5" disabled={app === undefined}>
    {app === undefined ? (
      <p className="text-muted-foreground text-xs">
        Choose the Target App first.
      </p>
    ) : null}
    <StartingDataField
      name="android-starting-data"
      onChange={(startingData) =>
        setForm((current) => ({ ...current, startingData }))
      }
      value={form.startingData}
    />
    <AndroidPermissionFields
      value={form.permissions}
      onChange={(decisions) =>
        setForm((current) => ({ ...current, permissions: decisions }))
      }
    />
    <label className="flex items-center gap-2 text-[13px] font-medium">
      <input
        checked={form.privateInput}
        className="accent-foreground size-4"
        onChange={(event) => {
          const { checked } = event.currentTarget;
          setForm((current) => ({ ...current, privateInput: checked }));
        }}
        type="checkbox"
      />
      Enable Variables
    </label>
    <Part
      description={`An element that is on screen when ${appName(app)} opens. Preparing checks it before you record. Leave it empty for the agent to choose from the Teaching Recording.`}
      title="Starting screen"
    >
      <ConditionInput
        label="Starting screen element"
        onChange={(value) =>
          setForm((current) => ({ ...current, start: value }))
        }
        placeholder="Sign in"
        value={form.start}
      />
    </Part>
    <Part
      description="An element that shows the journey worked. Leave it empty for the agent to choose."
      title="Done when"
    >
      <ConditionInput
        label="Done when element"
        onChange={(value) =>
          setForm((current) => ({ ...current, outcome: value }))
        }
        placeholder="Order confirmed"
        value={form.outcome}
      />
    </Part>
    <p className="text-muted-foreground text-xs">
      Preparation installs the supported capture helper on the selected
      emulator, replacing an incompatible helper when needed.
    </p>
  </fieldset>
);

/**
 * The Android start card on the Workspace home: 1 the Flow name and a device
 * the host reports, 2 the Target App, installed or uploaded as an `.apk`, and
 * 3 Setup, with app permissions, Starting Data, Variables and the optional
 * Starting screen and Done when. Start teaching first asks to prepare and open
 * the app; nothing touches the device until that is confirmed. The journey
 * may press whatever the person presses while recording, so there is no list
 * of allowed taps to declare.
 */
export const AndroidStartCard = ({
  discovery: given,
  error,
  flowName,
  onClose,
  onFlowNameChange,
  onOtherPlatform,
  onStart,
  pending,
  platforms,
}: {
  /** Replaces the host reads, for tests. */
  readonly discovery?: AndroidSetupDiscovery;
  readonly error: string | undefined;
  readonly flowName: string;
  readonly onClose: () => void;
  readonly onFlowNameChange: (name: string) => void;
  readonly onOtherPlatform: (platform: HomePlatform) => void;
  /** True when the session start was sent; it then owns any upload. */
  readonly onStart: (
    flowName: FlowName,
    selection: AndroidWorkspaceSelection,
    form: HTMLFormElement | null
  ) => boolean;
  readonly pending: boolean;
  readonly platforms: readonly HomePlatform[];
}) => {
  const ids = useId();
  const host = useAndroidSetupDiscovery();
  const discovery = given ?? host;
  const formRef = useRef<HTMLFormElement>(null);
  const [formAtom] = useState(() => Atom.make<SetupForm>(INITIAL_FORM));
  const [form, setForm] = useAtom(formAtom);
  const [refreshAtom] = useState(() => Atom.make(0));
  const [refresh, setRefresh] = useAtom(refreshAtom);
  const devices = useRead(discovery.devices, String(refresh));
  const { startDevice, starts } = useDeviceStarts(discovery.boot, () =>
    setRefresh((value) => value + 1)
  );
  const erase = useDeviceErase("android", true, String(refresh), () =>
    setRefresh((value) => value + 1)
  );
  const listed = devices._tag === "loaded" ? devices.value : [];
  const picked = pickedSerial(listed, form.device);
  const chosen = picked === "missing" ? null : chosenSerial(listed, picked);
  const discovered = listed.find((entry) => entry.serial === chosen);
  const device = discovered === undefined ? null : selectable(discovered);
  const release = deviceRelease(discovered);
  const loadedApps = useReadApps(
    device === null ? null : discovery.apps(device),
    device === null ? "none" : `${device.serial}-${refresh}`
  );
  const apps = device === null ? null : loadedApps;
  const { claimed, letGo, upload, uploaded } = useApkUpload(discovery, () =>
    setForm((current) => ({ ...current, app: null, ...CLEARED_CONDITIONS }))
  );
  const app = targetApp(uploaded, apps, form.app);
  const name = flowName.trim();
  const validName = Schema.is(FlowName)(name);
  const start = { name: form.start.name.trim(), role: form.start.role };
  const outcome = { name: form.outcome.name.trim(), role: form.outcome.role };
  const permissions = Object.entries(form.permissions).map(
    ([permission, decision]) => ({ decision, permission })
  );
  const ready = device !== null && app !== undefined && validName;
  const [confirmationAtom] = useState(() =>
    Atom.make<SetupConfirmation | null>(null)
  );
  const [confirmation, setConfirmation] = useAtom(confirmationAtom);
  const submitted = useRef(false);
  const fingerprint = JSON.stringify([name, form, uploaded, discovered]);
  const missingId = `${ids}-missing`;
  return (
    <StartCard
      error={error}
      footer={
        <>
          {ready ? null : (
            <p
              className="text-muted-foreground mt-1.5 text-center text-xs"
              id={missingId}
            >
              {setupMissing({ app, device, validName })}
            </p>
          )}
          {pending ? (
            <p
              className="text-muted-foreground mt-1.5 flex items-center justify-center gap-2 text-center text-xs"
              role="status"
            >
              <LoaderCircleIcon
                aria-hidden="true"
                className="size-3.5 animate-spin motion-reduce:animate-none"
              />
              Preparing your app: installing and launching it on the device.
              This can take up to a minute.
            </p>
          ) : null}
        </>
      }
      formRef={formRef}
      onClose={onClose}
      onOtherPlatform={onOtherPlatform}
      onSubmit={() => {
        if (!ready) {
          return;
        }
        const selection = setupSelection({
          app,
          device,
          outcome,
          permissions,
          privateInput: form.privateInput,
          release,
          start,
          startingData: form.startingData,
        });
        submitted.current = false;
        setConfirmation({
          appLabel: appName(app),
          deviceLabel: discovered?.avd ?? device.serial,
          fingerprint,
          flowName: name,
          selection:
            uploaded === null
              ? selection
              : { ...selection, apkPath: uploaded.apkPath },
        });
      }}
      outside={
        <>
          {erase.dialog}
          <PreparationConfirmation
            confirmation={confirmation}
            pending={pending}
            fingerprint={fingerprint}
            onCancel={() => setConfirmation(null)}
            onConfirm={() => {
              if (
                confirmation === null ||
                submitted.current ||
                pending ||
                confirmation.fingerprint !== fingerprint
              ) {
                return;
              }
              submitted.current = true;
              if (
                onStart(
                  confirmation.flowName,
                  confirmation.selection,
                  formRef.current
                )
              ) {
                claimed();
              }
              setConfirmation(null);
            }}
          />
        </>
      }
      platform="android"
      platforms={platforms}
      submitDescribedBy={ready ? undefined : missingId}
      submitDisabled={!ready || pending}
    >
      <StartSection label="Flow" number={1}>
        <FlowNameField
          name={flowName}
          onChange={onFlowNameChange}
          problem={describeFlowName(name)}
        />
        <Part title="Device">
          <DeviceStep
            devices={devices}
            erase={erase.controls}
            onRefresh={() => setRefresh((value) => value + 1)}
            onStart={startDevice}
            starts={starts}
            onSelect={(serial) =>
              setForm((current) => ({
                ...current,
                app: null,
                device: {
                  avd:
                    listed.find((entry) => entry.serial === serial)?.avd ??
                    null,
                  serial,
                },
                ...CLEARED_CONDITIONS,
              }))
            }
            selected={chosen}
          />
        </Part>
      </StartSection>

      <StartSection label="Target App" number={2}>
        <AppStep
          apps={apps}
          onRemoveUpload={() => {
            letGo();
            setForm((current) => ({ ...current, ...CLEARED_CONDITIONS }));
          }}
          onSelect={(appId) => {
            letGo();
            setForm((current) => ({
              ...current,
              app: appId,
              ...CLEARED_CONDITIONS,
            }));
          }}
          onUpload={(file) => upload.start(file, file.name)}
          selected={form.app}
          upload={uploaded}
          uploadState={upload.state}
        />
      </StartSection>

      <StartSetup summary="Starting data, permissions, start and finish">
        <AndroidSetupChoices app={app} form={form} setForm={setForm} />
      </StartSetup>
    </StartCard>
  );
};
