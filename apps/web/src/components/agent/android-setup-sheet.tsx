import { FlowSkillName } from "@contingency/protocol";
import type {
  AndroidDiscoveredApp,
  AndroidDiscoveredDevice,
  AndroidWorkspaceSelection,
} from "@contingency/protocol";
import { useAtom } from "@effect/atom-react";
import { Effect, Fiber, Option, Schema } from "effect";
import { Atom } from "effect/reactivity";
import {
  CheckIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  SearchIcon,
  SmartphoneIcon,
  TabletSmartphoneIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { listAndroidApps, listAndroidDevices } from "@/lib/rpc";
import { cn } from "@/lib/utils";

import {
  deviceRelease,
  selectable,
  unavailableReason,
} from "./android-setup-state";

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
  readonly flowSkillName: string;
  readonly privateInput: boolean;
  readonly permissions: Readonly<Record<string, "grant" | "revoke">>;
  readonly outcome: Condition;
  readonly query: string;
  readonly start: Condition;
}

const INITIAL_FORM: SetupForm = {
  app: null,
  device: null,
  flowSkillName: "new-flow",
  outcome: { name: "", role: "text" },
  permissions: {},
  privateInput: false,
  query: "",
  start: { name: "", role: "text" },
};

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
}: {
  readonly children: React.ReactNode;
  readonly done: boolean;
  readonly disabled?: boolean;
  readonly index: number;
  readonly title: string;
}) => (
  <fieldset
    aria-label={title}
    disabled={disabled}
    className={cn("min-w-0 space-y-2", disabled && "opacity-40")}
  >
    <h3 className="flex items-center gap-2 text-sm font-medium">
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
    <div className="pl-7">{children}</div>
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
  <div className="flex gap-1.5">
    <div className="w-28 shrink-0">
      <Choice
        label={`${label} role`}
        value={value.role}
        items={ROLES.map((role) => ({ label: role, value: role }))}
        onChange={(role) => onChange({ ...value, role })}
      />
    </div>
    <Input
      aria-label={label}
      onChange={(event) =>
        onChange({ ...value, name: event.currentTarget.value })
      }
      placeholder={placeholder}
      value={value.name}
    />
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
  selected,
}: {
  readonly devices: Loaded<AndroidDiscoveredDevice>;
  readonly onRefresh: () => void;
  readonly onSelect: (serial: string) => void;
  readonly selected: string | null;
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
        No devices found. Create an emulator in Android Studio or connect a
        phone with USB debugging on.
      </p>
    ) : null}
    {devices._tag === "loaded" && devices.value.length > 0 ? (
      <div className="grid grid-cols-2 gap-2">
        {devices.value.map((device) => {
          const reason = unavailableReason(device);
          const Icon =
            device.kind === "physical" ? TabletSmartphoneIcon : SmartphoneIcon;
          return (
            <button
              aria-pressed={selected === device.serial}
              className={cn(
                "hover:bg-muted/50 rounded-lg border p-2.5 text-left transition-[background-color,box-shadow] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent",
                selected === device.serial &&
                  "border-primary ring-primary/20 ring-2"
              )}
              disabled={reason !== null}
              key={device.serial}
              onClick={() => onSelect(device.serial)}
              type="button"
            >
              <span className="mb-1 flex items-center justify-between">
                <Icon aria-hidden="true" className="size-4" />
                <Badge variant="outline">
                  {device.kind === "physical" ? "Phone" : "Emulator"}
                </Badge>
              </span>
              <span className="block truncate text-sm font-medium">
                {device.kind === "physical"
                  ? (device.model ?? device.serial)
                  : (device.avd ?? device.serial)}
              </span>
              <span className="text-muted-foreground block text-xs">
                {reason ?? `${device.serial} · API ${device.api}`}
              </span>
            </button>
          );
        })}
      </div>
    ) : null}
    <Button onClick={onRefresh} size="xs" variant="ghost">
      <RefreshCwIcon />
      Refresh devices
    </Button>
  </div>
);

const AppStep = ({
  apps,
  onQuery,
  onSelect,
  query,
  selected,
}: {
  readonly apps: Loaded<AndroidDiscoveredApp> | null;
  readonly onQuery: (query: string) => void;
  readonly onSelect: (appId: string) => void;
  readonly query: string;
  readonly selected: string | null;
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
          {matches.length === 0 ? (
            <li className="text-muted-foreground px-2.5 py-2 text-xs">
              No launchable app matches.
            </li>
          ) : null}
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
        </ul>
      ) : null}
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

const androidSetupDiscovery = {
  apps: listAndroidApps,
  devices: listAndroidDevices,
};

export const AndroidSetupSheet = ({
  discovery = androidSetupDiscovery,
  onOpen,
  onOpenChange,
  open,
  pending,
}: {
  readonly discovery?: typeof androidSetupDiscovery;
  readonly onOpen: (
    flowSkillName: FlowSkillName,
    selection: AndroidWorkspaceSelection
  ) => void;
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
  const discovered =
    devices._tag === "loaded"
      ? devices.value.find((entry) => entry.serial === form.device)
      : undefined;
  const device = discovered === undefined ? null : selectable(discovered);
  const release = deviceRelease(discovered);
  const loadedApps = useRead(
    device === null ? null : discovery.apps(device),
    device === null ? "none" : `${device.serial}-${refresh}`
  );
  const apps = device === null ? null : loadedApps;
  const app = selectedApp(apps, form.app);
  const name = form.flowSkillName.trim();
  const validName = Schema.is(FlowSkillName)(name);
  const start = { name: form.start.name.trim(), role: form.start.role };
  const outcome = { name: form.outcome.name.trim(), role: form.outcome.role };
  const permissions = Object.entries(form.permissions).map(
    ([permission, decision]) => ({ decision, permission })
  );
  const conditionsReady = start.name !== "" && outcome.name !== "";
  const privateHelperConsent = form.privateInput ? "auto" : "none";
  const ready =
    device !== null && app !== undefined && conditionsReady && validName;
  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent className="w-full data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>New Android session</SheetTitle>
          <SheetDescription>
            Choose a device and app, then define where recording starts and
            ends.
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
            onOpen(name, {
              device,
              environment: {
                androidVersion: release,
                appBuild: app.versionCode,
                appId: app.package,
                permissions,
                startingState: `${start.role} ${start.name} is visible`,
              },
              helperConsent: "auto",
              outcomes: [outcome],
              privateHelperConsent,
              privateInput: form.privateInput,
              setup: {
                activity: app.launchActivity,
                conditions: [start],
                kind:
                  device.kind === "physical"
                    ? "clear-app-data"
                    : "restart-activity",
              },
            });
          }}
        >
          <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 pb-4">
            <label className="grid gap-1.5 text-sm font-medium">
              Flow skill name
              <Input
                aria-invalid={!validName}
                onChange={(event) => {
                  const { value } = event.currentTarget;
                  setForm((current) => ({ ...current, flowSkillName: value }));
                }}
                value={form.flowSkillName}
              />
            </label>
            <Step done={device !== null} index={1} title="Device">
              <DeviceStep
                devices={devices}
                onRefresh={() => setRefresh((value) => value + 1)}
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
                selected={form.device}
              />
              {device?.kind === "physical" ? (
                <p className="text-muted-foreground mt-2 text-xs">
                  Preparing asks before it clears the Target App's data on this
                  phone. Nothing else on it changes.
                </p>
              ) : null}
            </Step>
            <Step
              disabled={device === null}
              done={app !== undefined}
              index={2}
              title="Target App"
            >
              <AppStep
                apps={apps}
                onQuery={(query) =>
                  setForm((current) => ({ ...current, query }))
                }
                onSelect={(appId) =>
                  setForm((current) => ({
                    ...current,
                    app: appId,
                    outcome: INITIAL_FORM.outcome,
                    permissions: {},
                    start: INITIAL_FORM.start,
                  }))
                }
                query={form.query}
                selected={form.app}
              />
            </Step>
            <Step
              done={conditionsReady}
              disabled={app === undefined}
              index={3}
              title="Starting screen"
            >
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <p className="text-muted-foreground text-xs">
                    An element that is on screen when{" "}
                    {app === undefined ? "the app" : app.label || app.package}{" "}
                    opens. Preparing checks it before you record.
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
                <div className="space-y-1.5">
                  <p className="text-muted-foreground text-xs">
                    And one that shows the journey worked.
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
              </div>
            </Step>
            <Step
              disabled={app === undefined || !conditionsReady}
              done={false}
              index={4}
              title="Permissions and setup"
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
                Enable private Variables
              </label>
              <p className="text-muted-foreground mt-3 text-xs">
                Opening a session checks Contingency's helpers on this device
                and installs or updates them if needed.
              </p>
            </Step>
          </div>
        </form>
        <SheetFooter className="flex-row justify-end border-t">
          <Button
            disabled={!ready || pending}
            form="android-setup"
            type="submit"
          >
            Open session
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
};
