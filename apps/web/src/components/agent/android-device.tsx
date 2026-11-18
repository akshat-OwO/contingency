import type {
  AgentSessionId,
  AndroidWorkspaceObservation,
  NativeEmulation,
  NativeEmulationChange,
  NativeInput,
} from "@contingency/protocol";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
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
import type { ComponentType, ReactNode } from "react";

import { RailBadge, RailButton } from "@/components/browser/inspector-rail";
import { LocationFields } from "@/components/browser/location-fields";
import { SegmentedControl } from "@/components/browser/segmented-control";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { AndroidLiveStream } from "./android-live-stream";
import { DeviceLastScreen } from "./android-run-summary";
import type { AndroidStreamFrame } from "./android-stream-point";
import { ScreenElements } from "./device-elements";
import { NativeAgentTouch } from "./native-agent-touch";
import type {
  NativeStreamState,
  NativeStreamStats,
} from "./native-stream-status";
import {
  androidStreamRetryAtom,
  androidStreamStateAtom,
  androidStreamStats,
} from "./native-stream-store";
import { screenElementCount } from "./screen-elements";
import type { ScreenBox } from "./screen-elements";

/** Most phones are about 9 by 20; the frame takes the real ratio once decoded. */
const DEFAULT_FRAME: AndroidStreamFrame = { height: 2400, width: 1080 };

/** The rail's column: 52px wide, 12px from the frame. */
const RAIL_SPACE = 64;
/** A rail card: 320px wide, 12px from the rail. */
const CARD_SPACE = 332;
/** The Field Variable card: 288px wide, 12px from the frame. */
const LEADING_SPACE = 300;

/**
 * A device frame like the one T3 Code draws: a thin metal rim and the side
 * keys. The glass is exactly the frame's aspect, so a click's position on it
 * is its position on the device and the live display is never letterboxed.
 * It fits whichever of the stage's width or height runs out first.
 */
const DeviceFrame = ({
  children,
  frame,
  highlight,
  reserve,
  takeover,
}: {
  readonly children: ReactNode;
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
 * The rail beside the frame (ADR 0082): the platform's device keys and
 * Rotate, then Device settings, then Screen elements and Stream diagnostics.
 * What drives the device acts only while the user is in control; Stream
 * diagnostics is always there.
 */
export const DeviceRail = ({
  canAct,
  card,
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
  const overrides =
    (emulation?.appearance === "dark" ? 1 : 0) + (emulation?.location ? 1 : 0);
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
        badge={
          <span
            aria-hidden="true"
            className={cn(
              "ring-background absolute top-1.5 right-1.5 size-2 rounded-full ring-2",
              streamLive ? "bg-emerald-500" : "bg-destructive"
            )}
          />
        }
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
 * simulator itself.
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
  const [errorAtom] = useState(() => Atom.make<string | null>(null));
  const [error, setError] = useAtom(errorAtom);
  return (
    <div className="space-y-4">
      <section className="space-y-1.5">
        <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          Appearance
        </h3>
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
        <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          Location
        </h3>
        <LocationFields
          applied={emulation?.location}
          disabled={!canAct}
          onApply={(location) => onEmulate({ _tag: "location", ...location })}
          onError={(message) => setError(message ?? null)}
        />
        {error === null ? null : (
          <p className="text-destructive text-xs" role="alert">
            {error}
          </p>
        )}
      </section>
    </div>
  );
};

/** Copy for each stream state, as Stream diagnostics reads it. */
const streamWords: Record<NativeStreamState, string> = {
  connecting: "Connecting…",
  live: "Live",
  lost: "Lost: no frame after five tries",
  reconnecting: "Reconnecting…",
  secure: "Secure window: frames hidden",
  unclassified: "Screen hidden",
  unsupported: "This browser cannot decode the stream",
};

/** Samples the stream's running counts while the card is open. */
const useStreamStats = (stats: () => NativeStreamStats) => {
  const [snapshotAtom] = useState(() => Atom.make(stats()));
  const [snapshot, setSnapshot] = useAtom(snapshotAtom);
  useEffect(() => {
    const timer = setInterval(() => setSnapshot(stats()), 1000);
    return () => clearInterval(timer);
  }, [setSnapshot, stats]);
  return snapshot;
};

const streamDot = (state: NativeStreamState) => {
  if (state === "live") {
    return "bg-emerald-500";
  }
  return state === "connecting" || state === "reconnecting"
    ? "bg-brand"
    : "bg-destructive";
};

const StreamDiagnostics = ({ stream }: { readonly stream: NativeStream }) => {
  const stats = useStreamStats(stream.stats);
  return (
    <div className="space-y-3">
      <div
        className="bg-island-hover flex min-h-10 items-center gap-2 rounded-xl py-1 pr-1 pl-3 text-sm font-medium"
        role="status"
      >
        <span
          aria-hidden="true"
          className={cn(
            "size-2 shrink-0 rounded-full",
            streamDot(stream.state)
          )}
        />
        {streamWords[stream.state]}
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
        className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5 text-xs"
      >
        <dt className="text-muted-foreground">Device</dt>
        <dd className="text-right font-mono">{stream.device}</dd>
        <dt className="text-muted-foreground">Stream</dt>
        <dd className="text-right font-mono">
          {stats.width === 0
            ? "Waiting for frames"
            : `${stats.codec ?? stream.format} · ${stats.width} × ${stats.height}`}
        </dd>
        <dt className="text-muted-foreground">Frames shown</dt>
        <dd className="text-right font-mono">
          {stats.decoded.toLocaleString()}
        </dd>
        <dt className="text-muted-foreground">Keyframe rejoins</dt>
        <dd className="text-right font-mono">{stats.resyncs}</dd>
      </dl>
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
 * The device on its stage: the frame centred and fitted, its rail beside it,
 * the rail's cards beside the rail, and the Field Variable card (`leading`)
 * on the frame's other side. Nothing but the glass's own content draws over
 * the screen, so every touch on it reaches the device (ADR 0076).
 */
export const NativeStage = ({
  busy = false,
  canAct,
  children,
  emulation,
  frame,
  leading,
  lockedReason,
  observation,
  onActivate,
  onEmulate,
  onKey,
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
  readonly onEmulate: (change: NativeEmulationChange) => void;
  readonly onKey: (key: DeviceKey) => void;
  readonly platform: "Android" | "iOS";
  readonly stream: NativeStream;
  readonly takeover: boolean;
}) => {
  const [cardAtom] = useState(() => Atom.make<DeviceCard | null>(null));
  const [card, setCard] = useAtom(cardAtom);
  const [highlightAtom] = useState(() => Atom.make<ScreenBox | null>(null));
  const [highlight, setHighlight] = useAtom(highlightAtom);
  const stage = useRef<HTMLElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  // Losing control closes what only the person in control can use.
  const shown = card === "stream" || canAct ? card : null;
  const close = () => {
    // Closing removes what has focus; it goes back to the card's rail button.
    const focused = cardRef.current?.contains(document.activeElement) ?? false;
    setCard(null);
    setHighlight(null);
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
      <div className="relative flex items-center gap-3">
        {hasLeading ? (
          <div className="absolute top-1/2 right-full z-30 mr-3 -translate-y-1/2">
            {leading}
          </div>
        ) : null}
        <DeviceFrame
          frame={frame}
          highlight={highlight}
          reserve={reserve}
          takeover={takeover}
        >
          {children}
        </DeviceFrame>
        <DeviceRail
          canAct={canAct}
          card={shown}
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
                  emulation={emulation}
                  onEmulate={onEmulate}
                />
              ) : null}
              {shown === "elements" ? (
                <ScreenElements
                  disabled={!canAct || busy === true}
                  observation={observation}
                  onActivate={(inputs) => {
                    onActivate(inputs);
                    close();
                  }}
                  onHover={setHighlight}
                />
              ) : null}
              {shown === "stream" ? (
                <StreamDiagnostics stream={stream} />
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
  readonly onEmulate: (change: NativeEmulationChange) => void;
  readonly onInput: (input: NativeInput) => void;
  /** The agent holds the device, so its touches are drawn on the screen. */
  readonly agentDriving: boolean;
  readonly paused: boolean;
  /** Why the session paused: the code of its last Capture Gap. */
  readonly pauseCode?: string | undefined;
  readonly pending: boolean;
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
