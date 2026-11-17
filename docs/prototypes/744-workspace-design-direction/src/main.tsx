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
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import { FlowsPage, flowOfRun } from "./flows";
import {
  AndroidIcon,
  AppleIcon,
  CheckIcon,
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
  SunIcon,
  TaskIcon,
  UploadIcon,
  WatcherMark,
  WebIcon,
} from "./icons";

type Platform = "web" | "android" | "ios";
type Status = "ready" | "recording" | "running" | "needs-you" | "takeover";

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
      readonly kind: "input";
      readonly title: string;
      readonly detail: string;
      readonly field: string;
      readonly secret?: boolean;
    }
  | {
      readonly id: string;
      readonly kind: "question";
      readonly title: string;
      readonly detail: string;
      readonly choices: readonly string[];
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
}

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
    detail: "The Flow asks for it at the sign-in step.",
    field: "promo_code",
    kind: "input",
    title: "The agent needs a value for promo_code",
  },
  {
    detail: "Secrets are used for this Dry Run only and never saved.",
    field: "password",
    kind: "input",
    secret: true,
    title: "Enter the password for qa@shop.localhost",
  },
  {
    choices: ["Starter", "Pro"],
    detail:
      "The document says the account starts on Free, but the app only offers Starter and Pro.",
    kind: "question",
    title: "Which plan should the new account start on?",
  },
];

const statusOf = (s: Session): Status =>
  s.requests.length > 0
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
    flow: "login",
    id: "s2",
    platform: "android",
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
    requests: [{ ...REQUEST_SAMPLES[4], id: "r-seed-3" } as Request],
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
  switch (statusOf(session)) {
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
            <Select defaultValue={DEVICES[platform][0]?.value}>
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
              <FieldDescription className="hint">
                Devices that are off boot when the session starts.
              </FieldDescription>
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
}
const OptionsContext = createContext<Options>({
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

const Stage = ({ session }: { readonly session: Session }) =>
  session.platform === "web" ? (
    <section aria-label="Browser" className="stage web">
      <div className="urlbar">
        <span className="dots">
          <i />
          <i />
          <i />
        </span>
        <span className="url">
          shop.localhost/{session.flow.split(" ")[0]?.toLowerCase()}
        </span>
      </div>
      <div className="fake-page">
        <div className="bar" style={{ width: "30%" }} />
        <div className="hero-block" />
        <div className="grid">
          <div />
          <div />
          <div />
          <div />
          <div />
        </div>
      </div>
    </section>
  ) : (
    <section
      aria-label={`${PLATFORMS[session.platform].name} device`}
      className="stage native"
    >
      <div className="screen">
        <div className="bar" style={{ width: "40%" }} />
        <div className="card" />
        <div className="bar" />
        <div className="bar" style={{ width: "70%" }} />
        <div className="card" style={{ height: 80 }} />
      </div>
    </section>
  );

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
    foot: "Taught 2 days ago on Pixel_9 · Android 16",
    list: [
      "Open Contingency Public Login.",
      "Sign in with the supplied email and password.",
      "Done when the heading “Welcome back” shows.",
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

const TaskDetails = ({ session }: { readonly session: Session }) => {
  if (session.activity === "Teaching") return null;
  const d = DETAILS[session.activity];
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

const CommentComposer = ({
  session,
  onSent,
}: {
  readonly session: Session;
  readonly onSent: (text: string) => void;
}) => {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger aria-label="Comment" className="pill-btn">
        <CommentIcon />
        <span className="tool-label">Comment</span>
      </PopoverTrigger>
      <PopoverContent
        aria-label="Comment"
        align="end"
        className="popover island details"
        side="top"
        sideOffset={14}
      >
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim() === "") return;
            onSent(text.trim());
            setText("");
            setOpen(false);
          }}
        >
          <PopoverTitle className="popover-title">
            Comment at{" "}
            <span className="mono">
              {session.status === "recording" ? clock(session.since) : "now"}
            </span>
          </PopoverTitle>
          <textarea
            aria-label="Comment"
            autoFocus
            className="input textarea"
            onChange={(e) => setText(e.currentTarget.value)}
            placeholder="Why you did this, or what the agent should notice"
            rows={3}
            value={text}
          />
          <div className="composer-row">
            <Button className="pill-btn" type="button">
              <PointerIcon />
              Attach element
            </Button>
            <Button className="btn" disabled={text.trim() === ""} type="submit">
              Add comment
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
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
  const action = primaryAction(session);
  const { disclosure, long } = useContext(OptionsContext);
  const line = (long ? LONG_LINE : LINE)[statusOf(session)];
  const ref = useStatusWidth();
  return (
    <section
      aria-label="Session status"
      className="status-island island"
      ref={ref}
    >
      <StatusChip session={session} />
      <Sentence disclosure={disclosure} line={line} session={session} />
      <div className="tools">
        <TaskDetails session={session} />
        {session.activity === "Teaching" ? (
          <CommentComposer
            onSent={() => onNotice("Comment added to the recording.", "ok")}
            session={session}
          />
        ) : null}
      </div>
      <Button
        className={`btn ${action.tone}`}
        onClick={() => {
          onPatch(action.patch);
          if (session.activity === "Teaching" && session.status === "recording")
            onNotice(`Saved ${session.flow}. Dry Run it from Flows.`, "ok");
        }}
      >
        {action.label}
      </Button>
    </section>
  );
};

const eyebrow = (r: Request) =>
  r.kind === "boundary"
    ? "Execution Boundary"
    : r.kind === "question"
      ? "Guided Run question"
      : r.secret
        ? "Dry Run secret"
        : "Input needed";

const REQUEST_ICON = {
  boundary: ShieldIcon,
  input: KeyIcon,
  question: QuestionIcon,
} as const;

const RequestTier = ({
  session,
  collapsed,
  onCollapse,
  onResolve,
}: {
  readonly session: Session;
  readonly collapsed: boolean;
  readonly onCollapse: (collapsed: boolean) => void;
  readonly onResolve: (request: Request, refused: boolean) => void;
}) => {
  const [answer, setAnswer] = useState("");
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
  const takeover = session.control === "user";
  const send = () => {
    if (answer.trim() === "") return;
    onResolve(first, false);
  };
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
            {eyebrow(first)}
            {count > 1 ? <span className="mono"> · 1 of {count}</span> : null}
          </span>
          <h2>{first.title}</h2>
        </div>
        <IconButton
          className="icon-btn small"
          label="Collapse requests"
          onClick={() => onCollapse(true)}
        >
          <MinimizeIcon />
        </IconButton>
      </header>
      <p className="request-detail">{first.detail}</p>
      {first.kind === "boundary" ? (
        <>
          <div className="request-target mono">{first.target}</div>
          <div className="request-actions">
            {takeover ? (
              <span className="hint grow">
                Return control to allow. You can still refuse.
              </span>
            ) : null}
            <Button
              className="btn ghosty"
              onClick={() => onResolve(first, true)}
            >
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
        </>
      ) : null}
      {first.kind === "input" ? (
        <form
          className="request-actions"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <Input
            aria-label={first.field}
            autoComplete="off"
            autoFocus
            className="input mono grow"
            onChange={(e) => setAnswer(e.currentTarget.value)}
            placeholder={first.field}
            type={first.secret ? "password" : "text"}
            value={answer}
          />
          <Button className="btn" disabled={answer.trim() === ""} type="submit">
            Send
          </Button>
        </form>
      ) : null}
      {first.kind === "question" ? (
        <form
          className="request-answers"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <div className="choices">
            {first.choices.map((c) => (
              <Button
                className="pill-btn floating"
                key={c}
                onClick={() => onResolve(first, false)}
              >
                {c}
              </Button>
            ))}
          </div>
          <div className="request-actions">
            <Input
              aria-label="Answer"
              autoComplete="off"
              className="input grow"
              onChange={(e) => setAnswer(e.currentTarget.value)}
              placeholder="Or answer in your own words"
              value={answer}
            />
            <Button
              className="btn"
              disabled={answer.trim() === ""}
              type="submit"
            >
              Send answer
            </Button>
          </div>
        </form>
      ) : null}
    </section>
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
}: {
  readonly session: Session;
  readonly sessions: readonly Session[];
  readonly notice: Notice | null;
  readonly onHome: () => void;
  readonly onOpen: (id: string) => void;
  readonly onPatch: (patch: Patch) => void;
  readonly onNotice: NotifyFn;
}) => {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <>
      <nav aria-label="Workspace" className="chrome left island">
        <a
          aria-label="Contingency home"
          className="brand"
          href="#"
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
      <Stage session={session} />
      <div aria-live="polite" className="notices">
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
        <div className="bottom-center">
          <RequestTier
            collapsed={collapsed}
            key={session.requests[0]?.id}
            onCollapse={(c) => transition(() => setCollapsed(c))}
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
        <StatusIsland onNotice={onNotice} onPatch={onPatch} session={session} />
      </div>
    </>
  );
};

/* ---------------------------------------------------------------------- app */

const App = () => {
  useNow();
  const [sessions, setSessions] = useState<Session[]>(() =>
    SEED.map((s) => ({ ...s }))
  );
  const [view, setView] = useState<View>(() => fromUrl());
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
    disclosure: "popover",
    long: true,
  });
  const [sample, setSample] = useState(0);

  useEffect(() => {
    document.body.dataset.view = view.name;
  }, [view.name]);
  // The view lives in the URL, so `/flow` opens the Flows page directly and
  // Back returns to where you were.
  useEffect(() => {
    const url = toUrl(view);
    if (url !== location.pathname + location.search)
      history.pushState(null, "", url);
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
      <FlowsNav.Provider
        value={{ here: view.name === "flows", morphBack, open: openFlows }}
      >
        <div className="desktop-gate" role="alert">
          <div className="island gate-card">
            <WatcherMark className="brand-mark big" />
            <h1>Open Contingency on a desktop</h1>
            <p>
              The Workspace drives browsers, emulators and simulators side by
              side. It needs a screen at least 1024 pixels wide.
            </p>
          </div>
        </div>
        <div className="app">
          {view.name === "flows" ? (
            <FlowsPage
              actions={<Actions />}
              empty={catalogEmpty}
              nav={
                <nav aria-label="Workspace" className="chrome left island">
                  <a
                    aria-label="Contingency home"
                    className="brand"
                    href="/"
                    onClick={(e) => {
                      e.preventDefault();
                      home();
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
                          current={undefined}
                          onNew={home}
                          onOpen={(id) => open(id)}
                          sessions={sessions}
                          side="bottom"
                        />
                      </div>
                    </>
                  ) : null}
                </nav>
              }
              onRun={(run) => setView({ flow: view.flow, name: "flows", run })}
              onSelect={(flow) => setView({ flow, name: "flows" })}
              run={view.run}
              selected={view.flow}
              sessionFlow={fromSession}
            />
          ) : current ? (
            <SessionView
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
              }}
              returnTo={returnTo}
              returning={returning}
              sessions={sessions}
            />
          )}
          <Scaffold
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
            onCatalog={() => transition(() => setCatalogEmpty(!catalogEmpty))}
            side={side}
            onSide={() =>
              transition(() => setSide(side === "right" ? "left" : "right"))
            }
            onRequest={() => {
              if (!current) return;
              const next = REQUEST_SAMPLES[sample % REQUEST_SAMPLES.length];
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
            onOptions={setOptions}
            options={options}
          />
        </div>
      </FlowsNav.Provider>
    </OptionsContext.Provider>
  );
};

type View =
  | { readonly name: "home" }
  | { readonly name: "session"; readonly id: string }
  | {
      readonly name: "flows";
      readonly flow?: string;
      readonly run?: string;
    };

const toUrl = (view: View) => {
  if (view.name === "session") return `/?session=${view.id}`;
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
  // The old Run Summary view, `/?run=<id>`, lands on that Run in its Flow, so
  // every MCP `viewUrl` already handed out keeps working.
  if (run) return { flow: flowOfRun(run), name: "flows", run };
  const session = params.get("session");
  return session && SEED.some((s) => s.id === session)
    ? { id: session, name: "session" }
    : { name: "home" };
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
  onNotice,
  options,
  onOptions,
}: {
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
  readonly onNotice: () => void;
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
      {inSession ? (
        <>
          <button onClick={onSide} type="button">
            Status: {side}
          </button>
          <button onClick={onRequest} type="button">
            + Request
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
