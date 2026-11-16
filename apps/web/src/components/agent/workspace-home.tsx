import { describeFlowName } from "@contingency/protocol";
import type { AgentSessionSnapshot } from "@contingency/protocol";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Clock, Effect, Fiber, Schedule } from "effect";
import { CheckIcon, CircleAlertIcon, HandIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { WatcherMark } from "@/components/brand";
import { FlowsDockButton } from "@/components/catalog/flows-dock-button";
import { DocsLink } from "@/components/docs-link";
import { ModeToggle } from "@/components/mode-toggle";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRpcDependencies } from "@/lib/rpc-dependencies";
import { cn } from "@/lib/utils";
import { startWorkspaceTransition } from "@/lib/view-transition";
import {
  useWorkspaceRefreshClock,
  WORKSPACE_REFRESH_INTERVAL,
} from "@/lib/workspace-refresh";

import { AndroidStartCard } from "./android-start-card";
import { useAndroidSessionStart } from "./android-workspace";
import { useIosEntryEnabled } from "./ios-workspace-entry";
import { PlatformIcon } from "./platform-icons";
import {
  FlowNameField,
  StartCard,
  StartSection,
  StartSetup,
  TileIcon,
} from "./start-card";
import {
  androidHomeSession,
  DEFAULT_WEB_VIEWPORT,
  elapsedClock,
  homePlatformName,
  iosHomeSession,
  webHomeSession,
  webSessionStart,
  webViewportPresets,
} from "./workspace-home-state";
import type {
  HomePlatform,
  HomeSession,
  HomeSessionStatus,
  WebSessionStart,
} from "./workspace-home-state";

/** The platforms whose start card opens on the home; iOS has its own screen. */
export type HomeCard = "web" | "android";

/** What a Workspace-opened Teaching session is called before it is renamed. */
const DEFAULT_FLOW_NAME = "new-flow";

const PLATFORM_META: Record<HomePlatform, string> = {
  android: "Emulator or device",
  ios: "Simulator",
  web: "Chromium on this computer",
};

/* ------------------------------------------------------------- status chip */

const ProgressRing = ({
  step,
}: {
  readonly step: readonly [number, number];
}) => {
  const circumference = 2 * Math.PI * 6;
  return (
    <svg
      aria-hidden="true"
      className="size-3.5 -rotate-90 fill-none stroke-[2.25]"
      viewBox="0 0 16 16"
    >
      <circle className="stroke-current/20" cx="8" cy="8" r="6" />
      <circle
        className="stroke-current"
        cx="8"
        cy="8"
        r="6"
        strokeDasharray={`${(circumference * step[0]) / step[1]} ${circumference}`}
        strokeLinecap="round"
      />
    </svg>
  );
};

/** The recording clock ticks in its own leaf, so the shelf never re-renders. */
const RecordingClock = ({ startedAt }: { readonly startedAt: string }) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = globalThis.setInterval(() => setNow(Date.now()), 1000);
    return () => globalThis.clearInterval(interval);
  }, []);
  return (
    <span className="font-mono text-xs tabular-nums opacity-85">
      {elapsedClock(startedAt, now)}
    </span>
  );
};

/**
 * A session's status as a tinted chip with its own mark: Recording with the
 * elapsed time, Running with a progress ring and the step when known, Needs
 * you with a hand, and Ready with a check. None of the marks move.
 */
export const StatusChip = ({
  id,
  status,
}: {
  readonly id?: string;
  readonly status: HomeSessionStatus;
}) => {
  switch (status._tag) {
    case "recording": {
      return (
        <span className="status-chip" data-status="recording" id={id}>
          <span
            aria-hidden="true"
            className="size-2.5 scale-75 rounded-full bg-current shadow-[0_0_0_2px_var(--island-solid),0_0_0_3.5px_currentColor]"
          />
          Recording <RecordingClock startedAt={status.startedAt} />
        </span>
      );
    }
    case "running": {
      return (
        <span className="status-chip" data-status="running" id={id}>
          {status.step === undefined ? null : (
            <ProgressRing step={status.step} />
          )}
          Running
          {status.step === undefined ? null : (
            <span className="font-mono text-xs tabular-nums opacity-85">
              {status.step[0]}/{status.step[1]}
            </span>
          )}
        </span>
      );
    }
    case "needs-you": {
      return (
        <span className="status-chip" data-status="needs-you" id={id}>
          <HandIcon aria-hidden="true" className="size-3.5" />
          Needs you
        </span>
      );
    }
    default: {
      return (
        <span className="status-chip" data-status="ready" id={id}>
          <CheckIcon aria-hidden="true" className="size-3.5" />
          Ready
        </span>
      );
    }
  }
};

/* --------------------------------------------------------------- the chrome */

const GlyphBox = ({ platform }: { readonly platform: HomePlatform }) => (
  <span className="bg-island-hover text-foreground grid size-8 place-items-center rounded-[10px] shadow-[inset_0_0_0_1px_var(--island-border)]">
    <PlatformIcon className="size-[17px]" platform={platform} />
  </span>
);

/** The quiet look the shared header controls take on the home's island. */
const islandControlClassName =
  "text-muted-foreground hover:bg-island-hover hover:text-foreground size-[34px] rounded-xl border-transparent bg-transparent shadow-none dark:border-transparent dark:bg-transparent";

/* -------------------------------------------------------------- start card */

const WebStartCard = ({
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
  readonly onStart: (start: WebSessionStart, form: HTMLFormElement) => void;
  readonly pending: boolean;
  readonly platforms: readonly HomePlatform[];
}) => {
  const ids = useId();
  const [viewport, setViewport] = useState(DEFAULT_WEB_VIEWPORT);
  const [startingPage, setStartingPage] = useState("");
  const nameProblem = describeFlowName(flowName.trim());
  const start = webSessionStart(flowName, viewport, startingPage);
  const pageProblem =
    start.url === undefined || URL.canParse(start.url)
      ? null
      : "Enter a web address, such as https://example.com.";
  const ready = nameProblem === null && pageProblem === null;
  const selected = webViewportPresets.find(({ id }) => id === viewport);
  return (
    <StartCard
      error={error}
      onClose={onClose}
      onOtherPlatform={onOtherPlatform}
      onSubmit={(form) => onStart(start, form)}
      platform="web"
      platforms={platforms}
      submitDisabled={!ready || pending}
    >
      <StartSection label="Flow" number={1}>
        <FlowNameField
          name={flowName}
          onChange={onFlowNameChange}
          problem={nameProblem}
        />
        <div className="grid gap-1.5">
          <Label className="text-[13px]" id={`${ids}-viewport`}>
            Viewport
          </Label>
          <Select
            onValueChange={(value) => {
              const preset = webViewportPresets.find(
                ({ id }) => id === value
              );
              if (preset !== undefined) {
                setViewport(preset.id);
              }
            }}
            value={viewport}
          >
            <SelectTrigger aria-labelledby={`${ids}-viewport`} variant="island">
              <SelectValue>
                {selected === undefined ? null : (
                  <span className="flex w-full items-center justify-between gap-3">
                    {selected.label}
                    <span className="text-muted-foreground text-xs tabular-nums">
                      {selected.note}
                    </span>
                  </span>
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectContent variant="island">
              {webViewportPresets.map((preset) => (
                <SelectItem
                  key={preset.id}
                  label={preset.label}
                  value={preset.id}
                >
                  <span className="flex w-full items-center justify-between gap-3">
                    {preset.label}
                    <span
                      aria-hidden="true"
                      className="text-muted-foreground text-xs tabular-nums"
                    >
                      {preset.note}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </StartSection>

      <StartSection label="Starting page" number={2}>
        <div className="grid gap-1.5">
          <Label className="text-[13px]" htmlFor={`${ids}-page`}>
            Starting page
          </Label>
          <Input
            aria-describedby={`${ids}-page-hint`}
            aria-invalid={pageProblem !== null}
            autoComplete="off"
            className="font-mono"
            id={`${ids}-page`}
            inputMode="url"
            onChange={(event) => setStartingPage(event.target.value)}
            placeholder="https://example.com"
            spellCheck={false}
            value={startingPage}
            variant="island"
          />
          <p className="text-muted-foreground text-xs" id={`${ids}-page-hint`}>
            {pageProblem ?? "Optional. A blank page opens without one."}
          </p>
        </div>
      </StartSection>

      <StartSetup summary="Browser profile">
        <div className="border-island-border grid gap-0.5 rounded-xl border px-3 py-2.5">
          <span className="text-sm font-medium">Clean profile</span>
          <span className="text-muted-foreground text-xs">
            Every session starts with a clean browser profile: no cookies,
            storage or sign-ins.
          </span>
        </div>
      </StartSetup>
    </StartCard>
  );
};

/* ------------------------------------------------------------------ shelf */

/** The browser, Android and iOS sessions this process owns, in one list. */
const useHomeSessions = (
  webSessions: readonly AgentSessionSnapshot[]
): readonly HomeSession[] => {
  const { androidSessionsAtom, iosSessionsAtom } = useRpcDependencies();
  const android = useAtomValue(androidSessionsAtom);
  const ios = useAtomValue(iosSessionsAtom);
  const refreshAndroid = useAtomRefresh(androidSessionsAtom);
  const refreshIos = useAtomRefresh(iosSessionsAtom);
  const refreshClock = useWorkspaceRefreshClock();
  // The browser list refreshes with the Workspace; the native lists refresh
  // here, so a session started elsewhere appears without a reload.
  useEffect(() => {
    const fiber = Effect.runFork(
      Effect.sync(() => {
        refreshAndroid();
        refreshIos();
      }).pipe(
        Effect.repeat(Schedule.spaced(WORKSPACE_REFRESH_INTERVAL)),
        Effect.delay(WORKSPACE_REFRESH_INTERVAL),
        Effect.provideService(Clock.Clock, refreshClock),
        Effect.ignore
      )
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [refreshAndroid, refreshClock, refreshIos]);
  return [
    ...webSessions.map(webHomeSession),
    ...(android._tag === "Success" ? android.value : []).map(
      androidHomeSession
    ),
    ...(ios._tag === "Success" ? ios.value : []).map(iosHomeSession),
  ];
};

const SessionCard = ({
  onOpen,
  returning,
  session,
}: {
  readonly onOpen: (session: HomeSession, card: HTMLElement) => void;
  readonly returning: boolean;
  readonly session: HomeSession;
}) => {
  const statusId = useId();
  return (
    <Button
      aria-describedby={statusId}
      aria-label={session.label}
      className="grid grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-3"
      data-vt={returning ? "stage" : undefined}
      onClick={(event) => onOpen(session, event.currentTarget)}
      size="tile"
      variant="tile"
    >
      <GlyphBox platform={session.platform} />
      <span className="grid min-w-0">
        <span className="truncate font-medium">{session.title}</span>
        <span className="text-muted-foreground text-xs font-normal">
          {session.activity} · {homePlatformName(session.platform)}
        </span>
      </span>
      <StatusChip id={statusId} status={session.status} />
    </Button>
  );
};

/* -------------------------------------------------------------------- home */

/**
 * The Workspace home: the start surface for every platform, with the sessions
 * this process has in progress. `/` shows it whenever no session is named in
 * the route, even while sessions run. Chrome floats on islands over a still
 * dot-grid canvas. A tile grows into its start card, and a card on the shelf
 * grows into its session.
 */
export const WorkspaceHome = ({
  error,
  onCardChange,
  onOpenNative,
  onOpenWebSession,
  onStartWeb,
  pending,
  requestedCard,
  returnTo,
  unresolvedSessionId,
  webSessions,
}: {
  readonly error: string | undefined;
  /** Says which start card is open now, or null once the tiles are back. */
  readonly onCardChange?: ((card: HomeCard | null) => void) | undefined;
  /** Opens a native platform at a session, or at its setup for `new`. */
  readonly onOpenNative: (
    platform: "android" | "ios",
    session: string,
    card: HTMLElement | null
  ) => void;
  readonly onOpenWebSession: (sessionId: string, card: HTMLElement) => void;
  readonly onStartWeb: (start: WebSessionStart, form: HTMLFormElement) => void;
  readonly pending: boolean;
  /** The start card the route opens, as `?android=new` does. */
  readonly requestedCard?: HomeCard | undefined;
  /** The session the person just left, which its card grows back from. */
  readonly returnTo: string | undefined;
  readonly unresolvedSessionId: string | undefined;
  readonly webSessions: readonly AgentSessionSnapshot[];
}) => {
  const ios = useIosEntryEnabled();
  const platforms: readonly HomePlatform[] = ios
    ? ["web", "android", "ios"]
    : ["web", "android"];
  // The name is asked for here rather than generated, so the dock's session
  // label is something the person recognizes from the first frame. It
  // outlives the card, so closing, reopening and swapping platform keep it.
  const [flowName, setFlowName] = useState(DEFAULT_FLOW_NAME);
  const [card, setCard] = useState<HomeCard | null>(requestedCard ?? null);
  // The card a route change asks for opens, as a link to `?android=new` does.
  const [requested, setRequested] = useState(requestedCard);
  if (requested !== requestedCard) {
    setRequested(requestedCard);
    if (requestedCard !== undefined) {
      setCard(requestedCard);
    }
  }
  // The tile the last card folds back into.
  const [returning, setReturning] = useState<HomeCard | null>(null);
  const sessions = useHomeSessions(webSessions);
  const android = useAndroidSessionStart();
  const changeCard = (next: HomeCard | null) => {
    setCard(next);
    onCardChange?.(next);
  };
  const openPlatform = (platform: HomePlatform, tile: HTMLElement | null) => {
    if (platform === "ios") {
      onOpenNative(platform, "new", null);
      return;
    }
    startWorkspaceTransition(
      () => {
        changeCard(platform);
        setReturning(null);
      },
      { element: tile, name: "start-card" }
    );
  };
  // Another platform's pill swaps the card's contents in place: nothing
  // flies, and the Flow name stays.
  const switchPlatform = (platform: HomePlatform) => {
    if (platform === "ios") {
      onOpenNative(platform, "new", null);
      return;
    }
    changeCard(platform);
  };
  const closeCard = () => {
    startWorkspaceTransition(() => {
      setReturning(card);
      changeCard(null);
    });
  };
  const openSession = (session: HomeSession, card: HTMLElement) => {
    if (session.platform === "web") {
      onOpenWebSession(session.id, card);
      return;
    }
    onOpenNative(session.platform, session.id, card);
  };
  return (
    <div className="workspace-canvas relative h-full min-h-0 overflow-hidden">
      <nav
        aria-label="Workspace"
        className="island absolute top-4 left-4 z-10 flex items-center p-1.5"
      >
        {/* oxlint-disable-next-line react-doctor/no-prevent-default -- This is already the home; the wordmark only folds the start card away. */}
        <a
          className="hover:bg-island-hover inline-flex items-center gap-2 rounded-[14px] px-2.5 py-1.5"
          href="/"
          onClick={(event) => {
            event.preventDefault();
            if (card !== null) {
              closeCard();
            }
          }}
        >
          <WatcherMark className="text-island-brand" data-vt="brand-mark" />
          <span className="text-[15px] font-semibold tracking-[-0.04em] lowercase">
            Contingency
          </span>
        </a>
      </nav>
      <div className="island absolute top-4 right-4 z-10 flex items-center gap-1 p-1.5">
        <FlowsDockButton className="text-muted-foreground hover:bg-island-hover hover:text-foreground h-[34px] gap-[7px] rounded-xl px-3 text-sm" />
        <DocsLink className={islandControlClassName} />
        <ModeToggle className={islandControlClassName} />
      </div>
      <main className="absolute inset-0 grid [place-items:safe_center] overflow-y-auto px-4 pt-24 pb-16">
        <div className="grid w-full max-w-[760px] justify-items-center gap-10">
          <div className="grid gap-2 text-center">
            <h1 className="text-4xl leading-[1.1] font-semibold tracking-[-0.035em]">
              Teach a new Flow
            </h1>
            <p className="text-muted-foreground mx-auto max-w-[46ch] text-[15px] text-pretty">
              Show Contingency a journey once, on any platform. It learns the
              Flow from what you do.
            </p>
          </div>
          {unresolvedSessionId === undefined ? null : (
            <div className="w-full max-w-[540px] text-left">
              <Alert variant="destructive">
                <CircleAlertIcon aria-hidden="true" />
                <AlertTitle>That session id did not resolve</AlertTitle>
                <AlertDescription>
                  {`Agent Session ${unresolvedSessionId} is not owned by this server process or is no longer running. Start a session to carry on.`}
                </AlertDescription>
              </Alert>
            </div>
          )}
          {card === "web" ? (
            <WebStartCard
              error={error}
              flowName={flowName}
              onClose={closeCard}
              onFlowNameChange={setFlowName}
              onOtherPlatform={switchPlatform}
              onStart={onStartWeb}
              pending={pending}
              platforms={platforms.filter((platform) => platform !== "web")}
            />
          ) : null}
          {card === "android" ? (
            <AndroidStartCard
              error={android.error}
              flowName={flowName}
              onClose={closeCard}
              onFlowNameChange={setFlowName}
              onOtherPlatform={switchPlatform}
              onStart={(name, selection, form) =>
                android.start(name, selection, (sessionId) =>
                  onOpenNative("android", sessionId, form)
                )
              }
              pending={android.pending}
              platforms={platforms.filter((platform) => platform !== "android")}
            />
          ) : null}
          {card === null ? (
            <ul
              aria-label="Start a session"
              className={cn(
                "grid w-full gap-3.5",
                platforms.length === 3 ? "grid-cols-3" : "grid-cols-2"
              )}
            >
              {platforms.map((platform) => (
                <li key={platform}>
                  <Button
                    aria-label={`Start ${platform === "web" ? "a" : "an"} ${homePlatformName(platform)} session`}
                    className="grid h-full gap-[18px] rounded-[26px] p-[18px]"
                    data-vt={returning === platform ? "start-card" : undefined}
                    onClick={(event) =>
                      openPlatform(platform, event.currentTarget)
                    }
                    size="tile"
                    variant="tile"
                  >
                    <TileIcon platform={platform} />
                    <span className="grid">
                      <span className="text-[17px] font-semibold tracking-[-0.02em]">
                        {homePlatformName(platform)}
                      </span>
                      <span className="text-muted-foreground text-[13px] font-normal">
                        {PLATFORM_META[platform]}
                      </span>
                    </span>
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          {sessions.length === 0 ? null : (
            <section aria-label="In progress" className="grid w-full gap-3">
              <h2
                className="text-muted-foreground flex w-fit items-center gap-2 justify-self-center text-[13px] font-medium"
                data-vt="switcher"
              >
                In progress
                <span
                  aria-hidden="true"
                  className="bg-island-hover grid h-5 min-w-5 place-items-center rounded-[7px] px-1.5 font-mono text-[11px] font-semibold shadow-[inset_0_0_0_1px_var(--island-border)]"
                >
                  {sessions.length}
                </span>
              </h2>
              <ul className="grid grid-cols-2 gap-2.5">
                {sessions.map((session) => (
                  <li key={`${session.platform}-${session.id}`}>
                    <SessionCard
                      onOpen={openSession}
                      returning={session.id === returnTo}
                      session={session}
                    />
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </main>
    </div>
  );
};
