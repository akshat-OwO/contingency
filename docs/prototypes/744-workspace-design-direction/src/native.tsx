/**
 * The native session canvas (#764): the Android device or iOS simulator on
 * the stage and everything attached to it. The frame floats on the canvas at
 * the size that fits. Its rail (ADR 0082) sits beside it, cards open beside
 * the rail, and the Field Variable card opens on the frame's other side.
 * Nothing but the agent's touch and your input ring draws over the screen.
 */
import {
  AlertDialog,
  AlertDialogBackdrop,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@ui-sdk/react/alert-dialog";
import { Button } from "@ui-sdk/react/button";
import { Input } from "@ui-sdk/react/input";
import {
  SegmentedControl,
  SegmentedControlIndicator,
  SegmentedControlItem,
} from "@ui-sdk/react/segmented-control";
import { TooltipTrigger } from "@ui-sdk/react/tooltip";
import {
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode, RefObject } from "react";

import { InspectContext, morph, Tip, ToolButton } from "./canvas";
import type { PickedElement } from "./canvas";
import {
  AppSwitcherIcon,
  ActivityIcon,
  BackIcon,
  ChevronIcon,
  CloseIcon,
  ElementsIcon,
  EyeOffIcon,
  HomeKeyIcon,
  KeyIcon,
  LockIcon,
  PinIcon,
  RecentsIcon,
  RefreshIcon,
  RotateIcon,
  SearchIcon,
  SlidersIcon,
  StopIcon,
  WatcherLoader,
} from "./icons";
import { CommentPins, InspectHint } from "./teaching";

/* ------------------------------------------------------------------ model */

export type NativePlatform = "android" | "ios";

/** The device stream, as the stage shows it. */
export type DeviceStage =
  | "connecting"
  | "live"
  | "reconnecting"
  | "lost"
  | "paused"
  | "secure";

export const DEVICE_STAGE_NEXT: Record<DeviceStage, DeviceStage> = {
  connecting: "reconnecting",
  live: "connecting",
  lost: "paused",
  paused: "secure",
  reconnecting: "lost",
  secure: "live",
};

export type RailPlace = "beside" | "edge";

/** The scaffold's stream state and rail placement, shared by every device. */
export interface DeviceCanvas {
  readonly stage: DeviceStage;
  readonly rail: RailPlace;
  readonly onReconnect: () => void;
}

export interface NativeSession {
  readonly id: string;
  readonly flow: string;
  readonly platform: NativePlatform;
  readonly activity: "Teaching" | "Dry Run" | "Guided Run" | "Run";
  readonly control?: "agent" | "user";
  /** True while the agent waits on a request: its touch holds still. */
  readonly waiting: boolean;
}

interface Device {
  readonly name: string;
  readonly what: string;
  /** Logical points: the app lays out at this size and scales to the glass. */
  readonly w: number;
  readonly h: number;
  readonly stream: string;
  readonly keys: readonly {
    readonly label: string;
    readonly icon: () => ReactNode;
    readonly key: string;
  }[];
}

const DEVICES: Record<NativePlatform, Device> = {
  android: {
    h: 800,
    keys: [
      { icon: BackIcon, key: "back", label: "Android Back" },
      { icon: HomeKeyIcon, key: "home", label: "Android Home" },
      { icon: RecentsIcon, key: "recents", label: "Android Recents" },
    ],
    name: "Pixel_9 · Android 16",
    stream: "H.264 · 1080 × 2400",
    w: 360,
    what: "device",
  },
  ios: {
    h: 852,
    keys: [
      { icon: HomeKeyIcon, key: "home", label: "iOS Home" },
      { icon: AppSwitcherIcon, key: "switcher", label: "iOS App Switcher" },
    ],
    name: "iPhone 17 · iOS 26.5",
    stream: "Mirror · 1179 × 2556",
    w: 393,
    what: "simulator",
  },
};

type Card = "settings" | "elements" | "stream";
const CARD_TITLE: Record<Card, string> = {
  elements: "Screen elements",
  settings: "Device settings",
  stream: "Stream diagnostics",
};

interface ScreenElement {
  readonly role: string;
  readonly name: string;
  readonly secure: boolean;
}

const RAIL = 52;
const GAP = 12;
/** Rim and bezel, each side. */
const BEZEL = 12;

const GROUP_OF = (role: string) =>
  role === "textbox"
    ? "Fields"
    : ["button", "switch", "tab", "radio", "link"].includes(role)
      ? "Controls"
      : "Other elements";

/* ------------------------------------------------------------ the screens */

/** The app on the device: enough of one to point at, tap and type into. */
const FakeApp = ({
  platform,
  flow,
  typed,
}: {
  readonly platform: NativePlatform;
  readonly flow: string;
  readonly typed: ReadonlySet<string>;
}) =>
  platform === "android" ? (
    <div className="app-screen android">
      <div aria-hidden="true" className="app-status">
        <span>9:41</span>
        <span className="app-status-icons">
          <i />
          <i />
          <i />
        </span>
      </div>
      <header className="app-bar">
        <span className="app-icon-btn" data-el="button|Navigate up">
          ←
        </span>
        <span className="app-title" data-el="heading|Profile">
          Profile
        </span>
        <span className="app-icon-btn" data-el="button|More options">
          ⋮
        </span>
      </header>
      <div className="app-body">
        <div className="app-avatar-row">
          <span className="app-avatar" data-el="image|Profile photo">
            AL
          </span>
          <span className="app-link" data-el="button|Change photo">
            Change photo
          </span>
        </div>
        <label className="app-field" data-el="textbox|Display name">
          <span>Display name</span>
          <b>Ada L.</b>
        </label>
        <label className="app-field" data-el="textbox|Email">
          <span>Email</span>
          <b>ada@example.com</b>
        </label>
        <label className="app-field" data-el="textbox|Password" data-secure="">
          <span>Password</span>
          <b>{typed.has("Password") ? "••••••••••" : ""}</b>
        </label>
        <div className="app-switch-row" data-el="switch|Public profile">
          Show my profile publicly
          <span className="app-switch" />
        </div>
        <span className="app-primary" data-el="button|Save">
          Save
        </span>
      </div>
      <nav className="app-tabs">
        <span data-el="tab|Home">Home</span>
        <span data-el="tab|Search">Search</span>
        <span data-current="" data-el="tab|Profile">
          Profile
        </span>
      </nav>
      <span aria-hidden="true" className="app-gesture" />
    </div>
  ) : (
    <div className="app-screen ios">
      <div aria-hidden="true" className="app-status">
        <span>9:41</span>
        <span className="app-island" />
        <span className="app-status-icons">
          <i />
          <i />
          <i />
        </span>
      </div>
      <div className="app-body">
        <span className="app-wordmark" data-el="image|Northwind">
          northwind
        </span>
        <h1 className="app-h1" data-el="heading|Create your account">
          Create your account
        </h1>
        <p className="app-sub">Step 2 of 3 · {flow}</p>
        <label className="app-field" data-el="textbox|Email">
          <span>Email</span>
          <b>new.user@example.com</b>
        </label>
        <label className="app-field" data-el="textbox|Password" data-secure="">
          <span>Password</span>
          <b>{typed.has("Password") ? "••••••••••" : ""}</b>
        </label>
        <div className="app-plans">
          <span data-current="" data-el="radio|Free plan">
            Free
          </span>
          <span data-el="radio|Pro plan">Pro</span>
        </div>
        <span className="app-primary" data-el="button|Continue">
          Continue
        </span>
        <span className="app-link center" data-el="link|Sign in instead">
          Already have an account? Sign in
        </span>
      </div>
      <span aria-hidden="true" className="app-home-indicator" />
    </div>
  );

/** The agent's touch (ADR 0046): a dot where it taps, never a pointer. */
const AgentTouch = ({
  screenRef,
  active,
}: {
  readonly screenRef: RefObject<HTMLDivElement | null>;
  readonly active: boolean;
}) => {
  const [at, setAt] = useState({ n: 0, x: 180, y: 360 });
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      const screen = screenRef.current;
      if (!screen) return;
      const targets = [...screen.querySelectorAll<HTMLElement>("[data-el]")];
      const t = targets[Math.floor(Math.random() * targets.length)];
      if (!t) return;
      const box = screen.getBoundingClientRect();
      const r = t.getBoundingClientRect();
      const s = box.width / screen.offsetWidth || 1;
      setAt((p) => ({
        n: p.n + 1,
        x: (r.left - box.left + r.width / 2) / s,
        y: (r.top - box.top + r.height / 2) / s,
      }));
    }, 2100);
    return () => clearInterval(id);
  }, [active, screenRef]);
  return (
    <div
      aria-hidden="true"
      className="agent-cursor"
      data-active={active || undefined}
      data-native=""
      data-testid="agent-cursor"
      style={{ translate: `${at.x}px ${at.y}px` }}
    >
      <span className="agent-ripple" key={at.n} />
      <span className="agent-touch" />
      <span className="agent-tag">Agent</span>
    </div>
  );
};

/* -------------------------------------------------------------- the canvas */

export const NativeCanvas = ({
  session,
  ended = false,
  device: { stage, rail, onReconnect },
  onNotice,
}: {
  readonly session: NativeSession;
  readonly ended?: boolean;
  readonly device: DeviceCanvas;
  readonly onNotice: (text: string, tone?: "info" | "ok" | "error") => void;
}) => {
  const hardware = DEVICES[session.platform];
  const [landscape, setLandscape] = useState(false);
  const [card, setCard] = useState<Card | null>(null);
  const [appearance, setAppearance] = useState("light");
  const [location, setLocation] = useState<string | null>(null);
  const [typing, setTyping] = useState<string | null>(null);
  const [typed, setTyped] = useState<ReadonlySet<string>>(new Set());
  const [variables, setVariables] = useState<readonly string[]>([]);
  const [variableName, setVariableName] = useState("PASSWORD");
  const [hover, setHover] = useState<{
    readonly box: { x: number; y: number; w: number; h: number };
    readonly el: PickedElement;
  } | null>(null);
  const [inspect, setInspect] = useState<
    ((el: PickedElement | null) => void) | null
  >(null);
  const [missed, setMissed] = useState(false);
  const [ripple, setRipple] = useState<{
    x: number;
    y: number;
    n: number;
  } | null>(null);
  const [area, setArea] = useState({ h: 600, w: 900 });
  const areaRef = useRef<HTMLDivElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);

  const agentDrives =
    session.activity !== "Teaching" && session.control !== "user";
  const locked = agentDrives && !ended;
  const lockedReason = "The agent is driving. Take control to use the device.";
  const live = stage === "live" && !ended;
  const canInput = live && !agentDrives;

  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      if (e) setArea({ h: e.contentRect.height, w: e.contentRect.width });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    document.body.dataset.canvas = "native";
    return () => {
      delete document.body.dataset.canvas;
    };
  }, []);

  // A new session starts with its tools closed.
  useEffect(() => {
    setCard(null);
    setTyping(null);
    setInspect(null);
  }, [session.id]);

  // Taking the device away from you closes what only you can use.
  useEffect(() => {
    if (!agentDrives) return;
    setTyping(null);
    setCard((c) => (c === "stream" ? c : null));
  }, [agentDrives]);

  const [lw, lh] = landscape
    ? [hardware.h, hardware.w]
    : [hardware.w, hardware.h];
  const beside = rail === "beside" && !ended;
  const room = {
    h: area.h - 2 * BEZEL,
    w: area.w - 2 * BEZEL - (beside ? RAIL + GAP : 0),
  };
  // Rotating turns the device; it doesn't zoom it. Both orientations draw at
  // the scale that fits the portrait frame, or smaller when landscape needs it.
  const fit = (w: number, h: number) => Math.min(room.w / w, room.h / h);
  const scale = Math.max(
    0.3,
    Math.min(fit(hardware.w, hardware.h), fit(lw, lh))
  );
  const glassW = lw * scale;
  const glassH = lh * scale;
  // Cards sit beside the rail, and the Field Variable card on the frame's
  // other side, when the canvas has room; otherwise they float at its edge.
  const wrapW = glassW + 2 * BEZEL + (beside ? RAIL + GAP : 0);
  const side = (area.w - wrapW) / 2 + 16 - GAP;
  const fits = beside && side >= 360;

  // The screen's elements, as the accessibility tree reports them. The status
  // bar never counts.
  const [elements, setElements] = useState<readonly ScreenElement[]>([]);
  useLayoutEffect(() => {
    const screen = screenRef.current;
    if (!screen) return;
    setElements(
      [...screen.querySelectorAll<HTMLElement>("[data-el]")].map((el) => {
        const [role = "generic", name = ""] = (el.dataset.el ?? "").split("|");
        return { name, role, secure: el.dataset.secure !== undefined };
      })
    );
  }, [session.platform, landscape]);

  const boxOf = (el: HTMLElement) => {
    const screen = screenRef.current;
    if (!screen) return null;
    const box = screen.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const s = box.width / screen.offsetWidth || 1;
    return {
      h: r.height / s,
      w: r.width / s,
      x: (r.left - box.left) / s,
      y: (r.top - box.top) / s,
    };
  };
  const findEl = (name: string, role: string) =>
    screenRef.current?.querySelector<HTMLElement>(
      `[data-el="${role}|${name}"]`
    ) ?? null;
  const pickAt = (target: EventTarget | null) => {
    const el = (target as HTMLElement | null)?.closest<HTMLElement>(
      "[data-el]"
    );
    if (!el) return null;
    const box = boxOf(el);
    const [role = "generic", name = ""] = (el.dataset.el ?? "").split("|");
    return box
      ? { box, el: { name, role }, secure: "secure" in el.dataset }
      : null;
  };

  const tapAt = (x: number, y: number) =>
    setRipple((r) => ({ n: (r?.n ?? 0) + 1, x, y }));

  // Tapping a password field while you drive opens the Field Variable card.
  const tapped = (el: ScreenElement) => {
    if (el.role === "textbox" && el.secure)
      morph(() => setTyping(el.name), ["field-variable"]);
  };

  const bridge = useContext(InspectContext);
  useEffect(() => {
    bridge.current = ended
      ? null
      : (fn) => {
          setMissed(false);
          setInspect(() => fn);
        };
    return () => {
      bridge.current = null;
    };
  }, [bridge, ended]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (inspect) {
        e.preventDefault();
        inspect(null);
        setInspect(null);
        setMissed(false);
        setHover(null);
      } else if (card) {
        e.preventDefault();
        morph(() => setCard(null), ["tool-card"]);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [card, inspect]);

  const toggleCard = (c: Card) =>
    morph(() => setCard(card === c ? null : c), ["tool-card"]);

  const key = (label: string) => {
    onNotice(`${label} sent to the ${hardware.what}.`);
    setTyping(null);
  };

  const streamWord =
    stage === "live"
      ? "Live, 48 ms"
      : stage === "connecting"
        ? "Connecting"
        : stage === "reconnecting"
          ? "Reconnecting"
          : stage === "secure"
            ? "Secure window"
            : stage === "lost"
              ? "Lost"
              : "Paused";

  const railEl = ended ? null : (
    <nav
      aria-label="Device controls"
      className="device-rail island"
      data-place={rail}
    >
      {hardware.keys.map((k) => (
        <ToolButton
          description={locked ? lockedReason : undefined}
          disabled={locked || !live}
          key={k.key}
          label={k.label}
          onClick={() => key(k.label)}
          side="left"
        >
          <k.icon />
        </ToolButton>
      ))}
      <span aria-hidden="true" className="rail-divider" />
      <ToolButton
        description={locked ? lockedReason : undefined}
        disabled={locked || !live}
        label={landscape ? "Rotate to portrait" : "Rotate to landscape"}
        onClick={() => morph(() => setLandscape(!landscape), ["device-frame"])}
        side="left"
      >
        <RotateIcon />
      </ToolButton>
      <ToolButton
        badge={
          appearance === "dark" || location
            ? {
                n: (appearance === "dark" ? 1 : 0) + (location ? 1 : 0),
                tone: "info",
              }
            : null
        }
        description={locked ? lockedReason : undefined}
        disabled={locked}
        label="Device settings"
        onClick={() => toggleCard("settings")}
        pressed={card === "settings"}
        side="left"
      >
        <SlidersIcon />
      </ToolButton>
      <span aria-hidden="true" className="rail-divider" />
      <ToolButton
        description={locked ? lockedReason : `${elements.length} on screen`}
        disabled={locked || !live}
        label="Screen elements"
        onClick={() => toggleCard("elements")}
        pressed={card === "elements"}
        side="left"
      >
        <ElementsIcon />
      </ToolButton>
      <ToolButton
        badge={{ n: "", tone: stage === "live" ? "live" : "danger" }}
        description={streamWord}
        label="Stream diagnostics"
        onClick={() => toggleCard("stream")}
        pressed={card === "stream"}
        side="left"
      >
        <ActivityIcon />
      </ToolButton>
    </nav>
  );

  return (
    <>
      <div
        className="canvas-area native"
        data-ended={ended || undefined}
        data-rail={beside ? "beside" : "edge"}
        ref={areaRef}
        style={{
          ["--rail-space" as string]:
            ended || beside ? "0px" : `${RAIL + GAP}px`,
        }}
      >
        <div className="device-wrap">
          {typing && canInput ? (
            <FieldVariableCard
              fits={side >= 292}
              field={typing}
              name={variableName}
              onEnter={(v) => {
                setTyped((t) => new Set([...t, typing]));
                morph(() => setTyping(null), ["field-variable"]);
                onNotice(`Entered ${v} into ${typing}.`, "ok");
              }}
              onName={setVariableName}
              onRequest={() => {
                const v = variableName.trim().toUpperCase();
                if (v === "") return;
                onNotice(
                  `Asked for ${v}. It goes into ${typing} once it's supplied.`
                );
                setTimeout(
                  () =>
                    setVariables((all) =>
                      all.includes(v) ? all : [...all, v]
                    ),
                  900
                );
              }}
              onStop={() => morph(() => setTyping(null), ["field-variable"])}
              variables={variables}
            />
          ) : null}
          <section
            aria-label={
              session.platform === "android"
                ? "Android device"
                : "iOS simulator"
            }
            className="device-frame"
            data-ended={ended || undefined}
            data-inspect={inspect ? "" : undefined}
            data-morph="device-frame"
            data-orientation={landscape ? "landscape" : "portrait"}
            data-platform={session.platform}
            data-state={ended ? "ended" : stage}
            data-takeover={
              session.control === "user" && !ended ? "" : undefined
            }
            onPointerDown={() => {
              if (card && card !== "stream")
                morph(() => setCard(null), ["tool-card"]);
            }}
          >
            <span aria-hidden="true" className="device-key a" />
            <span aria-hidden="true" className="device-key b" />
            <div className="glass" style={{ height: glassH, width: glassW }}>
              {ended ? (
                <span className="last-frame">
                  <StopIcon />
                  Last frame
                </span>
              ) : null}
              <div
                aria-label={
                  canInput
                    ? `${session.platform === "android" ? "Selected device live display" : "Live iOS viewport"}. Pointer, wheel, and keyboard input go to the ${hardware.what}.`
                    : session.platform === "android"
                      ? "Selected device live display"
                      : "Live iOS viewport"
                }
                aria-roledescription={canInput ? "device display" : undefined}
                className="screen-surface"
                data-appearance={appearance}
                onClick={(e) => {
                  if (!inspect) return;
                  e.preventDefault();
                  const hit = pickAt(e.target);
                  if (!hit) {
                    setMissed(true);
                    return;
                  }
                  inspect({ ...hit.el, box: hit.box });
                  setInspect(null);
                  setHover(null);
                  setMissed(false);
                }}
                onPointerDown={(e) => {
                  if (inspect || !live) return;
                  if (agentDrives) {
                    onNotice(lockedReason);
                    return;
                  }
                  const screen = screenRef.current;
                  if (!screen) return;
                  const box = screen.getBoundingClientRect();
                  tapAt(
                    (e.clientX - box.left) / scale,
                    (e.clientY - box.top) / scale
                  );
                  const hit = pickAt(e.target);
                  if (hit) tapped({ ...hit.el, secure: hit.secure });
                }}
                onPointerLeave={() => {
                  if (inspect) setHover(null);
                }}
                onPointerMove={(e) => {
                  if (inspect) setHover(pickAt(e.target));
                }}
                ref={screenRef}
                role={canInput ? "application" : "img"}
                style={{
                  height: lh,
                  transform: `scale(${scale})`,
                  width: lw,
                }}
              >
                <FakeApp
                  flow={session.flow}
                  platform={session.platform}
                  typed={typed}
                />
                {ripple ? (
                  <span
                    aria-hidden="true"
                    className="input-ripple"
                    key={ripple.n}
                    style={{ left: ripple.x, top: ripple.y }}
                  />
                ) : null}
                {hover ? (
                  <div
                    aria-hidden="true"
                    className="inspect-box"
                    style={{
                      height: hover.box.h,
                      left: hover.box.x,
                      top: hover.box.y,
                      width: hover.box.w,
                    }}
                  >
                    {inspect ? (
                      <span className="inspect-tag mono">
                        {hover.el.role} <b>{hover.el.name}</b>
                      </span>
                    ) : null}
                  </div>
                ) : null}
                {session.activity === "Teaching" && !ended ? (
                  <CommentPins session={session.id} />
                ) : null}
                {ended ? null : (
                  <AgentTouch
                    active={live && agentDrives && !session.waiting}
                    screenRef={screenRef}
                  />
                )}
              </div>
              {ended ? null : (
                <StageVeil
                  onReconnect={onReconnect}
                  platform={session.platform}
                  stage={stage}
                />
              )}
            </div>
          </section>
          {beside ? railEl : null}
          {card && !ended ? (
            <section
              aria-label={CARD_TITLE[card]}
              className="tool-card island device-card"
              data-card={card}
              data-morph="tool-card"
              data-place={fits ? "beside" : "edge"}
            >
              <header className="tool-card-head">
                <h2>{CARD_TITLE[card]}</h2>
                <ToolButton
                  label={`Close ${CARD_TITLE[card]}`}
                  onClick={() => toggleCard(card)}
                >
                  <CloseIcon />
                </ToolButton>
              </header>
              <div className="tool-card-body">
                {card === "settings" ? (
                  <DeviceSettings
                    appearance={appearance}
                    location={location}
                    onAppearance={setAppearance}
                    onLocation={(l) => {
                      setLocation(l);
                      onNotice(
                        l ? `Location set to ${l}.` : "Location cleared.",
                        "ok"
                      );
                    }}
                    platform={session.platform}
                  />
                ) : null}
                {card === "elements" ? (
                  <ScreenElements
                    elements={elements}
                    onChoose={(el) => {
                      const node = findEl(el.name, el.role);
                      const box = node ? boxOf(node) : null;
                      if (box) tapAt(box.x + box.w / 2, box.y + box.h / 2);
                      setHover(null);
                      morph(() => setCard(null), ["tool-card"]);
                      tapped(el);
                    }}
                    onHover={(el) => {
                      const node = el ? findEl(el.name, el.role) : null;
                      const box = node ? boxOf(node) : null;
                      setHover(el && box ? { box, el } : null);
                    }}
                  />
                ) : null}
                {card === "stream" ? (
                  <StreamCard
                    device={hardware}
                    onReconnect={onReconnect}
                    platform={session.platform}
                    stage={stage}
                  />
                ) : null}
              </div>
            </section>
          ) : null}
        </div>
      </div>
      {beside ? null : railEl}
      {inspect ? <InspectHint error={missed} verb="Tap" /> : null}
    </>
  );
};

/* ----------------------------------------------------------------- states */

const StageVeil = ({
  stage,
  platform,
  onReconnect,
}: {
  readonly stage: DeviceStage;
  readonly platform: NativePlatform;
  readonly onReconnect: () => void;
}) => {
  const what = platform === "android" ? "device" : "simulator";
  if (stage === "live") return null;
  if (stage === "connecting")
    return (
      <div className="stage-veil" role="status">
        <WatcherLoader className="veil-watcher" />
        Connecting to the {what}…
      </div>
    );
  if (stage === "reconnecting")
    return (
      <div className="stage-veil" role="status">
        <WatcherLoader className="veil-watcher" />
        The stream was interrupted. Reconnecting…
      </div>
    );
  if (stage === "secure")
    return (
      <div className="stage-veil secure" role="status">
        <EyeOffIcon />
        <strong>Secure window, not visible</strong>
        <span className="hint">
          The app hides this screen from capture. Your input still reaches the{" "}
          {what}.
        </span>
      </div>
    );
  return (
    <div className="stage-veil paused" role="status">
      <strong>
        {stage === "lost"
          ? "The device stream was lost"
          : "Device disconnected"}
      </strong>
      <span className="hint">
        {stage === "lost"
          ? "Five tries in a row brought no frame. Input is held until it comes back."
          : `The ${what} stopped answering. The Run is paused until it's back.`}
      </span>
      {stage === "lost" ? (
        <Button className="btn ghosty" onClick={onReconnect}>
          <RefreshIcon />
          Reconnect device stream
        </Button>
      ) : null}
    </div>
  );
};

/* ------------------------------------------------------------------ cards */

const DeviceSettings = ({
  platform,
  appearance,
  onAppearance,
  location,
  onLocation,
}: {
  readonly platform: NativePlatform;
  readonly appearance: string;
  readonly onAppearance: (v: string) => void;
  readonly location: string | null;
  readonly onLocation: (v: string | null) => void;
}) => {
  const [lat, setLat] = useState("51.5072");
  const [lng, setLng] = useState("-0.1276");
  const valid =
    Math.abs(Number(lat)) <= 90 &&
    Math.abs(Number(lng)) <= 180 &&
    lat.trim() !== "" &&
    lng.trim() !== "" &&
    !Number.isNaN(Number(lat)) &&
    !Number.isNaN(Number(lng));
  return (
    <div className="emu">
      <div className="emu-row">
        <span className="label">Appearance</span>
        <SegmentedControl
          aria-label="Appearance"
          className="segmented"
          onValueChange={(v: unknown) => {
            if (typeof v === "string") onAppearance(v);
          }}
          value={appearance}
        >
          <SegmentedControlIndicator className="segmented-indicator" />
          <SegmentedControlItem className="segmented-item" value="light">
            Light
          </SegmentedControlItem>
          <SegmentedControlItem className="segmented-item" value="dark">
            Dark
          </SegmentedControlItem>
        </SegmentedControl>
      </div>
      <fieldset className="location">
        <legend className="label">
          <PinIcon />
          Location
          {location ? <span className="hint mono">{location}</span> : null}
        </legend>
        <div className="location-inputs">
          <Input
            aria-invalid={!valid || undefined}
            aria-label="Latitude"
            className="input mono compact"
            inputMode="decimal"
            onChange={(e) => setLat(e.currentTarget.value)}
            value={lat}
          />
          <Input
            aria-invalid={!valid || undefined}
            aria-label="Longitude"
            className="input mono compact"
            inputMode="decimal"
            onChange={(e) => setLng(e.currentTarget.value)}
            value={lng}
          />
        </div>
        {valid ? null : (
          <p className="field-error" role="alert">
            Latitude runs from −90 to 90, longitude from −180 to 180.
          </p>
        )}
        <div className="location-actions">
          <Button
            className="pill-btn"
            disabled={!valid}
            onClick={() => onLocation(`${lat}, ${lng}`)}
          >
            Apply
          </Button>
          <Button
            className="pill-btn"
            onClick={() => {
              setLat("51.5246");
              setLng("-0.0841");
              onLocation("51.5246, -0.0841");
            }}
          >
            Use my location
          </Button>
          {location ? (
            <Button className="pill-btn" onClick={() => onLocation(null)}>
              Clear
            </Button>
          ) : null}
        </div>
      </fieldset>
      <p className="emu-foot hint">
        {platform === "android"
          ? "Applied to the emulator now. The Flow records them as Teaching evidence."
          : "Applied to the simulator now. The Flow records them as Teaching evidence."}
      </p>
    </div>
  );
};

const ScreenElements = ({
  elements,
  onChoose,
  onHover,
}: {
  readonly elements: readonly ScreenElement[];
  readonly onChoose: (el: ScreenElement) => void;
  readonly onHover: (el: ScreenElement | null) => void;
}) => {
  const [query, setQuery] = useState("");
  const [showOther, setShowOther] = useState(false);
  const q = query.trim().toLowerCase();
  const shown = elements.filter(
    (e) => q === "" || `${e.name} ${e.role}`.toLowerCase().includes(q)
  );
  const groups = ["Fields", "Controls", "Other elements"]
    .map((g) => ({
      items: shown.filter((e) => GROUP_OF(e.role) === g),
      name: g,
    }))
    .filter((g) => g.items.length > 0);
  return (
    <div className="elements">
      <label className="search">
        <SearchIcon />
        <Input
          aria-label="Filter screen elements"
          autoFocus
          className="search-input"
          onChange={(e) => setQuery(e.currentTarget.value)}
          placeholder="Filter by name or role"
          value={query}
        />
      </label>
      {groups.length === 0 ? (
        <p className="hint">Nothing on screen matches “{query}”.</p>
      ) : null}
      {groups.map((g) => {
        const folded =
          g.name === "Other elements" &&
          groups.length > 1 &&
          !showOther &&
          q === "";
        return (
          <section aria-label={g.name} className="elements-group" key={g.name}>
            {g.name === "Other elements" && groups.length > 1 && q === "" ? (
              <button
                aria-expanded={showOther}
                className="elements-head toggle"
                onClick={() => setShowOther(!showOther)}
                type="button"
              >
                <ChevronIcon />
                {g.name}
                <span className="count quiet">{g.items.length}</span>
              </button>
            ) : (
              <h3 className="elements-head">
                {g.name}
                <span className="count quiet">{g.items.length}</span>
              </h3>
            )}
            {folded ? null : (
              <ul className="elements-list">
                {g.items.map((el) => (
                  <li key={`${el.role}|${el.name}`}>
                    <button
                      aria-label={`${el.role === "textbox" ? "Select" : "Activate"} ${el.name}`}
                      className="element-item"
                      onBlur={() => onHover(null)}
                      onClick={() => onChoose(el)}
                      onFocus={() => onHover(el)}
                      onPointerEnter={() => onHover(el)}
                      onPointerLeave={() => onHover(null)}
                      type="button"
                    >
                      <span className="element-name">
                        {el.secure ? <KeyIcon /> : null}
                        {el.name}
                      </span>
                      <span aria-hidden="true" className="hint mono">
                        {el.role}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
      <p className="emu-foot hint">
        Hover to find it on the screen. Choosing one taps its centre, the same
        input a press on the screen sends.
      </p>
    </div>
  );
};

const StreamCard = ({
  stage,
  device,
  platform,
  onReconnect,
}: {
  readonly stage: DeviceStage;
  readonly device: Device;
  readonly platform: NativePlatform;
  readonly onReconnect: () => void;
}) => (
  <div className="emu">
    <div
      className="stream-state"
      data-state={
        stage === "live"
          ? "live"
          : stage === "connecting" || stage === "reconnecting"
            ? "connecting"
            : "paused"
      }
    >
      <span aria-hidden="true" className="stream-dot" />
      {stage === "live"
        ? `Live · ${platform === "android" ? "60" : "30"} fps`
        : stage === "connecting"
          ? "Connecting…"
          : stage === "reconnecting"
            ? "Reconnecting · try 2 of 5"
            : stage === "lost"
              ? "Lost · no frame after 5 tries"
              : stage === "secure"
                ? "Secure window · frames hidden"
                : "Paused · device disconnected"}
      {stage === "lost" ? (
        <Button className="pill-btn" onClick={onReconnect}>
          <RefreshIcon />
          Reconnect
        </Button>
      ) : null}
    </div>
    <dl aria-label="Stream diagnostics" className="stream-stats">
      <dt>Device</dt>
      <dd className="mono">{device.name}</dd>
      <dt>Stream</dt>
      <dd className="mono">{device.stream}</dd>
      <dt>Input to frame, p95</dt>
      <dd className="mono">{stage === "live" ? "48.2 ms" : "—"}</dd>
      <dt>Decode, p95</dt>
      <dd className="mono">{stage === "live" ? "3.4 ms" : "—"}</dd>
      <dt>Decoded / dropped</dt>
      <dd className="mono">1,812 / 4</dd>
    </dl>
    <p className="emu-foot hint">Last 120 decoded frames.</p>
  </div>
);

const FieldVariableCard = ({
  fits,
  field,
  variables,
  name,
  onName,
  onRequest,
  onEnter,
  onStop,
}: {
  readonly fits: boolean;
  readonly field: string;
  readonly variables: readonly string[];
  readonly name: string;
  readonly onName: (v: string) => void;
  readonly onRequest: () => void;
  readonly onEnter: (v: string) => void;
  readonly onStop: () => void;
}) => (
  <form
    aria-label="Field Variable"
    className="field-variable island"
    data-morph="field-variable"
    data-place={fits ? "beside" : "edge"}
    onSubmit={(e) => {
      e.preventDefault();
      onRequest();
    }}
  >
    <header className="tool-card-head">
      <h2>
        <LockIcon />
        Enter a Variable into {field}
      </h2>
      <Tip label="Stop typing" side="top">
        <TooltipTrigger
          render={
            <Button
              aria-label="Stop typing"
              className="tool-btn"
              onClick={onStop}
              type="button"
            />
          }
        >
          <CloseIcon />
        </TooltipTrigger>
      </Tip>
    </header>
    <div className="tool-card-body">
      <p className="hint">
        A password field never takes typed text. The Flow keeps a Variable here,
        and each Run supplies its own value.
      </p>
      {variables.length > 0 ? (
        <div className="fv-vars">
          {variables.map((v) => (
            <Button
              className="pill-btn wide"
              key={v}
              onClick={() => onEnter(v)}
              type="button"
            >
              <KeyIcon />
              Enter {v}
            </Button>
          ))}
        </div>
      ) : null}
      <div className="fv-request">
        <Input
          aria-label="Variable name"
          className="input mono compact"
          onChange={(e) => onName(e.currentTarget.value)}
          spellCheck={false}
          value={name}
        />
        <Button className="btn" disabled={name.trim() === ""} type="submit">
          Request Variable
        </Button>
      </div>
    </div>
  </form>
);

/* --------------------------------------------------------- start card */

/**
 * Erase (ADR 0081): a setup action on the start card, only by a click here.
 * A device another session is using can't be erased until it stops.
 */
export const EraseDevice = ({
  device,
}: {
  readonly device:
    | { readonly label: string; readonly note: string }
    | undefined;
}) => {
  const [erasing, setErasing] = useState(false);
  if (!device) return null;
  const name = device.label.split(" · ")[0] ?? device.label;
  const inUse = device.note === "Running";
  if (inUse)
    return (
      <span className="hint erase-note">Stop this device to erase it.</span>
    );
  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={
          <Button
            aria-label={`Erase ${name}`}
            className="pill-btn erase-btn"
            disabled={erasing}
          />
        }
      >
        {erasing ? "Erasing…" : "Erase"}
      </AlertDialogTrigger>
      <AlertDialogBackdrop className="dialog-backdrop" />
      <AlertDialogContent className="alert-card island">
        <AlertDialogTitle className="alert-title">
          Erase {name}?
        </AlertDialogTitle>
        <AlertDialogDescription className="hint">
          Every app, account and setting on {device.label} is removed. The next
          session starts it fresh.
        </AlertDialogDescription>
        <div className="alert-actions">
          <AlertDialogClose className="btn ghosty">Cancel</AlertDialogClose>
          <AlertDialogClose
            className="btn danger"
            onClick={() => {
              setErasing(true);
              setTimeout(() => setErasing(false), 1800);
            }}
            value="confirm"
          >
            Erase device
          </AlertDialogClose>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
};
