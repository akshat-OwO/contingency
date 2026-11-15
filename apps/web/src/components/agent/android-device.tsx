import type {
  AgentSessionId,
  NativeEmulation,
  NativeEmulationChange,
  NativeInput,
} from "@contingency/protocol";
import { useAtom } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import {
  ChevronLeftIcon,
  CircleIcon,
  ShieldAlertIcon,
  SlidersHorizontalIcon,
  SmartphoneIcon,
  SquareIcon,
  UnplugIcon,
} from "lucide-react";
import { useState } from "react";
import type { ComponentType } from "react";

import { LocationFields } from "@/components/browser/location-fields";
import { SegmentedControl } from "@/components/browser/segmented-control";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { AndroidLiveStream } from "./android-live-stream";
import { DeviceLastScreen } from "./android-run-summary";
import type { AndroidStreamFrame } from "./android-stream-point";

/** Most phones are about 9 by 20; the frame takes the real ratio once decoded. */
const DEFAULT_FRAME: AndroidStreamFrame = { height: 2400, width: 1080 };

/**
 * A device frame like the one T3 Code draws: a thin metal rim and the side
 * keys. The glass is exactly the frame's aspect, so a click's position on it
 * is its position on the device and the live display is never letterboxed.
 * A rail, when given, sits beside the frame's right edge from its top, and
 * the two are centered together.
 */
export const DeviceFrame = ({
  children,
  frame,
  rail,
}: {
  readonly children: React.ReactNode;
  readonly frame: AndroidStreamFrame;
  readonly rail?: React.ReactNode;
}) => (
  // The frame fits whichever of the stage's width or height runs out first,
  // so a phone-width stage never pushes it past the edge. A size container
  // has no width of its own, so its parent must give it one.
  <div
    className="grid size-full min-h-0 min-w-0 place-items-center"
    style={{ containerType: "size" }}
  >
    <div className="flex items-start gap-3">
      <div
        className="relative"
        style={{
          // A rail takes 64px of the width: 52px wide, 12px from the frame.
          width: `min(100cqw - ${rail === undefined ? 0 : 64}px, calc((100cqh - 24px) * ${frame.width} / ${frame.height} + 24px))`,
        }}
      >
        <span
          aria-hidden="true"
          className="absolute top-[22%] -right-[3px] h-[9%] w-[3px] rounded-r bg-neutral-500"
        />
        <span
          aria-hidden="true"
          className="absolute top-[35%] -right-[3px] h-[14%] w-[3px] rounded-r bg-neutral-500"
        />
        <div className="w-full rounded-[2.75rem] bg-gradient-to-b from-neutral-500 via-neutral-700 to-neutral-600 p-[3px] shadow-2xl">
          <div className="w-full rounded-[2.6rem] bg-neutral-950 p-[9px]">
            <div
              className="relative w-full overflow-hidden rounded-[2.1rem] bg-neutral-950"
              style={{ aspectRatio: `${frame.width} / ${frame.height}` }}
            >
              {children}
            </div>
          </div>
        </div>
      </div>
      {rail}
    </div>
  </div>
);

/** A device navigation key, by the `KeyboardEvent.key` it is forwarded as. */
export type DeviceKey = "AppSwitch" | "GoBack" | "GoHome";

/**
 * Android's navigation keys, in the order the device draws them. Native
 * agents use the whole OS (ADR 0067), so each key works over any app.
 */
const ANDROID_KEYS = [
  { icon: ChevronLeftIcon, key: "GoBack", label: "Back" },
  { icon: CircleIcon, key: "GoHome", label: "Home" },
  { icon: SquareIcon, key: "AppSwitch", label: "Recents" },
] as const satisfies readonly {
  readonly icon: typeof ChevronLeftIcon;
  readonly key: DeviceKey;
  readonly label: string;
}[];

/** A phone on its side: the orientation the rotate button turns the device to. */
const LandscapePhoneIcon = () => <SmartphoneIcon className="rotate-90" />;

const RailButton = ({
  disabled,
  icon: Icon,
  label,
  onClick,
  tooltip,
}: {
  readonly disabled: boolean;
  readonly icon: ComponentType;
  readonly label: string;
  readonly onClick: () => void;
  readonly tooltip: string;
}) => (
  <Tooltip>
    <TooltipTrigger
      render={(props) => (
        <Button
          {...props}
          aria-label={label}
          className="size-10 rounded-xl"
          disabled={disabled}
          onClick={onClick}
          size="icon"
          variant="ghost"
        >
          <Icon />
        </Button>
      )}
    />
    <TooltipContent side="left">{tooltip}</TooltipContent>
  </Tooltip>
);

/**
 * Appearance and location for the device (ADR 0082). Location uses the
 * browser Emulation's fields; on a device it moves the emulator itself.
 */
const DeviceSettings = ({
  canAct,
  emulation,
  onEmulate,
}: {
  readonly canAct: boolean;
  readonly emulation: NativeEmulation | undefined;
  readonly onEmulate: (change: NativeEmulationChange) => void;
}) => {
  const [error, setError] = useState<string | undefined>();
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={(tooltip) => (
            <PopoverTrigger
              {...tooltip}
              render={(props) => (
                <Button
                  {...props}
                  aria-label="Device settings"
                  className="size-10 rounded-xl"
                  disabled={!canAct}
                  size="icon"
                  variant="ghost"
                >
                  <SlidersHorizontalIcon />
                </Button>
              )}
            />
          )}
        />
        <TooltipContent side="left">Device settings</TooltipContent>
      </Tooltip>
      <PopoverContent align="start" className="w-72 gap-4 p-3" side="left">
        <section className="space-y-1.5">
          <h2 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            Appearance
          </h2>
          <SegmentedControl
            disabled={!canAct}
            label="Appearance"
            onChange={(appearance) =>
              onEmulate({ _tag: "appearance", appearance })
            }
            options={[
              { label: "Light", value: "light" },
              { label: "Dark", value: "dark" },
            ]}
            value={emulation?.appearance}
          />
        </section>
        <section className="space-y-1.5">
          <h2 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            Location
          </h2>
          <LocationFields
            applied={emulation?.location}
            disabled={!canAct}
            onApply={(location) => onEmulate({ _tag: "location", ...location })}
            onError={setError}
          />
          {error === undefined ? null : (
            <p className="text-destructive text-xs" role="alert">
              {error}
            </p>
          )}
        </section>
      </PopoverContent>
    </Popover>
  );
};

/** The rail beside the frame. Its controls act only while the user is in control. */
const DeviceRail = ({
  canAct,
  emulation,
  onEmulate,
  onKey,
}: {
  readonly canAct: boolean;
  readonly emulation: NativeEmulation | undefined;
  readonly onEmulate: (change: NativeEmulationChange) => void;
  readonly onKey: (key: DeviceKey) => void;
}) => {
  const landscape = emulation?.orientation === "landscape";
  return (
    <nav
      aria-label="Device controls"
      className="material-float flex shrink-0 flex-col items-center gap-1 rounded-2xl p-1.5 shadow-sm"
    >
      {ANDROID_KEYS.map(({ icon, key, label }) => (
        <RailButton
          disabled={!canAct}
          icon={icon}
          key={key}
          label={`Android ${label}`}
          onClick={() => onKey(key)}
          tooltip={label}
        />
      ))}
      <span aria-hidden="true" className="bg-border my-1 h-px w-6" />
      <RailButton
        disabled={!canAct}
        icon={landscape ? SmartphoneIcon : LandscapePhoneIcon}
        label={landscape ? "Rotate to portrait" : "Rotate to landscape"}
        onClick={() =>
          onEmulate({
            _tag: "orientation",
            orientation: landscape ? "portrait" : "landscape",
          })
        }
        tooltip={landscape ? "Rotate to portrait" : "Rotate to landscape"}
      />
      <DeviceSettings
        canAct={canAct}
        emulation={emulation}
        onEmulate={onEmulate}
      />
    </nav>
  );
};

/**
 * A session with no device to show: before preparation, or after it released
 * the device. A full-height black frame would say nothing more than this
 * line, so the stage gives the space back.
 */
export const DeviceUnavailable = ({
  message,
}: {
  readonly message: string;
}) => (
  <div className="grid h-full min-h-0 place-items-center">
    <div className="material-panel flex max-w-xs items-center gap-3 rounded-xl px-4 py-3 shadow-sm">
      <SmartphoneIcon
        aria-hidden="true"
        className="text-muted-foreground size-5 shrink-0"
      />
      <p className="text-muted-foreground text-sm text-pretty">{message}</p>
    </div>
  </div>
);

/**
 * The live device: the frame with the stream filling its glass and its rail
 * on the right. While the user can act, what they do on the glass goes to
 * `onInput` as Forwarded Input.
 */
export const AndroidDevice = ({
  canAct,
  cleanup,
  emulation,
  ended = false,
  live,
  onDeviceKey,
  onEmulate,
  onInput,
  paused,
  pending,
  sessionId,
  secure,
  unavailable,
}: {
  readonly canAct: boolean;
  /** The session's cleanup state, so a purge drops the kept screen. */
  readonly cleanup: string;
  /** The session released its device for good; nothing will stream again. */
  readonly ended?: boolean;
  /** Whether the session holds a prepared device to stream. */
  readonly live: boolean;
  readonly onDeviceKey: (key: DeviceKey) => void;
  /** The device's Emulation as last read or set. */
  readonly emulation?: NativeEmulation | undefined;
  readonly onEmulate: (change: NativeEmulationChange) => void;
  readonly onInput: (input: NativeInput) => void;
  readonly paused: boolean;
  readonly pending: boolean;
  readonly sessionId: AgentSessionId;
  readonly secure: boolean;
  /** What the glass says while there is no stream. */
  readonly unavailable: string;
}) => {
  const [frameAtom] = useState(() => Atom.make(DEFAULT_FRAME));
  const [frame, setFrame] = useAtom(frameAtom);
  const displayUnavailable = secure ? "" : unavailable;
  if (ended) {
    return (
      <DeviceLastScreen
        cleanup={cleanup}
        fallback={<DeviceUnavailable message={displayUnavailable} />}
        platform="android"
        sessionId={sessionId}
      />
    );
  }
  return (
    <div className="relative flex h-full min-h-0 w-full min-w-0 items-center justify-center gap-3 lg:gap-5">
      {/*
        The side columns balance the frame and its rail on a wide stage. Why
        a click sent nothing is said in the dock, so nothing ever covers the
        glass.
      */}
      <div aria-hidden="true" className="hidden lg:block lg:w-56 lg:shrink-0" />
      <div
        aria-busy={pending}
        className={cn(
          "h-full min-h-0 min-w-0 flex-1 lg:flex-none lg:basis-[min(100%,32rem)]",
          pending && "cursor-progress"
        )}
      >
        <DeviceFrame
          frame={frame}
          rail={
            <DeviceRail
              canAct={canAct}
              emulation={emulation}
              onEmulate={onEmulate}
              onKey={onDeviceKey}
            />
          }
        >
          {live && !secure ? (
            <AndroidLiveStream
              dimmed={paused}
              onFrame={setFrame}
              onInput={canAct ? onInput : undefined}
              sessionId={sessionId}
            />
          ) : (
            <div className="absolute inset-0 grid place-items-center p-8 text-center text-sm text-neutral-400">
              {displayUnavailable}
            </div>
          )}
          {paused ? (
            <div className="absolute inset-0 grid place-items-center p-6 text-center">
              <div className="bg-background space-y-1 rounded-2xl border p-4 shadow-lg">
                {secure ? (
                  <ShieldAlertIcon className="mx-auto size-6 text-amber-600" />
                ) : (
                  <UnplugIcon className="mx-auto size-6 text-amber-600" />
                )}
                <p className="text-sm font-medium">
                  {secure
                    ? "Secure window, not visible"
                    : "Device disconnected"}
                </p>
                <p className="text-muted-foreground text-xs">
                  {secure
                    ? "This window cannot provide outcome evidence. The outcome is inconclusive."
                    : "Recover the same device from the dock."}
                </p>
              </div>
            </div>
          ) : null}
        </DeviceFrame>
      </div>
      <div aria-hidden="true" className="hidden lg:block lg:w-56 lg:shrink-0" />
    </div>
  );
};
