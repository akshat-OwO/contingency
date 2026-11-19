import { Button } from "@ui-sdk/react/button";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@ui-sdk/react/collapsible";
import {
  Combobox,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
} from "@ui-sdk/react/combobox";
import { Field, FieldDescription, FieldLabel } from "@ui-sdk/react/field";
import {
  FileInput,
  FileInputDropzone,
  FileInputItem,
  FileInputItemRemove,
  FileInputList,
  FileInputTrigger,
} from "@ui-sdk/react/file-input";
import { Input } from "@ui-sdk/react/input";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@ui-sdk/react/popover";
import { Radio, RadioGroup, RadioIndicator } from "@ui-sdk/react/radio";
import {
  SegmentedControl,
  SegmentedControlIndicator,
  SegmentedControlItem,
} from "@ui-sdk/react/segmented-control";
import {
  Select,
  SelectContent,
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
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import { InspectContext, WebCanvas } from "./canvas";
import type { InspectBridge, PickedElement, StageState } from "./canvas";
import { FlowsPage, REVIEWS, flowOfRun, runById } from "./flows";
import {
  AndroidIcon,
  AppleIcon,
  CheckIcon,
  ArrowLeftIcon,
  ChevronIcon,
  ChevronsIcon,
  CloseIcon,
  CommentIcon,
  DocsIcon,
  InfoIcon,
  FlowsIcon,
  HandIcon,
  KeyIcon,
  MinimizeIcon,
  MoonIcon,
  PlusIcon,
  PointerIcon,
  QuestionIcon,
  ShieldIcon,
  StopIcon,
  SunIcon,
  TaskIcon,
  UploadIcon,
  WatcherMark,
  WebIcon,
} from "./icons";
import {
  BotProtectionNotice,
  CONTROL_LABEL,
  ControlButton,
  GUIDED_CONTROLS,
  TAKEOVER_STATES,
  TakeoverVariableCard,
  controlSentence,
} from "./interactive";
import type { GuidedControl, TakeoverState } from "./interactive";
import { DEVICE_STAGE_NEXT, EraseDevice, NativeCanvas } from "./native";
import type { DeviceCanvas, DeviceStage, RailPlace } from "./native";
import {
  QuestionCard,
  REQUEST_STATES,
  RequestStateContext,
  VariableCard,
} from "./requests";
import type {
  QuestionItem,
  RequestState,
  VariableGroup,
  VariableItem,
} from "./requests";
import {
  DetailsFillContext,
  FILLS,
  LiveTaskDetails,
  useFilledRun,
} from "./run-details";
import type { Fill } from "./run-details";
import {
  DecisionBar,
  RunSummary,
  SummaryDock,
  SummaryMissing,
  SummaryPill,
  SummaryWriting,
  VerdictChip,
  verdictOf,
} from "./summary";
import type { Decision, Run } from "./summary";
import {
  CommentCard,
  DemoPassword,
  TeachingProvider,
  useCommentCount,
} from "./teaching";

type Platform = "web" | "android" | "ios";
type Status =
  | "ready"
  | "recording"
  | "running"
  | "needs-you"
  | "takeover"
  | "ended";

/** How far the Runner has got writing an ended Run's summary. */
type SummaryState = "writing" | "ready" | "missing";

/** What the agent is waiting on. Shown bottom centre, one at a time. */
type Request =
  | {
      readonly id: string;
      readonly kind: "boundary";
      readonly title: string;
      readonly detail: string;
      readonly target: string;
    }
  | {
      readonly id: string;
      readonly kind: "variables";
      readonly title: string;
      readonly detail: string;
      readonly group: VariableGroup;
      readonly items: readonly VariableItem[];
    }
  | {
      readonly id: string;
      readonly kind: "question";
      readonly title: string;
      readonly detail: string;
      readonly questions: readonly QuestionItem[];
    };

interface Session {
  readonly id: string;
  readonly platform: Platform;
  readonly flow: string;
  readonly activity: "Teaching" | "Dry Run" | "Guided Run" | "Run";
  status: Status;
  readonly step?: readonly [number, number];
  since: number;
  /** Who drives the device during a Run. Teaching is always the user's. */
  control?: "agent" | "user";
  requests: readonly Request[];
  readonly task?: string;
  /** The Teaching Recording a Dry Run session tests. */
  readonly recording?: string;
  /** Set when the session's Run ends; its summary docks beside it. */
  ended?: { readonly run: string; readonly summary: SummaryState };
  /**
   * A Guided recording on Web (ADR 0065, #777): the agent drives while
   * capture runs, and asks for help with a reason.
   */
  guided?: { readonly requested?: string };
  /** The site's bot protection refused a request (#266). */
  bot?: string;
}

/** The Run each Run session ends with, so the prototype can end it. */
const ENDS_WITH: Record<string, string> = {
  s2: "run_F2pr",
  s4: "run_R3dj",
  s5: "run_N4cs",
  s6: "run_W8hs",
};

type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;

const REQUEST_SAMPLES: readonly WithoutId<Request>[] = [
  {
    detail: "Allow permits this exact attempt once; a retry asks again.",
    kind: "boundary",
    target: "Place order · $74.00",
    title: "Allow the agent to place the order?",
  },
  {
    detail:
      "Allowing this exact host covers this Run. The saved Domain Scope stays unchanged.",
    kind: "boundary",
    target: "pay.stripe.com",
    title: "Allow the agent to visit a new host?",
  },
  {
    detail: "Setup sign-in",
    group: "setup",
    items: [
      {
        name: "ADMIN_EMAIL",
        purpose: "Signs in to the staging admin before recording.",
        refusable: true,
      },
      { name: "ADMIN_PASSWORD", refusable: true },
      { answer: "supplied", name: "STORE_URL", refusable: true },
    ],
    kind: "variables",
    title: "Setup Variables",
  },
  {
    detail: "Dry Run secret",
    group: "dry-run",
    items: [
      { name: "PASSWORD", refusable: false },
      { answer: "supplied", name: "OTP_SEED", refusable: false },
    ],
    kind: "variables",
    title: "Dry Run Variables",
  },
  {
    detail: "Prerequisite inputs",
    group: "prerequisite",
    items: [
      {
        name: "login/PASSWORD",
        purpose: "The login Flow runs first to sign in.",
        refusable: true,
      },
      { answer: "refused", name: "login/OTP", refusable: true },
    ],
    kind: "variables",
    title: "Prerequisite Variables",
  },
  {
    detail: "Runtime input",
    group: "runtime",
    items: [{ name: "PROMO_CODE", refusable: true }],
    kind: "variables",
    title: "Runtime Variables",
  },
  {
    detail: "Example inputs",
    group: "example",
    items: [{ name: "public-login/PASSWORD", refusable: true }],
    kind: "variables",
    title: "Example private inputs",
  },
  {
    detail: "Guided Run",
    kind: "question",
    questions: [
      {
        answer: { by: "user", text: "Use the staging store, not production." },
        id: "q0",
        text: "Which store should the account be created in?",
      },
      {
        id: "q1",
        text: "The document says the account starts on Free, but the app only offers Starter and Pro. Which plan should it start on?",
      },
    ],
    title: "Which plan should the new account start on?",
  },
  {
    detail: "Guided Run",
    kind: "question",
    questions: [
      {
        id: "q2",
        proposal: {
          kind: "Browser Check",
          lines: [
            ["Request", "POST /api/accounts"],
            ["Expect", "status = 201"],
            ["When", "After Create account"],
          ],
          reason:
            "Creating the account should call the accounts API once and succeed.",
        },
        text: "Add a check that account creation succeeds?",
      },
    ],
    title: "Add a check that account creation succeeds?",
  },
];

/** Who holds the browser in a Guided recording. */
const guidedControl = (s: Session): GuidedControl =>
  s.control === "user"
    ? "user"
    : s.guided?.requested !== undefined
      ? "requested"
      : "agent";

const statusOf = (s: Session): Status =>
  s.ended
    ? "ended"
    : s.requests.length > 0
      ? "needs-you"
      : s.control === "user"
        ? "takeover"
        : s.status;

const PLATFORMS: Record<
  Platform,
  {
    readonly name: string;
    readonly meta: string;
    readonly Icon: () => ReactNode;
  }
> = {
  web: { Icon: WebIcon, meta: "Chromium on this Mac", name: "Web" },
  android: { Icon: AndroidIcon, meta: "Emulator or device", name: "Android" },
  ios: { Icon: AppleIcon, meta: "Simulator", name: "iOS" },
};
const ORDER: readonly Platform[] = ["web", "android", "ios"];

const now = Date.now();
const SEED: readonly Session[] = [
  {
    activity: "Teaching",
    flow: "checkout",
    id: "s1",
    platform: "web",
    since: now - 42_000,
    requests: [],
    status: "recording",
  },
  {
    activity: "Dry Run",
    flow: "profile",
    id: "s2",
    platform: "android",
    recording: "rec_5Pf0",
    since: now - 128_000,
    control: "agent",
    requests: [],
    status: "running",
    step: [4, 9],
  },
  {
    activity: "Guided Run",
    flow: "onboarding",
    id: "s3",
    platform: "ios",
    since: now - 305_000,
    control: "agent",
    requests: [{ ...REQUEST_SAMPLES[7], id: "r-seed-3" } as Request],
    status: "running",
    step: [3, 7],
  },
  {
    activity: "Run",
    flow: "Find a red jacket under $80",
    id: "s4",
    platform: "web",
    since: now - 61_000,
    control: "agent",
    requests: [{ ...REQUEST_SAMPLES[1], id: "r-seed-4" } as Request],
    status: "running",
    step: [2, 6],
    task: "Find a red jacket under $80 in size M and add it to the cart. Stop before paying.",
  },
  {
    activity: "Guided Run",
    bot: "auth.shop.example",
    control: "agent",
    flow: "signup",
    guided: {},
    id: "s7",
    platform: "web",
    requests: [],
    since: now - 96_000,
    status: "recording",
  },
  {
    activity: "Dry Run",
    control: "agent",
    flow: "wishlist",
    id: "s6",
    platform: "web",
    recording: "rec_8Wl3",
    requests: [],
    since: now - 48_000,
    status: "running",
    step: [3, 3],
  },
  {
    activity: "Dry Run",
    control: "agent",
    ended: { run: "run_N4cs", summary: "ready" },
    flow: "onboarding",
    id: "s5",
    platform: "ios",
    recording: "rec_3Vw8",
    requests: [],
    since: now - 400_000,
    status: "running",
    step: [5, 5],
  },
];

const sessionLabel = (s: Session) =>
  s.activity === "Teaching" ? s.flow : `${s.flow} · ${s.activity}`;

const clock = (since: number) => {
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

const useNow = () => {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
};

const reducedMotion = () =>
  matchMedia("(prefers-reduced-motion: reduce)").matches;

// The old snapshot is taken before `update` runs, so the element that should
// grow into the next view is named first and every stale name is cleared.
const transition = (
  update: () => void,
  morph?: { readonly element: Element | null; readonly name: string }
) => {
  for (const el of document.querySelectorAll<HTMLElement>("[data-vt]")) {
    el.style.viewTransitionName = el.dataset.vt ?? "";
  }
  if (morph?.element instanceof HTMLElement) {
    morph.element.style.viewTransitionName = morph.name;
  }
  if (!document.startViewTransition || reducedMotion()) {
    update();
    return;
  }
  document.startViewTransition(() => flushSync(update));
};

/* ------------------------------------------------------------------ status */

const ProgressRing = ({
  step,
}: {
  readonly step: readonly [number, number];
}) => {
  const c = 2 * Math.PI * 6;
  return (
    <svg aria-hidden="true" className="ring" viewBox="0 0 16 16">
      <circle className="ring-track" cx="8" cy="8" r="6" />
      <circle
        className="ring-fill"
        cx="8"
        cy="8"
        r="6"
        strokeDasharray={`${(c * step[0]) / step[1]} ${c}`}
      />
    </svg>
  );
};

const StatusChip = ({ session }: { readonly session: Session }) => {
  const status = statusOf(session);
  if (session.guided?.requested !== undefined && status === "recording") {
    return (
      <span className="chip" data-status="needs-you">
        <HandIcon />
        Takeover requested
      </span>
    );
  }
  if (session.guided && status === "recording") {
    return (
      <span className="chip" data-status="recording">
        <span aria-hidden="true" className="rec-mark" />
        Guided recording <span className="mono">{clock(session.since)}</span>
      </span>
    );
  }
  switch (status) {
    case "recording":
      return (
        <span className="chip" data-status="recording">
          <span aria-hidden="true" className="rec-mark" />
          Recording <span className="mono">{clock(session.since)}</span>
        </span>
      );
    case "running":
      return (
        <span className="chip" data-status="running">
          {session.step ? <ProgressRing step={session.step} /> : null}
          Running
          {session.step ? (
            <span className="mono">
              {session.step[0]}/{session.step[1]}
            </span>
          ) : null}
        </span>
      );
    case "needs-you":
      return (
        <span className="chip" data-status="needs-you">
          <HandIcon />
          Needs you
        </span>
      );
    case "ready":
      return (
        <span className="chip" data-status="ready">
          <CheckIcon />
          Ready
        </span>
      );
    case "takeover":
      return (
        <span className="chip" data-status="takeover">
          <PointerIcon />
          You have control
        </span>
      );
    case "ended":
      return (
        <span className="chip" data-status="ended">
          <StopIcon />
          Ended
        </span>
      );
  }
};

/* ----------------------------------------------------------------- chrome */

const Hint = ({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) => (
  <Tooltip>
    {children}
    <TooltipContent className="tooltip">{label}</TooltipContent>
  </Tooltip>
);

const IconButton = ({
  label,
  onClick,
  children,
  className = "icon-btn",
}: {
  readonly label: string;
  readonly onClick?: () => void;
  readonly children: ReactNode;
  readonly className?: string;
}) => (
  <Hint label={label}>
    <TooltipTrigger render={<Button className={className} onClick={onClick} />}>
      {children}
    </TooltipTrigger>
  </Hint>
);

const ThemeButton = () => {
  const [dark, setDark] = useState(
    () =>
      document.documentElement.dataset.theme === "dark" ||
      (!document.documentElement.dataset.theme &&
        matchMedia("(prefers-color-scheme: dark)").matches)
  );
  return (
    <IconButton
      label={dark ? "Light theme" : "Dark theme"}
      onClick={() => {
        document.documentElement.dataset.theme = dark ? "light" : "dark";
        setDark(!dark);
      }}
    >
      {dark ? <SunIcon /> : <MoonIcon />}
    </IconButton>
  );
};

/** Where **Flows** goes: `/flow`, a page of its own instead of a drawer. */
const FlowsNav = createContext<{
  readonly open: (from: Element) => void;
  readonly here: boolean;
  /** Leaving `/flow`: the sidebar shrinks back into this button. */
  readonly morphBack: boolean;
}>({ here: false, morphBack: false, open: () => {} });

const Actions = () => {
  const nav = useContext(FlowsNav);
  const flows = (
    <Button
      aria-current={nav.here ? "page" : undefined}
      className="pill-btn"
      data-here={nav.here || undefined}
      onClick={(e) => {
        if (!nav.here) nav.open(e.currentTarget);
      }}
      style={{
        viewTransitionName: nav.morphBack ? "flows-sidebar" : undefined,
      }}
    >
      <FlowsIcon />
      Flows
    </Button>
  );
  return (
    <div className="chrome right island">
      {flows}
      <IconButton label="Docs">
        <DocsIcon />
      </IconButton>
      <ThemeButton />
    </div>
  );
};

const SessionSwitcher = ({
  sessions,
  current,
  onOpen,
  onNew,
  side,
}: {
  readonly sessions: readonly Session[];
  readonly current: Session | undefined;
  readonly onOpen: (id: string) => void;
  readonly onNew?: () => void;
  readonly side: "top" | "bottom";
}) => {
  const [open, setOpen] = useState(false);
  const CurrentIcon = current ? PLATFORMS[current.platform].Icon : null;
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        aria-haspopup="dialog"
        aria-label="Agent Session"
        className="switcher"
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
        role="combobox"
      >
        {current && CurrentIcon ? (
          <>
            <span className="platform-glyph">
              <CurrentIcon />
            </span>
            <span className="label">{sessionLabel(current)}</span>
          </>
        ) : (
          <>
            <span className="label">Sessions</span>
            <span className="count">{sessions.length}</span>
          </>
        )}
        <span className="chev">
          <ChevronsIcon />
        </span>
      </PopoverTrigger>
      <PopoverContent
        aria-label="Agent Sessions"
        className="popover island"
        side={side}
        sideOffset={14}
      >
        <PopoverTitle className="popover-title">Agent Sessions</PopoverTitle>
        <div className="popover-list">
          {sessions.map((s) => {
            const { Icon, name } = PLATFORMS[s.platform];
            return (
              <Button
                aria-label={sessionLabel(s)}
                aria-pressed={s.id === current?.id}
                className="option"
                key={s.id}
                onClick={() => {
                  setOpen(false);
                  onOpen(s.id);
                }}
              >
                <span className="glyph-box">
                  <Icon />
                </span>
                <span className="option-text">
                  <span className="opt-title">{s.flow}</span>
                  <span className="opt-sub">
                    {s.activity} · {name}
                  </span>
                </span>
                <StatusChip session={s} />
              </Button>
            );
          })}
        </div>
        {onNew ? (
          <>
            <hr />
            <Button
              className="pill-btn wide"
              onClick={() => {
                setOpen(false);
                onNew();
              }}
            >
              <PlusIcon />
              New session
            </Button>
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
};

/* ----------------------------------------------------------- start a session */

const ROLES = ["button", "heading", "text", "textfield", "image", "link"];

const RoleAndElement = ({
  title,
  description,
}: {
  readonly title: string;
  readonly description: string;
}) => (
  <fieldset className="pair">
    <legend>{title}</legend>
    <p className="hint">{description}</p>
    <div className="pair-row">
      <Field className="field">
        <FieldLabel className="sr-only">{title} role</FieldLabel>
        <Select defaultValue="button">
          <SelectTrigger className="select-trigger">
            <SelectValue />
            <ChevronsIcon />
          </SelectTrigger>
          <SelectContent className="select-list island">
            {ROLES.map((role) => (
              <SelectItem className="select-item" key={role} value={role}>
                {role}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field className="field grow">
        <FieldLabel className="sr-only">{title} element</FieldLabel>
        <Input className="input" placeholder="Accessible name, e.g. Sign in" />
      </Field>
    </div>
  </fieldset>
);

const AppUpload = ({
  accept,
  kind,
  onChange,
}: {
  readonly accept: string;
  readonly kind: string;
  readonly onChange: (has: boolean) => void;
}) => (
  <Field className="field">
    <FieldLabel>Upload a build</FieldLabel>
    <FileInput
      accept={accept}
      className="file-input"
      onValueChange={(files: readonly File[]) => onChange(files.length > 0)}
    >
      <FileInputDropzone className="dropzone">
        <UploadIcon />
        <span>
          Drop a <span className="mono">{kind}</span> here or
        </span>
        <FileInputTrigger className="link-btn">browse</FileInputTrigger>
      </FileInputDropzone>
      <FileInputList aria-label="Uploaded build" className="file-list">
        <FileInputItem className="file-item">
          {({ file }: { file: File }) => (
            <>
              <span className="mono">{file.name}</span>
              <FileInputItemRemove
                aria-label={`Remove ${file.name}`}
                className="icon-btn small"
              >
                <CloseIcon />
              </FileInputItemRemove>
            </>
          )}
        </FileInputItem>
      </FileInputList>
    </FileInput>
  </Field>
);

const BROWSER_PROFILES = [
  { browser: "Chrome", profile: "Personal" },
  { browser: "Chrome", profile: "Work" },
  { browser: "Arc", profile: "Default" },
  { browser: "Edge", profile: "Default" },
];

const BrowserProfile = () => {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <div className="field">
      <span className="label" id="profile-label">
        Browser profile
      </span>
      {picked ? (
        <div className="profile-row">
          <span className="glyph-box">
            <WebIcon />
          </span>
          <span className="option-text">
            <span className="opt-title">{picked}</span>
            <span className="opt-sub">
              Cookies and storage are copied into this session only.
            </span>
          </span>
          <Button className="pill-btn" onClick={() => setPicked(null)}>
            Remove
          </Button>
        </div>
      ) : (
        <div className="profile-row">
          <span className="option-text">
            <span className="opt-title">Clean profile</span>
            <span className="opt-sub">
              Every session starts with no cookies or sign-ins.
            </span>
          </span>
          <Popover onOpenChange={setOpen} open={open}>
            <PopoverTrigger className="pill-btn floating">
              Import profile…
            </PopoverTrigger>
            <PopoverContent
              aria-label="Installed browsers"
              className="popover island narrow"
              side="bottom"
              align="end"
              sideOffset={8}
            >
              <PopoverTitle className="popover-title">
                Installed browsers
              </PopoverTitle>
              <div className="popover-list">
                {BROWSER_PROFILES.map(({ browser, profile }) => (
                  <Button
                    className="option"
                    key={`${browser}-${profile}`}
                    onClick={() => {
                      setPicked(`${browser} · ${profile}`);
                      setOpen(false);
                    }}
                  >
                    <span className="glyph-box">
                      <WebIcon />
                    </span>
                    <span className="option-text">
                      <span className="opt-title">{browser}</span>
                      <span className="opt-sub">{profile}</span>
                    </span>
                  </Button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        </div>
      )}
    </div>
  );
};

const DEVICES: Record<
  Platform,
  readonly { value: string; label: string; note: string }[]
> = {
  web: [
    { label: "Desktop", note: "1280 × 800", value: "desktop" },
    { label: "iPhone 15", note: "Emulated", value: "iphone" },
    { label: "Pixel 8", note: "Emulated", value: "pixel" },
  ],
  android: [
    { label: "Pixel_9 · Android 16", note: "Running", value: "pixel9" },
    { label: "Pixel_7 · Android 15", note: "Boots on start", value: "pixel7" },
  ],
  ios: [
    { label: "iPhone 17 · iOS 26.5", note: "Booted", value: "iphone17" },
    {
      label: "iPhone 16e · iOS 26.5",
      note: "Boots on start",
      value: "iphone16e",
    },
  ],
};

const INSTALLED = [
  { label: "Contingency Public Login", value: "com.contingency.publiclogin" },
  { label: "Shop", value: "com.example.shop" },
  { label: "Settings", value: "com.android.settings" },
];

const PERMISSIONS = ["Location", "Camera", "Notifications"];

const StartCard = ({
  platform,
  flow,
  setFlow,
  onClose,
  onSwitch,
  onStart,
}: {
  readonly platform: Platform;
  readonly onClose: () => void;
  readonly onSwitch: (p: Platform) => void;
  readonly onStart: (flow: string, form: HTMLFormElement) => void;
  readonly flow: string;
  readonly setFlow: (flow: string) => void;
}) => {
  const { Icon, name } = PLATFORMS[platform];
  const [url, setUrl] = useState("https://shop.localhost");
  const [deviceValue, setDeviceValue] = useState<string | undefined>();
  const [app, setApp] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState(false);
  const native = platform !== "web";
  const ready =
    flow.trim() !== "" &&
    (platform === "web"
      ? url.trim() !== ""
      : platform === "android"
        ? app !== null || uploaded
        : uploaded);
  return (
    <div className="start-wrap">
      <form
        aria-labelledby="start-title"
        className="start island"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) {
            onStart(flow.trim(), event.currentTarget);
          }
        }}
      >
        <header>
          <span className="tile-icon">
            <Icon />
          </span>
          <div>
            <h2 id="start-title">Teach on {name}</h2>
            <p>Name the Flow, choose where it runs and what it opens.</p>
          </div>
          <IconButton label="Back to platforms" onClick={onClose}>
            <CloseIcon />
          </IconButton>
        </header>

        <section aria-label="Flow" className="section">
          <span className="section-num" aria-hidden="true">
            1
          </span>
          <Field className="field">
            <FieldLabel>Flow name</FieldLabel>
            <Input
              autoComplete="off"
              autoFocus
              className="input mono"
              onChange={(e) => setFlow(e.currentTarget.value)}
              required
              spellCheck={false}
              value={flow}
            />
          </Field>
          <Field className="field">
            <FieldLabel>
              {platform === "web"
                ? "Viewport"
                : platform === "android"
                  ? "Device"
                  : "Simulator"}
            </FieldLabel>
            <Select
              onValueChange={(v: string | null) => {
                if (v) setDeviceValue(v);
              }}
              value={
                DEVICES[platform].some((d) => d.value === deviceValue)
                  ? deviceValue
                  : DEVICES[platform][0]?.value
              }
            >
              <SelectTrigger className="select-trigger">
                <SelectValue />
                <ChevronsIcon />
              </SelectTrigger>
              <SelectContent className="select-list island">
                {DEVICES[platform].map((d) => (
                  <SelectItem
                    className="select-item"
                    key={d.value}
                    value={d.value}
                  >
                    {d.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {native ? (
              <div className="device-foot">
                <FieldDescription className="hint">
                  Devices that are off boot when the session starts.
                </FieldDescription>
                <EraseDevice
                  device={
                    DEVICES[platform].find((d) => d.value === deviceValue) ??
                    DEVICES[platform][0]
                  }
                />
              </div>
            ) : null}
          </Field>
        </section>

        <section
          aria-label={native ? "Target App" : "Starting page"}
          className="section"
        >
          <span className="section-num" aria-hidden="true">
            2
          </span>
          {platform === "web" ? (
            <Field className="field">
              <FieldLabel>Starting page</FieldLabel>
              <Input
                className="input mono"
                inputMode="url"
                onChange={(e) => setUrl(e.currentTarget.value)}
                spellCheck={false}
                value={url}
              />
            </Field>
          ) : null}
          {platform === "android" ? (
            <>
              <Combobox
                onValueChange={(value: string | null) => setApp(value)}
                value={app}
              >
                <div className="field">
                  <ComboboxLabel className="label">Target App</ComboboxLabel>
                  <ComboboxInput
                    className="input"
                    placeholder="Search installed apps"
                  />
                </div>
                <ComboboxContent className="select-list island">
                  <ComboboxList>
                    {INSTALLED.map((a) => (
                      <ComboboxItem
                        className="select-item two-line"
                        key={a.value}
                        value={a.value}
                      >
                        {a.label}
                        <span className="mono hint">{a.value}</span>
                      </ComboboxItem>
                    ))}
                  </ComboboxList>
                </ComboboxContent>
              </Combobox>
              <div className="or" aria-hidden="true">
                or
              </div>
              <AppUpload accept=".apk" kind=".apk" onChange={setUploaded} />
            </>
          ) : null}
          {platform === "ios" ? (
            <AppUpload accept=".app,.zip" kind=".app" onChange={setUploaded} />
          ) : null}
        </section>

        <Collapsible className="more">
          <CollapsibleTrigger className="more-trigger">
            <span className="section-num" aria-hidden="true">
              3
            </span>
            <span className="more-title">Setup</span>
            <span className="hint">
              {native
                ? "Starting data, permissions, start and finish"
                : "Browser profile"}
            </span>
            <span className="more-chev">
              <ChevronIcon />
            </span>
          </CollapsibleTrigger>
          <CollapsiblePanel className="more-panel">
            {native ? null : <BrowserProfile />}
            {native ? (
              <Field className="field">
                <FieldLabel>Starting data</FieldLabel>
                <RadioGroup className="radio-cards" defaultValue="keep">
                  <label className="radio-card">
                    <Radio className="radio" value="keep">
                      <RadioIndicator className="radio-dot" />
                    </Radio>
                    <span>
                      Keep current data
                      <span className="hint">
                        Cookies, sign-ins and storage stay.
                      </span>
                    </span>
                  </label>
                  <label className="radio-card">
                    <Radio className="radio" value="clear">
                      <RadioIndicator className="radio-dot" />
                    </Radio>
                    <span>
                      Clear app data
                      <span className="hint">Starts as a first launch.</span>
                    </span>
                  </label>
                </RadioGroup>
              </Field>
            ) : null}
            {platform === "android" ? (
              <fieldset className="pair">
                <legend>App permissions</legend>
                {PERMISSIONS.map((p) => (
                  <div className="perm-row" key={p}>
                    <span>{p}</span>
                    <SegmentedControl
                      aria-label={`${p} permission`}
                      className="segmented"
                      defaultValue="unchanged"
                    >
                      <SegmentedControlIndicator className="segmented-indicator" />
                      <SegmentedControlItem
                        className="segmented-item"
                        value="unchanged"
                      >
                        Ask
                      </SegmentedControlItem>
                      <SegmentedControlItem
                        className="segmented-item"
                        value="grant"
                      >
                        Grant
                      </SegmentedControlItem>
                      <SegmentedControlItem
                        className="segmented-item"
                        value="revoke"
                      >
                        Deny
                      </SegmentedControlItem>
                    </SegmentedControl>
                  </div>
                ))}
              </fieldset>
            ) : null}
            {native ? (
              <>
                <RoleAndElement
                  description="Teaching waits until this element shows."
                  title="Starting screen"
                />
                <RoleAndElement
                  description="The Flow is done once this element shows."
                  title="Done when"
                />
              </>
            ) : null}
          </CollapsiblePanel>
        </Collapsible>

        <Button className="btn" disabled={!ready} type="submit">
          Start teaching
        </Button>
      </form>
      <div aria-label="Other platforms" className="others" role="group">
        {ORDER.filter((p) => p !== platform).map((p) => {
          const Other = PLATFORMS[p].Icon;
          return (
            <Button
              className="pill-btn floating"
              key={p}
              onClick={() => onSwitch(p)}
            >
              <Other />
              {PLATFORMS[p].name}
            </Button>
          );
        })}
      </div>
    </div>
  );
};

/* -------------------------------------------------------------------- views */

const Home = ({
  flow,
  setFlow,
  sessions,
  expanded,
  returning,
  returnTo,
  onExpand,
  onCollapse,
  onOpen,
  onStart,
}: {
  readonly flow: string;
  readonly setFlow: (flow: string) => void;
  readonly sessions: readonly Session[];
  readonly expanded: Platform | null;
  readonly returning: Platform | null;
  readonly returnTo: string | null;
  readonly onExpand: (p: Platform, from?: Element | null) => void;
  readonly onCollapse: () => void;
  readonly onOpen: (id: string, from?: Element | null) => void;
  readonly onStart: (
    platform: Platform,
    flow: string,
    form: HTMLFormElement
  ) => void;
}) => (
  <>
    <nav aria-label="Workspace" className="chrome left island">
      <a
        className="brand"
        href="#"
        onClick={(e) => {
          e.preventDefault();
          if (expanded) onCollapse();
        }}
      >
        <WatcherMark className="brand-mark" />
        <span className="brand-text">contingency</span>
      </a>
    </nav>
    <Actions />
    <main className="home">
      <div className="home-stack">
        <div className="hero">
          <h1>Teach a new Flow</h1>
          <p>
            Show Contingency a journey once, on any platform. It learns the Flow
            from what you do.
          </p>
        </div>
        {expanded ? (
          <StartCard
            flow={flow}
            key={expanded}
            setFlow={setFlow}
            onClose={onCollapse}
            onStart={(flow, form) => onStart(expanded, flow, form)}
            onSwitch={(p) => onExpand(p)}
            platform={expanded}
          />
        ) : (
          <ul aria-label="Start a session" className="platforms">
            {ORDER.map((p, i) => {
              const { Icon, meta, name } = PLATFORMS[p];
              return (
                <li key={p}>
                  <Button
                    aria-label={`Start a ${name} session`}
                    className="tile island"
                    data-vt={`tile-${p}`}
                    onClick={(e) => onExpand(p, e.currentTarget)}
                    style={{
                      viewTransitionName:
                        returning === p ? "start-card" : `tile-${p}`,
                    }}
                  >
                    <span className="tile-icon">
                      <Icon />
                    </span>
                    <span>
                      <span className="tile-name">{name}</span>
                      <br />
                      <span className="tile-meta">{meta}</span>
                    </span>
                    <kbd aria-hidden="true">{i + 1}</kbd>
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        {sessions.length > 0 ? (
          <section aria-labelledby="shelf-title" className="shelf">
            <h2 className="shelf-head" id="shelf-title">
              In progress <span className="count quiet">{sessions.length}</span>
            </h2>
            <ul>
              {sessions.map((s) => {
                const { Icon, name } = PLATFORMS[s.platform];
                return (
                  <li key={s.id}>
                    <Button
                      aria-label={sessionLabel(s)}
                      className="session-card island"
                      data-vt={`card-${s.id}`}
                      onClick={(e) => onOpen(s.id, e.currentTarget)}
                      style={{
                        viewTransitionName:
                          returnTo === s.id ? "stage" : `card-${s.id}`,
                      }}
                    >
                      <span className="glyph-box" title={name}>
                        <Icon />
                      </span>
                      <span className="option-text">
                        <span className="opt-title">{s.flow}</span>
                        <span className="opt-sub">
                          {s.activity} · {name}
                        </span>
                      </span>
                      <StatusChip session={s} />
                    </Button>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
      </div>
    </main>
  </>
);

const LINE: Record<Status, string> = {
  "needs-you": "The agent is waiting on you.",
  ready: "Start recording when the journey begins.",
  recording: "Every click and keystroke becomes an instruction.",
  running: "The agent is following the Flow.",
  takeover: "Capture continues. Return control when you're done.",
  ended: "The Run ended. Its summary is beside it.",
};

/**
 * What the product says today: long enough to clip at 240px. The scaffold's
 * **Sentence** switch shows these, so each disclosure can be judged on real
 * copy.
 */
const LONG_LINE: Record<Status, string> = {
  "needs-you":
    "The agent is waiting on you. Answer the request to let it continue; nothing runs until you do.",
  ready:
    "The agent is preparing the browser. Start recording appears when it hands you control; nothing is captured before then.",
  recording:
    "Every click and keystroke becomes an instruction. Add a comment to explain why, and Stop when the journey ends.",
  running:
    "The agent is following the Flow on its own. Take control at any time; the agent waits until you return it.",
  takeover:
    "Capture continues while you drive. Return control when you're done and the agent picks up from this page.",
  ended:
    "The Run ended and the device was released. Its summary is docked beside the last frame; Done closes the session.",
};

/**
 * How a clipped sentence is read in full (#753 review). The status island
 * itself never changes size in any of them.
 * - `popover`: the sentence is a button; it opens an island above the status.
 * - `tooltip`: hovering or focusing the sentence shows it whole.
 * - `none`: no disclosure, today's prototype, as the baseline.
 */
type Disclosure = "popover" | "tooltip" | "none";
const DISCLOSURES: readonly Disclosure[] = ["popover", "tooltip", "none"];
interface Options {
  readonly disclosure: Disclosure;
  readonly long: boolean;
  /** A demo Flow whose variation needs a password (#775). */
  readonly demo: boolean;
  /** Whether a control change fails, to show its error (#777). */
  readonly controlFails: boolean;
  /** Forces the Takeover Variable into one state (#777). */
  readonly takeover: TakeoverState;
}
const OptionsContext = createContext<Options>({
  controlFails: false,
  demo: false,
  takeover: "live",
  disclosure: "popover",
  long: true,
});

type Patch = (s: Session) => Session;

interface Notice {
  readonly id: number;
  readonly text: string;
  readonly tone: "info" | "ok" | "error";
}
type NotifyFn = (text: string, tone?: Notice["tone"]) => void;

const primaryAction = (
  s: Session
): { readonly label: string; readonly tone: string; readonly patch: Patch } =>
  s.activity === "Teaching"
    ? s.status === "recording"
      ? { label: "Stop", patch: (x) => ({ ...x, status: "ready" }), tone: "" }
      : {
          label: "Start recording",
          patch: (x) => ({ ...x, since: Date.now(), status: "recording" }),
          tone: "rec",
        }
    : s.control === "user"
      ? {
          label: "Return control",
          patch: (x) => ({ ...x, control: "agent" }),
          tone: "",
        }
      : {
          label: "Take control",
          patch: (x) => ({ ...x, control: "user" }),
          tone: "ghosty",
        };

const DETAILS: Record<
  Exclude<Session["activity"], "Teaching">,
  {
    readonly title: string;
    readonly body: (s: Session) => string;
    readonly listTitle: string;
    readonly list: readonly string[];
    readonly foot: string;
  }
> = {
  "Dry Run": {
    body: (s) =>
      `Repeat the ${s.flow} Flow in a fresh app state, with fresh inputs, to show it still reaches its outcome.`,
    foot: "Taught 25 minutes ago on Pixel_9 · Android 16",
    list: [
      "Open the Profile tab.",
      "Tap Edit, enter display_name, then tap Save.",
      "Done when the profile shows display_name after a restart.",
    ],
    listTitle: "Flow steps",
    title: "Dry Run",
  },
  "Guided Run": {
    body: (s) =>
      `Learn the ${s.flow} Flow by following docs/onboarding.md in the app.`,
    foot: "Source Document · docs/onboarding.md",
    list: [
      "Create an account with a new email.",
      "Choose the Free plan.",
      "Turn on notifications.",
    ],
    listTitle: "What the document says",
    title: "Guided Run",
  },
  Run: {
    body: (s) => s.task ?? s.flow,
    foot: "Demo store",
    list: [
      "Search the catalogue for “red jacket”.",
      "Filter to size M and under $80.",
      "Open the first result and add it to the cart.",
    ],
    listTitle: "Instructions",
    title: "Task",
  },
};

/**
 * A live Web task Run's details (#778): the sections its Run Summary keeps,
 * with the result last because nothing is concluded yet.
 */
const LiveDetails = ({ run }: { readonly run: Run }) => {
  const filled = useFilledRun(run);
  return (
    <LiveTaskDetails
      run={{ ...filled, findings: filled.findings.slice(0, 1) }}
    />
  );
};

const TaskDetails = ({ session }: { readonly session: Session }) => {
  if (session.activity === "Teaching") return null;
  const d = DETAILS[session.activity];
  const run = ENDS_WITH[session.id]
    ? runById(ENDS_WITH[session.id] ?? "")
    : undefined;
  if (
    run &&
    session.platform === "web" &&
    (session.activity === "Run" || session.activity === "Dry Run")
  ) {
    return (
      <Popover>
        <PopoverTrigger aria-label="Task details" className="pill-btn">
          <TaskIcon />
          <span className="tool-label">Task details</span>
        </PopoverTrigger>
        <PopoverContent
          aria-label="Task details"
          align="end"
          className="popover island details run-details"
          side="top"
          sideOffset={14}
        >
          <PopoverTitle className="popover-title">
            {session.activity === "Run" ? "Interactive Run" : "Dry Run"}
          </PopoverTitle>
          <LiveDetails run={run} />
        </PopoverContent>
      </Popover>
    );
  }
  return (
    <Popover>
      <PopoverTrigger aria-label="Task details" className="pill-btn">
        <TaskIcon />
        <span className="tool-label">Task details</span>
      </PopoverTrigger>
      <PopoverContent
        aria-label="Task details"
        align="end"
        className="popover island details"
        side="top"
        sideOffset={14}
      >
        <PopoverTitle className="popover-title">{d.title}</PopoverTitle>
        <p className="details-task">{d.body(session)}</p>
        <p className="popover-title">{d.listTitle}</p>
        <ol className="details-list">
          {d.list.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ol>
        <p className="hint">
          Started {clock(session.since)} ago · {d.foot}
        </p>
      </PopoverContent>
    </Popover>
  );
};

/** Comment opens the comment card above the status island. */
const CommentButton = ({
  session,
  open,
  onToggle,
}: {
  readonly session: Session;
  readonly open: boolean;
  readonly onToggle: () => void;
}) => {
  const count = useCommentCount(session.id);
  return (
    <Button
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-label={
        count === 0
          ? "Comment"
          : `Comment, ${count} ${count === 1 ? "comment" : "comments"} so far`
      }
      className="pill-btn"
      data-open={open || undefined}
      onClick={onToggle}
    >
      <CommentIcon />
      <span className="tool-label">Comment</span>
      {count > 0 ? <span className="count">{count}</span> : null}
    </Button>
  );
};

// The requests island stays centred and narrows to clear the status island,
// so it reads the status island's width.
const useStatusWidth = () => {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!el) return;
    const root = document.documentElement;
    const ro = new ResizeObserver(([entry]) => {
      if (entry)
        root.style.setProperty(
          "--status-w",
          `${Math.ceil(entry.borderBoxSize[0]?.inlineSize ?? 0)}px`
        );
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return setEl;
};

const Sentence = ({
  disclosure,
  line,
  session,
}: {
  readonly disclosure: Disclosure;
  readonly line: string;
  readonly session: Session;
}) => {
  if (disclosure === "popover") {
    return (
      <Popover>
        <PopoverTrigger
          aria-label={`Status: ${line}`}
          className="sentence sentence-btn"
        >
          {line}
        </PopoverTrigger>
        <PopoverContent
          aria-label="Status"
          align="end"
          className="popover island narrow sentence-pop"
          side="top"
          sideOffset={14}
        >
          <div className="sentence-pop-head">
            <StatusChip session={session} />
          </div>
          <p>{line}</p>
        </PopoverContent>
      </Popover>
    );
  }
  if (disclosure === "tooltip") {
    return (
      <Tooltip>
        <TooltipTrigger
          render={<span className="sentence sentence-tip" tabIndex={0} />}
        >
          {line}
        </TooltipTrigger>
        <TooltipContent className="tooltip sentence-tooltip" side="top">
          {line}
        </TooltipContent>
      </Tooltip>
    );
  }
  return <span className="sentence">{line}</span>;
};

const StatusIsland = ({
  session,
  onPatch,
  onNotice,
}: {
  readonly session: Session;
  readonly onPatch: (patch: Patch) => void;
  readonly onNotice: NotifyFn;
}) => {
  const { controlFails, disclosure, long } = useContext(OptionsContext);
  // A Guided recording keeps Stop as its primary action; control is the one
  // button beside it (#777).
  const guided = session.guided !== undefined && session.status === "recording";
  const control = guidedControl(session);
  const action = guided
    ? {
        label: "Stop recording",
        patch: ((x) => ({ ...x, status: "ready" })) satisfies Patch,
        tone: "",
      }
    : primaryAction(session);
  const line =
    guided && session.requests.length === 0
      ? controlSentence(control, session.guided?.requested ?? "")
      : (long ? LONG_LINE : LINE)[statusOf(session)];
  const ref = useStatusWidth();
  const [commenting, setCommenting] = useState(false);
  const [controlPending, setControlPending] = useState(false);
  const bridge = useContext(InspectContext);
  const teaching =
    (session.activity === "Teaching" || session.guided !== undefined) &&
    session.status === "recording";
  const changeControl = () => {
    setControlPending(true);
    setTimeout(() => {
      setControlPending(false);
      if (controlFails) {
        onNotice(
          `${CONTROL_LABEL[control]} did not go through. ${control === "user" ? "You still have control." : "The agent still has control."}`,
          "error"
        );
        return;
      }
      onPatch((x) => ({
        ...x,
        control: control === "user" ? "agent" : "user",
        guided: {},
      }));
    }, 700);
  };
  useEffect(() => {
    if (!teaching) setCommenting(false);
  }, [teaching]);
  // ⌘⇧K (Ctrl+Shift+K) opens the card while recording, as in the product.
  useEffect(() => {
    if (!teaching) return;
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "k"
      ) {
        e.preventDefault();
        setCommenting(true);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [teaching]);
  return (
    <>
      {commenting ? (
        <CommentCard
          onClose={() => setCommenting(false)}
          onPick={(done) => bridge.current?.(done)}
          onSent={(text) => onNotice(text, "ok")}
          session={{
            id: session.id,
            platform: session.platform,
            since: session.since,
          }}
        />
      ) : null}
      <section
        aria-label="Session status"
        className="status-island island"
        ref={ref}
      >
        <StatusChip session={session} />
        <Sentence disclosure={disclosure} line={line} session={session} />
        <div className="tools">
          <TaskDetails session={session} />
          {teaching ? (
            <CommentButton
              onToggle={() => setCommenting((o) => !o)}
              open={commenting}
              session={session}
            />
          ) : null}
        </div>
        {guided ? (
          <ControlButton
            control={control}
            onClick={changeControl}
            pending={controlPending}
          />
        ) : null}
        <Button
          className={`btn ${action.tone}`}
          onClick={() => {
            onPatch(action.patch);
            if (teaching)
              onNotice(`Saved ${session.flow}. Dry Run it from Flows.`, "ok");
          }}
        >
          {action.label}
        </Button>
      </section>
    </>
  );
};

/** The Takeover Variable, in its own card in the Requests island (#777). */
const TakeoverIsland = () => {
  const { takeover } = useContext(OptionsContext);
  const [collapsed, setCollapsed] = useState(false);
  if (collapsed) {
    return (
      <Button
        aria-label="Show request: Takeover Variable"
        className="request-pill island"
        onClick={() => transition(() => setCollapsed(false))}
      >
        <span className="request-icon small">
          <KeyIcon />
        </span>
        <span className="request-pill-text">Takeover Variable</span>
      </Button>
    );
  }
  return (
    <section aria-label="Requests" className="request island">
      <TakeoverVariableCard
        collapse={
          <IconButton
            className="icon-btn small"
            label="Collapse requests"
            onClick={() => transition(() => setCollapsed(true))}
          >
            <MinimizeIcon />
          </IconButton>
        }
        forced={takeover}
      />
    </section>
  );
};

const REQUEST_ICON = {
  boundary: ShieldIcon,
  question: QuestionIcon,
  variables: KeyIcon,
} as const;

const RequestTier = ({
  session,
  collapsed,
  onCollapse,
  onResolve,
  onUpdate,
}: {
  readonly session: Session;
  readonly collapsed: boolean;
  readonly onCollapse: (collapsed: boolean) => void;
  readonly onResolve: (request: Request, refused: boolean) => void;
  readonly onUpdate: (request: Request) => void;
}) => {
  const first = session.requests[0];
  if (!first) return null;
  const count = session.requests.length;
  const Icon = REQUEST_ICON[first.kind];
  if (collapsed) {
    return (
      <Button
        aria-label={`Show request: ${first.title}`}
        className="request-pill island"
        onClick={() => onCollapse(false)}
      >
        <span className="request-icon small">
          <Icon />
        </span>
        <span className="request-pill-text">{first.title}</span>
        {count > 1 ? <span className="count">{count}</span> : null}
      </Button>
    );
  }
  const collapse = (
    <IconButton
      className="icon-btn small"
      label="Collapse requests"
      onClick={() => onCollapse(true)}
    >
      <MinimizeIcon />
    </IconButton>
  );
  const more =
    count > 1 ? (
      <p className="request-more mono">+{count - 1} more after this</p>
    ) : null;
  if (first.kind === "variables") {
    return (
      <section
        aria-label="Requests"
        className="request island"
        data-kind="variables"
      >
        <VariableCard
          collapse={collapse}
          group={first.group}
          items={first.items}
          onAnswer={(name, answer) => {
            const items = first.items.map((item) =>
              item.name === name ? { ...item, answer } : item
            );
            if (items.every((item) => item.answer !== undefined)) {
              onResolve(first, false);
            } else {
              onUpdate({ ...first, items });
            }
          }}
        />
        {more}
      </section>
    );
  }
  if (first.kind === "question") {
    return (
      <section
        aria-label="Requests"
        className="request island"
        data-kind="question"
      >
        <QuestionCard
          closed={false}
          collapse={collapse}
          onAnswer={(id, answer) => {
            const questions = first.questions.map((q) =>
              q.id === id ? { ...q, answer } : q
            );
            // Every question answered: the agent has what it asked for.
            if (questions.every((q) => q.answer !== undefined)) {
              onResolve(first, false);
            } else {
              onUpdate({ ...first, questions });
            }
          }}
          questions={first.questions}
        />
        {more}
      </section>
    );
  }
  const takeover = session.control === "user";
  return (
    <section
      aria-label="Requests"
      className="request island"
      data-kind={first.kind}
    >
      <header>
        <span className="request-icon">
          <Icon />
        </span>
        <div className="request-head">
          <span className="eyebrow">
            Execution Boundary
            {count > 1 ? <span className="mono"> · 1 of {count}</span> : null}
          </span>
          <h2>{first.title}</h2>
        </div>
        {collapse}
      </header>
      <p className="request-detail">{first.detail}</p>
      <div className="request-target mono">{first.target}</div>
      <div className="request-actions">
        {takeover ? (
          <span className="hint grow">
            Return control to allow. You can still refuse.
          </span>
        ) : null}
        <Button className="btn ghosty" onClick={() => onResolve(first, true)}>
          Refuse
        </Button>
        <Button
          className="btn"
          disabled={takeover}
          onClick={() => onResolve(first, false)}
        >
          Allow
        </Button>
      </div>
    </section>
  );
};

/** Marks the page while a summary is docked, so the stage and the bottom
 * islands give up its width. */
const useDock = (state: "open" | "collapsed" | null) => {
  // Layout effect: a view transition snapshots the next view before passive
  // effects run, and the stage must already have its width back by then.
  useLayoutEffect(() => {
    if (state === null) return;
    document.body.dataset.dock = state;
    return () => {
      delete document.body.dataset.dock;
    };
  }, [state]);
};

/**
 * Collapse and expand are the only moves that morph the dock, into the status
 * island's Summary pill and back. The name is set just for that transition, so
 * leaving the view never flies the dock anywhere.
 */
const morphDock = (update: () => void) => {
  const root = document.documentElement;
  if (!document.startViewTransition || reducedMotion()) {
    update();
    return;
  }
  root.dataset.dockMorph = "";
  const vt = document.startViewTransition(() => flushSync(update));
  void vt.finished.finally(() => {
    delete root.dataset.dockMorph;
  });
};

/** The status island's Summary tool while the dock is collapsed. */
const CollapsedSummary = ({
  run,
  dock,
}: {
  readonly run: Run | undefined;
  readonly dock: DockProps;
}) =>
  dock.collapsed ? (
    <SummaryPill
      label="Run Summary"
      onExpand={() => morphDock(() => dock.onCollapse(false))}
      verdict={run ? <VerdictChip run={run} /> : null}
    />
  ) : null;

interface DockProps {
  readonly decisions: Readonly<Record<string, Decision>>;
  readonly onDecide: (
    recording: string,
    d: "verify" | "reject" | "retry"
  ) => void;
  readonly collapsed: boolean;
  readonly onCollapse: (collapsed: boolean) => void;
  readonly onFlow: (name: string) => void;
}

/**
 * The Run Summary docked on the right, for an ended session, a Dry Run review
 * or an ended device session. A Dry Run with a Teaching Recording carries the
 * Verify / Reject bar underneath.
 */
const DockedSummary = ({
  run,
  summary,
  recording,
  onRetry,
  decisions,
  onDecide,
  collapsed,
  onCollapse,
  onFlow,
}: DockProps & {
  readonly run: Run | undefined;
  readonly summary: SummaryState;
  readonly recording: string | undefined;
  readonly onRetry: () => void;
}) => {
  useDock(collapsed ? "collapsed" : "open");
  const review = recording ? REVIEWS[recording] : undefined;
  const decision = recording ? decisions[recording] : undefined;
  // Verifying runs Cleanup, which takes the Dry Run's video with it.
  const shown =
    run && (decision === "verified" || decision === "cleanup-failed")
      ? { ...run, purged: true }
      : run;
  const ready = summary === "ready" && shown !== undefined;
  return (
    <SummaryDock
      collapsed={collapsed}
      footer={
        ready && review && decision ? (
          <DecisionBar
            decision={decision}
            flow={review.flow}
            onDecide={(d) => {
              if (recording) onDecide(recording, d);
            }}
            passed={verdictOf(shown).tone === "passed"}
          />
        ) : null
      }
      label="Run Summary"
      onCollapse={(c) => morphDock(() => onCollapse(c))}
    >
      {summary === "writing" ? (
        <SummaryWriting />
      ) : summary === "missing" ? (
        <SummaryMissing onRetry={onRetry} />
      ) : shown ? (
        <RunSummary key={shown.id} onFlow={onFlow} run={shown} variant="dock" />
      ) : (
        <div className="pane-empty">
          <p>
            No Dry Run yet. Ask your agent to Dry Run{" "}
            <span className="mono">{review?.flow}</span>; its summary shows
            here.
          </p>
        </div>
      )}
    </SummaryDock>
  );
};

/** The status island once there is nothing left to drive. */
const EndedStatus = ({
  chip,
  line,
  children,
}: {
  readonly chip: ReactNode;
  readonly line: string;
  readonly children: ReactNode;
}) => {
  const ref = useStatusWidth();
  return (
    <section
      aria-label="Session status"
      className="status-island island"
      ref={ref}
    >
      {chip}
      <span className="sentence">{line}</span>
      <div className="tools">{children}</div>
    </section>
  );
};

const TopNav = ({
  sessions,
  current,
  onHome,
  onOpen,
}: {
  readonly sessions: readonly Session[];
  readonly current: Session | undefined;
  readonly onHome: () => void;
  readonly onOpen: (id: string) => void;
}) => (
  <nav aria-label="Workspace" className="chrome left island">
    <a
      aria-label="Contingency home"
      className="brand"
      href="/"
      onClick={(e) => {
        e.preventDefault();
        onHome();
      }}
    >
      <WatcherMark className="brand-mark" />
      <span className="brand-text">contingency</span>
    </a>
    {sessions.length > 0 ? (
      <>
        <span className="divider" />
        <div className="switcher-slot">
          <SessionSwitcher
            current={current}
            onNew={onHome}
            onOpen={onOpen}
            sessions={sessions}
            side="bottom"
          />
        </div>
      </>
    ) : null}
  </nav>
);

/**
 * A finished Run with no live session behind it: a Dry Run review at
 * `?recording=` (ADR 0073), or a native Run's ended device session opened from
 * the Flows page (ADR 0078). Both show the last frame and the docked summary.
 */
const EndedView = ({
  mode,
  platform,
  flow,
  run,
  recording,
  sessions,
  onHome,
  onOpen,
  onDone,
  dock,
  device,
}: {
  readonly device: DeviceCanvas;
  readonly mode: "review" | "device";
  readonly platform: Platform;
  readonly flow: string;
  readonly run: Run | undefined;
  readonly recording: string | undefined;
  readonly sessions: readonly Session[];
  readonly onHome: () => void;
  readonly onOpen: (id: string) => void;
  readonly onDone: () => void;
  readonly dock: DockProps;
}) => {
  const teaching = recording ? REVIEWS[recording]?.session : undefined;
  const back = sessions.find((s) => s.id === teaching);
  return (
    <>
      <TopNav
        current={undefined}
        onHome={onHome}
        onOpen={onOpen}
        sessions={sessions}
      />
      <Actions />
      {platform === "web" ? (
        <WebCanvas
          ended
          key={`ended-${flow}`}
          onNotice={() => {}}
          onReconnect={() => {}}
          session={{
            activity: "Dry Run",
            flow,
            id: `ended-${flow}`,
            waiting: false,
          }}
          stage="live"
        />
      ) : (
        <NativeCanvas
          device={device}
          ended
          key={`ended-${flow}`}
          onNotice={() => {}}
          session={{
            activity: "Dry Run",
            flow,
            id: `ended-${flow}`,
            platform,
            waiting: false,
          }}
        />
      )}
      <DockedSummary
        {...dock}
        onRetry={() => {}}
        recording={recording}
        run={run}
        summary="ready"
      />
      <div className="bottom-row">
        <EndedStatus
          chip={
            mode === "review" ? (
              <span className="chip" data-status="review">
                <CheckIcon />
                Dry Run review
              </span>
            ) : (
              <span className="chip" data-status="ended">
                <StopIcon />
                Ended
              </span>
            )
          }
          line={
            mode === "review"
              ? `${flow} · read-only. Nothing here restarts the Dry Run.`
              : "This device session ended. Its Run is read-only."
          }
        >
          <CollapsedSummary dock={dock} run={run} />
          {back ? (
            <Button className="btn ghosty" onClick={() => onOpen(back.id)}>
              <ArrowLeftIcon />
              Back to Teaching
            </Button>
          ) : null}
          <Button className="btn" onClick={onDone}>
            Done
          </Button>
        </EndedStatus>
      </div>
    </>
  );
};

const SessionView = ({
  session,
  sessions,
  notice,
  onHome,
  onOpen,
  onPatch,
  onNotice,
  onDone,
  dock,
  stage,
  onReconnect,
  device,
}: {
  readonly device: DeviceCanvas;
  readonly session: Session;
  readonly sessions: readonly Session[];
  readonly notice: Notice | null;
  readonly onHome: () => void;
  readonly onOpen: (id: string) => void;
  readonly onPatch: (patch: Patch) => void;
  readonly onNotice: NotifyFn;
  /** Closes an ended session. */
  readonly onDone: () => void;
  readonly dock: DockProps;
  readonly stage: StageState;
  readonly onReconnect: () => void;
}) => {
  const [collapsed, setCollapsed] = useState(false);
  const bridge = useRef<InspectBridge>({ current: null }).current;
  const options = useContext(OptionsContext);
  const [demoDone, setDemoDone] = useState(false);
  const demo = options.demo && !demoDone;
  const ended = session.ended;
  const teaching =
    ended && session.recording
      ? sessions.find(
          (s) =>
            s.id === REVIEWS[session.recording ?? ""]?.session ||
            (s.activity === "Teaching" && s.flow === session.flow)
        )
      : undefined;
  return (
    <InspectContext.Provider value={bridge}>
      <nav aria-label="Workspace" className="chrome left island">
        <a
          aria-label="Contingency home"
          className="brand"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            onHome();
          }}
        >
          <WatcherMark className="brand-mark" />
          <span className="brand-text">contingency</span>
        </a>
        <span className="divider" />
        <div className="switcher-slot">
          <SessionSwitcher
            current={session}
            onNew={onHome}
            onOpen={onOpen}
            sessions={sessions}
            side="bottom"
          />
        </div>
      </nav>
      <Actions />
      {session.platform === "web" ? (
        <WebCanvas
          ended={ended !== undefined}
          key={session.id}
          onNotice={onNotice}
          onReconnect={onReconnect}
          session={{
            activity: session.activity,
            control: session.control,
            flow: session.flow,
            id: session.id,
            waiting: session.requests.length > 0,
          }}
          stage={stage}
        />
      ) : (
        <NativeCanvas
          device={device}
          ended={ended !== undefined}
          key={session.id}
          onNotice={onNotice}
          session={{
            activity: session.activity,
            control: session.control,
            flow: session.flow,
            id: session.id,
            platform: session.platform,
            waiting: session.requests.length > 0,
          }}
        />
      )}
      {ended ? (
        <DockedSummary
          {...dock}
          onRetry={() =>
            onPatch((s) => ({
              ...s,
              ended: s.ended && { ...s.ended, summary: "ready" },
            }))
          }
          recording={session.recording}
          run={runById(ended.run)}
          summary={ended.summary}
        />
      ) : null}
      <div aria-live="polite" className="notices">
        {session.bot !== undefined && session.platform === "web" && !ended ? (
          <BotProtectionNotice
            host={session.bot}
            onDismiss={() => onPatch((s) => ({ ...s, bot: undefined }))}
          />
        ) : null}
        {notice ? (
          <div
            className="notice island"
            data-tone={notice.tone}
            key={notice.id}
            role="status"
          >
            <span aria-hidden="true" className="notice-mark">
              {notice.tone === "ok" ? (
                <CheckIcon />
              ) : notice.tone === "error" ? (
                <CloseIcon />
              ) : (
                <InfoIcon />
              )}
            </span>
            {notice.text}
          </div>
        ) : null}
      </div>
      <div className="bottom-row">
        {ended ? (
          <EndedStatus
            chip={<StatusChip session={session} />}
            line={
              ended.summary === "writing"
                ? "The Run ended. Writing its summary…"
                : LINE.ended
            }
          >
            <CollapsedSummary
              dock={dock}
              run={ended.summary === "ready" ? runById(ended.run) : undefined}
            />
            <TaskDetails session={session} />
            {teaching ? (
              <Button
                className="btn ghosty"
                onClick={() => onOpen(teaching.id)}
              >
                <ArrowLeftIcon />
                Back to Teaching
              </Button>
            ) : null}
            <Button className="btn" onClick={onDone}>
              Done
            </Button>
          </EndedStatus>
        ) : null}
        <div className="bottom-center" hidden={ended !== undefined}>
          {demo &&
          session.activity === "Teaching" &&
          session.platform === "web" &&
          session.status === "recording" ? (
            <DemoPassword
              onEntered={() => {
                setDemoDone(true);
                onNotice(
                  "Entered DEMO_PASSWORD into the Password field.",
                  "ok"
                );
              }}
            />
          ) : null}
          {session.guided !== undefined &&
          session.status === "recording" &&
          session.control === "user" ? (
            <TakeoverIsland />
          ) : null}
          <RequestTier
            collapsed={collapsed}
            key={session.requests[0]?.id}
            onCollapse={(c) => transition(() => setCollapsed(c))}
            onUpdate={(request) =>
              onPatch((s) => ({
                ...s,
                requests: s.requests.map((r) =>
                  r.id === request.id ? request : r
                ),
              }))
            }
            onResolve={(request, refused) => {
              onPatch((s) => ({
                ...s,
                requests: s.requests.filter((r) => r.id !== request.id),
              }));
              if (refused)
                onNotice("Refused. The agent will look for another way.");
            }}
            session={session}
          />
        </div>
        {ended ? null : (
          <StatusIsland
            onNotice={onNotice}
            onPatch={onPatch}
            session={session}
          />
        )}
      </div>
    </InspectContext.Provider>
  );
};

/* ---------------------------------------------------------------------- app */

const App = () => {
  useNow();
  const [requestState, setRequestState] = useState<RequestState>("live");
  const [sessions, setSessions] = useState<Session[]>(() =>
    SEED.map((s) => ({ ...s }))
  );
  const [view, setView] = useState<View>(() => fromUrl());
  const legacyUrl = useRef(true);
  const [fromSession, setFromSession] = useState<string | undefined>();
  const [catalogEmpty, setCatalogEmpty] = useState(false);
  const [expanded, setExpanded] = useState<Platform | null>(null);
  const [returning, setReturning] = useState<Platform | null>(null);
  const [returnTo, setReturnTo] = useState<string | null>(null);
  const [flow, setFlow] = useState("checkout");
  const [notice, setNoticeState] = useState<Notice | null>(null);
  const setNotice: NotifyFn = (text, tone = "info") =>
    setNoticeState({ id: Date.now(), text, tone });
  const [side, setSide] = useState<"left" | "right">("right");
  const [options, setOptions] = useState<Options>({
    controlFails: false,
    demo: false,
    takeover: "live",
    disclosure: "popover",
    long: true,
  });
  const [sample, setSample] = useState(0);
  const [fill, setFill] = useState<Fill>("seeded");
  const [decisions, setDecisions] = useState<Record<string, Decision>>(() =>
    Object.fromEntries(
      Object.entries(REVIEWS).map(([id, r]) => [id, r.decision])
    )
  );
  const [cleanupFails, setCleanupFails] = useState(false);
  const [dockCollapsed, setDockCollapsed] = useState(false);
  // The Web stage's stream: a new session connects first, and the scaffold
  // can pause it.
  const [stage, setStage] = useState<StageState>("live");
  // A device session's stream, and where its rail sits.
  const [deviceStage, setDeviceStage] = useState<DeviceStage>("live");
  const [rail, setRail] = useState<RailPlace>("beside");
  const connect = () => {
    setStage("connecting");
    setDeviceStage("connecting");
    setTimeout(() => {
      setStage((s) => (s === "connecting" ? "live" : s));
      setDeviceStage((s) => (s === "connecting" ? "live" : s));
    }, 1400);
  };
  const device = useMemo<DeviceCanvas>(
    () => ({
      onReconnect: () => {
        setDeviceStage("reconnecting");
        setTimeout(
          () => setDeviceStage((s) => (s === "reconnecting" ? "live" : s)),
          1200
        );
      },
      rail,
      stage: deviceStage,
    }),
    [deviceStage, rail]
  );

  useEffect(() => {
    document.body.dataset.view = view.name;
  }, [view.name]);
  // The view lives in the URL, so `/flow` opens the Flows page directly and
  // Back returns to where you were.
  useEffect(() => {
    const url = toUrl(view);
    // `/?session=<id>` (every MCP `viewUrl` already handed out) and unknown
    // ids settle on their canonical URL without a history entry.
    const replace = legacyUrl.current;
    legacyUrl.current = false;
    if (url === location.pathname + location.search) return;
    if (replace) history.replaceState(null, "", url);
    else history.pushState(null, "", url);
  }, [view]);
  useEffect(() => {
    const onPop = () => transition(() => setView(fromUrl()));
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  useEffect(() => {
    document.body.dataset.statusSide = side;
  }, [side]);
  useEffect(() => {
    if (notice === null) return;
    const id = setTimeout(() => setNoticeState(null), 3600);
    return () => clearTimeout(id);
  }, [notice]);

  const patch = (id: string, fn: (s: Session) => Session) =>
    transition(() =>
      setSessions((all) => all.map((s) => (s.id === id ? fn(s) : s)))
    );

  const expand = (p: Platform, from?: Element | null) =>
    transition(
      () => {
        setExpanded(p);
        setReturning(null);
      },
      from ? { element: from, name: "start-card" } : undefined
    );

  const collapse = () =>
    transition(() => {
      setReturning(expanded);
      setExpanded(null);
    });

  const open = (id: string, from?: Element | null) =>
    transition(
      () => {
        setView({ id, name: "session" });
        setReturnTo(id);
        setExpanded(null);
        setStage("live");
        setDeviceStage("live");
      },
      from ? { element: from, name: "stage" } : undefined
    );

  const home = () =>
    transition(() => {
      setView({ name: "home" });
      setReturning(null);
    });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, [role=listbox], [role=dialog]"))
        return;
      if (e.key === "Escape" && expanded) collapse();
      if (
        view.name === "home" &&
        !expanded &&
        ["1", "2", "3"].includes(e.key)
      ) {
        e.preventDefault();
        const p = ORDER[Number(e.key) - 1];
        if (p)
          expand(
            p,
            document.querySelectorAll(".tile")[Number(e.key) - 1] ?? null
          );
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });

  const current =
    view.name === "session"
      ? sessions.find((s) => s.id === view.id)
      : undefined;
  useEffect(() => {
    if (view.name === "session" && !current) {
      legacyUrl.current = true;
      setView({ name: "home" });
    }
  }, [view, current]);

  const decide = (recording: string, d: "verify" | "reject" | "retry") => {
    const flowName = REVIEWS[recording]?.flow ?? "the Flow";
    const next: Decision =
      d === "reject"
        ? "rejected"
        : d === "verify" && cleanupFails
          ? "cleanup-failed"
          : "verified";
    transition(() => setDecisions((all) => ({ ...all, [recording]: next })));
    setNotice(
      next === "rejected"
        ? `Rejected ${flowName}. The agent can fix it and Dry Run again.`
        : next === "cleanup-failed"
          ? `Verified ${flowName}, but Cleanup couldn't finish.`
          : `Verified ${flowName}. Its Teaching evidence is gone.`,
      next === "cleanup-failed" ? "error" : "ok"
    );
  };
  const dock = {
    collapsed: dockCollapsed,
    decisions,
    onCollapse: setDockCollapsed,
    onDecide: decide,
    onFlow: (name: string) =>
      transition(() => setView({ flow: `local:${name}`, name: "flows" })),
  };
  const endRun = (id: string) => {
    const run = ENDS_WITH[id];
    if (!run) return;
    patch(id, (s) => ({
      ...s,
      control: "agent",
      ended: { run, summary: "writing" },
      requests: [],
    }));
    setTimeout(
      () =>
        patch(id, (s) =>
          s.ended?.summary === "writing"
            ? { ...s, ended: { ...s.ended, summary: "ready" } }
            : s
        ),
      1800
    );
  };
  const closeSession = (id: string) =>
    transition(() => {
      setSessions((all) => all.filter((s) => s.id !== id));
      setView({ name: "home" });
    });

  // The Flows button grows into the catalog sidebar, and the sidebar shrinks
  // back into the button on the way out. The ref still holds the previous
  // view while the transition renders the next one.
  const openFlows = (from: Element) =>
    transition(
      () => {
        setFromSession(current?.flow);
        setView({ name: "flows" });
        setExpanded(null);
      },
      { element: from, name: "flows-sidebar" }
    );
  const lastView = useRef(view.name);
  useEffect(() => {
    lastView.current = view.name;
  });
  const morphBack = lastView.current === "flows" && view.name !== "flows";

  return (
    <OptionsContext.Provider value={options}>
      <DetailsFillContext.Provider value={fill}>
        <RequestStateContext.Provider value={requestState}>
          <TeachingProvider>
            <FlowsNav.Provider
              value={{
                here: view.name === "flows",
                morphBack,
                open: openFlows,
              }}
            >
              <div className="desktop-gate" role="alert">
                <div className="island gate-card">
                  <WatcherMark className="brand-mark big" />
                  <h1>Open Contingency on a desktop</h1>
                  <p>
                    The Workspace drives browsers, emulators and simulators side
                    by side. It needs a screen at least 1024 pixels wide.
                  </p>
                </div>
              </div>
              <div className="app">
                {view.name === "flows" ? (
                  <FlowsPage
                    actions={<Actions />}
                    empty={catalogEmpty}
                    nav={
                      <TopNav
                        current={undefined}
                        onHome={home}
                        onOpen={(id) => open(id)}
                        sessions={sessions}
                      />
                    }
                    onEnded={(run) =>
                      transition(() => setView({ name: "ended", run }))
                    }
                    onReview={(recording) =>
                      transition(() => setView({ name: "review", recording }))
                    }
                    onRun={(run) =>
                      setView({ flow: view.flow, name: "flows", run })
                    }
                    onSelect={(flow) => setView({ flow, name: "flows" })}
                    run={view.run}
                    selected={view.flow}
                    sessionFlow={fromSession}
                  />
                ) : view.name === "review" ? (
                  <EndedView
                    dock={dock}
                    device={device}
                    flow={REVIEWS[view.recording]?.flow ?? view.recording}
                    key={view.recording}
                    mode="review"
                    onDone={() =>
                      transition(() =>
                        setView({
                          flow: `local:${REVIEWS[view.recording]?.flow ?? ""}`,
                          name: "flows",
                        })
                      )
                    }
                    onHome={home}
                    onOpen={(id) => open(id)}
                    platform={REVIEWS[view.recording]?.platform ?? "web"}
                    recording={view.recording}
                    run={runById(REVIEWS[view.recording]?.run ?? "")}
                    sessions={sessions}
                  />
                ) : view.name === "ended" ? (
                  <EndedView
                    dock={dock}
                    device={device}
                    flow={runById(view.run)?.flows[0] ?? view.run}
                    key={view.run}
                    mode="device"
                    onDone={() =>
                      transition(() =>
                        setView({
                          flow: flowOfRun(view.run),
                          name: "flows",
                          run: view.run,
                        })
                      )
                    }
                    onHome={home}
                    onOpen={(id) => open(id)}
                    platform={runById(view.run)?.platform ?? "android"}
                    recording={undefined}
                    run={runById(view.run)}
                    sessions={sessions}
                  />
                ) : current ? (
                  <SessionView
                    dock={dock}
                    device={device}
                    onDone={() => closeSession(current.id)}
                    onReconnect={connect}
                    stage={stage}
                    notice={notice}
                    onNotice={setNotice}
                    onPatch={(fn) => patch(current.id, fn)}
                    onHome={home}
                    onOpen={(id) => open(id)}
                    session={current}
                    sessions={sessions}
                  />
                ) : (
                  <Home
                    expanded={expanded}
                    flow={flow}
                    setFlow={setFlow}
                    onCollapse={collapse}
                    onExpand={expand}
                    onOpen={open}
                    onStart={(platform, flow, form) => {
                      const id = `n${Date.now()}`;
                      transition(
                        () => {
                          setSessions((all) => [
                            {
                              activity: "Teaching",
                              flow,
                              id,
                              platform,
                              requests: [],
                              since: Date.now(),
                              status: "ready",
                            },
                            ...all,
                          ]);
                          setView({ id, name: "session" });
                          setReturnTo(id);
                          setExpanded(null);
                        },
                        { element: form, name: "stage" }
                      );
                      connect();
                    }}
                    returnTo={returnTo}
                    returning={returning}
                    sessions={sessions}
                  />
                )}
                {view.name === "review" || view.name === "ended" ? (
                  <div aria-live="polite" className="notices">
                    {notice ? (
                      <div
                        className="notice island"
                        data-tone={notice.tone}
                        key={notice.id}
                        role="status"
                      >
                        <span aria-hidden="true" className="notice-mark">
                          {notice.tone === "ok" ? <CheckIcon /> : <CloseIcon />}
                        </span>
                        {notice.text}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <Scaffold
                  canEnd={
                    current !== undefined &&
                    !current.ended &&
                    ENDS_WITH[current.id] !== undefined
                  }
                  onEnd={() => {
                    if (current) endRun(current.id);
                  }}
                  fill={fill}
                  onFill={() =>
                    setFill(
                      FILLS[(FILLS.indexOf(fill) + 1) % FILLS.length] ??
                        "seeded"
                    )
                  }
                  summary={current?.ended?.summary}
                  onSummary={() => {
                    if (!current?.ended) return;
                    const order: SummaryState[] = [
                      "ready",
                      "writing",
                      "missing",
                    ];
                    const next =
                      order[(order.indexOf(current.ended.summary) + 1) % 3] ??
                      "ready";
                    patch(current.id, (s) => ({
                      ...s,
                      ended: s.ended && { ...s.ended, summary: next },
                    }));
                  }}
                  review={
                    view.name === "review"
                      ? decisions[view.recording]
                      : current?.ended && current.recording
                        ? decisions[current.recording]
                        : undefined
                  }
                  onReview={() => {
                    const rec =
                      view.name === "review"
                        ? view.recording
                        : current?.recording;
                    if (!rec) return;
                    const order: Decision[] = [
                      "pending",
                      "rejected",
                      "verified",
                      "cleanup-failed",
                    ];
                    transition(() =>
                      setDecisions((all) => ({
                        ...all,
                        [rec]:
                          order[
                            (order.indexOf(all[rec] ?? "pending") + 1) %
                              order.length
                          ] ?? "pending",
                      }))
                    );
                  }}
                  cleanupFails={cleanupFails}
                  onCleanup={() => setCleanupFails(!cleanupFails)}
                  onSessions={(on) => {
                    transition(() => {
                      setSessions(on ? SEED.map((s) => ({ ...s })) : []);
                      setView({ name: "home" });
                    });
                  }}
                  sessionsOn={sessions.length > 0}
                  inSession={current !== undefined}
                  inFlows={view.name === "flows"}
                  catalogEmpty={catalogEmpty}
                  onCatalog={() =>
                    transition(() => setCatalogEmpty(!catalogEmpty))
                  }
                  side={side}
                  onSide={() =>
                    transition(() =>
                      setSide(side === "right" ? "left" : "right")
                    )
                  }
                  requestState={requestState}
                  onRequestState={() =>
                    setRequestState(
                      REQUEST_STATES[
                        (REQUEST_STATES.indexOf(requestState) + 1) %
                          REQUEST_STATES.length
                      ] ?? "live"
                    )
                  }
                  onRequest={() => {
                    if (!current) return;
                    const next =
                      REQUEST_SAMPLES[sample % REQUEST_SAMPLES.length];
                    setSample(sample + 1);
                    if (next)
                      patch(current.id, (s) => ({
                        ...s,
                        requests: [
                          ...s.requests,
                          { ...next, id: `r${Date.now()}` } as Request,
                        ],
                      }));
                  }}
                  onNotice={() =>
                    setNotice("That gesture did not go through.", "error")
                  }
                  stage={
                    current && !current.ended
                      ? current.platform === "web"
                        ? stage
                        : deviceStage
                      : undefined
                  }
                  onStage={() =>
                    current?.platform === "web"
                      ? setStage((s) => STAGE_NEXT[s])
                      : setDeviceStage((s) => DEVICE_STAGE_NEXT[s])
                  }
                  rail={
                    current && !current.ended && current.platform !== "web"
                      ? rail
                      : undefined
                  }
                  onRail={() => setRail(rail === "beside" ? "edge" : "beside")}
                  onOptions={setOptions}
                  options={options}
                  guided={
                    current?.guided !== undefined &&
                    current.status === "recording" &&
                    !current.ended
                      ? guidedControl(current)
                      : undefined
                  }
                  onGuided={() => {
                    if (!current) return;
                    const next =
                      GUIDED_CONTROLS[
                        (GUIDED_CONTROLS.indexOf(guidedControl(current)) + 1) %
                          GUIDED_CONTROLS.length
                      ] ?? "agent";
                    patch(current.id, (s) => ({
                      ...s,
                      control: next === "user" ? "user" : "agent",
                      guided:
                        next === "requested"
                          ? {
                              requested:
                                "The sign-up form asks for a phone code.",
                            }
                          : {},
                    }));
                  }}
                  bot={
                    current?.platform === "web" && !current.ended
                      ? current.bot !== undefined
                      : undefined
                  }
                  onBot={() => {
                    if (!current) return;
                    patch(current.id, (s) => ({
                      ...s,
                      bot:
                        s.bot === undefined ? "auth.shop.example" : undefined,
                    }));
                  }}
                />
              </div>
            </FlowsNav.Provider>
          </TeachingProvider>
        </RequestStateContext.Provider>
      </DetailsFillContext.Provider>
    </OptionsContext.Provider>
  );
};

const STAGE_NEXT: Record<StageState, StageState> = {
  connecting: "paused",
  live: "connecting",
  paused: "live",
};

type View =
  | { readonly name: "home" }
  | { readonly name: "session"; readonly id: string }
  | { readonly name: "review"; readonly recording: string }
  | { readonly name: "ended"; readonly run: string }
  | {
      readonly name: "flows";
      readonly flow?: string;
      readonly run?: string;
    };

const toUrl = (view: View) => {
  // A running session lives at its own path, `/<session-id>`.
  if (view.name === "session") return `/${view.id}`;
  if (view.name === "review") return `/?recording=${view.recording}`;
  // A native Run's ended device session; the prototype keys it by Run.
  if (view.name === "ended") return `/ended:${view.run}`;
  if (view.name === "home") return "/";
  const params = new URLSearchParams();
  // Local Flows go by name alone; `global:<name>` names the user-global root.
  if (view.flow) params.set("flow", view.flow.replace(/^local:/, ""));
  if (view.run) params.set("run", view.run);
  const query = params.toString();
  return `/flow${query ? `?${query}` : ""}`;
};

const fromUrl = (): View => {
  const params = new URLSearchParams(location.search);
  const run = params.get("run") ?? undefined;
  if (location.pathname.replace(/\/$/, "") === "/flow") {
    const flow = params.get("flow");
    return {
      flow: flow ? (flow.includes(":") ? flow : `local:${flow}`) : undefined,
      name: "flows",
      run,
    };
  }
  const recording = params.get("recording");
  if (recording && REVIEWS[recording]) return { name: "review", recording };
  const endedRun = params.get("session")?.match(/^ended:(.+)$/)?.[1];
  if (endedRun && runById(endedRun)) return { name: "ended", run: endedRun };
  // The old Run Summary view, `/?run=<id>`, lands on that Run in its Flow, so
  // every MCP `viewUrl` already handed out keeps working.
  if (run) return { flow: flowOfRun(run), name: "flows", run };
  const path = decodeURIComponent(location.pathname.replace(/^\/|\/$/g, ""));
  const ended = path.match(/^ended:(.+)$/)?.[1];
  if (ended && runById(ended)) return { name: "ended", run: ended };
  // `/?session=<id>` is the MCP `viewUrl`; it lands on `/<id>`.
  const session = path || params.get("session");
  return session ? { id: session, name: "session" } : { name: "home" };
};

const Scaffold = ({
  inFlows,
  catalogEmpty,
  onCatalog,
  sessionsOn,
  onSessions,
  inSession,
  side,
  onSide,
  onRequest,
  requestState,
  onRequestState,
  onNotice,
  options,
  onOptions,
  stage,
  onStage,
  rail,
  onRail,
  canEnd,
  onEnd,
  summary,
  onSummary,
  review,
  onReview,
  cleanupFails,
  onCleanup,
  guided,
  onGuided,
  bot,
  onBot,
  fill,
  onFill,
}: {
  readonly fill: Fill;
  readonly onFill: () => void;
  readonly guided: GuidedControl | undefined;
  readonly onGuided: () => void;
  readonly bot: boolean | undefined;
  readonly onBot: () => void;
  readonly canEnd: boolean;
  readonly onEnd: () => void;
  readonly summary: SummaryState | undefined;
  readonly onSummary: () => void;
  readonly review: Decision | undefined;
  readonly onReview: () => void;
  readonly cleanupFails: boolean;
  readonly onCleanup: () => void;
  readonly inFlows: boolean;
  readonly catalogEmpty: boolean;
  readonly onCatalog: () => void;
  readonly options: Options;
  readonly onOptions: (options: Options) => void;
  readonly sessionsOn: boolean;
  readonly onSessions: (on: boolean) => void;
  readonly inSession: boolean;
  readonly side: "left" | "right";
  readonly onSide: () => void;
  readonly onRequest: () => void;
  readonly requestState: RequestState;
  readonly onRequestState: () => void;
  readonly onNotice: () => void;
  readonly stage: StageState | DeviceStage | undefined;
  readonly onStage: () => void;
  readonly rail: RailPlace | undefined;
  readonly onRail: () => void;
}) => {
  const [theme, setTheme] = useState<"system" | "light" | "dark">("system");
  return (
    <div aria-label="Prototype controls" className="scaffold" role="group">
      <span>Prototype</span>
      <button onClick={() => onSessions(!sessionsOn)} type="button">
        Sessions: {sessionsOn ? "on" : "off"}
      </button>
      <button
        onClick={() => {
          const next = (
            { dark: "system", light: "dark", system: "light" } as const
          )[theme];
          if (next === "system") delete document.documentElement.dataset.theme;
          else document.documentElement.dataset.theme = next;
          setTheme(next);
        }}
        type="button"
      >
        Theme: {theme}
      </button>
      {inFlows ? (
        <button onClick={onCatalog} type="button">
          Catalog: {catalogEmpty ? "empty" : "full"}
        </button>
      ) : null}
      {stage ? (
        <button onClick={onStage} type="button">
          Stage: {stage}
        </button>
      ) : null}
      {rail ? (
        <button onClick={onRail} type="button">
          Rail: {rail}
        </button>
      ) : null}
      <button onClick={onFill} type="button">
        Details: {fill}
      </button>
      {canEnd ? (
        <button onClick={onEnd} type="button">
          End Run
        </button>
      ) : null}
      {summary ? (
        <button onClick={onSummary} type="button">
          Summary: {summary}
        </button>
      ) : null}
      {review ? (
        <>
          <button onClick={onReview} type="button">
            Decision: {review}
          </button>
          <button onClick={onCleanup} type="button">
            Cleanup: {cleanupFails ? "fails" : "works"}
          </button>
        </>
      ) : null}
      {inSession && !summary ? (
        <>
          <button onClick={onSide} type="button">
            Status: {side}
          </button>
          <button onClick={onRequest} type="button">
            + Request
          </button>
          <button onClick={onRequestState} type="button">
            Request state: {requestState}
          </button>
          <button onClick={onNotice} type="button">
            Notice
          </button>
          <button
            onClick={() => onOptions({ ...options, long: !options.long })}
            type="button"
          >
            Sentence: {options.long ? "long" : "short"}
          </button>
          <button
            onClick={() =>
              onOptions({
                ...options,
                disclosure:
                  DISCLOSURES[
                    (DISCLOSURES.indexOf(options.disclosure) + 1) %
                      DISCLOSURES.length
                  ] ?? "popover",
              })
            }
            type="button"
          >
            Full sentence: {options.disclosure}
          </button>
          <button
            onClick={() => onOptions({ ...options, demo: !options.demo })}
            type="button"
          >
            Demo password: {options.demo ? "on" : "off"}
          </button>
          {guided ? (
            <>
              <button onClick={onGuided} type="button">
                Control: {guided}
              </button>
              <button
                onClick={() =>
                  onOptions({ ...options, controlFails: !options.controlFails })
                }
                type="button"
              >
                Control change: {options.controlFails ? "fails" : "works"}
              </button>
              <button
                onClick={() =>
                  onOptions({
                    ...options,
                    takeover:
                      TAKEOVER_STATES[
                        (TAKEOVER_STATES.indexOf(options.takeover) + 1) %
                          TAKEOVER_STATES.length
                      ] ?? "live",
                  })
                }
                type="button"
              >
                Takeover Variable: {options.takeover}
              </button>
            </>
          ) : null}
          {bot === undefined ? null : (
            <button onClick={onBot} type="button">
              Bot block: {bot ? "on" : "off"}
            </button>
          )}
        </>
      ) : null}
    </div>
  );
};

const GHOSTS: readonly (readonly [number, number, number, number, string])[] = [
  [-640, -300, 220, 140, "checkout"],
  [500, -270, 260, 150, "login · Dry Run"],
  [-720, 200, 200, 230, "onboarding"],
  [620, 240, 240, 150, "search"],
  [-160, -540, 300, 110, "contingency/"],
  [80, 470, 240, 130, "settings"],
];
const world = document.getElementById("canvas-world");
if (world) {
  world.innerHTML = GHOSTS.map(
    ([x, y, w, h, t]) =>
      `<div class="ghost" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px">${t}</div>`
  ).join("");
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
