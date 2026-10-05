import type {
  AgentSessionId,
  BrowserConsoleEntry,
  BrowserNetworkRequest,
  BrowserTab,
  BrowserTabId,
  SessionEmulation,
  UserAgentProfileId,
  Viewport,
} from "@contingency/protocol";
import { httpOriginFromUrl, isBrowserRpcError } from "@contingency/protocol";
import { useAtom, useAtomSet } from "@effect/atom-react";
import { Effect, Fiber, Result, Schedule } from "effect";
import { Atom } from "effect/reactivity";
import {
  ActivityIcon,
  DatabaseIcon,
  FingerprintIcon,
  GlobeIcon,
  SparklesIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";

import { BrowserDeviceBar } from "@/components/browser/browser-device-bar";
import {
  devicePresets,
  RESPONSIVE_PRESET_ID,
} from "@/components/browser/browser-device-presets";
import { BrowserDevtools } from "@/components/browser/browser-devtools";
import {
  consoleErrorCount,
  devtoolsPanelTitles,
} from "@/components/browser/browser-devtools-panels";
import type {
  DevtoolsDockSide,
  DevtoolsPanel,
} from "@/components/browser/browser-devtools-panels";
import { BrowserStreamDiagnostics } from "@/components/browser/browser-stream-diagnostics";
import { useAgentBrowserTooling } from "@/components/browser/browser-tooling";
import { EmulationPanel } from "@/components/browser/emulation-panel";
import type { SessionEmulationState } from "@/components/browser/emulation-panel";
import type { EmulationPatch } from "@/components/browser/emulation-patch";
import { RailBadge, RailButton } from "@/components/browser/inspector-rail";
import { UserAgentList } from "@/components/browser/user-agent-list";
import { Button } from "@/components/ui/button";
import { useRpcDependencies } from "@/lib/rpc-dependencies";
import { cn } from "@/lib/utils";

/**
 * How often the stage re-reads what it cannot be pushed: the browser's tabs
 * and the network requests they have made.
 */
const SETUP_POLL_INTERVAL = "2 seconds";

interface SetupState {
  readonly activeTab: BrowserTab | undefined;
  readonly emulation: SessionEmulationState;
  readonly error: string | undefined;
  /** The identity the session was asked for, which it does not report back. */
  readonly identity: UserAgentProfileId;
  readonly networkRequests: readonly BrowserNetworkRequest[];
  readonly pending: boolean;
  readonly presetId: string;
}

// SAFETY: "default" is a declared UserAgentProfileId, and the session reports
// its own identity as soon as the first read lands.
const DEFAULT_IDENTITY = "default" as UserAgentProfileId;

const initialSetupState: SetupState = {
  activeTab: undefined,
  emulation: { status: "unknown" },
  error: undefined,
  identity: DEFAULT_IDENTITY,
  networkRequests: [],
  pending: false,
  presetId: RESPONSIVE_PRESET_ID,
};

const setupStateAtom = Atom.make<SetupState>(initialSetupState);

/** The configuration cards the rail opens over the stage. */
type InspectorCard = "emulation" | "identity" | "stream";

interface InspectorState {
  /** Pixels the inspector takes below the stage when docked there. */
  readonly bottomHeight: number;
  readonly card: InspectorCard | undefined;
  /** An explicit dock side; without one the stage's width decides. */
  readonly dockSide: DevtoolsDockSide | undefined;
  readonly panel: DevtoolsPanel | undefined;
  /** Pixels the inspector takes beside the stage when docked there. */
  readonly rightWidth: number;
}

const DEFAULT_RIGHT_WIDTH = 576;
const DEFAULT_BOTTOM_HEIGHT = 320;
const MIN_INSPECTOR_SIZE = 220;
const RESIZE_STEP = 16;
/** The rail's own width, which the stage and inspector share the rest of. */
const RAIL_WIDTH = 48;
/** The narrowest stage worth keeping beside a right-docked inspector. */
const MIN_STAGE_WIDTH = 560;
/** The share of the region the inspector may take, so the stage survives. */
const MAX_INSPECTOR_SHARE = 0.7;

/**
 * Which tool the rail has open survives Agent Session switches: it is the
 * author's workspace layout, not a property of the browser being inspected.
 */
const inspectorStateAtom = Atom.make<InspectorState>({
  bottomHeight: DEFAULT_BOTTOM_HEIGHT,
  card: undefined,
  dockSide: undefined,
  panel: undefined,
  rightWidth: DEFAULT_RIGHT_WIDTH,
});

/** Surfaces that own their own Escape, so it never also closes the card. */
const ESCAPE_OWNERS =
  '[role="dialog"], [data-slot="select-content"], [role="menu"]';

const cardTitles: Readonly<Record<InspectorCard, string>> = {
  emulation: "Emulation",
  identity: "User agent",
  stream: "Stream diagnostics",
};

const setupErrorMessage = <Failure,>(failure: Failure): string =>
  failure instanceof Error || isBrowserRpcError(failure)
    ? failure.message
    : "The Workspace could not configure the browser.";

const presetViewport = (
  presetId: string,
  current: Viewport | undefined
): Viewport | undefined => {
  const preset = devicePresets.find(({ id }) => id === presetId);
  if (preset === undefined) {
    return undefined;
  }
  return {
    deviceScaleFactor: current?.deviceScaleFactor ?? 1,
    height: preset.height,
    width: preset.width,
  };
};

/** How many Emulation overrides the author has applied, for the rail. */
const emulationOverrideCount = (
  emulation: SessionEmulation | undefined
): number => {
  if (emulation === undefined) {
    return 0;
  }
  const overrides = [
    emulation.geolocation,
    emulation.locale,
    emulation.timezoneId,
    emulation.colorScheme,
  ].filter((value) => value !== undefined && value !== null).length;
  return overrides + (emulation.permissions?.length ?? 0);
};

interface ElementSize {
  readonly height: number;
  readonly width: number;
}

const useElementSize = <Element extends HTMLElement>() => {
  const ref = useRef<Element>(null);
  const [size, setSize] = useState<ElementSize>({ height: 0, width: 0 });
  useEffect(() => {
    const element = ref.current;
    if (element === null) {
      return;
    }
    const observer = new ResizeObserver(([entry]) => {
      if (entry === undefined) {
        return;
      }
      const { height, width } = entry.contentRect;
      setSize((current) =>
        current.height === height && current.width === width
          ? current
          : { height, width }
      );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, size };
};

const clampSize = (size: number, region: number): number =>
  Math.round(
    Math.min(
      Math.max(size, MIN_INSPECTOR_SIZE),
      Math.max(region * MAX_INSPECTOR_SHARE, MIN_INSPECTOR_SIZE)
    )
  );

/**
 * The separator between the stage and the docked inspector. Dragging it, or
 * the arrow keys while it has focus, trade space between the two; the stage
 * only re-zooms, so the page inside it never reflows.
 */
const InspectorResizeHandle = ({
  onResize,
  region,
  side,
  size,
}: {
  readonly onResize: (size: number) => void;
  /** The length of the region the stage and inspector share. */
  readonly region: number;
  readonly side: DevtoolsDockSide;
  readonly size: number;
}) => {
  const drag = useRef<{
    readonly origin: number;
    readonly size: number;
  } | null>(null);
  const pointer = (event: ReactPointerEvent<HTMLDivElement>) =>
    side === "right" ? event.clientX : event.clientY;
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const grow = side === "right" ? "ArrowLeft" : "ArrowUp";
    const shrink = side === "right" ? "ArrowRight" : "ArrowDown";
    if (event.key === grow || event.key === shrink) {
      event.preventDefault();
      onResize(
        clampSize(
          size + (event.key === grow ? RESIZE_STEP : -RESIZE_STEP),
          region
        )
      );
    }
  };
  return (
    <div
      aria-label="Resize DevTools"
      aria-orientation={side === "right" ? "vertical" : "horizontal"}
      aria-valuemax={Math.round(region * MAX_INSPECTOR_SHARE)}
      aria-valuemin={MIN_INSPECTOR_SIZE}
      aria-valuenow={size}
      className={cn(
        "bg-border hover:bg-ring/60 focus-visible:bg-ring relative z-10 shrink-0 touch-none transition-colors outline-none after:absolute",
        side === "right"
          ? "w-px cursor-col-resize after:-inset-x-1 after:inset-y-0"
          : "h-px cursor-row-resize after:inset-x-0 after:-inset-y-1"
      )}
      onKeyDown={onKeyDown}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { origin: pointer(event), size };
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (start !== null) {
          onResize(
            clampSize(start.size + start.origin - pointer(event), region)
          );
        }
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      role="separator"
      tabIndex={0}
    />
  );
};

/**
 * Where the docked inspector sits and how large it is. With no explicit
 * choice it docks beside the stage only while the stage keeps a usable width
 * there; a narrow Workspace — a Run Summary open, a small window — docks it
 * below instead.
 */
const inspectorLayout = (inspector: InspectorState, body: ElementSize) => {
  const autoSide: DevtoolsDockSide =
    body.width === 0 ||
    body.width - RAIL_WIDTH - inspector.rightWidth >= MIN_STAGE_WIDTH
      ? "right"
      : "bottom";
  const side = inspector.dockSide ?? autoSide;
  const regionLength = side === "right" ? body.width - RAIL_WIDTH : body.height;
  return {
    inspectorSize: clampSize(
      side === "right" ? inspector.rightWidth : inspector.bottomHeight,
      regionLength
    ),
    regionLength,
    side,
  };
};

/** Why the browser's setup is read-only, when someone else holds it. */
const browserLockedReason = (
  userHoldsBrowser: boolean,
  teaching: boolean
): string | undefined => {
  if (userHoldsBrowser) {
    return undefined;
  }
  return teaching
    ? "The agent is preparing the browser. You can change its Emulation or storage once it hands you control."
    : "The agent holds the browser. Take control to change its Emulation or storage.";
};

/**
 * Why the Emulation is read-only. A Teaching Recording declares the one
 * Emulation it was demonstrated under, so it is fixed from Start (ADR 0013);
 * storage stays editable.
 */
const emulationLockedReason = (
  userHoldsBrowser: boolean,
  teaching: boolean,
  emulationFixed: boolean
): string | undefined =>
  browserLockedReason(userHoldsBrowser, teaching) ??
  (emulationFixed
    ? "Emulation is fixed once recording starts: the recording declares the Emulation it was demonstrated under."
    : undefined);

const StageError = ({
  message,
  onDismiss,
}: {
  readonly message: string;
  readonly onDismiss: () => void;
}) => (
  <div className="pointer-events-none absolute inset-x-0 top-12 z-30 flex justify-center px-3">
    <p
      className="bg-background text-destructive animate-in fade-in-0 slide-in-from-top-1 pointer-events-auto flex max-w-xl items-center gap-2 rounded-lg border px-3 py-1.5 text-xs shadow-md"
      role="alert"
    >
      {message}
      <Button
        aria-label="Dismiss browser setup error"
        onClick={onDismiss}
        size="icon-xs"
        variant="ghost"
      >
        <XIcon />
      </Button>
    </p>
  </div>
);

/**
 * Every browser tool behind one rail: configuration cards above the divider,
 * docked inspection panels below it, and stream diagnostics at the foot.
 */
const InspectorRail = ({
  card,
  errors,
  identityCustomised,
  onToggleCard,
  onTogglePanel,
  overrides,
  panel,
  requests,
}: {
  readonly card: InspectorCard | undefined;
  readonly errors: number;
  readonly identityCustomised: boolean;
  readonly onToggleCard: (card: InspectorCard) => void;
  readonly onTogglePanel: (panel: DevtoolsPanel) => void;
  readonly overrides: number;
  readonly panel: DevtoolsPanel | undefined;
  readonly requests: number;
}) => (
  <nav
    aria-label="Browser tools"
    className="bg-background flex w-12 shrink-0 flex-col items-center gap-1 border-l py-2"
  >
    <RailButton
      active={card === "identity"}
      badge={identityCustomised ? <RailBadge tone="info">1</RailBadge> : null}
      icon={<FingerprintIcon />}
      label="User agent"
      onClick={() => onToggleCard("identity")}
    />
    <RailButton
      active={card === "emulation"}
      badge={
        overrides === 0 ? null : <RailBadge tone="info">{overrides}</RailBadge>
      }
      description={
        overrides === 0 ? undefined : `${overrides} overrides applied`
      }
      icon={<SparklesIcon />}
      label="Emulation"
      onClick={() => onToggleCard("emulation")}
    />
    <span aria-hidden="true" className="bg-border my-1 h-px w-5" />
    <RailButton
      active={panel === "console"}
      badge={
        errors === 0 ? null : <RailBadge tone="danger">{errors}</RailBadge>
      }
      description={errors === 0 ? undefined : `${errors} errors`}
      icon={<TerminalIcon />}
      label="Console"
      onClick={() => onTogglePanel("console")}
    />
    <RailButton
      active={panel === "network"}
      badge={
        requests === 0 ? null : <RailBadge tone="neutral">{requests}</RailBadge>
      }
      description={requests === 0 ? undefined : `${requests} requests`}
      icon={<GlobeIcon />}
      label="Network"
      onClick={() => onTogglePanel("network")}
    />
    <RailButton
      active={panel === "storage"}
      icon={<DatabaseIcon />}
      label="Storage"
      onClick={() => onTogglePanel("storage")}
    />
    <div className="mt-auto">
      <RailButton
        active={card === "stream"}
        icon={<ActivityIcon />}
        label="Stream diagnostics"
        onClick={() => onToggleCard("stream")}
      />
    </div>
  </nav>
);

/**
 * A configuration card floating over the stage beside the rail. It is
 * transient: Escape, the close button, or a press on the stage dismisses it.
 */
const InspectorCardSurface = ({
  card,
  children,
  lockedReason,
  onClose,
}: {
  readonly card: InspectorCard;
  readonly children: ReactNode;
  readonly lockedReason: string | undefined;
  readonly onClose: () => void;
}) => (
  <section
    aria-label={cardTitles[card]}
    className="bg-background ring-foreground/10 animate-in fade-in-0 zoom-in-[0.98] slide-in-from-right-1 absolute top-2 right-14 z-30 flex max-h-[min(36rem,calc(100%-1rem))] w-88 max-w-[calc(100%-4.5rem)] origin-top-right flex-col overflow-hidden rounded-2xl shadow-[0_24px_64px_-24px_rgb(0_0_0/0.4)] ring-1 duration-200 ease-[cubic-bezier(0.32,0.72,0,1)]"
  >
    <header className="flex h-10 shrink-0 items-center border-b pr-1.5 pl-3.5">
      <h2 className="text-sm font-medium">{cardTitles[card]}</h2>
      <Button
        aria-label={`Close ${cardTitles[card]}`}
        className="ml-auto"
        onClick={onClose}
        size="icon-sm"
        variant="ghost"
      >
        <XIcon />
      </Button>
    </header>
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      {lockedReason === undefined || card === "stream" ? null : (
        <p className="bg-muted/60 text-muted-foreground mb-3 rounded-lg px-3 py-2 text-xs">
          {lockedReason}
        </p>
      )}
      {children}
    </div>
  </section>
);

/**
 * The session's browser setup as the stage reads and changes it: the applied
 * Emulation and identity, the active tab, and its network requests. What the
 * session cannot push is polled; every change is one Emulation patch.
 */
const useBrowserSetup = (sessionId: AgentSessionId) => {
  const {
    agentBrowserEmulationSetMutation,
    agentBrowserEmulationGetMutation,
    agentBrowserNetworkRequestsGetMutation,
    agentBrowserTabsGetMutation,
  } = useRpcDependencies();
  const [state, setState] = useAtom(setupStateAtom);
  const readEmulation = useAtomSet(agentBrowserEmulationGetMutation, {
    mode: "promise",
  });
  const applyEmulation = useAtomSet(agentBrowserEmulationSetMutation, {
    mode: "promise",
  });
  const readTabs = useAtomSet(agentBrowserTabsGetMutation, { mode: "promise" });
  const readNetworkRequests = useAtomSet(
    agentBrowserNetworkRequestsGetMutation,
    {
      mode: "promise",
    }
  );

  const refresh = Effect.gen(function* readBrowserSetup() {
    const emulation = yield* Effect.tryPromise({
      catch: (cause) => cause,
      try: () =>
        readEmulation({
          payload: { sessionId },
        }),
    });
    const tabs = yield* Effect.tryPromise({
      catch: (cause) => cause,
      try: () =>
        readTabs({
          payload: { sessionId },
        }),
    });
    const activeTab = tabs.tabs.find(({ active }) => active) ?? tabs.tabs[0];
    const requests: readonly BrowserNetworkRequest[] =
      activeTab === undefined
        ? []
        : (yield* Effect.tryPromise({
            catch: (cause) => cause,
            try: () =>
              readNetworkRequests({
                payload: { sessionId, tabId: activeTab.tabId },
              }),
          })).requests;
    setState((current) => ({
      ...current,
      activeTab,
      emulation: { emulation: emulation.emulation, status: "known" },
      error: undefined,
      identity: emulation.userAgentProfile,
      networkRequests: requests,
    }));
  }).pipe(
    Effect.catchCause(
      () =>
        // A poll that lost the browser must not blank what the stage shows:
        // the next tick recovers, and an error banner here would flicker.
        Effect.void
    )
  );
  const refreshFromEffect = useEffectEvent(() => refresh);

  useEffect(() => {
    setState(() => initialSetupState);
    const fiber = Effect.runFork(
      Effect.suspend(refreshFromEffect).pipe(
        Effect.repeat(Schedule.spaced(SETUP_POLL_INTERVAL))
      )
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [sessionId, setState]);

  const patch = (
    change: EmulationPatch & {
      readonly userAgentProfile?: UserAgentProfileId | undefined;
      readonly viewport?: Viewport | undefined;
    }
  ) => {
    setState((current) => ({ ...current, error: undefined, pending: true }));
    Effect.runFork(
      Effect.result(
        Effect.tryPromise({
          catch: (cause) => cause,
          try: () =>
            applyEmulation({
              payload: { ...change, sessionId },
            }),
        })
      ).pipe(
        Effect.flatMap((outcome) =>
          Effect.sync(() => {
            setState((current) =>
              Result.isFailure(outcome)
                ? {
                    ...current,
                    error: setupErrorMessage(outcome.failure),
                    pending: false,
                  }
                : {
                    ...current,
                    emulation: {
                      emulation: outcome.success.emulation,
                      status: "known",
                    },
                    error: undefined,
                    identity: outcome.success.userAgentProfile,
                    pending: false,
                  }
            );
          })
        )
      )
    );
  };

  return { patch, refresh, setState, state };
};

/**
 * The live browser as a device stage, with every browser tool behind one
 * inspector rail beside it. The stage owns the whole column: the device bar
 * floats over it, configuration (identity, Emulation, stream diagnostics)
 * opens as a card over it, and inspection (console, network, storage) docks
 * beside or below it. Making room only re-zooms the frame — the Page keeps the
 * viewport the session applies. Every call is addressed by Agent Session id:
 * the MCP-owned browser has no handle the Workspace can name (ADR 0038).
 */
export const WorkspaceBrowserStage = ({
  children,
  consoleEntries,
  emulationFixed,
  onClearConsole,
  sessionId,
  teaching,
  userHoldsBrowser,
}: {
  /** The live frame and everything that floats over it. */
  readonly children: ReactNode;
  readonly consoleEntries: readonly BrowserConsoleEntry[];
  /** A Teaching Recording has started, so its Emulation can no longer change. */
  readonly emulationFixed: boolean;
  readonly onClearConsole: () => void;
  readonly sessionId: AgentSessionId;
  /**
   * Teaching has no Take control: an agent preparing its setup hands the
   * browser over itself (ADR 0042).
   */
  readonly teaching: boolean;
  readonly userHoldsBrowser: boolean;
}) => {
  const tooling = useAgentBrowserTooling(sessionId);
  const { patch, refresh, setState, state } = useBrowserSetup(sessionId);
  const [inspector, setInspector] = useAtom(inspectorStateAtom);
  const { ref: bodyRef, size: body } = useElementSize<HTMLDivElement>();
  const closeCard = useEffectEvent(() => {
    setInspector((current) => ({ ...current, card: undefined }));
  });
  useEffect(() => {
    if (inspector.card === undefined) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      // Escape meant for something the card opened — the location
      // permission dialog, a Select's list — dismisses that alone. Closing
      // the card too would discard what the author had typed into it.
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        (event.target instanceof Element &&
          event.target.closest(ESCAPE_OWNERS) !== null)
      ) {
        return;
      }
      closeCard();
    };
    globalThis.addEventListener("keydown", onKeyDown);
    return () => globalThis.removeEventListener("keydown", onKeyDown);
  }, [inspector.card]);

  const applied =
    state.emulation.status === "known" ? state.emulation.emulation : undefined;
  const disabled = !userHoldsBrowser || state.pending || emulationFixed;
  const activeUrl = state.activeTab?.url;
  const origin =
    activeUrl === undefined ? undefined : httpOriginFromUrl(activeUrl)?.origin;
  const lockedReason = emulationLockedReason(
    userHoldsBrowser,
    teaching,
    emulationFixed
  );

  const { inspectorSize, regionLength, side } = inspectorLayout(
    inspector,
    body
  );

  const toggleCard = (card: InspectorCard) =>
    setInspector((current) => ({
      ...current,
      card: current.card === card ? undefined : card,
    }));
  const togglePanel = (panel: DevtoolsPanel) =>
    setInspector((current) => ({
      ...current,
      card: undefined,
      panel: current.panel === panel ? undefined : panel,
    }));
  const closePanel = () =>
    setInspector((current) => ({ ...current, panel: undefined }));
  const toggleDockSide = () =>
    setInspector((current) => ({
      ...current,
      dockSide: side === "right" ? "bottom" : "right",
    }));
  const clearNetwork = () =>
    setState((current) => ({ ...current, networkRequests: [] }));
  const showError = (message: string) =>
    setState((current) => ({ ...current, error: message }));
  const refreshNow = () => {
    Effect.runFork(refresh);
  };
  const changePreset = (presetId: string) => {
    setState((current) => ({ ...current, presetId }));
    const viewport = presetViewport(presetId, applied?.viewport);
    if (viewport !== undefined) {
      patch({ viewport });
    }
  };

  const { panel, card } = inspector;

  return (
    <div className="relative flex min-h-0 flex-1" ref={bodyRef}>
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1",
          side === "right" ? "flex-row" : "flex-col"
        )}
      >
        {/*
          The stage is always the region's first child, so docking the
          inspector, moving it, or closing it never remounts the live canvas.
        */}
        <section
          aria-label="Browser stage"
          className="bg-muted/40 relative flex min-h-0 min-w-0 flex-1 flex-col bg-[radial-gradient(var(--color-border)_1px,transparent_1px)] [background-size:16px_16px]"
          onPointerDown={() => {
            if (card !== undefined) {
              closeCard();
            }
          }}
        >
          <div className="pointer-events-none flex shrink-0 justify-center px-2 pt-2">
            <BrowserDeviceBar
              applied={applied?.viewport}
              disabled={disabled}
              lockedReason={lockedReason}
              onPresetChange={changePreset}
              onViewportChange={(viewport) => patch({ viewport })}
              presetId={state.presetId}
            />
          </div>
          {state.error === undefined ? null : (
            <StageError
              message={state.error}
              onDismiss={() =>
                setState((current) => ({ ...current, error: undefined }))
              }
            />
          )}
          <div className="relative flex min-h-0 flex-1 flex-col">
            {children}
          </div>
        </section>

        {panel === undefined ? null : (
          <>
            <InspectorResizeHandle
              onResize={(size) =>
                setInspector((current) =>
                  side === "right"
                    ? { ...current, rightWidth: size }
                    : { ...current, bottomHeight: size }
                )
              }
              region={regionLength}
              side={side}
              size={inspectorSize}
            />
            <div
              className="animate-in fade-in-0 flex min-h-0 min-w-0 shrink-0 flex-col duration-150"
              style={
                side === "right"
                  ? { width: inspectorSize }
                  : { height: inspectorSize }
              }
            >
              {state.activeTab === undefined ? (
                <section
                  aria-label={devtoolsPanelTitles[panel]}
                  className="bg-background text-muted-foreground grid size-full place-items-center p-3 text-xs"
                >
                  Waiting for the browser to open a page.
                </section>
              ) : (
                <BrowserDevtools
                  consoleEntries={consoleEntries}
                  dockSide={side}
                  key={state.activeTab.tabId}
                  mutationsLocked={!userHoldsBrowser}
                  networkRequests={state.networkRequests}
                  onClearConsole={onClearConsole}
                  onClearNetwork={clearNetwork}
                  onClose={closePanel}
                  onError={showError}
                  onRefreshNetwork={refreshNow}
                  onToggleDockSide={toggleDockSide}
                  panel={panel}
                  refreshingNetwork={false}
                  tabId={state.activeTab.tabId satisfies BrowserTabId}
                  tabTitle={state.activeTab.title || "Current tab"}
                  tabUrl={state.activeTab.url}
                  tooling={tooling}
                />
              )}
            </div>
          </>
        )}
      </div>

      <InspectorRail
        card={card}
        errors={consoleErrorCount(consoleEntries)}
        identityCustomised={state.identity !== DEFAULT_IDENTITY}
        onToggleCard={toggleCard}
        onTogglePanel={togglePanel}
        overrides={emulationOverrideCount(applied)}
        panel={panel}
        requests={state.networkRequests.length}
      />

      {card === undefined ? null : (
        <InspectorCardSurface
          card={card}
          lockedReason={lockedReason}
          onClose={closeCard}
        >
          {card === "identity" ? (
            <UserAgentList
              disabled={disabled}
              onValueChange={(userAgentProfile) => {
                // An identity moves every signal it implies together (ADR
                // 0013). The session applies the identity's own device
                // metrics, so the identity travels alone rather than beside
                // a viewport this View may not have read yet.
                setState((current) => ({
                  ...current,
                  presetId: RESPONSIVE_PRESET_ID,
                }));
                patch({ userAgentProfile });
              }}
              value={state.identity}
            />
          ) : null}
          {card === "emulation" ? (
            <EmulationPanel
              applied={state.emulation}
              currentOrigin={origin}
              disabled={disabled}
              onPatch={patch}
            />
          ) : null}
          {card === "stream" ? (
            <BrowserStreamDiagnostics sessionId={sessionId} />
          ) : null}
        </InspectorCardSurface>
      )}
    </div>
  );
};
