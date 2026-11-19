// The Run details (#778): the sections a task Run keeps, read in the Run
// dock's Task details while it runs and in the Run Summary's tabs once it
// ends. Every section is one component, so the two places can't drift apart.
// The scaffold's **Details** switch fills them with empty, short or long
// content; `seeded` keeps each Run's own sample.
import { Button } from "@ui-sdk/react/button";
import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";

import {
  CheckCircleIcon,
  CheckIcon,
  CopyIcon,
  CornerIcon,
  ExternalIcon,
  MinusCircleIcon,
  SparklesIcon,
  XCircleIcon,
} from "./icons";
import type { Assessment, Platform, Run } from "./summary";

export type Fill = "seeded" | "empty" | "short" | "long";
export const FILLS: readonly Fill[] = ["seeded", "empty", "short", "long"];

/** The scaffold's fill, read by every Run Summary and Task details. */
export const DetailsFillContext = createContext<Fill>("seeded");

/* ------------------------------------------------------------------ model */

export interface Evidence {
  readonly kind: string;
  readonly id: string;
}

/** ADR 0056: a check the Flow taught, and what the Run's watch saw. */
export interface CheckResult {
  readonly flow: string;
  readonly id: string;
  readonly status: "passed" | "failed" | "inconclusive" | "interrupted" | null;
  readonly summary?: string;
  readonly attempt?: string;
  readonly at?: string;
}

/** ADR 0048: a scan the Flow requires, and the report the Run took. */
export interface ScanRequirement {
  readonly mode: "accessibility" | "navigation" | "reload" | "timespan";
  readonly when: string;
  readonly until?: string;
  readonly destination?: string;
  readonly outside?: string;
  readonly report?: {
    readonly status: "running" | "completed" | "failed" | "partial";
    readonly summary: string;
    readonly seconds?: number;
  };
}

export interface Modification {
  readonly at: string;
  readonly text: string;
  readonly source: "saved" | "agent";
  readonly removedAt?: string;
}

/** ADR 0057: a sub-goal the agent handed to System One. */
export interface Pursuit {
  readonly ending: "done" | "blocked" | "unsure" | "paused" | "needs-input";
  readonly goal: string;
  readonly reason: string;
  readonly attempts: readonly {
    readonly id: string;
    readonly operation: number;
    readonly target: number;
    readonly value?: number;
  }[];
}

export interface EmulationChange {
  readonly at: string;
  readonly actor: "Agent" | "You";
  readonly zoom: readonly [number, number];
  readonly text: readonly [number, number];
}

export interface Details {
  /** A bundled Example or demo store, said under the task. */
  readonly demo?: { readonly site: string; readonly example: boolean };
  readonly exampleFlows?: readonly string[];
  readonly zoom: number;
  readonly textScale: number;
  readonly emulationChanges: readonly EmulationChange[];
  readonly modifications: readonly Modification[];
  readonly checks: readonly CheckResult[];
  readonly scans: readonly ScanRequirement[];
  readonly pursuits: readonly Pursuit[];
  readonly assessmentEvidence: readonly Evidence[];
}

/* ---------------------------------------------------------------- samples */

const SHORT_WEB: Details = {
  assessmentEvidence: [{ id: "obs_7Qk2", kind: "observation" }],
  checks: [
    {
      at: "10:42:18",
      attempt: "att_4",
      flow: "checkout",
      id: "cart-total",
      status: "passed",
      summary: "GET /api/cart answered 200 with total 79.00.",
    },
  ],
  emulationChanges: [],
  modifications: [
    {
      at: "10:41:02",
      source: "saved",
      text: "Block requests to analytics.example.com",
    },
  ],
  pursuits: [
    {
      attempts: [
        { id: "att_2", operation: 0.94, target: 0.88 },
        { id: "att_3", operation: 0.91, target: 0.83, value: 0.97 },
      ],
      ending: "done",
      goal: "Filter the results to size M",
      reason: "The size filter showed M as selected.",
    },
  ],
  scans: [
    {
      mode: "accessibility",
      report: {
        seconds: 3.4,
        status: "completed",
        summary: "No serious or critical issues on the cart page.",
      },
      when: "the cart page shows",
    },
  ],
  textScale: 100,
  zoom: 100,
};

const LONG_WEB: Details = {
  assessmentEvidence: [
    { id: "obs_7Qk2", kind: "observation" },
    {
      id: "obs_7Qk9-cart-after-coupon-and-shipping-change",
      kind: "observation",
    },
    { id: "net_12f0", kind: "network" },
    { id: "con_3aa1", kind: "console" },
  ],
  checks: [
    {
      at: "10:42:18",
      attempt: "att_4",
      flow: "checkout",
      id: "cart-total",
      status: "passed",
      summary: "GET /api/cart answered 200 with total 79.00.",
    },
    {
      at: "10:43:51",
      attempt: "att_9",
      flow: "checkout",
      id: "coupon-applied-to-every-line-item-including-gift-wrap",
      status: "failed",
      summary:
        "POST /api/cart/coupon answered 200, but the gift-wrap line item kept its full price of 4.50, so the response body did not match the taught predicate items[*].discounted == true.",
    },
    {
      at: "10:44:07",
      attempt: "att_11",
      flow: "checkout",
      id: "session-cookie-secure",
      status: "inconclusive",
      summary: "The cookie changed twice within the window.",
    },
    { flow: "shipping-address", id: "address-saved", status: null },
  ],
  demo: { example: false, site: "Northwind" },
  emulationChanges: [
    { actor: "Agent", at: "10:42:40", text: [100, 100], zoom: [100, 125] },
    { actor: "You", at: "10:45:02", text: [100, 130], zoom: [125, 125] },
  ],
  exampleFlows: ["sign-in"],
  modifications: [
    {
      at: "10:41:02",
      source: "saved",
      text: "Block requests to analytics.example.com",
    },
    {
      at: "10:41:30",
      removedAt: "10:44:12",
      source: "agent",
      text: "Set cookie consent_banner=dismissed on .northwind.example for the whole Run, so the banner never covers the cart total or the coupon field",
    },
    {
      at: "10:42:05",
      source: "agent",
      text: "Throttle network to Slow 4G",
    },
  ],
  pursuits: [
    {
      attempts: [
        { id: "att_2", operation: 0.94, target: 0.88 },
        { id: "att_3", operation: 0.91, target: 0.83, value: 0.97 },
      ],
      ending: "done",
      goal: "Filter the results to size M",
      reason: "The size filter showed M as selected.",
    },
    {
      attempts: [
        { id: "att_6", operation: 0.71, target: 0.42 },
        { id: "att_7", operation: 0.66, target: 0.38, value: 0.55 },
        { id: "att_8", operation: 0.61, target: 0.31 },
      ],
      ending: "unsure",
      goal: "Apply the coupon SPRING20 and confirm every line item shows the discounted price, including gift wrap",
      reason:
        "Two fields accepted a code and System One could not tell which one the page meant; it stopped rather than guess a third time.",
    },
    {
      attempts: [],
      ending: "needs-input",
      goal: "Sign in as the returning shopper",
      reason: "The page asked for a one-time code.",
    },
  ],
  scans: [
    {
      mode: "accessibility",
      report: {
        seconds: 3.4,
        status: "completed",
        summary: "No serious or critical issues on the cart page.",
      },
      when: "the cart page shows",
    },
    {
      destination:
        "https://northwind.example/checkout/payment?step=2&cart=8f3e1d",
      mode: "navigation",
      report: {
        seconds: 6.9,
        status: "partial",
        summary:
          "Largest Contentful Paint 3.8 s; the payment iframe never finished loading, so Total Blocking Time is missing.",
      },
      when: "Continue to payment is chosen",
    },
    {
      mode: "timespan",
      outside: "The agent reopened the cart, which the task did not ask for.",
      report: {
        seconds: 41.2,
        status: "completed",
        summary: "Cumulative Layout Shift 0.02 across 14 interactions.",
      },
      until: "the order confirmation shows",
      when: "Place order is chosen",
    },
    { mode: "reload", when: "the confirmation page shows" },
  ],
  textScale: 100,
  zoom: 100,
};

const EMPTY_WEB: Details = {
  assessmentEvidence: [],
  checks: [],
  emulationChanges: [],
  modifications: [],
  pursuits: [],
  scans: [],
  textScale: 100,
  zoom: 100,
};

const LONG_TASK =
  "Find a red jacket under $80 in size M, add it to the cart with gift wrap, apply the coupon SPRING20, and check that every line item, including gift wrap, shows the discounted price before you place the order with the saved card.";

const NATIVE_LONG_TASK =
  "Create an account with a new email, choose the Free plan, turn on notifications when the app asks, and check that the welcome screen names the plan and the email you used, even after the app is closed and opened again.";

const LONG_INSTRUCTIONS = [
  "Use the saved card ending 4242, not a new one.",
  "If SPRING20 is refused, try SPRING-20 once and then stop and report what the page said, word for word, including any error under the coupon field.",
];

/** A Run with its details, as the seed or as the scaffold's fill. */
export const fillRun = (run: Run, fill: Fill): Run => {
  if (fill === "seeded") return run;
  if (run.platform !== "web") {
    // ADR 0078: a native Run keeps no browser evidence; only its task, Flows
    // and findings fill.
    return {
      ...run,
      findings: fill === "empty" ? [] : run.findings,
      flows: fill === "empty" ? [] : run.flows,
      instructions:
        fill === "long"
          ? [
              "Use a new email each time.",
              "Deny location if the app asks; the Flow does not need it, and the prompt should not block the welcome screen.",
            ]
          : [],
      task: fill === "long" ? NATIVE_LONG_TASK : run.task,
    };
  }
  const details =
    fill === "long" ? LONG_WEB : fill === "short" ? SHORT_WEB : EMPTY_WEB;
  return {
    ...run,
    checks: details.checks.map((c) => ({
      name: `${c.flow} · ${c.id}`,
      outcome:
        c.status === "passed"
          ? "working"
          : c.status === null
            ? "inconclusive"
            : "not-working",
    })),
    details,
    findings: fill === "empty" ? [] : run.findings,
    flows:
      fill === "empty"
        ? []
        : fill === "long"
          ? [...run.flows, "shipping-address", "sign-in"]
          : run.flows,
    instructions: fill === "long" ? LONG_INSTRUCTIONS : [],
    modifications: details.modifications.map((m) => m.text),
    scans: details.scans.map((s) => ({
      name: SCAN_MODE[s.mode],
      outcome: s.report?.status === "completed" ? "working" : "not-working",
      text: s.report?.summary ?? "Not run",
    })),
    task: fill === "long" ? LONG_TASK : run.task,
  };
};

/** The Run's details, from its seed when it has none of its own. */
export const detailsOf = (run: Run): Details =>
  run.details ?? {
    ...EMPTY_WEB,
    checks: (run.checks ?? []).map((c, i) => ({
      at: `10:4${i}:12`,
      attempt: `att_${i + 3}`,
      flow: run.flows[0] ?? "checkout",
      id: c.name,
      status: c.outcome === "working" ? "passed" : "failed",
    })),
    modifications: (run.modifications ?? []).map((text, i) => ({
      at: `10:4${i}:02`,
      source: "agent",
      text,
    })),
    scans: (run.scans ?? []).map((s) => ({
      mode: "navigation",
      report: {
        status: s.outcome === "working" ? "completed" : "failed",
        summary: s.text,
      },
      when: s.name,
    })),
  };

export const useFilledRun = (run: Run) =>
  fillRun(run, useContext(DetailsFillContext));

/* ---------------------------------------------------------------- labels */

const SCAN_MODE: Record<ScanRequirement["mode"], string> = {
  accessibility: "Accessibility",
  navigation: "Upcoming navigation",
  reload: "Page reload",
  timespan: "Interaction timespan",
};

const CHECK_STATUS: Record<NonNullable<CheckResult["status"]>, string> = {
  failed: "Failed",
  inconclusive: "Inconclusive",
  interrupted: "Interrupted",
  passed: "Passed",
};

const SCAN_STATUS: Record<
  NonNullable<ScanRequirement["report"]>["status"],
  string
> = {
  completed: "Completed",
  failed: "Failed",
  partial: "Partial",
  running: "Running",
};

const ENDING: Record<Pursuit["ending"], string> = {
  blocked: "Blocked",
  done: "Done",
  "needs-input": "Needs input",
  paused: "Paused",
  unsure: "Unsure",
};

const ASSESSMENT: Record<Assessment, string> = {
  blocked: "Blocked",
  inconclusive: "Inconclusive",
  "not-working": "Not working",
  working: "Working",
};

/** One mark for every pass, fail or open state in the details. */
type Mark = "pass" | "fail" | "open";
const MarkIcon = ({
  mark,
  label,
}: {
  readonly mark: Mark;
  readonly label: string;
}) => (
  <span
    aria-label={label}
    className="check-mark"
    data-state={mark === "open" ? "na" : mark}
    role="img"
  >
    {mark === "pass" ? (
      <CheckCircleIcon />
    ) : mark === "fail" ? (
      <XCircleIcon />
    ) : (
      <MinusCircleIcon />
    )}
  </span>
);

const percent = (n: number) => `${Math.round(n * 100)}%`;

/* --------------------------------------------------------------- sections */

/**
 * A section of the details: an eyebrow heading, its count or coverage on the
 * right, and its rows. The region keeps its name so a reader can jump to it.
 */
const Section = ({
  label,
  heading = label,
  meta,
  tone,
  children,
}: {
  readonly label: string;
  readonly heading?: string;
  readonly meta?: ReactNode;
  readonly tone?: "fail";
  readonly children: ReactNode;
}) => (
  <section aria-label={label} className="sub detail">
    <div className="detail-head">
      <h4 className="eyebrow">{heading}</h4>
      {meta ? (
        <span className="detail-meta" data-tone={tone}>
          {meta}
        </span>
      ) : null}
    </div>
    {children}
  </section>
);

/** An evidence id the agent cited, copied for an agent to open. */
export const EvidenceChip = ({ evidence }: { readonly evidence: Evidence }) => {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(t);
  }, [copied]);
  const short =
    evidence.id.length > 28
      ? `${evidence.id.slice(0, 16)}…${evidence.id.slice(-8)}`
      : evidence.id;
  return (
    <Button
      aria-label={`Copy ${evidence.kind} ${evidence.id}`}
      className="evidence-chip"
      onClick={() => {
        void navigator.clipboard?.writeText(evidence.id).catch(() => {});
        setCopied(true);
      }}
      title={`${evidence.kind}: ${evidence.id}. Copy it for your agent to open the evidence.`}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      <span className="evidence-kind">{evidence.kind}</span>
      <span className="mono">{short}</span>
    </Button>
  );
};

export const EvidenceList = ({
  evidence,
  hint = false,
}: {
  readonly evidence: readonly Evidence[];
  readonly hint?: boolean;
}) =>
  evidence.length === 0 ? null : (
    <div className="evidence">
      <ul aria-label="Browser evidence" className="chips">
        {evidence.map((e) => (
          <li key={`${e.kind}:${e.id}`}>
            <EvidenceChip evidence={e} />
          </li>
        ))}
      </ul>
      {hint ? (
        <p className="row-sub">
          Copy an id for your agent to open that evidence.
        </p>
      ) : null}
    </div>
  );

export const RequestedTask = ({
  run,
  label,
}: {
  readonly run: Run;
  readonly label: string;
}) => {
  const d = detailsOf(run);
  return (
    <Section label={label}>
      <p className="task-text">{run.task ?? run.title}</p>
      {d.demo ? (
        <p className="row-sub">
          {d.demo.example
            ? `A bundled Example on the ${d.demo.site} demo store. It demonstrates Contingency and is not your verified work.`
            : `Demo work on the ${d.demo.site} demo store, not a real website.`}
        </p>
      ) : null}
      {run.instructions && run.instructions.length > 0 ? (
        <ol aria-label="Changed instructions" className="instructions">
          {run.instructions.map((i) => (
            <li key={i}>
              <CornerIcon />
              {i}
            </li>
          ))}
        </ol>
      ) : null}
    </Section>
  );
};

export const ReferencedFlows = ({
  run,
  onFlow,
}: {
  readonly run: Run;
  readonly onFlow?: (name: string) => void;
}) => {
  const examples = new Set(detailsOf(run).exampleFlows ?? []);
  return (
    <Section label="Referenced flows" heading="Referenced Flows">
      {run.flows.length === 0 ? (
        <p className="detail-empty">No Flows referenced.</p>
      ) : (
        <ul className="chips">
          {run.flows.map((f) => (
            <li key={f}>
              <Button className="flow-pill" onClick={() => onFlow?.(f)}>
                {f}
                {examples.has(f) ? (
                  <span className="pill-tag">Example</span>
                ) : null}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
};

export const EmulationSection = ({ run }: { readonly run: Run }) => {
  const d = detailsOf(run);
  return (
    <Section label="Emulation">
      <dl className="facts flush">
        <div>
          <dt>Viewport</dt>
          <dd>{run.emulation ?? "Desktop 1280×800 · en-US"}</dd>
        </div>
        <div>
          <dt>Page zoom</dt>
          <dd>{d.zoom}%</dd>
        </div>
        <div>
          <dt>Text scale</dt>
          <dd>{d.textScale}%</dd>
        </div>
      </dl>
      {d.emulationChanges.length === 0 ? null : (
        <ol aria-label="Emulation changes" className="ledger">
          {d.emulationChanges.map((c) => (
            <li key={c.at}>
              <span className="mono ledger-time">{c.at}</span>
              <span>
                {c.zoom[0] === c.zoom[1]
                  ? `Text scale ${c.text[0]}% → ${c.text[1]}%`
                  : `Page zoom ${c.zoom[0]}% → ${c.zoom[1]}%`}
                <span className="row-sub">
                  {c.actor === "You" ? "You" : "The agent"}
                </span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
};

export const BrowserModifications = ({ run }: { readonly run: Run }) => {
  const mods = detailsOf(run).modifications;
  if (mods.length === 0) return null;
  return (
    <Section
      label="Browser Modifications"
      meta={`${mods.filter((m) => !m.removedAt).length} active`}
    >
      <ol aria-label="Browser Modification activity" className="ledger">
        {mods.map((m) => (
          <li data-removed={m.removedAt ? "" : undefined} key={m.at}>
            <span className="mono ledger-time">
              <time>{m.at}</time>
            </span>
            <span>
              {m.text}
              <span className="row-sub">
                {m.source === "saved"
                  ? "Saved with the Flow"
                  : "Added by the agent"}
                {m.removedAt ? (
                  <>
                    {" · Removed "}
                    <time className="mono">{m.removedAt}</time>
                  </>
                ) : null}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </Section>
  );
};

export const BrowserChecks = ({ run }: { readonly run: Run }) => {
  const checks = detailsOf(run).checks;
  if (checks.length === 0) return null;
  const passed = checks.filter((c) => c.status === "passed").length;
  return (
    <Section
      label="Browser Checks"
      meta={`${passed} of ${checks.length} required passed`}
      tone={passed === checks.length ? undefined : "fail"}
    >
      <ul className="ledger">
        {checks.map((c) => {
          const label =
            c.status === null ? "Not evaluated" : CHECK_STATUS[c.status];
          return (
            <li key={`${c.flow}/${c.id}`}>
              <MarkIcon
                label={label}
                mark={
                  c.status === "passed"
                    ? "pass"
                    : c.status === null
                      ? "open"
                      : "fail"
                }
              />
              <span className="ledger-body">
                <span className="ledger-title">
                  <span className="mono">{c.id}</span>
                  <span
                    className="ledger-status"
                    data-state={c.status ?? "open"}
                  >
                    {label}
                  </span>
                </span>
                <span className="row-sub">
                  {c.summary ?? "This required check has not been evaluated."}
                </span>
                <span className="ledger-foot">
                  {c.flow}
                  {c.attempt ? (
                    <>
                      {" · "}
                      <span className="mono">{c.attempt}</span> · {c.at}
                    </>
                  ) : null}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </Section>
  );
};

export const RequiredScans = ({ run }: { readonly run: Run }) => {
  const scans = detailsOf(run).scans;
  if (scans.length === 0) return null;
  const done = scans.filter((s) => s.report?.status === "completed").length;
  const complete = done === scans.length;
  return (
    <Section
      label="Required scans"
      meta={
        complete
          ? `${done} of ${scans.length} completed`
          : `${done} of ${scans.length} completed · coverage incomplete`
      }
      tone={complete ? undefined : "fail"}
    >
      <ul className="ledger">
        {scans.map((s) => {
          const status = s.report ? SCAN_STATUS[s.report.status] : "Not run";
          return (
            <li key={`${s.mode}:${s.when}`}>
              <MarkIcon
                label={status}
                mark={
                  s.report?.status === "completed"
                    ? "pass"
                    : s.report === undefined || s.report.status === "running"
                      ? "open"
                      : "fail"
                }
              />
              <span className="ledger-body">
                <span className="ledger-title">
                  <span>{SCAN_MODE[s.mode]}</span>
                  <span
                    className="ledger-status"
                    data-state={s.report?.status ?? "open"}
                  >
                    {status}
                  </span>
                </span>
                <span className="row-sub">
                  When {s.when}
                  {s.until ? `, until ${s.until}` : ""}
                </span>
                {s.destination ? (
                  <span className="ledger-foot mono wrap">{s.destination}</span>
                ) : null}
                {s.outside ? (
                  <span className="ledger-note">
                    Outside the requested scope: {s.outside}
                  </span>
                ) : null}
                {s.report ? (
                  <>
                    <span className="ledger-text">{s.report.summary}</span>
                    <span className="ledger-foot">
                      {s.report.seconds === undefined ? null : (
                        <span className="mono">
                          {s.report.seconds.toFixed(1)} s
                        </span>
                      )}
                      {s.mode === "timespan"
                        ? " · agent-driven, includes reasoning time"
                        : ""}
                      {s.report.status === "running" ? null : (
                        <a className="ledger-link" href="#report">
                          Download full report
                          <ExternalIcon />
                        </a>
                      )}
                    </span>
                  </>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
    </Section>
  );
};

export const Pursuits = ({ run }: { readonly run: Run }) => {
  const pursuits = detailsOf(run).pursuits;
  if (pursuits.length === 0) return null;
  return (
    <Section label="System One Pursuits" meta={`${pursuits.length} delegated`}>
      <ul className="ledger">
        {pursuits.map((p) => (
          <li key={p.goal}>
            <span
              aria-hidden="true"
              className="pursuit-mark"
              data-ending={p.ending}
            >
              <SparklesIcon />
            </span>
            <span className="ledger-body">
              <span className="ledger-title">
                <span>{p.goal}</span>
                <span
                  className="ledger-status"
                  data-state={p.ending === "done" ? "passed" : "open"}
                >
                  {ENDING[p.ending]}
                </span>
              </span>
              <span className="row-sub">{p.reason}</span>
              {p.attempts.length === 0 ? null : (
                <ol aria-label="Model-chosen attempts" className="attempts">
                  {p.attempts.map((a) => (
                    <li key={a.id}>
                      <span className="mono">{a.id}</span>
                      <span>
                        operation <b>{percent(a.operation)}</b> · target{" "}
                        <b>{percent(a.target)}</b>
                        {a.value === undefined ? null : (
                          <>
                            {" "}
                            · value <b>{percent(a.value)}</b>
                          </>
                        )}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
};

/** The Agent Assessment, as the live dock shows it before the Run ends. */
export const AgentAssessment = ({
  run,
  live,
}: {
  readonly run: Run;
  readonly live: boolean;
}) => (
  <Section label="Task assessment" heading="Agent Assessment">
    {live ? (
      <p className="detail-empty">
        Not submitted yet. The agent assesses the task when it finishes.
      </p>
    ) : (
      <>
        <p className="assessment-line">
          <span
            aria-hidden="true"
            className="dot-mark"
            data-assessment={run.assessment}
          />
          <span>
            <strong>{ASSESSMENT[run.assessment]}</strong>
            <span className="row-sub">{run.explanation}</span>
          </span>
        </p>
        <EvidenceList evidence={detailsOf(run).assessmentEvidence} hint />
      </>
    )}
  </Section>
);

/** Device facts: what a native Run has in place of Emulation (ADR 0078). */
export const DeviceFacts = ({
  platform,
  run,
}: {
  readonly platform: Exclude<Platform, "web">;
  readonly run: Run;
}) => (
  <Section label="Device">
    <dl className="facts flush">
      <div>
        <dt>Device</dt>
        <dd>
          {platform === "android"
            ? "Pixel_9 · Android 16 · emulator-5554"
            : "iPhone 17 · iOS 26.5"}
        </dd>
      </div>
      <div>
        <dt>Target App</dt>
        <dd className="mono">
          {platform === "android"
            ? "com.example.shop · build 412"
            : "com.example.Onboard · build 88"}
        </dd>
      </div>
      <div>
        <dt>Starting data</dt>
        <dd>Fresh install</dd>
      </div>
      <div>
        <dt>Takeover</dt>
        <dd>
          {run.video.some((s) => s.kind === "takeover")
            ? "Occurred; a Dry Run cannot pass"
            : "None"}
        </dd>
      </div>
      <div>
        <dt>Capture gaps</dt>
        <dd>
          {run.video.some((s) => s.kind === "hidden")
            ? "Hidden Interval"
            : "None"}
        </dd>
      </div>
    </dl>
  </Section>
);

/**
 * Task details in the live Run dock: what it was asked and how it is set up
 * first, since it has concluded nothing yet; then what it has recorded.
 */
export const LiveTaskDetails = ({
  run,
  onFlow,
}: {
  readonly run: Run;
  readonly onFlow?: (name: string) => void;
}) => (
  <div className="detail-stack">
    <RequestedTask
      label={run.kind === "Dry Run" ? "Intended outcome" : "Requested task"}
      run={run}
    />
    <ReferencedFlows onFlow={onFlow} run={run} />
    <EmulationSection run={run} />
    <BrowserModifications run={run} />
    <BrowserChecks run={run} />
    <RequiredScans run={run} />
    <Pursuits run={run} />
    <AgentAssessment live run={run} />
    <Section
      label="Findings"
      meta={run.findings.length === 0 ? undefined : String(run.findings.length)}
    >
      {run.findings.length === 0 ? (
        <p className="detail-empty">No findings yet.</p>
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
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  </div>
);
