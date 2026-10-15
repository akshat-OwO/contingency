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
import { Textarea } from "@/components/ui/textarea";
import { listAndroidApps, listAndroidDevices } from "@/lib/rpc";
import { cn } from "@/lib/utils";

import {
  SUPPORTED_RELEASE,
  parseAndroidPermissionDecisions,
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
  readonly helperConsent: AndroidWorkspaceSelection["helperConsent"];
  readonly notificationPermission: "unchanged" | "grant" | "revoke";
  readonly permissions: string;
  readonly outcome: Condition;
  readonly query: string;
  readonly start: Condition;
}

const INITIAL_FORM: SetupForm = {
  app: null,
  device: null,
  flowSkillName: "new-flow",
  helperConsent: "none",
  notificationPermission: "unchanged",
  outcome: { name: "", role: "text" },
  permissions: "",
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

const Step = ({
  children,
  done,
  index,
  title,
}: {
  readonly children: React.ReactNode;
  readonly done: boolean;
  readonly index: number;
  readonly title: string;
}) => (
  <section aria-label={title} className="space-y-2">
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
  </section>
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
    <NativeSelect
      aria-label={`${label} role`}
      className="w-28 shrink-0"
      onChange={(event) =>
        onChange({ ...value, role: event.currentTarget.value })
      }
      value={value.role}
    >
      {ROLES.map((role) => (
        <NativeSelectOption key={role} value={role}>
          {role}
        </NativeSelectOption>
      ))}
    </NativeSelect>
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
        No devices. Start an emulator or connect a phone with USB debugging on.
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
              <span className="text-muted-foreground block truncate text-xs">
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

type PermissionForm = Pick<SetupForm, "notificationPermission" | "permissions">;

const permissionDecisions = (form: PermissionForm) =>
  parseAndroidPermissionDecisions(
    `${form.notificationPermission === "unchanged" ? "" : `${form.notificationPermission} android.permission.POST_NOTIFICATIONS`}\n${form.permissions}`
  );

const AndroidPermissionFields = ({
  value,
  onChange,
  invalid,
}: {
  readonly value: PermissionForm;
  readonly onChange: (value: PermissionForm) => void;
  readonly invalid: boolean;
}) => (
  <section aria-label="App permissions" className="space-y-3 pl-7">
    <p className="text-muted-foreground text-xs">
      Set permissions before launch. These choices apply to the Target App after
      its data is cleared, so permission dialogs do not block the starting
      screen.
    </p>
    <label className="grid gap-1.5 text-xs">
      Notification permission
      <NativeSelect
        onChange={(event) => {
          const choice = Schema.decodeUnknownSync(
            Schema.Literals(["unchanged", "grant", "revoke"])
          )(event.currentTarget.value);
          onChange({ ...value, notificationPermission: choice });
        }}
        value={value.notificationPermission}
      >
        <NativeSelectOption value="unchanged">
          App does not request notifications
        </NativeSelectOption>
        <NativeSelectOption value="grant">
          Grant before start
        </NativeSelectOption>
        <NativeSelectOption value="revoke">
          Deny before start
        </NativeSelectOption>
      </NativeSelect>
    </label>
    <label className="grid gap-1.5 text-xs">
      Additional permission decisions
      <Textarea
        aria-label="Additional permission decisions"
        aria-describedby="android-permissions-hint"
        aria-invalid={invalid}
        onChange={(event) =>
          onChange({ ...value, permissions: event.currentTarget.value })
        }
        value={value.permissions}
      />
      <span id="android-permissions-hint" className="text-muted-foreground">
        One grant or revoke per line, such as revoke android.permission.CAMERA.
        Declare each permission once.
      </span>
    </label>
    {invalid ? (
      <p role="alert" className="text-destructive text-xs">
        Declare each permission once as grant or revoke followed by
        android.permission.NAME.
      </p>
    ) : null}
  </section>
);

/**
 * Where a Teaching session on Android begins: a device the host reports, an
 * app installed on it, and what proves the app is on its starting screen.
 * Nothing touches the device until the session is opened and prepared. The
 * journey may press whatever the person presses while recording, so there is
 * no list of allowed taps to declare.
 */
export const AndroidSetupSheet = ({
  onOpen,
  onOpenChange,
  open,
  pending,
}: {
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
    open ? listAndroidDevices : null,
    `${open}-${refresh}`
  );
  const discovered =
    devices._tag === "loaded"
      ? devices.value.find((entry) => entry.serial === form.device)
      : undefined;
  const device = discovered === undefined ? null : selectable(discovered);
  const loadedApps = useRead(
    device === null ? null : listAndroidApps(device),
    device === null ? "none" : `${device.serial}-${refresh}`
  );
  const apps = device === null ? null : loadedApps;
  const app =
    apps?._tag === "loaded"
      ? apps.value.find((entry) => entry.package === form.app)
      : undefined;
  const name = form.flowSkillName.trim();
  const validName = Schema.is(FlowSkillName)(name);
  const start = { name: form.start.name.trim(), role: form.start.role };
  const outcome = { name: form.outcome.name.trim(), role: form.outcome.role };
  const permissions = permissionDecisions(form);
  const ready =
    device !== null &&
    app !== undefined &&
    start.name !== "" &&
    outcome.name !== "" &&
    validName &&
    permissions !== undefined;
  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent className="w-full data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            New Android session
            <Badge
              title="Android is experimental. Expect fewer features than the browser Workspace."
              variant="outline"
            >
              Experimental
            </Badge>
          </SheetTitle>
          <SheetDescription>
            Pick what to teach on. Nothing on the device changes until you
            prepare the session.
          </SheetDescription>
        </SheetHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          id="android-setup"
          onSubmit={(event) => {
            event.preventDefault();
            if (!ready || !validName) {
              return;
            }
            onOpen(name, {
              device,
              environment: {
                androidVersion: SUPPORTED_RELEASE,
                appBuild: app.versionCode,
                appId: app.package,
                permissions,
                startingState: `${start.role} ${start.name} is visible`,
              },
              helperConsent: form.helperConsent,
              outcomes: [outcome],
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
            <Step done={app !== undefined} index={2} title="Target App">
              <AppStep
                apps={apps}
                onQuery={(query) =>
                  setForm((current) => ({ ...current, query }))
                }
                onSelect={(appId) =>
                  setForm((current) => ({ ...current, app: appId }))
                }
                query={form.query}
                selected={form.app}
              />
            </Step>
            <Step
              done={start.name !== "" && outcome.name !== ""}
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
            <AndroidPermissionFields
              value={form}
              onChange={(value) =>
                setForm((current) => ({ ...current, ...value }))
              }
              invalid={permissions === undefined}
            />
            <label className="grid gap-1.5 pl-7 text-xs">
              <span className="text-muted-foreground">
                Contingency's pinned helper
              </span>
              <NativeSelect
                onChange={(event) => {
                  const value = Schema.decodeUnknownOption(
                    Schema.Literals(["none", "install", "replace"])
                  )(event.currentTarget.value).pipe(
                    Option.getOrElse(() => "none" as const)
                  );
                  setForm((current) => ({ ...current, helperConsent: value }));
                }}
                size="sm"
                value={form.helperConsent}
              >
                <NativeSelectOption value="none">
                  Use the installed helper only
                </NativeSelectOption>
                <NativeSelectOption value="install">
                  Install it if missing
                </NativeSelectOption>
                <NativeSelectOption value="replace">
                  Replace an incompatible one
                </NativeSelectOption>
              </NativeSelect>
            </label>
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
