import { FlowName } from "@contingency/protocol";
import type {
  AndroidDiscoveredApp,
  AndroidDiscoveredDevice,
  AndroidWorkspaceSelection,
  UploadedAndroidApp,
} from "@contingency/protocol";
import { useAtom } from "@effect/atom-react";
import { Effect, Fiber, Option, Schema } from "effect";
import { Atom } from "effect/reactivity";
import {
  CheckIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  SearchIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  bootAndroidEmulator,
  discardTargetAppBuild,
  listAndroidApps,
  listAndroidDevices,
  uploadAndroidApk,
} from "@/lib/rpc";
import { cn } from "@/lib/utils";

import {
  androidDeviceChoice,
  deviceRelease,
  selectable,
  unavailableReason,
} from "./android-setup-state";
import type { DeviceStart } from "./device-choice-state";
import { DeviceChoices, useDeviceStarts } from "./device-choices";
import { NativeOptionalSteps } from "./native-optional-steps";
import {
  BuildPicker,
  InstalledAppsFrame,
  UploadedBuild,
  useBuildUpload,
} from "./target-app-upload";
import type {
  BuildUploadState,
  InstalledAppsNotice,
} from "./target-app-upload";
import { WorkspacePlatformSwitcher } from "./workspace-platform";

/** Roles agent-device reports that a person can name on a screen. */
const ROLES = ["text", "group", "heading", "button", "image"] as const;

type Loaded<Value> =
  | { readonly _tag: "loading" }
  | { readonly _tag: "failed"; readonly message: string }
  | { readonly _tag: "loaded"; readonly value: readonly Value[] };

interface Condition {
  readonly name: string;
  readonly role: string;
}

interface SetupForm {
  readonly app: string | null;
  readonly device: string | null;
  readonly flowName: string;
  readonly privateInput: boolean;
  readonly permissions: Readonly<Record<string, "grant" | "revoke">>;
  readonly outcome: Condition;
  readonly query: string;
  readonly start: Condition;
}

/**
 * The device the sheet sets up: the one the person picked, or, with exactly
 * one ready device, that one, since there is nothing to choose.
 */
const chosenSerial = (
  listed: readonly AndroidDiscoveredDevice[],
  picked: string | null
): string | null => {
  if (picked !== null) {
    return picked;
  }
  const ready = listed.filter((entry) => unavailableReason(entry) === null);
  return ready.length === 1 ? (ready[0]?.serial ?? null) : null;
};

const INITIAL_FORM: SetupForm = {
  app: null,
  device: null,
  flowName: "new-flow",
  outcome: { name: "", role: "text" },
  permissions: {},
  privateInput: false,
  query: "",
  start: { name: "", role: "text" },
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

const Choice = ({
  label,
  value,
  items,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly items: readonly { readonly value: string; readonly label: string }[];
  readonly onChange: (value: string) => void;
}) => (
  <Select
    items={items}
    value={value}
    onValueChange={(next) => {
      if (next !== null) {
        onChange(next);
      }
    }}
  >
    <SelectTrigger aria-label={label} className="w-full">
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      {items.map((item) => (
        <SelectItem key={item.value} value={item.value}>
          {item.label}
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
);

const Step = ({
  children,
  done,
  disabled = false,
  index,
  title,
  waitingFor,
}: {
  readonly children: React.ReactNode;
  readonly done: boolean;
  readonly disabled?: boolean;
  readonly index: number;
  readonly title: string;
  /** What unlocks this step, said while it is disabled. */
  readonly waitingFor?: string;
}) => (
  <fieldset
    aria-label={title}
    disabled={disabled}
    className="min-w-0 space-y-2"
  >
    <h3
      className={cn(
        "flex items-center gap-2 text-sm font-medium",
        disabled && "text-muted-foreground"
      )}
    >
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
    </h3>
    {/*
      An unavailable step keeps its heading and words readable and says what
      unlocks it; only its controls dim, through their own disabled styles.
    */}
    <div className="space-y-2 pl-7">
      {/* A locked step says what unlocks it instead of showing dead inputs. */}
      {disabled && waitingFor !== undefined ? (
        <p className="text-muted-foreground text-xs">{waitingFor}</p>
      ) : (
        children
      )}
    </div>
  </fieldset>
);

const ConditionInput = ({
  label,
  onChange,
  placeholder,
  value,
}: {
  readonly label: string;
  readonly onChange: (value: Condition) => void;
  readonly placeholder: string;
  readonly value: Condition;
}) => (
  // Visible Role and Element captions, as on iOS; each control keeps its
  // full accessible name, which contains the caption.
  <div className="flex gap-1.5">
    <div className="w-28 shrink-0 space-y-1">
      <span aria-hidden="true" className="block text-xs font-medium">
        Role
      </span>
      <Choice
        label={`${label} role`}
        value={value.role}
        items={ROLES.map((role) => ({ label: role, value: role }))}
        onChange={(role) => onChange({ ...value, role })}
      />
    </div>
    <div className="min-w-0 flex-1 space-y-1">
      <span aria-hidden="true" className="block text-xs font-medium">
        Element
      </span>
      <Input
        aria-label={label}
        onChange={(event) =>
          onChange({ ...value, name: event.currentTarget.value })
        }
        placeholder={placeholder}
        value={value.name}
      />
    </div>
  </div>
);

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
  onRefresh,
  onSelect,
  onStart,
  selected,
  starts,
}: {
  readonly devices: Loaded<AndroidDiscoveredDevice>;
  readonly onRefresh: () => void;
  readonly onSelect: (serial: string) => void;
  readonly onStart: (avd: string) => void;
  readonly selected: string | null;
  readonly starts: Readonly<Record<string, DeviceStart>>;
}) => (
  <div className="space-y-2">
    {devices._tag === "loading" ? (
      <p className="text-muted-foreground flex items-center gap-2 text-xs">
        <LoaderCircleIcon
          aria-hidden="true"
          className="size-3.5 animate-spin"
        />
        Asking ADB for devices…
      </p>
    ) : null}
    {devices._tag === "failed" ? (
      <p className="text-destructive text-xs">{devices.message}</p>
    ) : null}
    {devices._tag === "loaded" && devices.value.length === 0 ? (
      <p className="text-muted-foreground text-xs">
        No devices found. Create an emulator in Android Studio.
      </p>
    ) : null}
    {devices._tag === "loaded" && devices.value.length > 0 ? (
      <DeviceChoices
        devices={devices.value.map(androidDeviceChoice)}
        emptyMessage="No emulator is running. Create one in Android Studio, then refresh."
        onSelect={onSelect}
        onStart={onStart}
        selected={selected}
        starts={starts}
      />
    ) : null}
    <Button onClick={onRefresh} size="xs" variant="ghost">
      <RefreshCwIcon />
      Refresh devices
    </Button>
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

const installedAppsNotice = (
  apps: Loaded<AndroidDiscoveredApp>,
  matches: readonly AndroidDiscoveredApp[]
): InstalledAppsNotice | null => {
  if (apps._tag === "loading") {
    return { _tag: "loading" };
  }
  if (apps._tag === "failed") {
    return { _tag: "message", text: apps.message, tone: "destructive" };
  }
  if (matches.length === 0) {
    return {
      _tag: "message",
      text: "No launchable app matches.",
      tone: "muted",
    };
  }
  return null;
};

const InstalledApps = ({
  apps,
  matches,
  onQuery,
  onSelect,
  query,
  selected,
}: {
  readonly apps: Loaded<AndroidDiscoveredApp>;
  readonly matches: readonly AndroidDiscoveredApp[];
  readonly onQuery: (query: string) => void;
  readonly onSelect: (appId: string) => void;
  readonly query: string;
  readonly selected: string | null;
}) => (
  <div className="space-y-1.5">
    <div className="relative">
      <SearchIcon
        aria-hidden="true"
        className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
      />
      <Input
        aria-label="Search installed apps"
        className="pl-8"
        onChange={(event) => onQuery(event.currentTarget.value)}
        placeholder="Apps installed on this device"
        value={query}
      />
    </div>
    <InstalledAppsFrame notice={installedAppsNotice(apps, matches)}>
      {matches.map((app) => (
        <li key={app.package}>
          <button
            aria-pressed={selected === app.package}
            className={cn(
              "hover:bg-muted flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm",
              selected === app.package && "bg-muted"
            )}
            onClick={() => onSelect(app.package)}
            type="button"
          >
            <span className="min-w-0 flex-1 truncate">
              {app.label || app.package}
              {app.label ? (
                <span className="text-muted-foreground ml-2 text-xs">
                  {app.package}
                </span>
              ) : null}
            </span>
            <Badge variant="outline">build {app.versionCode}</Badge>
          </button>
        </li>
      ))}
    </InstalledAppsFrame>
  </div>
);

const AppStep = ({
  apps,
  onQuery,
  onRemoveUpload,
  onSelect,
  onUpload,
  query,
  selected,
  upload,
  uploadState,
}: {
  readonly apps: Loaded<AndroidDiscoveredApp> | null;
  readonly onQuery: (query: string) => void;
  readonly onRemoveUpload: () => void;
  readonly onSelect: (appId: string) => void;
  readonly onUpload: (file: File) => void;
  readonly query: string;
  readonly selected: string | null;
  readonly upload: UploadedAndroidApp | null;
  readonly uploadState: BuildUploadState;
}) => {
  if (apps === null) {
    return (
      <p className="text-muted-foreground text-xs">
        Pick a device to list its apps.
      </p>
    );
  }
  const needle = query.trim().toLowerCase();
  const matches =
    apps._tag === "loaded"
      ? apps.value.filter((app) =>
          `${app.label} ${app.package}`.toLowerCase().includes(needle)
        )
      : [];
  return (
    <div className="space-y-3">
      {upload === null ? (
        <BuildPicker
          accept=".apk,application/vnd.android.package-archive"
          describedBy="android-apk-upload-status"
          directory={false}
          label="Upload an .apk"
          onFiles={(files) => {
            const [first] = files;
            if (first !== undefined && first.file instanceof File) {
              onUpload(first.file);
            }
          }}
          state={uploadState}
        />
      ) : (
        <UploadedApk apps={apps} onRemove={onRemoveUpload} upload={upload} />
      )}
      <InstalledApps
        apps={apps}
        matches={matches}
        onQuery={onQuery}
        onSelect={onSelect}
        query={query}
        selected={upload === null ? selected : null}
      />
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
const DECISIONS = [
  { label: "Ask in app", value: "unchanged" },
  { label: "Grant before start", value: "grant" },
  { label: "Deny before start", value: "revoke" },
];
const AndroidPermissionFields = ({
  value,
  onChange,
}: {
  readonly value: SetupForm["permissions"];
  readonly onChange: (value: SetupForm["permissions"]) => void;
}) => (
  <section aria-label="App permissions" className="space-y-3">
    <p className="text-muted-foreground text-xs">
      Choose only permissions the app requests. Leave the others at Ask in app.
    </p>
    {PERMISSIONS.map(([name, label]) => {
      const permission = `android.permission.${name}`;
      return (
        <div
          key={permission}
          className="grid grid-cols-[1fr_11rem] items-center gap-2 text-xs"
        >
          <span>{label}</span>
          <Choice
            label={`${label} permission`}
            value={value[permission] ?? "unchanged"}
            items={DECISIONS}
            onChange={(decision) => {
              const next = { ...value };
              if (decision === "grant" || decision === "revoke") {
                next[permission] = decision;
              } else {
                onChange(
                  Object.fromEntries(
                    Object.entries(value).filter(([key]) => key !== permission)
                  )
                );
                return;
              }
              onChange(next);
            }}
          />
        </div>
      );
    })}
  </section>
);

/**
 * Where a Teaching session on Android begins: a device the host reports, an
 * app installed on it, and what proves the app is on its starting screen.
 * Nothing touches the device until the session is opened and prepared. The
 * journey may press whatever the person presses while recording, so there is
 * no list of allowed taps to declare.
 */
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
 * What the sheet reads from the host, how it starts a stopped AVD, and how
 * it uploads or discards an `.apk`.
 */
interface AndroidSetupDiscovery {
  readonly apps: typeof listAndroidApps;
  readonly boot: (avd: string) => Effect.Effect<unknown, unknown>;
  readonly devices: Effect.Effect<readonly AndroidDiscoveredDevice[], unknown>;
  readonly discard: typeof discardTargetAppBuild;
  readonly upload: typeof uploadAndroidApk;
}
const androidSetupDiscovery: AndroidSetupDiscovery = {
  apps: listAndroidApps,
  boot: bootAndroidEmulator,
  devices: listAndroidDevices,
  discard: discardTargetAppBuild,
  upload: uploadAndroidApk,
};

/** The Android selection the sheet's choices declare. */
const setupSelection = ({
  app,
  device,
  outcome,
  permissions,
  privateInput,
  release,
  start,
}: {
  readonly app: AndroidDiscoveredApp;
  readonly device: AndroidWorkspaceSelection["device"];
  readonly outcome: Condition;
  readonly permissions: NonNullable<
    AndroidWorkspaceSelection["environment"]["permissions"]
  >;
  readonly privateInput: boolean;
  readonly release: string;
  readonly start: Condition;
}): AndroidWorkspaceSelection => ({
  device,
  environment: {
    androidVersion: release,
    appBuild: app.versionCode,
    appId: app.package,
    permissions,
    startingState:
      start.name === ""
        ? "Restart the Target App"
        : `${start.role} ${start.name} is visible`,
  },
  helperConsent: "auto",
  outcomes: outcome.name === "" ? [] : [outcome],
  privateInput,
  setup: {
    activity: app.launchActivity,
    conditions: start.name === "" ? [] : [start],
    kind: "restart-activity",
  },
});

/** What the sheet still needs, said once beside the disabled submit. */
const setupMissing = ({
  app,
  device,
  validName,
}: {
  readonly app: unknown;
  readonly device: unknown;
  readonly validName: boolean;
}): string => {
  if (!validName) {
    return "Name the Flow to continue.";
  }
  if (device === null) {
    return "Choose a running device to continue.";
  }
  if (app === undefined) {
    return "Choose the Target App to continue.";
  }
  return "Finish the setup above to continue.";
};

/**
 * The uploaded `.apk`, if any. An upload no session claimed is deleted as
 * soon as it is let go of; one a session claimed is the session's to delete.
 */
const useApkUpload = (
  discovery: AndroidSetupDiscovery,
  onUploaded: () => void
) => {
  const [uploadAtom] = useState(() =>
    Atom.make<UploadedAndroidApp | null>(null)
  );
  const [uploaded, setUploaded] = useAtom(uploadAtom);
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
  return { claimed: () => setUploaded(null), letGo, upload, uploaded };
};

const appName = (app: AndroidDiscoveredApp | undefined) =>
  app === undefined ? "the app" : app.label || app.package;
const preparationDescription = (apk: string | undefined) =>
  apk === undefined
    ? "Use the installed Target App without reinstalling it."
    : "Reinstall the selected APK while preserving existing app data and login state.";

interface SetupConfirmation {
  readonly flowName: FlowName;
  readonly selection: AndroidWorkspaceSelection;
  readonly appLabel: string;
  readonly deviceLabel: string;
  readonly fingerprint: string;
}
const PreparationConfirmation = ({
  confirmation,
  open,
  pending,
  fingerprint,
  onCancel,
  onConfirm,
}: {
  readonly confirmation: SetupConfirmation | null;
  readonly open: boolean;
  readonly pending: boolean;
  readonly fingerprint: string;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) => (
  <Dialog
    open={confirmation !== null && open}
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
          {preparationDescription(confirmation?.selection.apkPath)}
          {
            " Reinstall the required Contingency device helper if needed, including replacing a newer helper. Then open the Target App."
          }
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" onClick={() => onCancel()}>
          Cancel
        </Button>
        <Button
          disabled={pending || confirmation?.fingerprint !== fingerprint}
          onClick={onConfirm}
        >
          Confirm preparation
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);

export const AndroidSetupSheet = ({
  discovery = androidSetupDiscovery,
  onOpen,
  onOpenChange,
  open,
  pending,
}: {
  readonly discovery?: AndroidSetupDiscovery;
  /** True when the session start was sent; it then owns any upload. */
  readonly onOpen: (
    flowName: FlowName,
    selection: AndroidWorkspaceSelection
  ) => boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
  readonly pending: boolean;
}) => {
  const [formAtom] = useState(() => Atom.make<SetupForm>(INITIAL_FORM));
  const [form, setForm] = useAtom(formAtom);
  const [refreshAtom] = useState(() => Atom.make(0));
  const [refresh, setRefresh] = useAtom(refreshAtom);
  const devices = useRead(
    open ? discovery.devices : null,
    `${open}-${refresh}`
  );
  const { startDevice, starts } = useDeviceStarts(discovery.boot, () =>
    setRefresh((value) => value + 1)
  );
  const listed = devices._tag === "loaded" ? devices.value : [];
  const chosen = chosenSerial(listed, form.device);
  const discovered = listed.find((entry) => entry.serial === chosen);
  const device = discovered === undefined ? null : selectable(discovered);
  const release = deviceRelease(discovered);
  const loadedApps = useRead(
    device === null ? null : discovery.apps(device),
    device === null ? "none" : `${device.serial}-${refresh}`
  );
  const apps = device === null ? null : loadedApps;
  const { claimed, letGo, upload, uploaded } = useApkUpload(discovery, () =>
    setForm((current) => ({ ...current, app: null, ...CLEARED_CONDITIONS }))
  );
  const app = targetApp(uploaded, apps, form.app);
  const name = form.flowName.trim();
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
  const fingerprint = JSON.stringify([form, uploaded, discovered]);
  return (
    <Sheet
      onOpenChange={(next) => {
        if (!next) {
          setConfirmation(null);
          upload.reset();
          letGo();
        }
        onOpenChange(next);
      }}
      open={open}
    >
      <SheetContent className="w-full data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
        <SheetHeader>
          {/* The sheet covers the Workspace, so it carries the way out. */}
          <WorkspacePlatformSwitcher className="mb-3 self-start" />
          <SheetTitle>New Android session</SheetTitle>
          <SheetDescription>
            Choose a device and app to teach a journey.
          </SheetDescription>
        </SheetHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          id="android-setup"
          onSubmit={(event) => {
            event.preventDefault();
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
        >
          <div className="min-h-0 flex-1 scroll-pb-8 space-y-6 overflow-y-auto px-4 pb-8">
            <label className="grid gap-1.5 text-sm font-medium">
              Flow name
              <Input
                aria-invalid={!validName}
                onChange={(event) => {
                  const { value } = event.currentTarget;
                  setForm((current) => ({ ...current, flowName: value }));
                }}
                value={form.flowName}
              />
            </label>
            <Step done={device !== null} index={1} title="Device">
              <DeviceStep
                devices={devices}
                onRefresh={() => setRefresh((value) => value + 1)}
                onStart={startDevice}
                starts={starts}
                onSelect={(serial) =>
                  setForm((current) => ({
                    ...current,
                    app: null,
                    device: serial,
                    outcome: INITIAL_FORM.outcome,
                    permissions: {},
                    start: INITIAL_FORM.start,
                  }))
                }
                selected={chosen}
              />
            </Step>
            <Step
              disabled={device === null}
              done={app !== undefined}
              index={2}
              title="Target App"
              waitingFor="Choose a device to list its apps."
            >
              <AppStep
                apps={apps}
                onQuery={(query) =>
                  setForm((current) => ({ ...current, query }))
                }
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
                query={form.query}
                selected={form.app}
                upload={uploaded}
                uploadState={upload.state}
              />
            </Step>
            <Step
              disabled={app === undefined}
              // Every choice here has a default, so it is done once open.
              done={app !== undefined}
              index={3}
              title="Permissions and setup"
              waitingFor="Choose the Target App first."
            >
              <AndroidPermissionFields
                value={form.permissions}
                onChange={(decisions) =>
                  setForm((current) => ({ ...current, permissions: decisions }))
                }
              />
              <label className="mt-4 flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={form.privateInput}
                  onChange={(event) => {
                    const { checked } = event.currentTarget;
                    setForm((current) => ({
                      ...current,
                      privateInput: checked,
                    }));
                  }}
                />
                Enable Variables
              </label>
              <p className="text-muted-foreground mt-3 text-xs">
                Preparation installs the supported capture helper on the
                selected emulator, replacing an incompatible helper when needed.
              </p>
            </Step>
            <NativeOptionalSteps>
              <Step
                done={form.start.name.trim() !== ""}
                disabled={app === undefined}
                index={4}
                title="Starting screen"
                waitingFor="Choose the Target App first."
              >
                <div className="space-y-1.5">
                  <p className="text-muted-foreground text-xs">
                    An element that is on screen when {appName(app)} opens.
                    Preparing checks it before you record.
                  </p>
                  <ConditionInput
                    label="Starting screen element"
                    onChange={(value) =>
                      setForm((current) => ({ ...current, start: value }))
                    }
                    placeholder="Sign in"
                    value={form.start}
                  />
                </div>
              </Step>
              <Step
                done={form.outcome.name.trim() !== ""}
                disabled={app === undefined}
                index={5}
                title="Done when"
                waitingFor="Choose the Target App first."
              >
                <div className="space-y-1.5">
                  <p className="text-muted-foreground text-xs">
                    An element that shows the journey worked.
                  </p>
                  <ConditionInput
                    label="Done when element"
                    onChange={(value) =>
                      setForm((current) => ({ ...current, outcome: value }))
                    }
                    placeholder="Order confirmed"
                    value={form.outcome}
                  />
                </div>
              </Step>
            </NativeOptionalSteps>
          </div>
        </form>
        <SheetFooter className="flex-row items-center justify-end gap-3 border-t">
          {ready ? null : (
            <p
              className="text-muted-foreground mr-auto text-xs"
              id="android-setup-missing"
            >
              {setupMissing({ app, device, validName })}
            </p>
          )}
          <Button
            aria-describedby={ready ? undefined : "android-setup-missing"}
            disabled={!ready || pending}
            form="android-setup"
            type="submit"
          >
            Prepare and open app
          </Button>
        </SheetFooter>
      </SheetContent>
      <PreparationConfirmation
        confirmation={confirmation}
        open={open}
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
          if (onOpen(confirmation.flowName, confirmation.selection)) {
            claimed();
          }
          setConfirmation(null);
        }}
      />
    </Sheet>
  );
};
