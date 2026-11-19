// The Run Summary (#757): one view for every surface that shows a finished
// Run. It docks beside an ended session, beside a Dry Run review at
// `?recording=`, and sits inline in the Flows page's Runs pane. The docked
// shell, the decision bar and the loading and missing states live here too, so
// the three surfaces can't drift apart.
import { Button } from "@ui-sdk/react/button";
import {
  Slider,
  SliderControl,
  SliderIndicator,
  SliderThumb,
  SliderTrack,
} from "@ui-sdk/react/slider";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@ui-sdk/react/tabs";
import { useEffect, useId, useState } from "react";
import type { ReactNode } from "react";

import {
  AlertCircleIcon,
  AndroidIcon,
  AppleIcon,
  CheckCircleIcon,
  CheckIcon,
  CopyIcon,
  EyeOffIcon,
  ForwardIcon,
  MinusCircleIcon,
  PanelCloseIcon,
  PauseIcon,
  PlayIcon,
  PointerIcon,
  SummaryIcon,
  WebIcon,
  XCircleIcon,
} from "./icons";
import {
  BrowserChecks,
  BrowserModifications,
  DeviceFacts,
  EmulationSection,
  EvidenceList,
  Pursuits,
  ReferencedFlows,
  RequestedTask,
  RequiredScans,
  detailsOf,
  useFilledRun,
} from "./run-details";
import type { Details } from "./run-details";

export type Platform = "web" | "android" | "ios";
export type Assessment = "working" | "not-working" | "inconclusive" | "blocked";

/** One span of a Run's video. Idle Gaps play condensed (ADR 0046). */
export interface Segment {
  readonly kind: "action" | "idle" | "hidden" | "takeover";
  /** Seconds of the real Run this span covers. */
  readonly real: number;
  readonly label: string;
}

export interface Finding {
  readonly outcome: Assessment;
  readonly text: string;
  /** Real Run time the finding's evidence points at; seeks the video. */
  readonly at?: number;
  readonly evidence?: number;
}

export interface Run {
  readonly id: string;
  readonly kind: "Dry Run" | "Interactive Run";
  readonly platform: Platform;
  readonly title: string;
  readonly assessment: Assessment;
  readonly when: string;
  readonly explanation: string;
  readonly findings: readonly Finding[];
  readonly modifications?: readonly string[];
  readonly checks?: readonly {
    readonly name: string;
    readonly outcome: Assessment;
  }[];
  readonly scans?: readonly {
    readonly name: string;
    readonly outcome: Assessment;
    readonly text: string;
  }[];
  readonly flows: readonly string[];
  readonly video: readonly Segment[];
  /** Cleanup deleted this Dry Run's evidence when its Flow was verified. */
  readonly purged?: boolean;
  /** The task as the user asked for it. Defaults to the title. */
  readonly task?: string;
  /** Instructions the user relayed while it ran. */
  readonly instructions?: readonly string[];
  readonly outcome?: "completed" | "interrupted" | "user-closed";
  /** The agent attempted the whole intended outcome. */
  readonly outcomeComplete?: boolean;
  readonly emulation?: string;
  /** The Run details (#778); seeds without them derive them. */
  readonly details?: Details;
}

export const PLATFORM: Record<
  Platform,
  { readonly name: string; readonly Icon: () => ReactNode }
> = {
  android: { Icon: AndroidIcon, name: "Android" },
  ios: { Icon: AppleIcon, name: "iOS" },
  web: { Icon: WebIcon, name: "Web" },
};

export const ASSESSMENT: Record<Assessment, string> = {
  blocked: "Blocked",
  inconclusive: "Inconclusive",
  "not-working": "Not working",
  working: "Working",
};

const OUTCOME: Record<NonNullable<Run["outcome"]>, string> = {
  completed: "Completed",
  interrupted: "Interrupted",
  "user-closed": "Closed by you",
};

export const playback = (s: Segment) =>
  s.kind === "idle" ? Math.min(2, s.real / 10) : s.real;
export const clock = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
export const realLength = (run: Run) =>
  run.video.reduce((t, s) => t + s.real, 0);

/* ---------------------------------------------------------------- verdict */

type Tone = "passed" | "failed" | "attention" | "neutral";

interface Check {
  readonly label: string;
  readonly value: string;
  readonly state: "pass" | "fail" | "na";
}

const tookOver = (run: Run) => run.video.some((s) => s.kind === "takeover");

/** The facts every Run's record answers, whatever it was for. */
const runChecks = (run: Run): Check[] => {
  const checks = run.checks ?? [];
  const passed = checks.filter((c) => c.outcome === "working").length;
  const scans = run.scans ?? [];
  const outcome = run.outcome ?? "completed";
  return [
    checks.length === 0
      ? { label: "Browser Checks", state: "na", value: "None required" }
      : {
          label: "Browser Checks",
          state: passed === checks.length ? "pass" : "fail",
          value: `${passed}/${checks.length} passed`,
        },
    scans.length === 0
      ? { label: "Required scans", state: "na", value: "None required" }
      : {
          label: "Required scans",
          state: "pass",
          value: `${scans.length}/${scans.length} completed`,
        },
    {
      label: "Run finished",
      state: outcome === "completed" ? "pass" : "fail",
      value: OUTCOME[outcome],
    },
    {
      label: "Agent Assessment",
      state: run.assessment === "working" ? "pass" : "fail",
      value: ASSESSMENT[run.assessment],
    },
  ];
};

/** A Dry Run's pass rule: the same checks the decision bar trusts. */
const dryRunChecks = (run: Run): Check[] => {
  const complete = run.outcomeComplete ?? run.assessment === "working";
  return [
    ...runChecks(run),
    {
      label: "Full outcome attempted",
      state: complete ? "pass" : "fail",
      value: complete ? "Yes" : "No",
    },
    {
      label: "No Takeover",
      state: tookOver(run) ? "fail" : "pass",
      value: tookOver(run) ? "You took control" : "Agent only",
    },
  ];
};

export const checksOf = (run: Run) =>
  run.kind === "Dry Run" ? dryRunChecks(run) : runChecks(run);

const QUALIFYING = new Set(["Full outcome attempted", "No Takeover"]);

export const verdictOf = (
  run: Run
): { readonly label: string; readonly tone: Tone; readonly why?: string } => {
  if (run.kind === "Dry Run") {
    const failed = dryRunChecks(run).filter((c) => c.state === "fail");
    if (failed.length === 0) return { label: "Dry Run passed", tone: "passed" };
    if (failed.every((c) => QUALIFYING.has(c.label)))
      return {
        label: "Dry Run did not pass",
        tone: "attention",
        why: tookOver(run)
          ? "You took control during it, so it can't pass. The journey itself worked."
          : "The agent didn't attempt the whole outcome, so it can't pass.",
      };
    return { label: "Dry Run failed", tone: "failed" };
  }
  const tone: Record<Assessment, Tone> = {
    blocked: "attention",
    inconclusive: "neutral",
    "not-working": "failed",
    working: "passed",
  };
  return { label: ASSESSMENT[run.assessment], tone: tone[run.assessment] };
};

const TONE_ICON: Record<Tone, () => ReactNode> = {
  attention: AlertCircleIcon,
  failed: XCircleIcon,
  neutral: MinusCircleIcon,
  passed: CheckCircleIcon,
};

export const AssessmentChip = ({ value }: { readonly value: Assessment }) => (
  <span className="chip" data-assessment={value}>
    <span aria-hidden="true" className="dot" />
    {ASSESSMENT[value]}
  </span>
);

/** The verdict as a small chip, for the collapsed dock and session lists. */
export const VerdictChip = ({ run }: { readonly run: Run }) => {
  const v = verdictOf(run);
  const Icon = TONE_ICON[v.tone];
  return (
    <span className="chip" data-tone={v.tone}>
      <Icon />
      {v.label}
    </span>
  );
};

/* ------------------------------------------------------------------ video */

/** Where playback time `t` falls: its span, how far into it, and real time. */
const locate = (run: Run, t: number) => {
  let start = 0;
  let realBefore = 0;
  for (const s of run.video) {
    const len = playback(s);
    if (t < start + len || s === run.video.at(-1)) {
      const into = Math.min(1, Math.max(0, (t - start) / len));
      return { current: s, into, realNow: realBefore + s.real * into };
    }
    start += len;
    realBefore += s.real;
  }
  return { current: undefined, into: 0, realNow: 0 };
};

/** The playback time that shows real Run time `real`. */
const playbackAt = (run: Run, real: number) => {
  let t = 0;
  let left = real;
  for (const s of run.video) {
    if (left <= s.real) return t + playback(s) * (left / s.real);
    left -= s.real;
    t += playback(s);
  }
  return t;
};

/** One frame of the Run video, for the player and the seek preview. */
export const Frame = ({
  native,
  current,
  realNow,
}: {
  readonly native: boolean;
  readonly current: Segment | undefined;
  readonly realNow: number;
}) => (
  <>
    {native ? (
      <div className="phone">
        <div className="bar" style={{ width: "40%" }} />
        <div className="card" />
        <div className="bar" />
        <div className="bar" style={{ width: "70%" }} />
      </div>
    ) : (
      <div className="mini-page">
        <div className="bar" style={{ width: "28%" }} />
        <div className="hero-block" />
        <div className="grid">
          <div />
          <div />
          <div />
        </div>
      </div>
    )}
    {current?.kind === "action" ? (
      <span
        aria-hidden="true"
        className="agent-cursor"
        data-native={native || undefined}
        style={{
          left: `${(native ? 38 : 20) + ((realNow * 37) % (native ? 24 : 60))}%`,
          top: `${30 + ((realNow * 23) % 50)}%`,
        }}
      >
        <PointerIcon />
      </span>
    ) : null}
    {current?.kind === "hidden" ? (
      <div className="video-veil">
        <EyeOffIcon />
        <span className="veil-text">Hidden: secure screen</span>
      </div>
    ) : null}
    {current?.kind === "idle" ? (
      <span className="video-badge">
        <ForwardIcon />
        Fast-forwarded {clock(current.real)}
      </span>
    ) : null}
    {current?.kind === "takeover" ? (
      <span className="video-badge" data-tone="takeover">
        <PointerIcon />
        You had control
      </span>
    ) : null}
  </>
);

const KIND: Record<Segment["kind"], string> = {
  action: "Agent action",
  hidden: "Hidden Interval",
  idle: "Idle Gap",
  takeover: "Takeover",
};

export interface Seek {
  readonly real: number;
  /** Bumps on every request, so seeking to the same time twice still works. */
  readonly n: number;
}

const Video = ({
  run,
  seek,
}: {
  readonly run: Run;
  readonly seek: Seek | null;
}) => {
  const total = run.video.reduce((t, s) => t + playback(s), 0);
  /** The pointer over the seek bar: its x in the track, and the time there. */
  const [hover, setHover] = useState<{
    readonly x: number;
    readonly width: number;
    readonly t: number;
  } | null>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(
      () =>
        setT((x) => {
          if (x + 0.1 >= total) {
            setPlaying(false);
            return total;
          }
          return x + 0.1;
        }),
      100
    );
    return () => clearInterval(id);
  }, [playing, total]);
  useEffect(() => {
    if (seek === null) return;
    setT(playbackAt(run, seek.real));
    setPlaying(false);
  }, [seek, run]);

  const { current, realNow } = locate(run, t);
  const native = run.platform !== "web";
  const peek = hover ? locate(run, hover.t) : null;

  return (
    <section aria-label="Run video" className="video">
      <div className="video-frame" data-native={native || undefined}>
        <div className="video-screen">
          <Frame current={current} native={native} realNow={realNow} />
          {!playing && t === 0 ? (
            <button
              aria-label="Play Run video"
              className="video-big-play"
              onClick={() => setPlaying(true)}
              type="button"
            >
              <PlayIcon />
            </button>
          ) : null}
        </div>
        <p className="video-caption" aria-live="off">
          <span className="video-caption-text">{current?.label}</span>
          {current ? (
            <span className="peek-kind" data-kind={current.kind}>
              {KIND[current.kind]}
            </span>
          ) : null}
        </p>
      </div>
      <div className="video-controls">
        <Button
          aria-label={playing ? "Pause" : "Play"}
          className="icon-btn small"
          onClick={() => {
            if (t >= total) setT(0);
            setPlaying(!playing);
          }}
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </Button>
        <Slider
          className="scrub"
          max={total}
          min={0}
          onValueChange={(v: number) => {
            setPlaying(false);
            setT(v);
          }}
          step={0.1}
          value={t}
        >
          <SliderControl
            className="scrub-control"
            onPointerLeave={() => setHover(null)}
            onPointerMove={(e) => {
              const track = e.currentTarget.querySelector(".scrub-track");
              if (!(track instanceof HTMLElement)) return;
              const box = track.getBoundingClientRect();
              const x = Math.min(box.width, Math.max(0, e.clientX - box.left));
              setHover({ t: (x / box.width) * total, width: box.width, x });
            }}
          >
            <SliderTrack className="scrub-track">
              <span aria-hidden="true" className="scrub-segments">
                {run.video.map((s, i) => (
                  <span
                    data-kind={s.kind}
                    key={i}
                    style={{ flexGrow: playback(s) }}
                  />
                ))}
              </span>
              <SliderIndicator className="scrub-fill" />
              {hover && peek ? (
                // Pointer-only preview; the thumb's value text covers keyboard
                // and screen reader users.
                <span
                  aria-hidden="true"
                  className="scrub-peek island"
                  data-native={native || undefined}
                  style={{
                    left: `clamp(var(--peek-half), ${hover.x}px, ${hover.width}px - var(--peek-half))`,
                  }}
                >
                  <span className="peek-frame video-screen">
                    <Frame
                      current={peek.current}
                      native={native}
                      realNow={peek.realNow}
                    />
                  </span>
                  <span className="peek-text">
                    <span className="peek-label">{peek.current?.label}</span>
                    <span className="peek-meta">
                      <span className="mono">{clock(peek.realNow)}</span>
                      {peek.current ? (
                        <span
                          className="peek-kind"
                          data-kind={peek.current.kind}
                        >
                          {KIND[peek.current.kind]}
                        </span>
                      ) : null}
                    </span>
                  </span>
                </span>
              ) : null}
              {hover ? (
                <span
                  aria-hidden="true"
                  className="scrub-hover-line"
                  style={{ left: hover.x }}
                />
              ) : null}
              <SliderThumb
                aria-label="Seek"
                className="scrub-thumb"
                aria-valuetext={`${clock(realNow)} of the Run`}
              />
            </SliderTrack>
          </SliderControl>
        </Slider>
        <span className="mono video-time">
          {clock(realNow)} / {clock(realLength(run))}
        </span>
      </div>
    </section>
  );
};

/* ---------------------------------------------------------------- summary */

const CheckMark = ({ state }: { readonly state: Check["state"] }) =>
  state === "pass" ? (
    <span
      aria-label="Passed"
      className="check-mark"
      data-state="pass"
      role="img"
    >
      <CheckCircleIcon />
    </span>
  ) : state === "fail" ? (
    <span
      aria-label="Failed"
      className="check-mark"
      data-state="fail"
      role="img"
    >
      <XCircleIcon />
    </span>
  ) : (
    <span
      aria-label="Not required"
      className="check-mark"
      data-state="na"
      role="img"
    >
      <MinusCircleIcon />
    </span>
  );

const RunId = ({ id }: { readonly id: string }) => {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <Button
      aria-label={copied ? "Run ID copied" : `Copy Run ID ${id}`}
      className="run-id-btn"
      onClick={() => {
        void navigator.clipboard?.writeText(id).catch(() => {});
        setCopied(true);
      }}
    >
      <span className="mono">{id}</span>
      {copied ? <CheckIcon /> : <CopyIcon />}
    </Button>
  );
};

const evidenceCount = (run: Run) =>
  run.findings.reduce((n, f) => n + (f.evidence ?? 1), 0) +
  (run.checks?.length ?? 0) +
  (run.scans?.length ?? 0);

export const RunSummary = ({
  run: seeded,
  variant,
  onFlow,
  links,
}: {
  readonly run: Run;
  /** `dock` beside a session or review; `inline` in the Flows page. */
  readonly variant: "dock" | "inline";
  readonly onFlow?: (name: string) => void;
  /** Ways out of the summary, such as the ended session or the review. */
  readonly links?: ReactNode;
}) => {
  const run = useFilledRun(seeded);
  const [seek, setSeek] = useState<Seek | null>(null);
  const [tab, setTab] = useState("checks");
  const verdict = verdictOf(run);
  const Icon = TONE_ICON[verdict.tone];
  const checks = checksOf(run);
  const { Icon: PlatformIcon, name: platformName } = PLATFORM[run.platform];
  const actions = run.video.filter((s) => s.kind === "action").length;
  return (
    <article
      aria-label="Run Summary"
      className="summary"
      data-variant={variant}
    >
      <header className="verdict" data-tone={verdict.tone}>
        <span aria-hidden="true" className="verdict-icon">
          <Icon />
        </span>
        <div className="verdict-text">
          <p className="verdict-label">{verdict.label}</p>
          <p className="verdict-meta">
            <span className="verdict-platform">
              <PlatformIcon />
              {platformName}
            </span>
            <span aria-hidden="true">·</span>
            {run.kind}
            <span aria-hidden="true">·</span>
            {run.when}
          </p>
        </div>
      </header>
      <div className="summary-lede">
        <h3 className="summary-title">{run.title}</h3>
        {verdict.why ? <p className="summary-why">{verdict.why}</p> : null}
        <p className="summary-text">{run.explanation}</p>
      </div>
      {run.purged ? (
        <p className="purged">
          <EyeOffIcon />
          Cleanup removed this Dry Run's video when the Flow was verified. The
          summary stays.
        </p>
      ) : (
        <Video run={run} seek={seek} />
      )}
      <dl className="stats">
        <div>
          <dt>Duration</dt>
          <dd className="mono">{clock(realLength(run))}</dd>
        </div>
        <div>
          <dt>Actions</dt>
          <dd>{actions}</dd>
        </div>
        <div>
          <dt>Findings</dt>
          <dd>{run.findings.length}</dd>
        </div>
        <div>
          <dt>Evidence</dt>
          <dd>{evidenceCount(run)}</dd>
        </div>
      </dl>
      <Tabs
        className="summary-tabs"
        onValueChange={(v: string | null) => {
          if (v) setTab(v);
        }}
        value={tab}
      >
        <TabsList aria-label="Run Summary sections" className="seg-tabs">
          <TabsTab className="seg-tab" value="checks">
            {run.kind === "Dry Run" ? "Pass checks" : "Checks"}
            {checks.some((c) => c.state === "fail") ? (
              <span aria-label="has failures" className="seg-dot" role="img" />
            ) : null}
          </TabsTab>
          <TabsTab className="seg-tab" value="findings">
            Findings
            <span className="seg-count">{run.findings.length}</span>
          </TabsTab>
          <TabsTab className="seg-tab" value="task">
            Task
          </TabsTab>
        </TabsList>
        <TabsPanel className="seg-panel" value="checks">
          <ul aria-label="Checks" className="checklist">
            {checks.map((c) => (
              <li data-state={c.state} key={c.label}>
                <CheckMark state={c.state} />
                <span className="check-label">{c.label}</span>
                <span className="check-value">{c.value}</span>
              </li>
            ))}
          </ul>
          <EvidenceList evidence={detailsOf(run).assessmentEvidence} hint />
          {run.platform === "web" ? (
            <>
              <BrowserChecks run={run} />
              <RequiredScans run={run} />
            </>
          ) : null}
        </TabsPanel>
        <TabsPanel className="seg-panel" value="findings">
          {run.findings.length === 0 ? (
            <p className="hint">The agent reported no findings.</p>
          ) : (
            <ul aria-label="Findings" className="finding-list">
              {run.findings.map((f) => (
                <li key={f.text}>
                  <span
                    aria-hidden="true"
                    className="dot-mark"
                    data-assessment={f.outcome}
                  />
                  <div>
                    <p>{f.text}</p>
                    <p className="row-sub">
                      {ASSESSMENT[f.outcome]} · {f.evidence ?? 1} evidence
                      {f.at !== undefined && !run.purged ? (
                        <Button
                          aria-label={`Show ${clock(f.at)} in the Run video`}
                          className="seek-link"
                          onClick={() =>
                            setSeek({ n: Date.now(), real: f.at ?? 0 })
                          }
                        >
                          <PlayIcon />
                          {clock(f.at)}
                        </Button>
                      ) : null}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </TabsPanel>
        <TabsPanel className="seg-panel" value="task">
          <RequestedTask
            label={
              run.kind === "Dry Run" ? "Intended outcome" : "Requested task"
            }
            run={run}
          />
          <ReferencedFlows onFlow={onFlow} run={run} />
          {run.platform === "web" ? (
            <>
              <Pursuits run={run} />
              <BrowserModifications run={run} />
              <EmulationSection run={run} />
            </>
          ) : (
            <DeviceFacts platform={run.platform} run={run} />
          )}
          <dl className="facts">
            <div>
              <dt>Execution</dt>
              <dd>{OUTCOME[run.outcome ?? "completed"]}</dd>
            </div>
          </dl>
        </TabsPanel>
      </Tabs>
      <footer className="summary-foot">
        <RunId id={run.id} />
        {links ? <div className="summary-links">{links}</div> : null}
      </footer>
      {run.purged ? null : (
        <p className="local-note">The video and Trace stay on this machine.</p>
      )}
    </article>
  );
};

/** While the Runner writes the summary of a Run that just ended. */
export const SummaryWriting = () => (
  <div className="summary" aria-busy="true">
    <p className="writing" role="status">
      <span aria-hidden="true" className="spinner" />
      Writing the Run Summary…
    </p>
    <div className="skeleton verdict-skel" />
    <div className="skeleton line" style={{ width: "72%" }} />
    <div className="skeleton line" style={{ width: "90%" }} />
    <div className="skeleton video-skel" />
    <div className="skeleton stats-skel" />
  </div>
);

/** The Run ended, but its summary never arrived. */
export const SummaryMissing = ({
  onRetry,
}: {
  readonly onRetry: () => void;
}) => (
  <div className="summary">
    <div className="missing" role="alert">
      <span aria-hidden="true" className="verdict-icon">
        <AlertCircleIcon />
      </span>
      <div>
        <p className="verdict-label">The Run Summary could not be opened</p>
        <p className="summary-text">
          The Run ended, but its summary wasn't written in time. It will show on
          the Flows page once it is.
        </p>
        <Button className="btn ghosty small" onClick={onRetry}>
          Try again
        </Button>
      </div>
    </div>
  </div>
);

/* ------------------------------------------------------------------- dock */

/**
 * The floating island a summary docks in, on the right of an ended session or
 * a Dry Run review. The stage gives up its width rather than sitting under it.
 * Collapsing folds it into the status island as a SummaryPill, so nothing is
 * left floating over the canvas.
 */
export const SummaryDock = ({
  label,
  collapsed,
  onCollapse,
  footer,
  children,
}: {
  readonly label: string;
  readonly collapsed: boolean;
  readonly onCollapse: (collapsed: boolean) => void;
  readonly footer?: ReactNode;
  readonly children: ReactNode;
}) => {
  const bodyId = useId();
  // Collapsed, the summary lives in the status island as a SummaryPill.
  if (collapsed) return null;
  return (
    <aside aria-label={label} className="summary-dock island">
      <header className="dock-head">
        <span className="dock-glyph">
          <SummaryIcon />
        </span>
        <h2>{label}</h2>
        <Button
          aria-controls={bodyId}
          aria-expanded
          aria-label={`Collapse ${label}`}
          className="icon-btn small"
          onClick={() => onCollapse(true)}
        >
          <PanelCloseIcon />
        </Button>
      </header>
      <div className="dock-body" id={bodyId}>
        {children}
      </div>
      {footer ? <div className="dock-foot">{footer}</div> : null}
    </aside>
  );
};

/** The collapsed summary: a tool in the status island that keeps the verdict
 * in view and opens the dock again. */
export const SummaryPill = ({
  label,
  verdict,
  onExpand,
}: {
  readonly label: string;
  readonly verdict: ReactNode;
  readonly onExpand: () => void;
}) => (
  <Button
    aria-expanded={false}
    aria-label={`Expand ${label}`}
    className="pill-btn dock-pill"
    onClick={onExpand}
  >
    <SummaryIcon />
    <span className="tool-label">Summary</span>
    {verdict}
  </Button>
);

/* --------------------------------------------------------------- decision */

export type Decision = "pending" | "rejected" | "verified" | "cleanup-failed";

/**
 * Verify or reject, under a Dry Run's summary (ADR 0073). Only a passed Dry
 * Run with a pending decision offers the two buttons; everything else says
 * where the Flow stands.
 */
export const DecisionBar = ({
  flow,
  passed,
  decision,
  onDecide,
}: {
  readonly flow: string;
  readonly passed: boolean;
  readonly decision: Decision;
  readonly onDecide: (d: "verify" | "reject" | "retry") => void;
}) => {
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => setBusy(null), [decision]);
  const act = (d: "verify" | "reject" | "retry") => {
    setBusy(d);
    setTimeout(() => onDecide(d), 700);
  };
  if (decision === "pending" && passed) {
    return (
      <section aria-label="Flow decision" className="decision" data-tone="ask">
        <p className="decision-text">
          <strong>
            Verify <span className="mono">{flow}</span>?
          </strong>{" "}
          Verifying keeps the Flow and deletes its Teaching evidence.
        </p>
        <div className="decision-actions">
          <Button
            className="btn ghosty small"
            disabled={busy !== null}
            onClick={() => act("reject")}
          >
            {busy === "reject" ? "Rejecting…" : "Reject flow"}
          </Button>
          <Button
            className="btn small"
            disabled={busy !== null}
            onClick={() => act("verify")}
          >
            {busy === "verify" ? "Verifying…" : "Verify flow"}
          </Button>
        </div>
      </section>
    );
  }
  if (decision === "pending") {
    return (
      <section
        aria-label="Flow decision"
        className="decision"
        data-tone="failed"
      >
        <AlertCircleIcon />
        <p className="decision-text" role="status">
          This Flow can't be verified until a Dry Run passes. Ask the agent to
          fix it and run another.
        </p>
      </section>
    );
  }
  if (decision === "rejected") {
    return (
      <section
        aria-label="Flow decision"
        className="decision"
        data-tone="neutral"
      >
        <XCircleIcon />
        <p className="decision-text" role="status">
          You rejected <span className="mono">{flow}</span>. This evidence stays
          until the next Dry Run starts.
        </p>
      </section>
    );
  }
  if (decision === "verified") {
    return (
      <section
        aria-label="Flow decision"
        className="decision"
        data-tone="passed"
      >
        <CheckCircleIcon />
        <p className="decision-text" role="status">
          You verified <span className="mono">{flow}</span>. Cleanup removed its
          recording evidence.
        </p>
      </section>
    );
  }
  return (
    <section aria-label="Flow decision" className="decision" data-tone="failed">
      <div className="decision-text" role="alert">
        <p>
          <strong>Verified, but Cleanup couldn't finish.</strong> These files
          are still on disk:
        </p>
        <ul className="retained mono">
          <li>rec_6Tz4/video.mp4</li>
          <li>rec_6Tz4/trace.zip</li>
        </ul>
      </div>
      <div className="decision-actions">
        <Button
          className="btn small"
          disabled={busy !== null}
          onClick={() => act("retry")}
        >
          {busy === "retry" ? "Retrying…" : "Retry cleanup"}
        </Button>
      </div>
    </section>
  );
};
