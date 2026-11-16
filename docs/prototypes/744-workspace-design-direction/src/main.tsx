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
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import {
  AndroidIcon,
  AppleIcon,
  CheckIcon,
  ChevronIcon,
  ChevronsIcon,
  CloseIcon,
  DocsIcon,
  FlowsIcon,
  HandIcon,
  MoonIcon,
  PlusIcon,
  SunIcon,
  UploadIcon,
  WatcherMark,
  WebIcon,
} from "./icons";

type Platform = "web" | "android" | "ios";
type Status = "ready" | "recording" | "running" | "needs-you";

interface Session {
  readonly id: string;
  readonly platform: Platform;
  readonly flow: string;
  readonly activity: "Teaching" | "Dry Run" | "Guided Run" | "Run";
  status: Status;
  readonly step?: readonly [number, number];
  since: number;
}

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
    status: "recording",
  },
  {
    activity: "Dry Run",
    flow: "login",
    id: "s2",
    platform: "android",
    since: now - 128_000,
    status: "running",
    step: [4, 9],
  },
  {
    activity: "Guided Run",
    flow: "onboarding",
    id: "s3",
    platform: "ios",
    since: now - 305_000,
    status: "needs-you",
  },
  {
    activity: "Run",
    flow: "Find a red jacket under $80",
    id: "s4",
    platform: "web",
    since: now - 61_000,
    status: "running",
    step: [2, 6],
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
  switch (session.status) {
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

const Actions = () => (
  <div className="chrome right island">
    <Button className="pill-btn">
      <FlowsIcon />
      Flows
    </Button>
    <IconButton label="Docs">
      <DocsIcon />
    </IconButton>
    <ThemeButton />
  </div>
);

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

const DOCK: Record<
  Status,
  {
    readonly sentence: string;
    readonly action: string;
    readonly next?: Status;
    readonly tone: string;
  }
> = {
  ready: {
    action: "Start recording",
    next: "recording",
    sentence: "Start recording when the journey begins.",
    tone: "rec",
  },
  recording: {
    action: "Stop",
    next: "ready",
    sentence: "Every click and keystroke becomes an instruction.",
    tone: "",
  },
  running: {
    action: "Take control",
    sentence: "The agent is following the Flow.",
    tone: "ghosty",
  },
  "needs-you": {
    action: "Review",
    sentence: "Allow the location change?",
    tone: "",
  },
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

const SessionView = ({
  session,
  sessions,
  onHome,
  onOpen,
  onAdvance,
}: {
  readonly session: Session;
  readonly sessions: readonly Session[];
  readonly onHome: () => void;
  readonly onOpen: (id: string) => void;
  readonly onAdvance: (next: Status) => void;
}) => {
  const dock = DOCK[session.status];
  return (
    <>
      <Actions />
      <Stage session={session} />
      <div aria-label="Workspace dock" className="dock island" role="region">
        <IconButton className="brand" label="Contingency home" onClick={onHome}>
          <WatcherMark className="brand-mark" />
        </IconButton>
        <SessionSwitcher
          current={session}
          onNew={onHome}
          onOpen={onOpen}
          sessions={sessions}
          side="top"
        />
        <span className="divider" />
        <div className="dock-state">
          <StatusChip session={session} />
          <span className="sentence">{dock.sentence}</span>
        </div>
        <Button
          className={`btn ${dock.tone}`}
          onClick={() => {
            if (dock.next) onAdvance(dock.next);
          }}
        >
          {dock.action}
        </Button>
        <IconButton className="icon-btn flows-btn" label="Flows">
          <FlowsIcon />
        </IconButton>
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
  const [view, setView] = useState<
    | { readonly name: "home" }
    | { readonly name: "session"; readonly id: string }
  >({ name: "home" });
  const [expanded, setExpanded] = useState<Platform | null>(null);
  const [returning, setReturning] = useState<Platform | null>(null);
  const [returnTo, setReturnTo] = useState<string | null>(null);
  const [flow, setFlow] = useState("checkout");

  useEffect(() => {
    document.body.dataset.view = view.name;
  }, [view.name]);

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

  return (
    <>
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
        {current ? (
          <SessionView
            onAdvance={(next) =>
              transition(() =>
                setSessions((all) =>
                  all.map((s) =>
                    s.id === current.id
                      ? {
                          ...s,
                          since: next === "recording" ? Date.now() : s.since,
                          status: next,
                        }
                      : s
                  )
                )
              )
            }
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
        />
      </div>
    </>
  );
};

const Scaffold = ({
  sessionsOn,
  onSessions,
}: {
  readonly sessionsOn: boolean;
  readonly onSessions: (on: boolean) => void;
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
