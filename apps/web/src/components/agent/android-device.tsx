import type {
  AgentSessionId,
  AndroidWorkspaceObservation,
  NativeEmulation,
  NativeEmulationChange,
  NativeInput,
} from "@contingency/protocol";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Clock, Effect, Fiber } from "effect";
import { Atom } from "effect/reactivity";
import {
  ActivityIcon,
  ChevronLeftIcon,
  CircleIcon,
  CirclePauseIcon,
  ListIcon,
  ScanEyeIcon,
  ShieldAlertIcon,
  SlidersHorizontalIcon,
  SmartphoneIcon,
  SquareIcon,
  UnplugIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import type {
  ComponentType,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";

import {
  RailBadge,
  RailButton,
  RailDot,
} from "@/components/browser/inspector-rail";
import { LocationFields } from "@/components/browser/location-fields";
import { SegmentedControl } from "@/components/browser/segmented-control";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useWorkspaceRefreshClock } from "@/lib/workspace-refresh";

import { AndroidLiveStream } from "./android-live-stream";
import { DeviceLastScreen } from "./android-run-summary";
import type { AndroidStreamFrame } from "./android-stream-point";
import { InspectHint } from "./comment-card";
import { ScreenElements } from "./device-elements";
import { NativeAgentTouch } from "./native-agent-touch";
import { NATIVE_FRAME_SAMPLES, readNativeStream } from "./native-stream-status";
import type {
  NativeStreamState,
  NativeStreamStats,
} from "./native-stream-status";
import {
  androidStreamRetryAtom,
  androidStreamStateAtom,
  androidStreamStats,
} from "./native-stream-store";
import {
  attachedElement,
  elementAt,
  elementBox,
  screenElementCount,
} from "./screen-elements";
import type {
  AttachedElement,
  CommentPin,
  ObservedNode,
  ScreenBox,
} from "./screen-elements";

/** Most phones are about 9 by 20; the frame takes the real ratio once decoded. */
const DEFAULT_FRAME: AndroidStreamFrame = { height: 2400, width: 1080 };

/** The rail's column: 52px wide, 12px from the frame. */
const RAIL_SPACE = 64;
/** A rail card: 320px wide, 12px from the rail. */
const CARD_SPACE = 332;
/** The Field Variable card: 288px wide, 12px from the frame. */
const LEADING_SPACE = 300;

/** A Teaching recording's comments, pinned where their elements are. */
export interface NativeCommentPins {
  /** The comment the card's list points at, whose element is outlined. */
  readonly highlighted: number | undefined;
  readonly pins: readonly CommentPin[];
}

const percent = (box: ScreenBox) => ({
  height: `${box.height * 100}%`,
  left: `${box.left * 100}%`,
  top: `${box.top * 100}%`,
  width: `${box.width * 100}%`,
});

/** Numbered pins on the glass. They take no input, so every touch reaches the device. */
const CommentPinLayer = ({
  comments,
}: {
  readonly comments: NativeCommentPins;
}) => {
  const outlined = comments.pins.find(
    (pin) => pin.index === comments.highlighted
  );
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0"
      data-slot="comment-pins"
    >
      {outlined === undefined ? null : (
        <span
          className="border-status-running bg-status-running/15 absolute rounded-md border-2"
          style={percent(outlined.box)}
        />
      )}
      {comments.pins.map((pin) => (
        <span
          className="bg-status-running border-background absolute grid size-[22px] -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border-2 font-mono text-xs font-semibold text-white shadow-[0_2px_6px_oklch(0_0_0/0.25)] transition-[scale] duration-200 data-on:scale-120"
          data-on={pin.index === comments.highlighted ? "" : undefined}
          key={pin.index}
          style={{
            left: `${(pin.box.left + pin.box.width / 2) * 100}%`,
            top: `${pin.box.top * 100}%`,
          }}
        >
          {pin.index}
        </span>
      ))}
    </div>
  );
};

/**
 * A device frame like the one T3 Code draws: a thin metal rim and the side
 * keys. The glass is exactly the frame's aspect, so a click's position on it
 * is its position on the device and the live display is never letterboxed.
 * It fits whichever of the stage's width or height runs out first.
 */
const DeviceFrame = ({
  children,
  comments,
  frame,
  highlight,
  picker,
  reserve,
  takeover,
}: {
  readonly children: ReactNode;
  /** The recording's comment pins on this screen. */
  readonly comments: NativeCommentPins | undefined;
  /** The element picker over the glass, while a comment picks its element. */
  readonly picker?: ReactNode;
  readonly frame: AndroidStreamFrame;
  /** An element to outline on the screen, as Screen elements points at it. */
  readonly highlight: ScreenBox | null;
  /**
   * Room kept clear on each side of the centred row for the cards beside it,
   * so a wide landscape frame shrinks rather than pushing them off the stage.
   */
  readonly reserve: number;
  readonly takeover: boolean;
}) => (
  <div
    className="relative shrink-0"
    style={{
      width: `max(0px, min(100cqw - ${RAIL_SPACE + reserve * 2}px, calc((100cqh - 24px) * ${frame.width} / ${frame.height} + 24px)))`,
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
    <div
      className={cn(
        "w-full rounded-[2.75rem] bg-gradient-to-b from-neutral-500 via-neutral-700 to-neutral-600 p-[3px] shadow-2xl transition-shadow dark:ring-1 dark:ring-white/15",
        // Takeover: the person drives, and the frame says so.
        takeover &&
          "ring-brand shadow-[0_0_0_7px_color-mix(in_oklch,var(--brand)_22%,transparent)] ring-2 dark:ring-2"
      )}
    >
      <div className="w-full rounded-[2.6rem] bg-neutral-950 p-[9px]">
        <div
          className="relative w-full overflow-hidden rounded-[2.1rem] bg-neutral-950"
          style={{ aspectRatio: `${frame.width} / ${frame.height}` }}
        >
          {children}
          {comments === undefined ? null : (
            <CommentPinLayer comments={comments} />
          )}
          {picker}
          {highlight === null ? null : (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute rounded-md bg-sky-500/15 shadow-[0_0_0_2px_var(--color-sky-500)] transition-[left,top,width,height] duration-150 motion-reduce:transition-none"
              data-slot="screen-element-highlight"
              style={{
                height: `${highlight.height * 100}%`,
                left: `${highlight.left * 100}%`,
                top: `${highlight.top * 100}%`,
                width: `${highlight.width * 100}%`,
              }}
            />
          )}
        </div>
      </div>
    </div>
  </div>
);

/** A device navigation key, by the `KeyboardEvent.key` it is forwarded as. */
export type DeviceKey = "AppSwitch" | "GoBack" | "GoHome";

interface RailKey {
  readonly icon: typeof ChevronLeftIcon;
  readonly key: DeviceKey;
  readonly label: string;
}

/**
 * Android's navigation keys, in the order the device draws them. Native
 * agents use the whole OS (ADR 0067), so each key works over any app.
 */
const ANDROID_KEYS = [
  { icon: ChevronLeftIcon, key: "GoBack", label: "Back" },
  { icon: CircleIcon, key: "GoHome", label: "Home" },
  { icon: SquareIcon, key: "AppSwitch", label: "Recents" },
] as const satisfies readonly RailKey[];

/** iOS has no system Back (ADR 0083): Home and the App Switcher only. */
const IOS_KEYS = [
  { icon: CircleIcon, key: "GoHome", label: "Home" },
  { icon: SquareIcon, key: "AppSwitch", label: "App Switcher" },
] as const satisfies readonly RailKey[];

/** A phone on its side: the orientation the rotate button turns the device to. */
const LandscapePhoneIcon = () => <SmartphoneIcon className="rotate-90" />;

/** The cards the rail opens beside itself. */
export type DeviceCard = "elements" | "settings" | "stream";
const deviceCardTitles: Record<DeviceCard, string> = {
  elements: "Screen elements",
  settings: "Device settings",
  stream: "Stream diagnostics",
};

const Icon = ({ icon: Glyph }: { readonly icon: ComponentType }) => <Glyph />;

/**
 * Sends a Device setting. `onApplied` runs once the device accepts it, so a
 * refused or declined change never reads as this session's.
 */
export type EmulateDevice = (
  change: NativeEmulationChange,
  onApplied?: () => void
) => void;

/** The Device settings this session changed from the rail. */
export type ChangedSettings = ReadonlySet<"appearance" | "location">;
const noChangedSettings: ChangedSettings = new Set();

/**
 * How many settings this session changed away from the device's own: dark
 * appearance and a location. What the device already reported is its
 * environment, not a change, so it counts for nothing.
 */
const changedSettingCount = (
  emulation: NativeEmulation | undefined,
  changed: ChangedSettings
) =>
  (changed.has("appearance") && emulation?.appearance === "dark" ? 1 : 0) +
  (changed.has("location") && emulation?.location ? 1 : 0);

/**
 * The rail beside the frame (ADR 0082): the platform's device keys and
 * Rotate, then Device settings, then Screen elements and Stream diagnostics.
 * What drives the device acts only while the user is in control; Stream
 * diagnostics is always there.
 */
export const DeviceRail = ({
  canAct,
  card,
  changed = noChangedSettings,
  elements,
  emulation,
  lockedReason,
  onCard,
  onEmulate,
  onKey,
  platform,
  streamLive,
}: {
  readonly canAct: boolean;
  readonly card: DeviceCard | null;
  /** The settings this session changed, which the settings badge counts. */
  readonly changed?: ChangedSettings;
  /** How many elements Screen elements would list. */
  readonly elements: number;
  readonly emulation: NativeEmulation | undefined;
  /** Why the device's controls are locked, read after their names. */
  readonly lockedReason?: string | undefined;
  readonly onCard: (card: DeviceCard) => void;
  readonly onEmulate: (change: NativeEmulationChange) => void;
  readonly onKey: (key: DeviceKey) => void;
  /** Picks the platform's keys and names each for assistive technology. */
  readonly platform: "Android" | "iOS";
  readonly streamLive: boolean;
}) => {
  const landscape = emulation?.orientation === "landscape";
  const locked = canAct ? undefined : lockedReason;
  const rotate = landscape ? "Rotate to portrait" : "Rotate to landscape";
  const overrides = changedSettingCount(emulation, changed);
  return (
    <nav
      aria-label="Device controls"
      className="island pointer-events-auto flex w-[52px] shrink-0 flex-col items-center gap-1 p-2"
    >
      {(platform === "iOS" ? IOS_KEYS : ANDROID_KEYS).map(
        ({ icon, key, label }) => (
          <RailButton
            active={false}
            description={locked}
            disabled={!canAct}
            icon={<Icon icon={icon} />}
            key={key}
            label={`${platform} ${label}`}
            onClick={() => onKey(key)}
          />
        )
      )}
      <span aria-hidden="true" className="bg-island-border my-1 h-px w-5" />
      <RailButton
        active={false}
        description={locked}
        disabled={!canAct}
        icon={landscape ? <SmartphoneIcon /> : <LandscapePhoneIcon />}
        label={rotate}
        onClick={() =>
          onEmulate({
            _tag: "orientation",
            orientation: landscape ? "portrait" : "landscape",
          })
        }
      />
      <RailButton
        active={card === "settings"}
        badge={
          overrides === 0 ? undefined : (
            <RailBadge tone="info">{overrides}</RailBadge>
          )
        }
        description={locked}
        disabled={!canAct}
        icon={<SlidersHorizontalIcon />}
        label="Device settings"
        onClick={() => onCard("settings")}
      />
      <span aria-hidden="true" className="bg-island-border my-1 h-px w-5" />
      <RailButton
        active={card === "elements"}
        description={
          locked ?? `${elements} element${elements === 1 ? "" : "s"} on screen`
        }
        disabled={!canAct || elements === 0}
        icon={<ListIcon />}
        label="Screen elements"
        onClick={() => onCard("elements")}
      />
      <RailButton
        active={card === "stream"}
        badge={<RailDot status={streamLive ? "live" : "lost"} />}
        description={streamLive ? "Live" : "Not live"}
        icon={<ActivityIcon />}
        label="Stream diagnostics"
        onClick={() => onCard("stream")}
      />
    </nav>
  );
};

/**
 * Appearance and location for the device (ADR 0082). Location uses the
 * browser Emulation's fields; on a device it moves the emulator or
 * simulator itself. A location reads as applied only once this session set
 * it: the one the device reported was already there.
 */
const DeviceSettings = ({
  canAct,
  changed,
  emulation,
  onEmulate,
  platform,
}: {
  readonly canAct: boolean;
  readonly changed: ChangedSettings;
  readonly emulation: NativeEmulation | undefined;
  readonly onEmulate: (change: NativeEmulationChange) => void;
  readonly platform: "Android" | "iOS";
}) => {
  const [errorAtom] = useState(() => Atom.make<string | null>(null));
  const [error, setError] = useAtom(errorAtom);
  return (
    <div className="space-y-4 text-xs">
      <div className="flex min-h-[34px] items-center justify-between gap-3">
        <span className="text-muted-foreground font-medium">Appearance</span>
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
      </div>
      <fieldset className="min-w-0 space-y-2">
        <legend className="text-muted-foreground mb-2 font-medium">
          Location
        </legend>
        <LocationFields
          applied={changed.has("location") ? emulation?.location : undefined}
          disabled={!canAct}
          onApply={(location) => onEmulate({ _tag: "location", ...location })}
          onError={(message) => setError(message ?? null)}
        />
        {error === null ? null : (
          <p className="text-destructive" role="alert">
            {error}
          </p>
        )}
      </fieldset>
      <p className="text-muted-foreground text-pretty">
        Applied to the {platform === "Android" ? "emulator" : "simulator"} now.
        The Flow records them as Teaching evidence.
      </p>
    </div>
  );
};

/** Each stream state as Stream diagnostics' state row reads it. */
const streamWords: Record<NativeStreamState, string> = {
  connecting: "Connecting…",
  live: "Live",
  lost: "Lost · no frame after 5 tries",
  reconnecting: "Reconnecting…",
  secure: "Secure window · frames hidden",
  unclassified: "Screen hidden",
  unsupported: "This browser cannot decode the stream",
};

/** How often the open card re-reads the stream's running counts. */
const STREAM_READ_INTERVAL = "500 millis";

/**
 * Re-renders the open card on a steady beat, so it reads the stream's counts
 * fresh. The counts are read at render, never kept from when the card
 * opened, so a re-render for any reason (the stream going live, a parent
 * update) shows them current, and re-renders never restart the beat.
 */
const useStreamBeat = () => {
  const clock = useWorkspaceRefreshClock();
  const [beatAtom] = useState(() => Atom.make(0));
  const [, setBeat] = useAtom(beatAtom);
  useEffect(() => {
    const fiber = Effect.runFork(
      Effect.gen(function* readStream() {
        while (true) {
          yield* Effect.sleep(STREAM_READ_INTERVAL);
          setBeat((beat) => beat + 1);
        }
      }).pipe(Effect.provideService(Clock.Clock, clock))
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [clock, setBeat]);
};

const streamDot = (state: NativeStreamState) => {
  if (state === "live") {
    return "bg-status-ready";
  }
  return state === "connecting" || state === "reconnecting"
    ? "bg-brand"
    : "bg-status-recording";
};

/** A latency not yet measured reads as a dash, never as a missing stream. */
const milliseconds = (value: number | undefined) =>
  value === undefined ? "—" : `${value.toFixed(1)} ms`;

const StreamDiagnostics = ({
  platform,
  since,
  stream,
}: {
  readonly platform: "Android" | "iOS";
  /** When this stage started, so earlier sessions' input is not counted. */
  readonly since: number;
  readonly stream: NativeStream;
}) => {
  useStreamBeat();
  const stats = stream.stats();
  const reading = readNativeStream(
    stats,
    platform === "Android" ? "android" : "ios",
    since
  );
  const live = stream.state === "live";
  return (
    <div className="grid gap-3 text-xs">
      <div className="bg-island-hover flex min-h-10 items-center gap-2 rounded-xl py-1 pr-1 pl-3 text-sm font-medium">
        <span
          aria-hidden="true"
          className={cn(
            "size-2 shrink-0 rounded-full",
            streamDot(stream.state)
          )}
        />
        <span>
          {/* Only the state is announced; the frame rate changes too often. */}
          <span role="status">{streamWords[stream.state]}</span>
          {live && stats.frames.length > 0
            ? ` · ${reading.framesPerSecond} fps`
            : null}
        </span>
        {stream.state === "lost" && stream.onReconnect !== undefined ? (
          <Button
            className="ml-auto"
            onClick={stream.onReconnect}
            size="sm"
            variant="secondary"
          >
            Reconnect device stream
          </Button>
        ) : null}
      </div>
      <dl
        aria-label="Stream diagnostics"
        className="[&_dt]:text-muted-foreground grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5 [&_dd]:text-right [&_dd]:font-mono [&_dd]:tabular-nums"
      >
        <dt>Device</dt>
        <dd>{stream.device}</dd>
        <dt>Stream</dt>
        <dd>
          {stats.width === 0
            ? "—"
            : `${stream.format} · ${stats.width} × ${stats.height}`}
        </dd>
        <dt>Input to frame, p95</dt>
        <dd>{milliseconds(reading.inputToFrameP95Ms)}</dd>
        <dt>Decode, p95</dt>
        <dd>{milliseconds(reading.decodeP95Ms)}</dd>
        <dt>Decoded / dropped</dt>
        <dd>
          {stats.decoded.toLocaleString()} / {stats.dropped.toLocaleString()}
        </dd>
      </dl>
      <p className="text-muted-foreground">
        Last {NATIVE_FRAME_SAMPLES} decoded frames.
      </p>
    </div>
  );
};

/** What a native stage's Stream diagnostics needs from its stream. */
export interface NativeStream {
  readonly device: string;
  /** The stream's format when it doesn't report a codec, such as JPEG. */
  readonly format: string;
  readonly onReconnect?: (() => void) | undefined;
  readonly state: NativeStreamState;
  /** Reads the stream's running counts; they change every frame. */
  readonly stats: () => NativeStreamStats;
}

/**
 * A Teaching comment picking the element it attaches to. While `picking`,
 * the glass is a picker: pointing outlines the element under the pointer, a
 * click attaches it, and nothing reaches the device. Screen elements opens
 * beside it, so a keyboard can attach any element too.
 */
export interface NativeElementPick {
  /** The element the comment holds, outlined while the comment is open. */
  readonly attached: AttachedElement | undefined;
  readonly picking: boolean;
  readonly onCancel: () => void;
  readonly onPick: (element: AttachedElement) => void;
}

/** The glass as an element picker: an outline follows the pointer, a click attaches. */
const ElementPicker = ({
  observation,
  onHover,
  onPick,
}: {
  readonly observation: AndroidWorkspaceObservation;
  readonly onHover: (box: ScreenBox | null) => void;
  readonly onPick: (element: AttachedElement) => void;
}) => {
  const nodeAt = (event: ReactPointerEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return rect.width <= 0 || rect.height <= 0
      ? undefined
      : elementAt(
          observation,
          (event.clientX - rect.left) / rect.width,
          (event.clientY - rect.top) / rect.height
        );
  };
  return (
    <div
      // Pointer-only: Screen elements is the picker's keyboard path.
      aria-hidden="true"
      className="absolute inset-0 z-20 cursor-crosshair touch-none"
      data-slot="element-picker"
      onPointerDown={(event) => event.preventDefault()}
      onPointerLeave={() => onHover(null)}
      onPointerMove={(event) => {
        const node = nodeAt(event);
        onHover(
          node === undefined ? null : (elementBox(observation, node) ?? null)
        );
      }}
      onPointerUp={(event) => {
        const node = nodeAt(event);
        if (node !== undefined) {
          onHover(null);
          onPick(attachedElement(observation, node));
        }
      }}
    />
  );
};

/**
 * What a pick adds to the stage while it picks: the picker over the glass
 * and Screen elements' attach. Nothing while no comment is picking.
 */
const activePick = (
  pick: NativeElementPick | undefined,
  observation: AndroidWorkspaceObservation | null,
  onHover: (box: ScreenBox | null) => void
) => {
  if (pick?.picking !== true || observation === null) {
    return;
  }
  return {
    attach: (node: ObservedNode) => {
      onHover(null);
      pick.onPick(attachedElement(observation, node));
    },
    cancel: pick.onCancel,
    picker: (
      <ElementPicker
        observation={observation}
        onHover={onHover}
        onPick={pick.onPick}
      />
    ),
  };
};

/** The element under the pointer, else the one the open comment holds. */
const stageOutline = (
  hovered: ScreenBox | null,
  pick: NativeElementPick | undefined
) => hovered ?? pick?.attached?.box ?? null;

/**
 * The device on its stage: the frame centred and fitted, its rail beside it,
 * the rail's cards beside the rail, and the Field Variable card (`leading`)
 * on the frame's other side. Nothing but the glass's own content draws over
 * the screen, so every touch on it reaches the device (ADR 0076), except
 * while a comment picks its element (ADR 0088).
 */
export const NativeStage = ({
  busy = false,
  canAct,
  children,
  comments,
  emulation,
  frame,
  leading,
  lockedReason,
  observation,
  onActivate,
  onEmulate,
  onKey,
  pick,
  platform,
  stream,
  takeover,
}: {
  readonly busy?: boolean;
  readonly canAct: boolean;
  /** The glass's content: the live stream and its states. */
  readonly children: ReactNode;
  readonly emulation: NativeEmulation | undefined;
  readonly frame: AndroidStreamFrame;
  readonly leading?: ReactNode;
  readonly lockedReason: string | undefined;
  readonly observation: AndroidWorkspaceObservation | null;
  readonly onActivate: (inputs: readonly NativeInput[]) => void;
  readonly onEmulate: EmulateDevice;
  readonly onKey: (key: DeviceKey) => void;
  readonly pick?: NativeElementPick | undefined;
  /** The recording's comment pins, while Teaching records. */
  readonly comments?: NativeCommentPins | undefined;
  readonly platform: "Android" | "iOS";
  readonly stream: NativeStream;
  readonly takeover: boolean;
}) => {
  const [cardAtom] = useState(() => Atom.make<DeviceCard | null>(null));
  const [card, setCard] = useAtom(cardAtom);
  const [highlightAtom] = useState(() => Atom.make<ScreenBox | null>(null));
  const [highlight, setHighlight] = useAtom(highlightAtom);
  const [changedAtom] = useState(() => Atom.make(noChangedSettings));
  const [changed, setChanged] = useAtom(changedAtom);
  const [since] = useState(() => performance.now());
  const active = activePick(pick, observation, setHighlight);
  const stage = useRef<HTMLElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  // Losing control closes what only the person in control can use. A pick
  // lists the screen's elements beside it.
  let shown = card === "stream" || canAct ? card : null;
  if (active !== undefined) {
    shown = "elements";
  }
  const close = () => {
    // Closing removes what has focus; it goes back to the card's rail button.
    const focused = cardRef.current?.contains(document.activeElement) ?? false;
    setCard(null);
    setHighlight(null);
    active?.cancel();
    if (focused && shown !== null) {
      stage.current
        ?.querySelector<HTMLButtonElement>(
          `nav button[aria-label="${deviceCardTitles[shown]}"]`
        )
        ?.focus();
    }
  };
  const onEscape = useEffectEvent((event: KeyboardEvent) => {
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      close();
    }
  });
  useEffect(() => {
    if (shown === null) {
      return;
    }
    globalThis.addEventListener("keydown", onEscape);
    return () => globalThis.removeEventListener("keydown", onEscape);
  }, [shown]);
  const hasLeading = leading !== undefined && leading !== null;
  const reserve = Math.max(
    hasLeading ? LEADING_SPACE : 0,
    shown === null ? 0 : CARD_SPACE
  );
  return (
    <section
      aria-busy={busy}
      aria-label={platform === "Android" ? "Android device" : "iOS simulator"}
      className={cn(
        "relative grid size-full min-h-0 min-w-0 place-items-center",
        busy && "cursor-progress"
      )}
      ref={stage}
      // A size container has no width of its own, so its parent gives it one.
      style={{ containerType: "size" }}
    >
      {active === undefined ? null : (
        <InspectHint error={undefined} verb="Tap" />
      )}
      <div className="relative flex items-center gap-3">
        {hasLeading ? (
          <div className="absolute top-1/2 right-full z-30 mr-3 -translate-y-1/2">
            {leading}
          </div>
        ) : null}
        <DeviceFrame
          comments={comments}
          frame={frame}
          highlight={stageOutline(highlight, pick)}
          picker={active?.picker}
          reserve={reserve}
          takeover={takeover}
        >
          {children}
        </DeviceFrame>
        <DeviceRail
          canAct={canAct}
          card={shown}
          changed={changed}
          elements={screenElementCount(observation)}
          emulation={emulation}
          lockedReason={lockedReason}
          onCard={(next) => (shown === next ? close() : setCard(next))}
          onEmulate={onEmulate}
          onKey={onKey}
          platform={platform}
          streamLive={stream.state === "live"}
        />
        {shown === null ? null : (
          <section
            aria-label={deviceCardTitles[shown]}
            ref={cardRef}
            className="island bg-island-solid pointer-events-auto absolute top-1/2 left-full z-30 ml-3 flex max-h-[min(40rem,100cqh)] w-80 -translate-y-1/2 flex-col overflow-hidden rounded-[18px]"
          >
            <header className="border-island-border flex h-11 shrink-0 items-center border-b pr-1.5 pl-4">
              <h2 className="text-sm font-medium">{deviceCardTitles[shown]}</h2>
              <Button
                aria-label={`Close ${deviceCardTitles[shown]}`}
                className="ml-auto"
                onClick={close}
                size="icon-sm"
                variant="ghost"
              >
                <XIcon />
              </Button>
            </header>
            <div className="min-h-0 overflow-y-auto p-4">
              {shown === "settings" ? (
                <DeviceSettings
                  canAct={canAct}
                  changed={changed}
                  emulation={emulation}
                  onEmulate={(change) => {
                    const tag = change._tag;
                    onEmulate(
                      change,
                      tag === "orientation"
                        ? undefined
                        : () =>
                            setChanged((current): ChangedSettings =>
                              new Set(current).add(tag)
                            )
                    );
                  }}
                  platform={platform}
                />
              ) : null}
              {shown === "elements" ? (
                <ScreenElements
                  disabled={active === undefined && (!canAct || busy)}
                  observation={observation}
                  onActivate={(inputs) => {
                    onActivate(inputs);
                    close();
                  }}
                  onAttach={active?.attach}
                  onHover={setHighlight}
                />
              ) : null}
              {shown === "stream" ? (
                <StreamDiagnostics
                  platform={platform}
                  since={since}
                  stream={stream}
                />
              ) : null}
            </div>
          </section>
        )}
      </div>
    </section>
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

/** What the glass says for one reason a prepared session paused. */
interface PauseCopy {
  readonly detail: string;
  readonly icon: typeof UnplugIcon;
  readonly title: string;
}

/** The copy for each pause code that has its own; others read as paused. */
const pauseCopies = new Map<string, PauseCopy>([
  [
    "capture_incomplete",
    {
      detail:
        "The device is still connected. Recover from the dock to capture this screen again on the same device.",
      icon: ScanEyeIcon,
      title: "Screen capture incomplete",
    },
  ],
  [
    "device_disconnected",
    {
      detail: "Recover the same device from the dock.",
      icon: UnplugIcon,
      title: "Device disconnected",
    },
  ],
  [
    "device_mismatch",
    {
      detail:
        "The selected device's identity changed. Recover the same device from the dock.",
      icon: UnplugIcon,
      title: "Device changed",
    },
  ],
  [
    "secure_window",
    {
      detail:
        "This window cannot provide outcome evidence. The outcome is inconclusive.",
      icon: ShieldAlertIcon,
      title: "Secure window, not visible",
    },
  ],
]);
const otherPause: PauseCopy = {
  detail: "Recover the same device from the dock.",
  icon: CirclePauseIcon,
  title: "Execution paused",
};
const pauseCopy = (code: string | undefined) =>
  (code === undefined ? undefined : pauseCopies.get(code)) ?? otherPause;

/**
 * The live device: the frame with the stream filling its glass and its rail
 * on the right. While the user can act, what they do on the glass goes to
 * `onInput` as Forwarded Input.
 */
export const AndroidDevice = ({
  agentDriving,
  canAct,
  cleanup,
  device,
  emulation,
  ended = false,
  leading,
  live,
  lockedReason,
  observation,
  onDeviceKey,
  onEmulate,
  onInput,
  paused,
  pending,
  pauseCode,
  pick,
  comments,
  sessionId,
  takeover = false,
  unavailable,
}: {
  readonly canAct: boolean;
  /** The session's cleanup state, so a purge drops the kept screen. */
  readonly cleanup: string;
  /** The device's name, for Stream diagnostics. */
  readonly device: string;
  /** The session released its device for good; nothing will stream again. */
  readonly ended?: boolean;
  /** The Field Variable card, beside the frame. */
  readonly leading?: ReactNode;
  /** Whether the session holds a prepared device to stream. */
  readonly live: boolean;
  readonly lockedReason: string | undefined;
  readonly observation: AndroidWorkspaceObservation | null;
  readonly onDeviceKey: (key: DeviceKey) => void;
  /** The device's Emulation as last read or set. */
  readonly emulation?: NativeEmulation | undefined;
  readonly onEmulate: EmulateDevice;
  readonly onInput: (input: NativeInput) => void;
  /** The agent holds the device, so its touches are drawn on the screen. */
  readonly agentDriving: boolean;
  readonly paused: boolean;
  /** Why the session paused: the code of its last Capture Gap. */
  readonly pauseCode?: string | undefined;
  readonly pending: boolean;
  /** A Teaching comment picking its element on the screen. */
  readonly pick?: NativeElementPick | undefined;
  /** The recording's comment pins, while Teaching records. */
  readonly comments?: NativeCommentPins | undefined;
  readonly sessionId: AgentSessionId;
  readonly takeover?: boolean;
  /** What the glass says while there is no stream. */
  readonly unavailable: string;
}) => {
  const [frameAtom] = useState(() => Atom.make(DEFAULT_FRAME));
  const [frame, setFrame] = useAtom(frameAtom);
  const streamState = useAtomValue(androidStreamStateAtom(sessionId));
  const setRetry = useAtomSet(androidStreamRetryAtom(sessionId));
  const secure = paused && pauseCode === "secure_window";
  const pause = pauseCopy(pauseCode);
  const PauseIcon = pause.icon;
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
  const onReconnect = () => setRetry((value) => value + 1);
  let state: NativeStreamState = "connecting";
  if (secure) {
    state = "secure";
  } else if (live) {
    state = streamState;
  }
  return (
    <NativeStage
      busy={pending}
      canAct={canAct}
      emulation={emulation}
      frame={frame}
      leading={leading}
      lockedReason={lockedReason}
      observation={observation}
      onActivate={(inputs) => {
        for (const value of inputs) {
          onInput(value);
        }
      }}
      onEmulate={onEmulate}
      onKey={onDeviceKey}
      pick={pick}
      comments={comments}
      platform="Android"
      stream={{
        device,
        format: "H.264",
        onReconnect: live ? onReconnect : undefined,
        state,
        stats: () => androidStreamStats(sessionId),
      }}
      takeover={takeover}
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
      {live && !secure ? (
        <NativeAgentTouch
          frame={frame}
          sessionId={sessionId}
          visible={agentDriving}
        />
      ) : null}
      {paused ? (
        <div className="absolute inset-0 grid place-items-center p-6 text-center">
          <div className="bg-background space-y-1 rounded-2xl border p-4 shadow-lg">
            <PauseIcon className="mx-auto size-6 text-amber-600" />
            <p className="text-sm font-medium">{pause.title}</p>
            <p className="text-muted-foreground text-xs">{pause.detail}</p>
          </div>
        </div>
      ) : null}
    </NativeStage>
  );
};
