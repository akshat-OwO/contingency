import { describeFlowName, FlowName } from "@contingency/protocol";
import type {
  IosDeviceSelection,
  IosInstalledApp,
  IosWorkspaceSelection,
  StartingData,
  UploadedIosApp,
} from "@contingency/protocol";
import { useAtom, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Effect, Fiber, Schema } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { LoaderCircleIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useRpcDependencies } from "@/lib/rpc-dependencies";
import type { RpcDependencies } from "@/lib/rpc-dependencies";
import { cn } from "@/lib/utils";

import { DeviceChoices, useDeviceStarts } from "./device-choices";
import { useDeviceErase } from "./device-erase";
import {
  chosenSimulator,
  iosDeviceChoice,
  iosSetupMissing,
  iosSetupSelection,
  simulatorInventoryKey,
} from "./ios-setup-state";
import type { IosTarget } from "./ios-setup-state";
import { EMPTY_CONDITION, trimmedCondition } from "./native-condition";
import type { NativeCondition } from "./native-condition";
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
  InstalledAppsFrame,
  UploadedBuild,
  useBuildUpload,
} from "./target-app-upload";
import type { InstalledAppsNotice } from "./target-app-upload";
import type { HomePlatform } from "./workspace-home-state";

interface SetupForm {
  readonly outcome: NativeCondition;
  /** The simulator the person picked, if any. */
  readonly picked: string | null;
  readonly start: NativeCondition;
  readonly startingData: StartingData;
}

const INITIAL_FORM: SetupForm = {
  outcome: EMPTY_CONDITION,
  picked: null,
  start: EMPTY_CONDITION,
  startingData: "keep",
};

/** A refusal's sentence; its leading code is for agents, not people. */
const failure = (cause: unknown) =>
  Schema.is(Schema.Struct({ message: Schema.String }))(cause)
    ? cause.message.replace(/^[a-z][a-z0-9_]*:\s*/u, "")
    : "The iOS session is unavailable.";

/** A listed simulator as a selection names it, without its `simctl` state. */
const asSelection = ({
  state: _state,
  ...device
}: IosDeviceSelection & { readonly state: string }): IosDeviceSelection =>
  device;

type InstalledApps =
  | { readonly _tag: "idle" }
  | { readonly _tag: "loading" }
  | { readonly _tag: "failed"; readonly message: string }
  | { readonly _tag: "loaded"; readonly apps: readonly IosInstalledApp[] };

/** The apps on the chosen simulator, read again when it or refresh changes. */
const useInstalledIosApps = (
  listIosApps: RpcDependencies["listIosApps"],
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
            setState({ _tag: "failed", message: failure(cause) }),
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

const installedAppsNotice = (
  apps: InstalledApps
): InstalledAppsNotice | null => {
  if (apps._tag === "idle") {
    return {
      _tag: "message",
      text: "Pick a running simulator to list its apps.",
      tone: "muted",
    };
  }
  if (apps._tag === "loading") {
    return { _tag: "loading" };
  }
  if (apps._tag === "failed") {
    return { _tag: "message", text: apps.message, tone: "destructive" };
  }
  if (apps.apps.length === 0) {
    return {
      _tag: "message",
      text: "No apps are installed on this simulator yet.",
      tone: "muted",
    };
  }
  return null;
};

/**
 * The Target App the card holds. An upload no session claimed is deleted as
 * soon as it is let go of, including when the card closes; one a session
 * claimed is the session's to delete.
 */
const useIosTarget = (
  discard: RpcDependencies["discardTargetAppBuild"],
  upload: RpcDependencies["uploadIosApp"]
) => {
  const [targetAtom] = useState(() => Atom.make<IosTarget | null>(null));
  const [target, setTarget] = useAtom(targetAtom);
  // What closing the card lets go of, read when it unmounts.
  const latest = useRef({ discard, target });
  useEffect(() => {
    latest.current = { discard, target };
  });
  useEffect(
    () => () => {
      const held = latest.current;
      if (held.target?._tag === "uploaded") {
        Effect.runFork(held.discard(held.target.upload.id));
      }
    },
    []
  );
  const choose = (next: IosTarget | null) => {
    // The upload this replaces, even when it finished after this render.
    const held = latest.current.target;
    if (held?._tag === "uploaded") {
      Effect.runFork(discard(held.upload.id));
    }
    latest.current = { ...latest.current, target: next };
    setTarget(next);
  };
  const uploading = useBuildUpload(upload, (uploaded: UploadedIosApp) =>
    choose({ _tag: "uploaded", upload: uploaded })
  );
  const claimed = () => {
    latest.current = { ...latest.current, target: null };
    setTarget(null);
  };
  return { choose, claimed, target, upload: uploading };
};

const InstalledIosApps = ({
  apps,
  onSelect,
  target,
}: {
  readonly apps: InstalledApps;
  readonly onSelect: (app: IosInstalledApp) => void;
  readonly target: IosTarget | null;
}) => (
  <InstalledAppsFrame notice={installedAppsNotice(apps)}>
    {apps._tag === "loaded"
      ? apps.apps.map((app) => {
          const selected =
            target?._tag === "installed" &&
            target.app.bundleId === app.bundleId;
          return (
            <li key={app.bundleId}>
              <button
                aria-pressed={selected}
                className={cn(
                  "hover:bg-island-hover flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm",
                  selected && "bg-island-hover"
                )}
                onClick={() => onSelect(app)}
                type="button"
              >
                <span className="min-w-0 flex-1 truncate">
                  {app.label || app.bundleId}
                  {app.label === app.bundleId ? null : (
                    <span className="text-muted-foreground ml-2 font-mono text-xs">
                      {app.bundleId}
                    </span>
                  )}
                </span>
                <Badge variant="outline">build {app.build}</Badge>
              </button>
            </li>
          );
        })
      : null}
  </InstalledAppsFrame>
);

/** Section 3: what restarting the app applies before Teaching and every Run. */
const IosSetupChoices = ({
  form,
  setForm,
}: {
  readonly form: SetupForm;
  readonly setForm: (update: (current: SetupForm) => SetupForm) => void;
}) => (
  <div className="grid min-w-0 gap-5">
    <StartingDataField
      name="ios-starting-data"
      onChange={(startingData) =>
        setForm((current) => ({ ...current, startingData }))
      }
      value={form.startingData}
    />
    <Part
      description="An element on screen when the app opens. Leave it empty for the agent to choose from the Teaching Recording."
      title="Starting screen"
    >
      <ConditionInput
        label="Starting screen element"
        onChange={(start) => setForm((current) => ({ ...current, start }))}
        placeholder="Sign in"
        roleLabel="Starting screen role"
        value={form.start}
      />
    </Part>
    <Part
      description="An element that shows the journey worked. Leave it empty for the agent to choose."
      title="Done when"
    >
      <ConditionInput
        label="Done when element"
        onChange={(outcome) => setForm((current) => ({ ...current, outcome }))}
        placeholder="Signed in"
        roleLabel="Done when role"
        value={form.outcome}
      />
    </Part>
  </div>
);

/**
 * The iOS start card on the Workspace home: 1 the Flow name and a running
 * iPhone simulator, 2 the Target App, an uploaded simulator `.app` folder or
 * an app already on the simulator, and 3 Setup, with Starting Data and the
 * optional Starting screen and Done when. Start teaching opens a pending
 * session; installing and preparing wait for the person in that session.
 */
export const IosStartCard = ({
  error,
  flowName,
  onClose,
  onFlowNameChange,
  onOtherPlatform,
  onStart,
  pending,
  platforms,
}: {
  readonly error: string | undefined;
  readonly flowName: string;
  readonly onClose: () => void;
  readonly onFlowNameChange: (name: string) => void;
  readonly onOtherPlatform: (platform: HomePlatform) => void;
  /** True when the session start was sent; it then owns any upload. */
  readonly onStart: (
    flowName: FlowName,
    selection: IosWorkspaceSelection,
    form: HTMLFormElement | null
  ) => boolean;
  readonly pending: boolean;
  readonly platforms: readonly HomePlatform[];
}) => {
  const ids = useId();
  const rpc = useRpcDependencies();
  const formRef = useRef<HTMLFormElement>(null);
  const [formAtom] = useState(() => Atom.make<SetupForm>(INITIAL_FORM));
  const [form, setForm] = useAtom(formAtom);
  const devices = useAtomValue(rpc.iosDevicesAtom);
  const refreshDevices = useAtomRefresh(rpc.iosDevicesAtom);
  const listed = AsyncResult.isSuccess(devices) ? devices.value : [];
  const chosen = chosenSimulator(listed, form.picked);
  const { startDevice, starts } = useDeviceStarts(
    rpc.bootIosSimulator,
    refreshDevices
  );
  const [appsRefreshAtom] = useState(() => Atom.make(0));
  const [appsRefresh, setAppsRefresh] = useAtom(appsRefreshAtom);
  const refresh = () => {
    refreshDevices();
    setAppsRefresh((value) => value + 1);
  };
  // Keyed on the inventory, so a simulator this card just started is read
  // as owned once it is running.
  const erase = useDeviceErase(
    "ios",
    true,
    simulatorInventoryKey(listed),
    refresh
  );
  const found = listed.find(
    (entry) => entry.udid === chosen && entry.state === "Booted"
  );
  const device = found === undefined ? undefined : asSelection(found);
  const apps = useInstalledIosApps(rpc.listIosApps, device, appsRefresh);
  const { choose, claimed, target, upload } = useIosTarget(
    rpc.discardTargetAppBuild,
    rpc.uploadIosApp
  );
  const name = flowName.trim();
  const validName = Schema.is(FlowName)(name);
  const ready = validName && device !== undefined && target !== null;
  const missingId = `${ids}-missing`;
  const uploadStatusId = `${ids}-app-upload-status`;
  return (
    <StartCard
      error={error}
      footer={
        <>
          {ready || pending ? null : (
            <p
              className="text-muted-foreground mt-1.5 text-center text-xs"
              id={missingId}
            >
              {iosSetupMissing({
                booted: listed.some((entry) => entry.state === "Booted"),
                device: device ?? null,
                target,
                validName,
              })}
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
              Opening the iOS session…
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
        const sent = onStart(
          name,
          iosSetupSelection({
            device,
            outcome: trimmedCondition(form.outcome),
            start: trimmedCondition(form.start),
            startingData: form.startingData,
            target,
          }),
          formRef.current
        );
        if (sent) {
          // The session now owns the upload and deletes it when it ends.
          claimed();
        }
      }}
      outside={erase.dialog}
      platform="ios"
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
        <Part title="Simulator">
          <div className="space-y-2">
            <DeviceChoices
              devices={listed.map(iosDeviceChoice)}
              emptyMessage="No iPhone simulator on iOS 26 through 27 exists. Add one in Xcode, then refresh."
              erase={erase.controls}
              onSelect={(udid) => {
                setForm((current) => ({ ...current, picked: udid }));
                // An installed app belongs to the simulator it is on.
                if (target?._tag === "installed") {
                  choose(null);
                }
              }}
              onStart={startDevice}
              selected={chosen}
              starts={starts}
            />
            <Button onClick={refresh} size="xs" type="button" variant="ghost">
              <RefreshCwIcon />
              Refresh devices
            </Button>
          </div>
        </Part>
      </StartSection>

      <StartSection label="Target App" number={2}>
        <Part title="Target App">
          <div className="grid gap-3">
            {target?._tag === "uploaded" ? (
              <UploadedBuild
                detail={`${target.upload.bundleId} · build ${target.upload.build} · installs with your consent`}
                name={target.upload.name}
                onRemove={() => choose(null)}
                title={target.upload.label || target.upload.name}
              />
            ) : (
              <BuildDropzone
                describedBy={uploadStatusId}
                directory
                kind=".app"
                label="Upload a simulator .app"
                onFiles={(files, folder) => upload.start(files, folder)}
                state={upload.state}
              />
            )}
            <p className="text-muted-foreground before:bg-island-border after:bg-island-border flex items-center gap-3 text-xs before:h-px before:flex-1 after:h-px after:flex-1">
              or pick an app already on this simulator
            </p>
            <InstalledIosApps
              apps={apps}
              onSelect={(app) => choose({ _tag: "installed", app })}
              target={target}
            />
          </div>
        </Part>
      </StartSection>

      <StartSetup summary="Starting data, start and finish">
        <IosSetupChoices form={form} setForm={setForm} />
      </StartSetup>
    </StartCard>
  );
};
