/**
 * The Web session canvas (#763): the page on the stage and everything attached
 * to it. The page floats on the canvas at the viewport it emulates. The device
 * bar sits top centre, the tools rail on the right edge, its cards beside the
 * rail, and DevTools docks as an island to the right of or under the page.
 */
import { Button } from "@ui-sdk/react/button";
import { Input } from "@ui-sdk/react/input";
import { Radio, RadioGroup, RadioIndicator } from "@ui-sdk/react/radio";
import {
  SegmentedControl,
  SegmentedControlIndicator,
  SegmentedControlItem,
} from "@ui-sdk/react/segmented-control";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@ui-sdk/react/tooltip";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";

import {
  ActivityIcon,
  BackIcon,
  ChevronsIcon,
  CloseIcon,
  DatabaseIcon,
  DockBottomIcon,
  DockRightIcon,
  FingerprintIcon,
  ForwardArrowIcon,
  GlobeIcon,
  LockIcon,
  MonitorIcon,
  PhoneIcon,
  RefreshIcon,
  RotateIcon,
  SearchIcon,
  SparklesIcon,
  StopIcon,
  TabletIcon,
  TerminalIcon,
  TrashIcon,
  WatcherLoader,
} from "./icons";

/* ------------------------------------------------------------------ model */

export type StageState = "connecting" | "live" | "paused";

/** What the canvas needs to know about its session. */
export interface CanvasSession {
  readonly id: string;
  readonly flow: string;
  readonly activity: "Teaching" | "Dry Run" | "Guided Run" | "Run";
  readonly control?: "agent" | "user";
  /** True while the agent waits on a request: its cursor holds still. */
  readonly waiting: boolean;
}

/** An element picked on the page, for the Teaching comment. */
export interface PickedElement {
  readonly role: string;
  readonly name: string;
}

/**
 * The comment composer lives in the status island, the page on the stage.
 * Attach element hands the stage a callback and waits for a pick.
 */
type StartInspect = (onPick: (el: PickedElement | null) => void) => void;
export interface InspectBridge {
  current: StartInspect | null;
}
export const InspectContext = createContext<InspectBridge>({ current: null });

type Kind = "phone" | "tablet" | "desktop";
interface Preset {
  readonly id: string;
  readonly name: string;
  readonly width: number;
  readonly height: number;
}
const PRESETS: readonly Preset[] = [
  { height: 667, id: "iphone-se", name: "iPhone SE", width: 375 },
  { height: 844, id: "iphone-12-pro", name: "iPhone 12 Pro", width: 390 },
  {
    height: 932,
    id: "iphone-14-pro-max",
    name: "iPhone 14 Pro Max",
    width: 430,
  },
  { height: 915, id: "pixel-7", name: "Pixel 7", width: 412 },
  { height: 882, id: "galaxy-z-fold-5", name: "Galaxy Z Fold 5", width: 344 },
  { height: 1024, id: "ipad-mini", name: "iPad Mini", width: 768 },
  { height: 1180, id: "ipad-air", name: "iPad Air", width: 820 },
  { height: 1366, id: "ipad-pro", name: "iPad Pro", width: 1024 },
  { height: 800, id: "laptop", name: "Laptop", width: 1280 },
  { height: 1080, id: "desktop-hd", name: "Desktop HD", width: 1920 },
];
const kindOf = (width: number): Kind =>
  width <= 480 ? "phone" : width <= 1100 ? "tablet" : "desktop";
const GROUPS: readonly { readonly kind: Kind; readonly label: string }[] = [
  { kind: "phone", label: "Phones" },
  { kind: "tablet", label: "Tablets" },
  { kind: "desktop", label: "Displays" },
];
const KIND_ICON: Record<Kind, () => ReactNode> = {
  desktop: MonitorIcon,
  phone: PhoneIcon,
  tablet: TabletIcon,
};

type Card = "identity" | "emulation" | "stream";
const CARD_TITLE: Record<Card, string> = {
  emulation: "Emulation",
  identity: "User agent",
  stream: "Stream diagnostics",
};
type Panel = "console" | "network" | "storage";
const PANEL_TITLE: Record<Panel, string> = {
  console: "Console",
  network: "Network",
  storage: "Storage",
};

const IDENTITIES = [
  { id: "default", name: "Chromium on this Mac", sub: "The browser as it is" },
  { id: "iphone", name: "iPhone · Safari 18", sub: "Mobile, touch, 3× ratio" },
  { id: "pixel", name: "Pixel 9 · Chrome", sub: "Mobile, touch, 2.6× ratio" },
  { id: "ipad", name: "iPad Air · Safari", sub: "Tablet, touch, 2× ratio" },
  { id: "bot", name: "Googlebot", sub: "Crawler, no touch" },
] as const;

const CONSOLE = [
  { at: "0:02", level: "info", text: "[vite] connected." },
  { at: "0:05", level: "log", text: "cart: hydrated 0 items" },
  {
    at: "0:11",
    level: "warn",
    text: 'Image with src "/img/jacket-red.webp" has no width or height.',
  },
  {
    at: "0:14",
    level: "error",
    text: "Uncaught TypeError: Cannot read properties of undefined (reading 'price')\n    at ProductCard (product-card.tsx:42:18)",
  },
  { at: "0:19", level: "log", text: "analytics: page_view /jackets" },
  {
    at: "0:23",
    level: "error",
    text: "Failed to load resource: the server responded with a status of 500 (/api/recommendations)",
  },
] as const;

const NETWORK = [
  {
    method: "GET",
    ms: 42,
    path: "/jackets",
    size: "18.2 kB",
    status: 200,
    type: "document",
  },
  {
    method: "GET",
    ms: 12,
    path: "/assets/index-4f1a.js",
    size: "212 kB",
    status: 200,
    type: "script",
  },
  {
    method: "GET",
    ms: 9,
    path: "/assets/index-91cc.css",
    size: "31 kB",
    status: 200,
    type: "stylesheet",
  },
  {
    method: "GET",
    ms: 88,
    path: "/api/products?category=jackets",
    size: "6.4 kB",
    status: 200,
    type: "fetch",
  },
  {
    method: "GET",
    ms: 31,
    path: "/img/jacket-red.webp",
    size: "84 kB",
    status: 200,
    type: "image",
  },
  {
    method: "GET",
    ms: 640,
    path: "/api/recommendations",
    size: "0.3 kB",
    status: 500,
    type: "fetch",
  },
  {
    method: "POST",
    ms: 54,
    path: "/api/cart",
    size: "0.8 kB",
    status: 201,
    type: "fetch",
  },
  {
    method: "GET",
    ms: 18,
    path: "/api/session",
    size: "0.4 kB",
    status: 304,
    type: "fetch",
  },
] as const;

const STORAGE: Record<
  "cookies" | "local" | "session",
  readonly (readonly [string, string])[]
> = {
  cookies: [
    ["session_id", "s%3A9fK2…Qw"],
    ["cart_token", "c_71ab3e"],
    ["consent", "analytics=0"],
  ],
  local: [
    ["theme", '"system"'],
    ["recently_viewed", '["jkt-104","jkt-221"]'],
  ],
  session: [["checkout_step", '"shipping"']],
};

/* ----------------------------------------------------------------- motion */

const reducedMotion = () =>
  matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Canvas changes (a new viewport, DevTools opening, a tool card) morph the
 * page instead of jumping it. Names that only matter for this change are set
 * before the old snapshot and cleared once it lands.
 */
const morph = (update: () => void, names: readonly string[] = []) => {
  const els = names
    .map(
      (n) =>
        [document.querySelector<HTMLElement>(`[data-morph="${n}"]`), n] as const
    )
    .filter((p): p is readonly [HTMLElement, string] => p[0] !== null);
  if (!document.startViewTransition || reducedMotion()) {
    update();
    return;
  }
  for (const [el, n] of els) el.style.viewTransitionName = n;
  const vt = document.startViewTransition(() => {
    flushSync(update);
    for (const n of names) {
      const el = document.querySelector<HTMLElement>(`[data-morph="${n}"]`);
      if (el) el.style.viewTransitionName = n;
    }
  });
  void vt.finished.finally(() => {
    for (const n of names) {
      const el = document.querySelector<HTMLElement>(`[data-morph="${n}"]`);
      if (el) el.style.viewTransitionName = "";
    }
  });
};

/* ------------------------------------------------------------------ parts */

const Tip = ({
  label,
  side = "bottom",
  children,
}: {
  readonly label: string;
  readonly side?: "bottom" | "left" | "top";
  readonly children: ReactNode;
}) => (
  <Tooltip>
    {children}
    <TooltipContent className="tooltip" side={side}>
      {label}
    </TooltipContent>
  </Tooltip>
);

const ToolButton = ({
  label,
  pressed,
  badge,
  description,
  onClick,
  disabled,
  side = "bottom",
  children,
}: {
  readonly label: string;
  readonly pressed?: boolean;
  readonly badge?: {
    readonly n: number | string;
    readonly tone: "danger" | "info" | "neutral" | "live";
  } | null;
  readonly description?: string;
  readonly onClick?: () => void;
  readonly disabled?: boolean;
  readonly side?: "bottom" | "left" | "top";
  readonly children: ReactNode;
}) => (
  <Tip label={label} side={side}>
    <TooltipTrigger
      render={
        <Button
          aria-description={description}
          aria-label={label}
          aria-pressed={pressed}
          className="tool-btn"
          disabled={disabled}
          onClick={onClick}
        />
      }
    >
      {children}
      {badge ? (
        <span aria-hidden="true" className="tool-badge" data-tone={badge.tone}>
          {badge.tone === "live" ? null : badge.n}
        </span>
      ) : null}
    </TooltipTrigger>
  </Tip>
);

/** The page itself: a small shop, so there is something to point at. */
const FakeShop = ({ path }: { readonly path: string }) => (
  <div className="shop" key={path}>
    <header className="shop-head">
      <span className="shop-logo" data-el="link|Northwind home">
        northwind
      </span>
      <nav className="shop-nav">
        <span data-el="link|Men">Men</span>
        <span data-el="link|Women">Women</span>
        <span data-el="link|Sale">Sale</span>
      </nav>
      <span className="shop-search" data-el="textbox|Search products">
        <SearchIcon />
        Search
      </span>
      <span className="shop-cart" data-el="button|Cart, 0 items">
        Cart · 0
      </span>
    </header>
    <section className="shop-hero">
      <div>
        <h1 data-el="heading|Outerwear for wet weeks">
          Outerwear for wet weeks
        </h1>
        <p>Shell jackets, parkas and liners. Free returns on {path}.</p>
        <span className="shop-cta" data-el="button|Shop jackets">
          Shop jackets
        </span>
      </div>
      <div
        className="shop-hero-img"
        data-el="image|Model in a red shell jacket"
      />
    </section>
    <h2 className="shop-h2" data-el="heading|Jackets under $80">
      Jackets under $80
    </h2>
    <div className="shop-grid">
      {[
        ["Harbor shell", "$74", "red"],
        ["Fjord parka", "$79", "slate"],
        ["Tide liner", "$48", "olive"],
        ["Drift anorak", "$66", "sand"],
      ].map(([name, price, tone]) => (
        <article className="shop-card" key={name}>
          <div
            className="shop-img"
            data-el={`image|${name}`}
            data-tone={tone}
          />
          <div className="shop-meta">
            <span data-el={`link|${name}`}>{name}</span>
            <span className="shop-price">{price}</span>
          </div>
          <span className="shop-add" data-el={`button|Add ${name} to cart`}>
            Add to cart
          </span>
        </article>
      ))}
    </div>
  </div>
);

/** The agent's cursor (ADR 0046): drawn over the page while the agent drives. */
const AgentCursor = ({
  pageRef,
  active,
}: {
  readonly pageRef: React.RefObject<HTMLDivElement | null>;
  readonly active: boolean;
}) => {
  const [at, setAt] = useState<{ x: number; y: number; click: number }>({
    click: 0,
    x: 120,
    y: 120,
  });
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      const page = pageRef.current;
      if (!page) return;
      const targets = [...page.querySelectorAll<HTMLElement>("[data-el]")];
      const t = targets[Math.floor(Math.random() * targets.length)];
      if (!t) return;
      const box = page.getBoundingClientRect();
      const r = t.getBoundingClientRect();
      const scale = box.width / page.offsetWidth || 1;
      setAt((p) => ({
        click: p.click + 1,
        x: (r.left - box.left + r.width / 2) / scale,
        y: (r.top - box.top + r.height / 2) / scale,
      }));
    }, 1900);
    return () => clearInterval(id);
  }, [active, pageRef]);
  return (
    <div
      aria-hidden="true"
      className="agent-cursor"
      data-active={active || undefined}
      data-testid="agent-cursor"
      style={{ translate: `${at.x}px ${at.y}px` }}
    >
      <span className="agent-ripple" key={at.click} />
      <svg viewBox="0 0 24 24">
        <path d="M5 3l14 7.5-6.2 1.7L10 18.5z" />
      </svg>
      <span className="agent-tag">Agent</span>
    </div>
  );
};

/* -------------------------------------------------------------- the canvas */

const RAIL = 52;
const GAP = 12;
const MIN_PANEL = 280;

export const WebCanvas = ({
  session,
  ended = false,
  stage,
  onReconnect,
  onNotice,
}: {
  readonly session: CanvasSession;
  readonly ended?: boolean;
  readonly stage: StageState;
  readonly onReconnect: () => void;
  readonly onNotice: (text: string, tone?: "info" | "ok" | "error") => void;
}) => {
  const [presetId, setPresetId] = useState("responsive");
  const [rotated, setRotated] = useState(false);
  const [ratio, setRatio] = useState("2");
  const [card, setCard] = useState<Card | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [side, setSide] = useState<"right" | "bottom">("right");
  const [size, setSize] = useState({ bottom: 300, right: 420 });
  const [identity, setIdentity] = useState("default");
  const [scheme, setScheme] = useState("none");
  const [transport, setTransport] = useState("json");
  const [inspect, setInspect] = useState<
    ((el: PickedElement | null) => void) | null
  >(null);
  const [hover, setHover] = useState<{
    readonly box: { x: number; y: number; w: number; h: number };
    readonly el: PickedElement;
  } | null>(null);
  const [area, setArea] = useState({ h: 600, w: 900 });
  const [ripple, setRipple] = useState<{
    x: number;
    y: number;
    n: number;
  } | null>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);

  const agentDrives =
    session.activity !== "Teaching" && session.control !== "user";
  const locked = agentDrives && !ended;
  const lockedReason = "The agent is driving. Take control to change this.";
  const live = stage === "live" && !ended;
  const overrides = scheme === "none" ? 1 : 2;

  // The tab's own history: Back, Forward, Reload and the address field drive
  // it the way a browser's toolbar does. Locked while the agent drives.
  const home = `https://shop.localhost/${session.flow.split(" ")[0]?.toLowerCase() ?? ""}`;
  const [tab, setTab] = useState({ at: 0, entries: [home] });
  const url = tab.entries[tab.at] ?? home;
  const [draft, setDraft] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const loadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const load = () => {
    if (loadTimer.current) clearTimeout(loadTimer.current);
    setLoading(true);
    loadTimer.current = setTimeout(() => setLoading(false), 900);
  };
  const stopLoading = () => {
    if (loadTimer.current) clearTimeout(loadTimer.current);
    setLoading(false);
  };
  useEffect(
    () => () => {
      if (loadTimer.current) clearTimeout(loadTimer.current);
    },
    []
  );
  const go = (raw: string) => {
    const text = raw.trim();
    if (text === "") return;
    const next = /^[a-z]+:\/\//i.test(text) ? text : `https://${text}`;
    setTab((h) => ({
      at: h.at + 1,
      entries: [...h.entries.slice(0, h.at + 1), next],
    }));
    setDraft(null);
    load();
  };
  const step = (by: -1 | 1) => {
    setTab((h) => ({
      ...h,
      at: Math.min(h.entries.length - 1, Math.max(0, h.at + by)),
    }));
    load();
  };
  const shown = url.replace(/^https?:\/\//, "");
  const pagePath = shown.split("/").slice(1).join("/") || "home";

  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      if (e) setArea({ h: e.contentRect.height, w: e.contentRect.width });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The device bar centres on the window, but never slides under the
  // navigation island when a long session name widens it.
  const barRef = useRef<HTMLDivElement>(null);
  const [barBox, setBarBox] = useState({ centre: 0, width: 720 });
  useLayoutEffect(() => {
    const nav = document.querySelector<HTMLElement>(
      'nav[aria-label="Workspace"]'
    );
    const actions = document.querySelector<HTMLElement>(".chrome.right");
    if (!nav || !actions) return;
    // Centred on the window, as wide as 720px, and always clear of the
    // navigation and actions islands on either side.
    const place = () => {
      const from = nav.getBoundingClientRect().right + GAP;
      const to = actions.getBoundingClientRect().left - GAP;
      const width = Math.max(320, Math.min(720, to - from));
      const centre = Math.min(
        Math.max(innerWidth / 2, from + width / 2),
        to - width / 2
      );
      setBarBox({ centre, width });
    };
    const ro = new ResizeObserver(place);
    ro.observe(nav);
    ro.observe(actions);
    addEventListener("resize", place);
    return () => {
      ro.disconnect();
      removeEventListener("resize", place);
    };
  }, [ended]);

  useEffect(() => {
    document.body.dataset.canvas = "web";
    return () => {
      delete document.body.dataset.canvas;
    };
  }, []);

  // A new session starts with its tools closed.
  useEffect(() => {
    setCard(null);
    setInspect(null);
  }, [session.id]);

  const preset = PRESETS.find((p) => p.id === presetId);
  const [pw, ph] = preset
    ? rotated
      ? [preset.height, preset.width]
      : [preset.width, preset.height]
    : [Math.round(area.w), Math.round(area.h)];
  const scale = preset ? Math.min(1, area.w / pw, area.h / ph) : 1;
  const kind = preset ? kindOf(pw) : "desktop";
  const KindIcon = KIND_ICON[kind];

  // Escape closes the innermost canvas surface first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (inspect) {
        e.preventDefault();
        inspect(null);
        setInspect(null);
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
  const togglePanel = (p: Panel) =>
    morph(() => setPanel(panel === p ? null : p), ["devtools"]);

  const pickAt = (target: EventTarget | null) => {
    const el = (target as HTMLElement | null)?.closest<HTMLElement>(
      "[data-el]"
    );
    const page = pageRef.current;
    if (!el || !page) return null;
    const [role = "generic", name = ""] = (el.dataset.el ?? "").split("|");
    const box = page.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const s = box.width / page.offsetWidth || 1;
    return {
      box: {
        h: r.height / s,
        w: r.width / s,
        x: (r.left - box.left) / s,
        y: (r.top - box.top) / s,
      },
      el: { name, role },
    };
  };

  const bridge = useContext(InspectContext);
  useEffect(() => {
    bridge.current = ended ? null : (fn) => setInspect(() => fn);
    return () => {
      bridge.current = null;
    };
  }, [bridge, ended]);

  const devtoolsRight =
    panel && side === "right" && !ended ? size.right + GAP : 0;
  const devtoolsBottom =
    panel && side === "bottom" && !ended ? size.bottom + GAP : 0;

  return (
    <>
      {ended ? null : (
        <div
          aria-label="Device controls"
          className="device-bar island"
          data-locked={locked || undefined}
          ref={barRef}
          role="toolbar"
          style={{ left: barBox.centre, width: barBox.width }}
        >
          <div
            aria-label="Browser navigation"
            className="bar-group"
            role="group"
          >
            <ToolButton
              disabled={locked || tab.at === 0}
              label="Go back"
              onClick={() => step(-1)}
            >
              <BackIcon />
            </ToolButton>
            <ToolButton
              disabled={locked || tab.at === tab.entries.length - 1}
              label="Go forward"
              onClick={() => step(1)}
            >
              <ForwardArrowIcon />
            </ToolButton>
            <ToolButton
              disabled={locked}
              label={loading ? "Stop loading" : "Reload page"}
              onClick={loading ? stopLoading : load}
            >
              {loading ? <CloseIcon /> : <RefreshIcon />}
            </ToolButton>
          </div>
          <form
            className="bar-url"
            data-editing={draft !== null || undefined}
            onSubmit={(e) => {
              e.preventDefault();
              if (draft !== null) go(draft);
              e.currentTarget.querySelector("input")?.blur();
            }}
            role="search"
          >
            <LockIcon />
            <input
              aria-label="Browser address"
              autoComplete="off"
              className="bar-url-input mono"
              onBlur={() => setDraft(null)}
              onChange={(e) => setDraft(e.currentTarget.value)}
              onFocus={(e) => {
                setDraft(url);
                e.currentTarget.select();
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setDraft(null);
                  e.currentTarget.blur();
                }
              }}
              readOnly={locked}
              spellCheck={false}
              title={locked ? lockedReason : url}
              value={draft ?? shown}
            />
          </form>
          <span className="bar-divider" />
          <Select
            onValueChange={(v: string | null) => {
              if (v) morph(() => setPresetId(v));
            }}
            value={presetId}
          >
            <Tip label={locked ? lockedReason : "Device"}>
              <TooltipTrigger
                render={
                  <SelectTrigger
                    aria-label="Device"
                    className="bar-select"
                    disabled={locked}
                  />
                }
              >
                <KindIcon />
                <SelectValue>{preset?.name ?? "Responsive"}</SelectValue>
                <ChevronsIcon />
              </TooltipTrigger>
            </Tip>
            <SelectContent className="select-list island preset-list">
              <SelectItem className="select-item" value="responsive">
                Responsive
              </SelectItem>
              {GROUPS.map((g) => (
                <SelectGroup key={g.kind}>
                  <SelectGroupLabel
                    aria-hidden="true"
                    className="select-group-label"
                  >
                    {g.label}
                  </SelectGroupLabel>
                  {PRESETS.filter((p) => kindOf(p.width) === g.kind).map(
                    (p) => (
                      <SelectItem
                        className="select-item preset-item"
                        key={p.id}
                        value={p.id}
                      >
                        {p.name}
                        <span aria-hidden="true" className="hint mono">
                          {p.width}×{p.height}
                        </span>
                      </SelectItem>
                    )
                  )}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
          <span
            aria-label="Viewport size"
            className="bar-size mono"
            role="status"
          >
            {pw} × {ph}
            {scale < 0.995 ? (
              <span className="bar-zoom"> · {Math.round(scale * 100)}%</span>
            ) : null}
          </span>
          <ToolButton
            disabled={locked || !preset}
            label="Rotate viewport"
            onClick={() => morph(() => setRotated(!rotated))}
          >
            <RotateIcon />
          </ToolButton>
          <Select
            onValueChange={(v: string | null) => {
              if (v) setRatio(v);
            }}
            value={ratio}
          >
            <SelectTrigger
              aria-label="Device pixel ratio"
              className="bar-select narrow mono"
              disabled={locked}
            >
              <SelectValue>{ratio}×</SelectValue>
            </SelectTrigger>
            <SelectContent className="select-list island">
              {["1", "2", "3"].map((r) => (
                <SelectItem className="select-item mono" key={r} value={r}>
                  {r}×
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {locked ? (
            <span className="bar-lock" title={lockedReason}>
              <span className="sr-only">{lockedReason}</span>
            </span>
          ) : null}
        </div>
      )}

      <div
        className="canvas-area"
        data-ended={ended || undefined}
        ref={areaRef}
        style={{
          ["--rail-space" as string]: ended ? "0px" : `${RAIL + GAP}px`,
          ["--dt-right" as string]: `${devtoolsRight}px`,
          ["--dt-bottom" as string]: `${devtoolsBottom}px`,
        }}
      >
        <section
          aria-label="Browser stage"
          className="stage web"
          data-ended={ended || undefined}
          data-inspect={inspect ? "" : undefined}
          data-loading={loading || undefined}
          data-preset={preset ? "" : undefined}
          data-state={ended ? "ended" : stage}
          data-takeover={session.control === "user" && !ended ? "" : undefined}
          onPointerDown={() => {
            if (card) morph(() => setCard(null), ["tool-card"]);
          }}
          style={{
            height: preset ? ph * scale : "100%",
            width: preset ? pw * scale : "100%",
          }}
        >
          {ended ? (
            <span className="last-frame">
              <StopIcon />
              Last frame
            </span>
          ) : null}
          <div
            className="page"
            onClick={(e) => {
              if (inspect) {
                e.preventDefault();
                const hit = pickAt(e.target);
                if (!hit) return;
                inspect(hit.el);
                setInspect(null);
                setHover(null);
              }
            }}
            onPointerDown={(e) => {
              if (inspect || !live) return;
              if (agentDrives) {
                onNotice("The agent is driving. Take control to use the page.");
                return;
              }
              const page = pageRef.current;
              if (!page) return;
              const box = page.getBoundingClientRect();
              const s = box.width / page.offsetWidth || 1;
              setRipple((r) => ({
                n: (r?.n ?? 0) + 1,
                x: (e.clientX - box.left) / s,
                y: (e.clientY - box.top) / s,
              }));
            }}
            onPointerLeave={() => setHover(null)}
            onPointerMove={(e) => {
              if (inspect) setHover(pickAt(e.target));
            }}
            ref={pageRef}
            style={{
              height: ph,
              transform: preset ? `scale(${scale})` : undefined,
              width: pw,
            }}
          >
            <FakeShop path={pagePath} />
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
                <span className="inspect-tag mono">
                  {hover.el.role} <b>{hover.el.name}</b>
                </span>
              </div>
            ) : null}
            {ended ? null : (
              <AgentCursor
                active={live && agentDrives && !session.waiting}
                pageRef={pageRef}
              />
            )}
          </div>
          {loading && live ? (
            <span aria-hidden="true" className="page-progress">
              <span />
            </span>
          ) : null}
          {stage === "connecting" && !ended ? (
            <div className="stage-veil" role="status">
              <WatcherLoader className="veil-watcher" />
              Connecting to the browser…
            </div>
          ) : null}
          {stage === "paused" && !ended ? (
            <div className="stage-veil paused" role="status">
              <strong>The stream paused</strong>
              <span className="hint">
                The browser stopped sending frames. Input is held until it comes
                back.
              </span>
              <Button className="btn ghosty" onClick={onReconnect}>
                <RefreshIcon />
                Reconnect
              </Button>
            </div>
          ) : null}
        </section>
      </div>

      {inspect ? (
        <div className="inspect-hint island" role="status">
          Click an element to attach it to the comment
          <span className="hint">
            <kbd>Esc</kbd> cancels
          </span>
        </div>
      ) : null}

      {ended ? null : (
        <nav aria-label="Browser tools" className="tools-rail island">
          <ToolButton
            badge={identity === "default" ? null : { n: 1, tone: "info" }}
            label="User agent"
            onClick={() => toggleCard("identity")}
            pressed={card === "identity"}
            side="left"
          >
            <FingerprintIcon />
          </ToolButton>
          <ToolButton
            badge={{ n: overrides, tone: "info" }}
            description={`${overrides} overrides applied`}
            label="Emulation"
            onClick={() => toggleCard("emulation")}
            pressed={card === "emulation"}
            side="left"
          >
            <SparklesIcon />
          </ToolButton>
          <span aria-hidden="true" className="rail-divider" />
          <ToolButton
            badge={{ n: 2, tone: "danger" }}
            description="2 errors"
            label="Console"
            onClick={() => togglePanel("console")}
            pressed={panel === "console"}
            side="left"
          >
            <TerminalIcon />
          </ToolButton>
          <ToolButton
            badge={{ n: NETWORK.length, tone: "neutral" }}
            description={`${NETWORK.length} requests`}
            label="Network"
            onClick={() => togglePanel("network")}
            pressed={panel === "network"}
            side="left"
          >
            <GlobeIcon />
          </ToolButton>
          <ToolButton
            label="Storage"
            onClick={() => togglePanel("storage")}
            pressed={panel === "storage"}
            side="left"
          >
            <DatabaseIcon />
          </ToolButton>
          <span aria-hidden="true" className="rail-divider" />
          <ToolButton
            badge={{ n: "", tone: stage === "live" ? "live" : "danger" }}
            description={
              stage === "live"
                ? "Live, 31 ms"
                : stage === "paused"
                  ? "Paused"
                  : "Connecting"
            }
            label="Stream diagnostics"
            onClick={() => toggleCard("stream")}
            pressed={card === "stream"}
            side="left"
          >
            <ActivityIcon />
          </ToolButton>
        </nav>
      )}

      {card && !ended ? (
        <section
          aria-label={CARD_TITLE[card]}
          className="tool-card island"
          data-card={card}
          data-morph="tool-card"
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
          {locked && card !== "stream" ? (
            <p className="tool-lock">
              <LockIcon />
              {lockedReason}
            </p>
          ) : null}
          <div className="tool-card-body">
            {card === "identity" ? (
              <RadioGroup
                aria-label="User agent"
                className="radio-cards"
                disabled={locked}
                onValueChange={(v: unknown) => {
                  if (typeof v === "string") setIdentity(v);
                }}
                value={identity}
              >
                {IDENTITIES.map((i) => (
                  <label className="radio-card" key={i.id}>
                    <Radio className="radio" value={i.id}>
                      <RadioIndicator className="radio-dot" />
                    </Radio>
                    <span>
                      {i.name}
                      <span className="hint">{i.sub}</span>
                    </span>
                  </label>
                ))}
              </RadioGroup>
            ) : null}
            {card === "emulation" ? (
              <div className="emu">
                <div className="emu-row">
                  <span className="label">Color scheme</span>
                  <SegmentedControl
                    aria-label="Color scheme"
                    className="segmented"
                    disabled={locked}
                    onValueChange={(v: unknown) => {
                      if (typeof v === "string") setScheme(v);
                    }}
                    value={scheme}
                  >
                    <SegmentedControlIndicator className="segmented-indicator" />
                    {[
                      ["none", "Auto"],
                      ["light", "Light"],
                      ["dark", "Dark"],
                    ].map(([v, l]) => (
                      <SegmentedControlItem
                        className="segmented-item"
                        key={v}
                        value={v}
                      >
                        {l}
                      </SegmentedControlItem>
                    ))}
                  </SegmentedControl>
                </div>
                <div className="emu-row">
                  <span className="label">Locale</span>
                  <Input
                    aria-label="Locale"
                    className="input mono compact"
                    defaultValue="en-GB"
                    disabled={locked}
                  />
                </div>
                <div className="emu-row">
                  <span className="label">Time zone</span>
                  <Input
                    aria-label="Time zone"
                    className="input mono compact"
                    defaultValue="Europe/London"
                    disabled={locked}
                  />
                </div>
                <div className="emu-row">
                  <span className="label">Location</span>
                  <span className="emu-value mono">51.5072, −0.1276</span>
                </div>
                <div className="emu-row">
                  <span className="label">Page zoom</span>
                  <span className="emu-value mono">100%</span>
                </div>
                <p className="emu-foot hint">
                  Overrides belong to the Flow (ADR 0013). A Run applies the
                  saved ones before it starts.
                </p>
              </div>
            ) : null}
            {card === "stream" ? (
              <div className="emu">
                <div className="stream-state" data-state={stage}>
                  <span className="stream-dot" aria-hidden="true" />
                  {stage === "live"
                    ? "Live · 30 fps"
                    : stage === "paused"
                      ? "Paused · no frames for 4 s"
                      : "Connecting…"}
                  {stage === "paused" ? (
                    <Button className="pill-btn" onClick={onReconnect}>
                      <RefreshIcon />
                      Reconnect
                    </Button>
                  ) : null}
                </div>
                <div className="emu-row">
                  <span className="label">Streaming preference</span>
                  <SegmentedControl
                    aria-label="Streaming preference"
                    className="segmented"
                    onValueChange={(v: unknown) => {
                      if (typeof v === "string") setTransport(v);
                    }}
                    value={transport}
                  >
                    <SegmentedControlIndicator className="segmented-indicator" />
                    <SegmentedControlItem
                      className="segmented-item"
                      value="json"
                    >
                      Local performance
                    </SegmentedControlItem>
                    <SegmentedControlItem
                      className="segmented-item"
                      value="binary"
                    >
                      Lower bandwidth
                    </SegmentedControlItem>
                  </SegmentedControl>
                </div>
                <dl aria-label="Stream diagnostics" className="stream-stats">
                  <dt>Capture to canvas, p95</dt>
                  <dd className="mono">{stage === "live" ? "31.4 ms" : "—"}</dd>
                  <dt>Decode / draw, p95</dt>
                  <dd className="mono">
                    {stage === "live" ? "4.1 / 1.2 ms" : "—"}
                  </dd>
                  <dt>Received / rendered</dt>
                  <dd className="mono">1,204 / 1,198</dd>
                  <dt>Skipped / superseded</dt>
                  <dd className="mono">3 / 3</dd>
                </dl>
                <p className="emu-foot hint">
                  Last 120 rendered frames. Replay is excluded from latency.
                </p>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {panel && !ended ? (
        <section
          aria-label={PANEL_TITLE[panel]}
          className="devtools island"
          data-morph="devtools"
          data-side={side}
          style={
            side === "right" ? { width: size.right } : { height: size.bottom }
          }
        >
          <ResizeHandle
            max={
              side === "right"
                ? Math.round(innerWidth * 0.55)
                : Math.round(innerHeight * 0.55)
            }
            onResize={(n) =>
              setSize((s) =>
                side === "right" ? { ...s, right: n } : { ...s, bottom: n }
              )
            }
            side={side}
            size={side === "right" ? size.right : size.bottom}
          />
          <header className="devtools-head">
            <div
              aria-label="DevTools panels"
              className="devtools-tabs"
              role="group"
            >
              {(Object.keys(PANEL_TITLE) as Panel[]).map((p) => (
                <button
                  aria-pressed={panel === p}
                  className="devtools-tab"
                  key={p}
                  onClick={() => setPanel(p)}
                  type="button"
                >
                  {PANEL_TITLE[p]}
                </button>
              ))}
            </div>
            <span className="hint mono devtools-tabname">
              Jackets · Northwind
            </span>
            <ToolButton
              label={side === "right" ? "Dock to bottom" : "Dock to right"}
              onClick={() =>
                morph(
                  () => setSide(side === "right" ? "bottom" : "right"),
                  ["devtools"]
                )
              }
            >
              {side === "right" ? <DockBottomIcon /> : <DockRightIcon />}
            </ToolButton>
            <ToolButton
              label="Close DevTools"
              onClick={() => togglePanel(panel)}
            >
              <CloseIcon />
            </ToolButton>
          </header>
          <div className="devtools-body">
            {panel === "console" ? <ConsolePanel /> : null}
            {panel === "network" ? <NetworkPanel side={side} /> : null}
            {panel === "storage" ? <StoragePanel locked={locked} /> : null}
          </div>
        </section>
      ) : null}
    </>
  );
};

/**
 * Drags or arrow-keys the size of the pane on its far side. `right`: the pane
 * sits to the right and grows leftwards; `bottom`: it sits below and grows up.
 */
const ResizeHandle = ({
  side,
  size,
  max,
  min = MIN_PANEL,
  label = "Resize DevTools",
  className = "resize-handle",
  onResize,
}: {
  readonly side: "right" | "bottom";
  readonly size: number;
  readonly max: number;
  readonly min?: number;
  readonly label?: string;
  readonly className?: string;
  readonly onResize: (n: number) => void;
}) => {
  const clamp = (n: number) => Math.max(min, Math.min(max, Math.round(n)));
  return (
    <div
      aria-label={label}
      aria-orientation={side === "right" ? "vertical" : "horizontal"}
      aria-valuemax={max}
      aria-valuemin={min}
      aria-valuenow={size}
      className={className}
      data-side={side}
      onKeyDown={(e) => {
        const grow = side === "right" ? "ArrowLeft" : "ArrowUp";
        const shrink = side === "right" ? "ArrowRight" : "ArrowDown";
        if (e.key === grow || e.key === shrink) {
          e.preventDefault();
          onResize(clamp(size + (e.key === grow ? 24 : -24)));
        }
      }}
      onPointerDown={(e) => {
        e.preventDefault();
        const start = side === "right" ? e.clientX : e.clientY;
        const from = size;
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        document.body.dataset.resizing = side;
        const move = (m: PointerEvent) =>
          onResize(
            clamp(from + start - (side === "right" ? m.clientX : m.clientY))
          );
        const up = () => {
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", up);
          delete document.body.dataset.resizing;
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
      }}
      role="separator"
      tabIndex={0}
    />
  );
};

const ConsolePanel = () => {
  const [level, setLevel] = useState("all");
  const [q, setQ] = useState("");
  const rows = CONSOLE.filter(
    (r) =>
      (level === "all" ||
        (level === "errors" && r.level === "error") ||
        (level === "warnings" &&
          (r.level === "warn" || r.level === "error"))) &&
      r.text.toLowerCase().includes(q.toLowerCase())
  );
  return (
    <>
      <div className="devtools-filters">
        <SegmentedControl
          aria-label="Console level"
          className="segmented small"
          onValueChange={(v: unknown) => {
            if (typeof v === "string") setLevel(v);
          }}
          value={level}
        >
          <SegmentedControlIndicator className="segmented-indicator" />
          <SegmentedControlItem className="segmented-item" value="all">
            All
          </SegmentedControlItem>
          <SegmentedControlItem className="segmented-item" value="warnings">
            Warnings
          </SegmentedControlItem>
          <SegmentedControlItem className="segmented-item" value="errors">
            Errors
          </SegmentedControlItem>
        </SegmentedControl>
        <Input
          aria-label="Filter console messages"
          className="input compact"
          onChange={(e) => setQ(e.currentTarget.value)}
          placeholder="Filter"
          value={q}
        />
        <ToolButton label="Clear console">
          <TrashIcon />
        </ToolButton>
      </div>
      <ol aria-label="Console messages" className="console">
        {rows.map((r) => (
          <li data-level={r.level} key={r.at + r.text}>
            <span className="console-at mono">{r.at}</span>
            <pre className="mono">{r.text}</pre>
          </li>
        ))}
        {rows.length === 0 ? (
          <li className="hint">No messages match.</li>
        ) : null}
      </ol>
    </>
  );
};

const RESPONSES: Record<string, string> = {
  "/api/products?category=jackets": JSON.stringify(
    {
      category: "jackets",
      items: [
        {
          id: "jkt-104",
          name: "Harbor shell",
          price: 74,
          sizes: ["S", "M", "L"],
          colour: "red",
        },
        {
          id: "jkt-221",
          name: "Fjord parka",
          price: 79,
          sizes: ["M", "L"],
          colour: "slate",
        },
        {
          id: "jkt-318",
          name: "Tide liner",
          price: 48,
          sizes: ["S", "M"],
          colour: "olive",
        },
        {
          id: "jkt-402",
          name: "Drift anorak",
          price: 66,
          sizes: ["M", "L", "XL"],
          colour: "sand",
        },
      ],
      page: 1,
      total: 4,
    },
    null,
    2
  ),
  "/api/recommendations": JSON.stringify(
    {
      error: "internal_error",
      message: "recommendations service timed out after 600 ms",
      requestId: "req_8f2c1a",
    },
    null,
    2
  ),
  "/api/cart": JSON.stringify(
    {
      cartId: "c_71ab3e",
      items: [{ id: "jkt-104", size: "M", qty: 1, price: 74 }],
      subtotal: 74,
      currency: "USD",
    },
    null,
    2
  ),
  "/api/session": "(304 Not Modified: the browser reused its cached copy)",
  "/jackets":
    '<!doctype html>\n<html lang="en">\n  <head>\n    <title>Jackets · Northwind</title>\n    <script type="module" src="/assets/index-4f1a.js"></script>\n  </head>\n  <body>\n    <div id="root"></div>\n  </body>\n</html>',
};

const headersOf = (r: (typeof NETWORK)[number]) =>
  [
    [
      "content-type",
      r.type === "document"
        ? "text/html; charset=utf-8"
        : r.type === "fetch"
          ? "application/json"
          : r.type === "image"
            ? "image/webp"
            : r.type === "script"
              ? "text/javascript"
              : "text/css",
    ],
    ["content-length", r.size],
    [
      "cache-control",
      r.type === "fetch" ? "no-store" : "public, max-age=31536000",
    ],
    ["server", "vite"],
  ] as const;

const NetworkPanel = ({ side }: { readonly side: "right" | "bottom" }) => {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [tab, setTab] = useState("response");
  // The detail pane sits under the list when DevTools is docked right, and
  // beside it when DevTools is docked at the bottom. Each keeps its own size.
  const [split, setSplit] = useState({ bottom: 260, right: 380 });
  const netRef = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(600);
  useLayoutEffect(() => {
    const el = netRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      if (e)
        setRoom(side === "right" ? e.contentRect.height : e.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [side]);
  const rows = NETWORK.filter((r) => r.path.includes(q));
  const picked = NETWORK.find((r) => r.path === sel);
  // Docked right, the pane splits top/bottom; docked bottom, left/right.
  const splitSide = side === "right" ? "bottom" : "right";
  const splitSize = side === "right" ? split.bottom : split.right;
  const maxSplit = Math.max(160, Math.round(room - 120));
  const body = picked
    ? (RESPONSES[picked.path] ??
      `(${picked.type}, ${picked.size}: preview not shown)`)
    : "";
  return (
    <>
      <div className="devtools-filters">
        <Input
          aria-label="Filter network requests"
          className="input compact"
          onChange={(e) => setQ(e.currentTarget.value)}
          placeholder="Filter by path"
          value={q}
        />
        <ToolButton label="Clear network log">
          <TrashIcon />
        </ToolButton>
      </div>
      <div
        className="net"
        data-detail={picked ? "" : undefined}
        data-split={splitSide}
        ref={netRef}
      >
        <div className="net-list">
          <table aria-label="Network requests" className="net-table">
            <thead>
              <tr>
                <th>Path</th>
                <th>Status</th>
                <th>Type</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  data-bad={r.status >= 400 || undefined}
                  data-selected={sel === r.path || undefined}
                  key={r.path}
                  onClick={() => setSel(sel === r.path ? null : r.path)}
                >
                  <td className="mono net-path">
                    <button
                      aria-pressed={sel === r.path}
                      className="net-pick"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSel(sel === r.path ? null : r.path);
                      }}
                      type="button"
                    >
                      <span className="net-method">{r.method}</span> {r.path}
                    </button>
                  </td>
                  <td className="mono">{r.status}</td>
                  <td>{r.type}</td>
                  <td className="mono">{r.ms} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {picked ? (
          <>
            <ResizeHandle
              className="split-handle"
              label="Resize request details"
              max={maxSplit}
              min={140}
              onResize={(n) =>
                setSplit((v) =>
                  splitSide === "bottom"
                    ? { ...v, bottom: n }
                    : { ...v, right: n }
                )
              }
              side={splitSide}
              size={Math.min(splitSize, maxSplit)}
            />
            <aside
              aria-label="Request detail"
              className="net-detail"
              style={
                splitSide === "bottom"
                  ? { height: Math.min(splitSize, maxSplit) }
                  : { width: Math.min(splitSize, maxSplit) }
              }
            >
              <header>
                <span className="mono net-detail-title">
                  <span className="net-method">{picked.method}</span>{" "}
                  {picked.path}
                  <span
                    className="net-status"
                    data-bad={picked.status >= 400 || undefined}
                  >
                    {picked.status}
                  </span>
                </span>
                <ToolButton
                  label="Close request details"
                  onClick={() => setSel(null)}
                >
                  <CloseIcon />
                </ToolButton>
              </header>
              <SegmentedControl
                aria-label="Request detail"
                className="segmented small"
                onValueChange={(v: unknown) => {
                  if (typeof v === "string") setTab(v);
                }}
                value={tab}
              >
                <SegmentedControlIndicator className="segmented-indicator" />
                <SegmentedControlItem
                  className="segmented-item"
                  value="response"
                >
                  Response
                </SegmentedControlItem>
                <SegmentedControlItem
                  className="segmented-item"
                  value="headers"
                >
                  Headers
                </SegmentedControlItem>
                <SegmentedControlItem className="segmented-item" value="timing">
                  Timing
                </SegmentedControlItem>
              </SegmentedControl>
              <div className="net-detail-body">
                {tab === "response" ? (
                  <pre
                    aria-label="Response body"
                    className="net-body mono"
                    tabIndex={0}
                  >
                    {body}
                  </pre>
                ) : null}
                {tab === "headers" ? (
                  <dl className="stream-stats net-headers">
                    {headersOf(picked).map(([k, v]) => (
                      <div className="net-header-row" key={k}>
                        <dt className="mono">{k}</dt>
                        <dd className="mono">{v}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
                {tab === "timing" ? (
                  <dl className="stream-stats">
                    <dt>Queued</dt>
                    <dd className="mono">0.4 ms</dd>
                    <dt>Waiting for server</dt>
                    <dd className="mono">{Math.round(picked.ms * 0.8)} ms</dd>
                    <dt>Content download</dt>
                    <dd className="mono">{Math.round(picked.ms * 0.2)} ms</dd>
                    <dt>Initiator</dt>
                    <dd className="mono">product-card.tsx:42</dd>
                  </dl>
                ) : null}
              </div>
            </aside>
          </>
        ) : null}
      </div>
    </>
  );
};

const StoragePanel = ({ locked }: { readonly locked: boolean }) => {
  const [area, setArea] = useState<keyof typeof STORAGE>("cookies");
  return (
    <>
      <div className="devtools-filters">
        <SegmentedControl
          aria-label="Storage area"
          className="segmented small"
          onValueChange={(v: unknown) => {
            if (v === "cookies" || v === "local" || v === "session") setArea(v);
          }}
          value={area}
        >
          <SegmentedControlIndicator className="segmented-indicator" />
          <SegmentedControlItem className="segmented-item" value="cookies">
            Cookies
          </SegmentedControlItem>
          <SegmentedControlItem className="segmented-item" value="local">
            Local
          </SegmentedControlItem>
          <SegmentedControlItem className="segmented-item" value="session">
            Session
          </SegmentedControlItem>
        </SegmentedControl>
        <Input
          aria-label="Search storage"
          className="input compact"
          placeholder="Search"
        />
      </div>
      {locked ? (
        <p className="tool-lock">
          <LockIcon />
          Read-only while the agent drives.
        </p>
      ) : null}
      <table aria-label={`${area} for shop.localhost`} className="net-table">
        <thead>
          <tr>
            <th>Key</th>
            <th>Value</th>
          </tr>
        </thead>
        <tbody>
          {STORAGE[area].map(([k, v]) => (
            <tr key={k}>
              <td className="mono">{k}</td>
              <td className="mono net-path">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
};
