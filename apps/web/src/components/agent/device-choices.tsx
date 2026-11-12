import { useAtom } from "@effect/atom-react";
import { Effect, Fiber, Option, Schema } from "effect";
import { Atom } from "effect/reactivity";
import {
  LoaderCircleIcon,
  PlayIcon,
  SmartphoneIcon,
  TabletSmartphoneIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { isStartable, withStarts } from "./device-choice-state";
import type { DeviceChoice, DeviceStart } from "./device-choice-state";

const startFailure = (cause: unknown) =>
  Schema.decodeUnknownOption(Schema.Struct({ message: Schema.String }))(
    cause
  ).pipe(
    Option.map((value) => value.message),
    Option.getOrElse(() => "The host did not answer.")
  );

/**
 * Starts devices on request and keeps each start's progress until discovery
 * is refreshed. A start that is still running when the sheet unmounts is
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
  const startDevice = (bootId: string) => {
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
    fiber.addObserver(() => fibers.current.delete(fiber));
  };
  return { startDevice, starts };
};

const KindIcon = ({ kind }: { readonly kind: DeviceChoice["kind"] }) => {
  const Icon = kind === "Phone" ? TabletSmartphoneIcon : SmartphoneIcon;
  return <Icon aria-hidden="true" className="size-4" />;
};

const CardHeading = ({ device }: { readonly device: DeviceChoice }) => (
  <>
    <span className="mb-1 flex items-center justify-between">
      <KindIcon kind={device.kind} />
      <Badge variant="outline">{device.kind}</Badge>
    </span>
    <span className="block truncate text-sm font-medium">{device.name}</span>
  </>
);

const cardClass =
  "min-w-0 rounded-lg border p-2.5 text-left transition-[background-color,box-shadow]";

/** A stopped emulator or simulator, with its start's progress or failure. */
const StartableCard = ({
  device,
  onStart,
}: {
  readonly device: DeviceChoice;
  readonly onStart: (bootId: string) => void;
}) => {
  const { bootId, status } = device;
  const starting = status._tag === "starting";
  return (
    <div
      aria-busy={starting}
      aria-label={device.name}
      className={cardClass}
      role="group"
    >
      <CardHeading device={device} />
      <span
        aria-live="polite"
        className={cn(
          "block text-xs",
          status._tag === "failed"
            ? "text-destructive"
            : "text-muted-foreground"
        )}
      >
        {status._tag === "failed" ? status.reason : null}
        {status._tag === "starting" ? `Starting… ${device.detail}` : null}
        {status._tag === "stopped" ? `Stopped · ${device.detail}` : null}
      </span>
      <Button
        aria-label={`${status._tag === "failed" ? "Try starting" : "Start"} ${device.name}`}
        className="mt-2"
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
          <LoaderCircleIcon aria-hidden="true" className="animate-spin" />
        ) : (
          <PlayIcon aria-hidden="true" />
        )}
        {status._tag === "failed" ? "Try again" : null}
        {status._tag === "starting" ? "Starting…" : null}
        {status._tag === "stopped" ? "Start" : null}
      </Button>
    </div>
  );
};

const DeviceCard = ({
  device,
  onSelect,
  onStart,
  selected,
}: {
  readonly device: DeviceChoice;
  readonly onSelect: (id: string) => void;
  readonly onStart: (bootId: string) => void;
  readonly selected: boolean;
}) => {
  if (isStartable(device)) {
    return <StartableCard device={device} onStart={onStart} />;
  }
  const reason =
    device.status._tag === "unavailable" ? device.status.reason : null;
  return (
    <button
      aria-pressed={selected}
      className={cn(
        cardClass,
        "hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent",
        selected && "border-primary ring-primary/20 ring-2"
      )}
      disabled={device.status._tag !== "ready"}
      onClick={() => onSelect(device.id)}
      type="button"
    >
      <CardHeading device={device} />
      <span className="text-muted-foreground block text-xs">
        {reason ?? device.detail}
      </span>
    </button>
  );
};

/**
 * Device choice for both setup sheets. Ready devices come first. The rest
 * fold under a count, so a list of stopped devices never pushes the Target
 * App off the first screen; the fold opens while nothing is ready, so the
 * devices that can be started are in view.
 */
export const DeviceChoices = ({
  devices,
  emptyMessage,
  onSelect,
  onStart,
  selected,
  starts,
}: {
  readonly devices: readonly DeviceChoice[];
  /** Said when no device is ready, after any that can be started. */
  readonly emptyMessage: string;
  readonly onSelect: (id: string) => void;
  readonly onStart: (bootId: string) => void;
  readonly selected: string | null;
  readonly starts: Readonly<Record<string, DeviceStart>>;
}) => {
  const shown = withStarts(devices, starts);
  const ready = shown.filter((device) => device.status._tag === "ready");
  const rest = shown.filter((device) => device.status._tag !== "ready");
  const startable = rest.filter(isStartable);
  return (
    <div className="space-y-2">
      {ready.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          {startable.length === 0
            ? emptyMessage
            : "No device is running. Start one below."}
        </p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {ready.map((device) => (
            <DeviceCard
              device={device}
              key={device.id}
              onSelect={onSelect}
              onStart={onStart}
              selected={selected === device.id}
            />
          ))}
        </div>
      )}
      {rest.length === 0 ? null : (
        <details className="group" open={ready.length === 0 || undefined}>
          <summary className="text-muted-foreground hover:text-foreground w-fit cursor-pointer text-xs">
            {rest.length} stopped or unavailable{" "}
            {rest.length === 1 ? "device" : "devices"}
          </summary>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {rest.map((device) => (
              <DeviceCard
                device={device}
                key={device.id}
                onSelect={onSelect}
                onStart={onStart}
                selected={false}
              />
            ))}
          </div>
        </details>
      )}
    </div>
  );
};
