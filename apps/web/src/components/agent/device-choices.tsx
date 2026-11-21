import { useAtom } from "@effect/atom-react";
import { Effect, Fiber, Option, Schema } from "effect";
import { Atom } from "effect/reactivity";
import { LoaderCircleIcon, PlayIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

import { isStartable, withStarts } from "./device-choice-state";
import type { DeviceChoice, DeviceStart } from "./device-choice-state";
import { DeviceEraseButton, DeviceEraseRequests } from "./device-erase";
import type { DeviceEraseControls } from "./device-erase-state";

const startFailure = (cause: unknown) =>
  Schema.decodeUnknownOption(Schema.Struct({ message: Schema.String }))(
    cause
  ).pipe(
    Option.map((value) => value.message),
    Option.getOrElse(() => "The host did not answer.")
  );

/**
 * Starts devices on request and keeps each start's progress until discovery
 * is refreshed. A start that is still running when the card unmounts is
 * abandoned here; the host keeps booting the device.
 */
export const useDeviceStarts = (
  start: (bootId: string) => Effect.Effect<unknown, unknown>,
  onStarted: () => void
) => {
  const [startsAtom] = useState(() =>
    Atom.make<Readonly<Record<string, DeviceStart>>>({})
  );
  const [starts, setStarts] = useAtom(startsAtom);
  const fibers = useRef(new Set<Fiber.Fiber<unknown, unknown>>());
  useEffect(() => {
    const owned = fibers.current;
    return () => {
      for (const fiber of owned) {
        Effect.runFork(Fiber.interrupt(fiber));
      }
      owned.clear();
    };
  }, []);
  // Synchronous, so a second click before the re-render sends no second boot.
  const inFlight = useRef(new Set<string>());
  const startDevice = (bootId: string) => {
    if (inFlight.current.has(bootId)) {
      return;
    }
    inFlight.current.add(bootId);
    setStarts((current) => ({ ...current, [bootId]: { _tag: "starting" } }));
    const fiber = Effect.runFork(
      start(bootId).pipe(
        Effect.match({
          onFailure: (cause) => ({
            _tag: "failed" as const,
            reason: startFailure(cause),
          }),
          onSuccess: () => null,
        }),
        Effect.tap((outcome) =>
          Effect.sync(() => {
            setStarts((current) => {
              if (outcome !== null) {
                return { ...current, [bootId]: outcome };
              }
              return Object.fromEntries(
                Object.entries(current).filter(([key]) => key !== bootId)
              );
            });
            if (outcome === null) {
              onStarted();
            }
          })
        )
      )
    );
    fibers.current.add(fiber);
    fiber.addObserver(() => {
      fibers.current.delete(fiber);
      inFlight.current.delete(bootId);
    });
  };
  return { startDevice, starts };
};

/** Reads the host's devices again; it sits at the end of the hint row. */
export const RefreshDevicesButton = ({
  onRefresh,
}: {
  readonly onRefresh: () => void;
}) => (
  <Button
    aria-label="Refresh devices"
    className="text-muted-foreground hover:text-foreground shrink-0"
    onClick={onRefresh}
    size="icon-xs"
    title="Refresh devices"
    type="button"
    variant="ghost"
  >
    <RefreshCwIcon aria-hidden="true" />
  </Button>
);

/** What a device's option says beside its name. */
const optionNote = (device: DeviceChoice) => {
  switch (device.status._tag) {
    case "ready": {
      return device.detail;
    }
    case "stopped": {
      return "Stopped";
    }
    case "starting": {
      return "Starting…";
    }
    case "failed": {
      return "Did not start";
    }
    default: {
      return device.status.reason;
    }
  }
};

/** A device as its option and the trigger show it: its name, then a note. */
const DeviceLabel = ({ device }: { readonly device: DeviceChoice }) => (
  <span className="flex w-full min-w-0 items-center justify-between gap-3">
    <span className="truncate">{device.name}</span>
    <span className="text-muted-foreground min-w-0 truncate text-xs tabular-nums">
      {optionNote(device)}
    </span>
  </span>
);

/** The shown device's state under the field, said as it changes. */
const deviceStatus = (device: DeviceChoice) => {
  switch (device.status._tag) {
    case "ready": {
      return `Running · ${device.detail}`;
    }
    case "stopped": {
      return `Stopped · ${device.detail}`;
    }
    case "starting": {
      return `Starting… ${device.detail}`;
    }
    default: {
      return device.status.reason;
    }
  }
};

/**
 * The hint row under the field for the device it shows: its state, then
 * Start for one that can start and Erase where Device Erase allows it.
 */
const DeviceHint = ({
  device,
  erase,
  onStart,
}: {
  readonly device: DeviceChoice;
  readonly erase: DeviceEraseControls | undefined;
  readonly onStart: (bootId: string) => void;
}) => {
  const { bootId, status } = device;
  const starting = status._tag === "starting";
  return (
    <div
      aria-busy={starting}
      aria-label={device.name}
      className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-x-3 gap-y-1"
      role="group"
    >
      <span
        aria-live="polite"
        className={cn(
          "min-w-0 text-xs text-pretty",
          status._tag === "failed" || status._tag === "unavailable"
            ? "text-destructive"
            : "text-muted-foreground"
        )}
      >
        {deviceStatus(device)}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {isStartable(device) ? (
          <Button
            aria-label={`${status._tag === "failed" ? "Try starting" : "Start"} ${device.name}`}
            disabled={starting || bootId === undefined}
            onClick={() => {
              if (bootId !== undefined) {
                onStart(bootId);
              }
            }}
            size="xs"
            type="button"
            variant="outline"
          >
            {starting ? (
              <LoaderCircleIcon
                aria-hidden="true"
                className="animate-spin motion-reduce:animate-none"
              />
            ) : (
              <PlayIcon aria-hidden="true" />
            )}
            {status._tag === "failed" ? "Try again" : null}
            {status._tag === "starting" ? "Starting…" : null}
            {status._tag === "stopped" ? "Start" : null}
          </Button>
        ) : null}
        {erase === undefined ? null : (
          <DeviceEraseButton controls={erase} device={device} />
        )}
      </span>
    </div>
  );
};

/**
 * Device choice for Android and iOS setup, as the #744 card shows it: one
 * Select of every device the host reports, then a hint row for the device
 * it shows, with Start, Erase and Refresh devices. A ready device is chosen
 * by picking it. While none is running, the first one that can start shows,
 * so Start is one press away; picking a stopped device chooses nothing the
 * session could use until it runs.
 */
export const DeviceChoices = ({
  devices,
  emptyMessage,
  erase,
  label,
  onRefresh,
  onSelect,
  onStart,
  selected,
  starts,
}: {
  readonly devices: readonly DeviceChoice[];
  /** Said when no device is ready and none can be started. */
  readonly emptyMessage: string;
  /** Device Erase (ADR 0081); absent where the card does not offer it. */
  readonly erase?: DeviceEraseControls;
  /** The field's name, such as Device or Simulator. */
  readonly label: string;
  readonly onRefresh?: () => void;
  readonly onSelect: (id: string) => void;
  readonly onStart: (bootId: string) => void;
  readonly selected: string | null;
  readonly starts: Readonly<Record<string, DeviceStart>>;
}) => {
  const shown = withStarts(devices, starts);
  const ready = shown.filter((device) => device.status._tag === "ready");
  const picked = shown.find((device) => device.id === selected);
  const current =
    picked ?? (ready.length === 0 ? shown.find(isStartable) : undefined);
  return (
    <div className="grid gap-1.5">
      {erase === undefined ? null : (
        <DeviceEraseRequests controls={erase} devices={shown} />
      )}
      {shown.length === 0 ? null : (
        <Select
          onValueChange={(value) => {
            const device = shown.find((entry) => entry.id === value);
            if (device !== undefined) {
              onSelect(device.id);
            }
          }}
          placeholder="Choose a device"
          value={current?.id ?? null}
        >
          <SelectTrigger aria-label={label} variant="island">
            <SelectValue>
              {current === undefined ? null : <DeviceLabel device={current} />}
            </SelectValue>
          </SelectTrigger>
          <SelectContent variant="island">
            {shown.map((device) => (
              <SelectItem
                disabled={device.status._tag === "unavailable"}
                key={device.id}
                label={device.name}
                value={device.id}
              >
                <DeviceLabel device={device} />
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <div className="flex min-h-7 items-center justify-between gap-3">
        {current === undefined ? (
          <p className="text-muted-foreground min-w-0 flex-1 text-xs">
            {ready.length === 0
              ? emptyMessage
              : "Choose one of the running devices."}
          </p>
        ) : (
          <DeviceHint device={current} erase={erase} onStart={onStart} />
        )}
        {onRefresh === undefined ? null : (
          <RefreshDevicesButton onRefresh={onRefresh} />
        )}
      </div>
    </div>
  );
};
