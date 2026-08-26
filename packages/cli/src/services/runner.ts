import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { arch, cpus, loadavg, platform, totalmem } from "node:os";
import path from "node:path";

import { AxeBuilder } from "@axe-core/playwright";
import {
  accessibilityRuleTags,
  FindingSeverity,
  Flow as FlowSchema,
  stepNavigates,
} from "@contingency/protocol";
import type {
  AuthoredStep,
  Condition,
  CoreWebVitals,
  ElidedFindings,
  Finding,
  Flow,
  LocatorDescriptor,
  PreStep,
  Run,
  RunAttempt,
  RunEnvironment,
  RunFailure,
  RunPreStep,
  RunStep,
  RunTraceManifest,
  RunTraceSegment,
  RunVideoManifest,
  RunVideoSegment,
  SelectorCandidate,
  SelectorDiagnostics,
} from "@contingency/protocol";
import {
  Context,
  Data,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Schema,
  Semaphore,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { chromium, errors } from "playwright-core";
import type { Browser, BrowserContext, Locator, Page } from "playwright-core";

import { ensureChromiumInstalled } from "./browser-install.ts";
import {
  describeDiagnostics,
  missedCandidate,
  redactDiagnostics,
  selectorDiagnostics,
} from "./selector-diagnostics.ts";
import {
  deriveVideoFromTrace,
  prepareTraceArtifacts,
  traceWasWritten,
} from "./trace-artifacts.ts";
import type { PreparedTraceArtifacts } from "./trace-artifacts.ts";
import type { VariableResolution } from "./variables.ts";
import { redactSecrets, substituteVariables } from "./variables.ts";
import { VITALS_COLLECTOR, VITALS_RECORDER } from "./vitals-recorder.ts";

/**
 * Run sessions replay a Flow, so they open at the Flow's own viewport rather
 * than a canvas-sized one.
 */
const RUN_VIEWPORT = {
  deviceScaleFactor: 1,
  height: 800,
  width: 1280,
} as const;

/**
 * How long one Step may act before failing, set explicitly rather than left at
 * Playwright's thirty-second default. A few inherited defaults under retry
 * would consume the whole Run ceiling and report a ceiling breach instead of
 * naming the Step that hung (ADR 0021).
 */
const DEFAULT_ACTION_TIMEOUT_MS = 10_000;

/** How long one navigation may take, for the same reason (ADR 0021). */
const DEFAULT_NAVIGATION_TIMEOUT_MS = 20_000;

/** A chatty Page may never become idle, so startup readiness has a ceiling. */
const NAVIGATION_IDLE_BOUND_MS = 2000;

/** How often a bounded wait re-reads its condition while waiting it out. */
const WAIT_POLL_MS = 100;

/**
 * The shortest wait for a Page a Step names. A popup the previous Step opened
 * normally registers long before its Step acts; this floor only keeps a
 * zero-ish Step timeout from turning that race into a guaranteed failure.
 */
const MINIMUM_PAGE_WAIT_MS = 1000;

/**
 * How long a Run waits for its Page to go quiet after the final Step — network
 * idle and a stable DOM — before stopping the Trace and closing the context
 * (ADR 0015). Bounded, so a Page that never settles cannot stretch a Run
 * indefinitely; applied once, here, and never between Steps, whose timings
 * describe the site rather than the Runner.
 */
const QUIESCE_BOUND_MS = 2000;

/** How long the DOM must not change for the Page to count as settled. */
const DOM_STABLE_WINDOW_MS = 250;

export class RunnerError extends Data.TaggedError("RunnerError")<{
  /**
   * Who the failure belongs to, when the Runner knows. Only the Runner can
   * say: by the time a failure is a message, "no locator resolved" and "the
   * browser died" read alike.
   */
  readonly kind?: RunFailure["kind"];
  /**
   * Every candidate a resolution failure tried, and what the page had instead.
   * Absent on failures that are not about finding an element.
   */
  readonly diagnostics?: SelectorDiagnostics;
  readonly message: string;
}> {}

export interface RunnerRunOptions {
  /** Keep the Run's Playwright Trace. Defaults to true. */
  readonly trace?: boolean;
  /** Generate a video from the Trace's per-Step screenshots. */
  readonly video?: boolean;
  /** Directory holding one subdirectory per Flow. Defaults to the state dir. */
  readonly outputDirectory: string;
  /**
   * How many extra attempts a failing Flow gets. `0` disables retrying, which a
   * Flow with real side effects needs: a rerun places a second order.
   */
  readonly retry?: number | undefined;
  /** Wall-clock ceiling for the whole Run, retries included. */
  readonly timeout?: Duration.Duration | undefined;
  /** Values for the Flow's Variables, resolved by preflight before this runs. */
  readonly variables?: VariableResolution | undefined;
}

/** Retries a Run gets when the caller does not say. */
export const DEFAULT_RETRY = 3;

/**
 * Wall-clock ceiling for a whole Run. Per-Step timeouts do not bound a long
 * Flow under retry, so the Run carries its own.
 */
export const DEFAULT_TIMEOUT = Duration.minutes(5);

const NO_VARIABLES: VariableResolution = {
  secretNames: new Set(),
  values: new Map(),
};

export interface RunnerService {
  readonly run: (
    flow: Flow,
    options: RunnerRunOptions
  ) => Effect.Effect<RunResult, RunnerError>;
}

export interface RunResult {
  readonly directory: string;
  readonly run: Run;
}

export const Runner = Context.Service<RunnerService>("@contingency/Runner");

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .toSorted(([left], [right]) => (left < right ? -1 : 1))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);
  return `{${entries.join(",")}}`;
};

/**
 * Content hash of the Flow as executed. Keys are sorted so that a
 * semantically identical Flow hashes identically regardless of key order.
 */
export const hashFlow = (flow: Flow): string =>
  createHash("sha256").update(stableStringify(flow)).digest("hex");

/**
 * A Flow's Run history is keyed on its stable identity. A Flow that declares
 * none falls back to its content hash, which is stable and, unlike the title,
 * not user-editable.
 */
export const flowIdentity = (flow: Flow, flowHash: string): string =>
  flow.flowId ?? `sha256-${flowHash.slice(0, 16)}`;

/**
 * A Flow's identity comes from a file the Runner did not write, so it can hold
 * path separators, `..`, or a name a filesystem refuses. It names the Run's
 * directory, so it is encoded to one safe segment first; `Run.flowId` keeps the
 * identity as declared.
 *
 * Every key carries a hash of the original identity. That keeps the mapping
 * injective — `a/b` and `a\b` sanitize alike, and long identities truncate
 * alike, either of which would merge two Flows' histories into one directory.
 *
 * The readable part keeps no dots, so a key is always one stem ending in
 * `-<hash>`; Windows reserves device names such as `CON` both bare and with
 * any extension, and a stem that cannot end before a dot never matches one.
 */
export const flowDirectorySegment = (flowId: string): string => {
  const digest = createHash("sha256").update(flowId).digest("hex").slice(0, 16);
  const readable = flowId
    .replaceAll(/[^A-Za-z0-9_-]/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 40);
  return readable.length === 0 ? `flow-${digest}` : `${readable}-${digest}`;
};

/**
 * Where every Run of this Flow is filed. Preflight probes this exact path, so
 * a per-Flow directory left behind by an earlier Run with different
 * permissions is caught before the browser opens rather than after.
 */
export const flowRunsDirectory = (
  outputDirectory: string,
  flow: Flow
): string => {
  const flowHash = hashFlow(flow);
  return path.join(
    outputDirectory,
    flowDirectorySegment(flowIdentity(flow, flowHash))
  );
};

/** Sortable, filesystem-safe, and readable: `20260816T112233-<short id>`. */
export const runDirectoryName = (startedAt: Date, runId: string): string => {
  const stamp = startedAt.toISOString().replaceAll(/[-:]/gu, "").slice(0, 15);
  return `${stamp}-${runId.slice(0, 8)}`;
};

/**
 * Where a Run's artifacts live. Computed rather than discovered, so a Trace
 * can be written into it before the Run that describes it exists.
 */
export const runDirectory = (
  outputDirectory: string,
  flowId: string,
  startedAt: Date,
  runId: string
): string =>
  path.join(
    outputDirectory,
    flowDirectorySegment(flowId),
    runDirectoryName(startedAt, runId)
  );

const nowIso = Effect.sync(() => new Date());

/** The first status a site is answering with rather than serving a page. */
const HTTP_ERROR_STATUS = 400;

/**
 * How Chromium reports a navigation that did not complete:
 * `net::ERR_NAME_NOT_RESOLVED at https://…`.
 */
const NAVIGATION_FAILED = "net::";

/**
 * Who a failed Step belongs to.
 *
 * A navigation that did not complete is the site's. Locator exhaustion is the
 * Flow's, and only the Runner can say that one: by the time a failure is a
 * message, "no locator resolved" and "the browser died" read alike, which is
 * why the attribution travels on the error rather than being re-derived here.
 *
 * Everything else is left unattributed. A browser-process failure or a click
 * that landed wrong establishes nothing about whose fault it is, and a guess
 * routes it to someone who cannot act on it.
 */
export const classifyStepFailure = (
  attributed: RunFailure["kind"],
  message: string
): RunFailure["kind"] => {
  if (attributed !== undefined) {
    return attributed;
  }
  return message.startsWith(NAVIGATION_FAILED) ? "siteError" : undefined;
};

/**
 * Whether this Step asked to be measured. The toggle is only meaningful on a
 * Step that navigates, which the Flow schema already enforces, so a Step
 * without it is never measured (ADR 0008).
 */
const measuresPerformance = (step: AuthoredStep): boolean =>
  step.performance === true && stepNavigates(step);

/** The Page a Step names, absent on Steps that carry none. */
const pageIndexOf = (step: AuthoredStep): number | undefined =>
  "page" in step ? step.page : undefined;

// ---------------------------------------------------------------------------
// Driving Playwright
// ---------------------------------------------------------------------------

interface ReplayExecution {
  /**
   * Every Page this attempt acts on, indexed by the order it opened. Popups
   * and new tabs append themselves as they appear, so an index the Flow was
   * authored against stays stable even when the popup carries a per-run nonce.
   */
  readonly pages: Page[];
  readonly variables: VariableResolution;
  /**
   * The Page whose navigation is still awaiting measurement — where Core Web
   * Vitals are read when {@link measurePending} runs.
   */
  measuredPage: Page | undefined;
}

/** One attempt's browser resources, owned by the attempt's scope. */
interface AttemptSession {
  readonly context: BrowserContext;
  readonly execution: ReplayExecution;
}

interface ArtifactCapture {
  readonly keepTrace: boolean;
  settledFrame: Buffer | undefined;
  readonly stepFrames: Map<number, Buffer>;
  readonly traceFile: string;
  readonly traceSegments: RunTraceSegment[];
  readonly videoFile: string | undefined;
  readonly videoSegments: RunVideoSegment[];
}

/** The cookies and origin storage a context carries, as Playwright reports it. */
type BrowserStorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

/** The URL forms a Flow may navigate to; anything else is refused. */
const normalizeUrl = (value: string): Effect.Effect<string, RunnerError> =>
  Effect.try({
    catch: () => new RunnerError({ message: `Invalid URL: ${value}` }),
    try: () => {
      const trimmed = value.trim();
      const url = new URL(
        /^[A-Za-z][A-Za-z\d+.-]*:/u.test(trimmed)
          ? trimmed
          : `https://${trimmed}`
      );
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("Only HTTP and HTTPS URLs are supported");
      }
      return url.href;
    },
  });

const locatorFor = (page: Page, descriptor: LocatorDescriptor): Locator => {
  switch (descriptor.kind) {
    case "role": {
      // The schema accepts any role name the ARIA vocabulary might grow;
      // Playwright narrows to the roles it knows today.
      return page.getByRole(descriptor.role as never, {
        name: descriptor.name,
      });
    }
    case "label": {
      return page.getByLabel(descriptor.label);
    }
    case "placeholder": {
      return page.getByPlaceholder(descriptor.placeholder);
    }
    case "text": {
      return page.getByText(descriptor.text);
    }
    case "css": {
      return page.locator(descriptor.selector);
    }
    case "xpath": {
      return page.locator(`xpath=${descriptor.expression}`);
    }
    default: {
      throw new Error("Unknown locator descriptor.");
    }
  }
};

/**
 * Whether one candidate's failure is evidence about the candidate itself —
 * it matched nothing in time, or matched more than one element — rather than
 * about the browser. Only that kind justifies trying the next alternative;
 * anything else means the question could not be put to the page at all.
 */
const isCandidateMiss = (cause: unknown): boolean => {
  if (cause instanceof errors.TimeoutError) {
    return true;
  }
  return (
    cause instanceof Error && cause.message.includes("strict mode violation")
  );
};

/** Compile a Flow-authored URL pattern, refusing what will not parse. */
const compilePattern = (pattern: string): Effect.Effect<RegExp, RunnerError> =>
  Effect.try({
    catch: () =>
      new RunnerError({
        kind: "flowError",
        message: `"${pattern}" in this condition is not a usable regular expression.`,
      }),
    try: () => new RegExp(pattern, "u"),
  });

/**
 * The Page a Step acts on, by the order it opened. Omitting the index means
 * the first Page. An index beyond what has opened is waited out briefly — a
 * click resolves slightly before the popup it triggered registers — but a
 * Page that never appears fails the Step rather than hanging.
 */
const pageFor = Effect.fn("Runner.pageFor")(function* pageFor(
  execution: ReplayExecution,
  pageIndex: number | undefined,
  timeoutMs: number
) {
  const index = pageIndex ?? 0;
  const deadline = Date.now() + Math.max(timeoutMs, MINIMUM_PAGE_WAIT_MS);
  for (;;) {
    const page = execution.pages[index];
    if (page !== undefined) {
      if (!page.isClosed()) {
        return page;
      }
      break;
    }
    if (Date.now() >= deadline) {
      break;
    }
    yield* Effect.sleep(WAIT_POLL_MS);
  }
  return yield* new RunnerError({
    kind: "flowError",
    message: `Page ${index} of this Flow never opened, or has already closed.`,
  });
});

/**
 * A failed Step's diagnostics, scrubbed, or nothing when the failure was not
 * about finding an element. Spread into the record either way, so the field is
 * absent rather than explicitly undefined.
 */
const redactedSelector = (
  failure: RunnerError,
  variables: VariableResolution
): { selector?: SelectorDiagnostics } =>
  failure.diagnostics === undefined
    ? {}
    : { selector: redactDiagnostics(failure.diagnostics, variables) };

/**
 * Act through a Step's ordered target, first match wins. The alternatives are
 * candidates, not a sequence: the first that resolves wins, and only the
 * exhaustion of all of them fails the Step — naming every strategy tried, so
 * a stale ladder is visible at a glance.
 */
const throughLadder = Effect.fn("Runner.throughLadder")(function* throughLadder(
  page: Page,
  target: readonly LocatorDescriptor[],
  perform: (locator: Locator) => Promise<unknown>
) {
  const tried: SelectorCandidate[] = [];
  for (const descriptor of target) {
    const locator = locatorFor(page, descriptor);
    const outcome = yield* Effect.result(
      Effect.tryPromise({
        catch: (cause: unknown) => cause,
        try: () => perform(locator),
      })
    );
    if (outcome._tag === "Success") {
      return;
    }
    // A candidate that already reached the page is not an unresolved locator:
    // trying the next one would act on the page a second time, and a dead
    // session or a browser failure is not evidence about the selector.
    if (!isCandidateMiss(outcome.failure)) {
      return yield* new RunnerError({ message: errorMessage(outcome.failure) });
    }
    const candidate = yield* Effect.result(
      missedCandidate(descriptor, locator, outcome.failure)
    );
    // The page could not say why the candidate missed, so the miss is not
    // established. Recording an unverified absence here would launder a dead
    // session into a stale-Flow verdict, which is the same misattribution the
    // guard above prevents — just one step later.
    if (candidate._tag === "Failure") {
      return yield* new RunnerError({
        message: errorMessage(candidate.failure),
      });
    }
    tried.push(candidate.success);
  }
  const diagnostics = yield* selectorDiagnostics(page, target, tried);
  return yield* new RunnerError({
    diagnostics,
    kind: "flowError",
    message: describeDiagnostics(diagnostics),
  });
});

/**
 * What the collector resolves with. `null` is the page saying it produced no
 * such measurement, which is not the same as zero.
 */
const CollectedVitals = Schema.Struct({
  cls: Schema.Number,
  fcp: Schema.NullOr(Schema.Number),
  inp: Schema.NullOr(Schema.Number),
  lcp: Schema.NullOr(Schema.Number),
  ttfb: Schema.NullOr(Schema.Number),
});

/**
 * Read Core Web Vitals off the page the last navigating Step landed on, at the
 * last moment the Run is on it — just before navigating away, or when the
 * attempt ends. Sampling earlier would understate CLS and LCP, whose entries
 * keep arriving after load, and INP is structurally unmeasurable before any
 * interaction happened.
 *
 * A measurement that cannot be taken does not fail the Step: failing the Run
 * over a metric read reports a broken site on the strength of our own inability
 * to observe it. {@link measurePending} absorbs this failure, and the absence
 * stays visible because the Flow toggled the Step and the Run carries no
 * vitals for it.
 */
const collectVitals = Effect.fn("Runner.collectVitals")(function* collectVitals(
  execution: ReplayExecution
) {
  const page =
    execution.measuredPage ??
    (yield* pageFor(execution, undefined, DEFAULT_ACTION_TIMEOUT_MS));
  const raw = yield* Effect.tryPromise({
    catch: () => new Error("The page could not answer."),
    try: () => page.evaluate(VITALS_COLLECTOR),
  });
  if (typeof raw !== "object" || raw === null) {
    return yield* new RunnerError({
      message: "The page did not report Core Web Vitals.",
    });
  }
  const decoded = yield* Schema.decodeUnknownEffect(CollectedVitals)(raw).pipe(
    Effect.mapError(() => new Error("unparsable"))
  );
  return {
    cls: decoded.cls,
    ...(decoded.fcp === null ? {} : { fcp: decoded.fcp }),
    ...(decoded.inp === null ? {} : { inp: decoded.inp }),
    ...(decoded.lcp === null ? {} : { lcp: decoded.lcp }),
    ...(decoded.ttfb === null ? {} : { ttfb: decoded.ttfb }),
  } satisfies CoreWebVitals;
});

// ---------------------------------------------------------------------------
// Accessibility Audits
// ---------------------------------------------------------------------------

/** What one Audit Step found, what the engine did not list in full, and which engine ran. */
export interface AuditResult {
  /** The engine's own version, so the Run can record it (ADR 0017). */
  readonly axeVersion: string | undefined;
  readonly elided: readonly ElidedFindings[];
  readonly findings: readonly Finding[];
}

/** One shared empty result, for every Step that finds nothing. */
const NO_FINDINGS: AuditResult = {
  axeVersion: undefined,
  elided: [],
  findings: [],
};

/** A target path: selectors, nested once per frame or shadow-root hop. */
type AuditTargetPath = string | readonly AuditTargetPath[];

/**
 * One target the accessibility engine reports. A plain string is a selector in
 * the current document; nesting means a hop, into a frame or a shadow root.
 */
const AuditTarget = Schema.Union([
  Schema.String,
  Schema.Array(
    Schema.suspend((): Schema.Codec<AuditTargetPath> => AuditTarget)
  ),
]);

/** The shape of an axe report, narrowed to what a Finding needs. Decoding only
 * the used fields keeps an engine upgrade that adds a field from failing
 * every Audit.
 */
const AuditReport = Schema.Struct({
  counts: Schema.Struct({
    inapplicable: Schema.Number,
    incomplete: Schema.Number,
    passes: Schema.Number,
    violations: Schema.Number,
  }),
  violations: Schema.Array(
    Schema.Struct({
      help: Schema.String,
      helpUrl: Schema.optional(Schema.String),
      id: Schema.String,
      impact: FindingSeverity,
      nodeCount: Schema.Int,
      nodes: Schema.Array(
        Schema.Struct({
          failureSummary: Schema.optional(Schema.String),
          target: Schema.Array(AuditTarget),
        })
      ),
    })
  ),
});

/**
 * How many elements per failing rule are listed as Findings before the rest
 * are elided. This cap is Contingency's own, chosen and written down (ADR
 * 0017): ten per rule, matching what the replaced browser tool listed, so a
 * rule failing on four hundred elements produces ten Findings and one true
 * count rather than four hundred of each.
 */
const AUDIT_NODE_SAMPLE_CAP = 10;

/**
 * Render an engine target path as one selector anyone can act on.
 *
 * The outer array crosses frames and a nested one enters a shadow root, so
 * the two get different joins rather than being flattened together:
 * `iframe >>> a` and `#host >> a` are found in entirely different ways.
 */
const renderAuditHop = (hop: AuditTargetPath): string =>
  typeof hop === "string" ? hop : hop.map(renderAuditHop).join(" >> ");

const renderAuditTarget = (target: readonly AuditTargetPath[]): string =>
  target.map(renderAuditHop).join(" >>> ");

/**
 * Run the pinned accessibility engine over the whole page, under the given
 * rule tags, through its Playwright integration (ADR 0017). The builder
 * injects the engine into every frame — cross-origin ones included — stitches
 * targets across frame and shadow-root hops, and fetches nothing from the
 * network. Contingency pins the engine version in its own manifest, so an
 * upgrade is a reviewed dependency bump rather than something that arrives
 * with someone else's binary.
 *
 * The wrapper finishes every audit on a utility page of its own, opened on
 * the Run's context and closed when done. That page joins the Run's Page
 * registry like any other, so `pages` is snapshotted before the audit and any
 * entry appended during it that is closed by the time it resolves was the
 * engine's, not the site's, and is removed again. A popup the audited page
 * opened stays: it is still open.
 *
 * An unrecognised tag selects no rules silently, and every page then audits
 * clean forever — so the one case where nothing ran is a failure.
 *
 * `stepIndex` names the Audit Step every returned Finding came from.
 */
const runAudit = Effect.fn("Runner.runAudit")(function* runAudit(
  page: Page,
  /** The Run's live Page registry, in opening order. */
  pages: Page[],
  tags: readonly string[],
  stepIndex: number
) {
  const knownPages = pages.length;
  const raw = yield* Effect.tryPromise({
    catch: (cause) =>
      new RunnerError({
        message: `The accessibility engine did not answer: ${errorMessage(cause)}`,
      }),
    try: () => new AxeBuilder({ page }).withTags([...tags]).analyze(),
  });
  for (let index = pages.length - 1; index >= knownPages; index -= 1) {
    if (pages[index]?.isClosed()) {
      pages.splice(index, 1);
    }
  }
  const report = yield* Schema.decodeUnknownEffect(AuditReport)({
    counts: {
      inapplicable: raw.inapplicable.length,
      incomplete: raw.incomplete.length,
      passes: raw.passes.length,
      violations: raw.violations.length,
    },
    // The pinned WCAG rules always carry an impact rating; the fallback exists
    // so a rule that somehow does not still reports rather than failing the
    // whole Audit on decode.
    violations: raw.violations.map((violation) => ({
      help: violation.help,
      ...(violation.helpUrl ? { helpUrl: violation.helpUrl } : {}),
      id: violation.id,
      impact: violation.impact ?? ("minor" as const),
      nodeCount: violation.nodes.length,
      nodes: violation.nodes.map((node) => ({
        ...(node.failureSummary ? { failureSummary: node.failureSummary } : {}),
        target: node.target,
      })),
    })),
  }).pipe(
    Effect.mapError(
      (cause) =>
        new RunnerError({
          message: `The accessibility engine answered in a shape we do not read: ${errorMessage(cause)}`,
        })
    )
  );

  const evaluated =
    report.counts.inapplicable +
    report.counts.incomplete +
    report.counts.passes +
    report.counts.violations;
  if (evaluated === 0) {
    return yield* new RunnerError({
      message: `The accessibility ruleset selected no rules to run: ${tags.join(", ")}.`,
    });
  }

  return {
    axeVersion: raw.testEngine.version,
    elided: report.violations.flatMap((violation) =>
      violation.nodeCount <= AUDIT_NODE_SAMPLE_CAP
        ? []
        : [
            {
              reported: AUDIT_NODE_SAMPLE_CAP,
              rule: violation.id,
              severity: violation.impact,
              stepIndex,
              total: violation.nodeCount,
            } satisfies ElidedFindings,
          ]
    ),
    findings: report.violations.flatMap((violation) =>
      violation.nodes.slice(0, AUDIT_NODE_SAMPLE_CAP).map((node) => ({
        ...(violation.helpUrl === undefined
          ? {}
          : { helpUrl: violation.helpUrl }),
        message: node.failureSummary ?? violation.help,
        rule: violation.id,
        severity: violation.impact,
        stepIndex,
        target: renderAuditTarget(node.target),
      }))
    ),
  } satisfies AuditResult;
});

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

/**
 * Whether a condition holds — `true`, `false`, or a reason it could not be
 * established at all.
 *
 * The third case is kept separate on purpose. An unanswerable condition is not
 * evidence that the interference was absent, and recording it as `skipped`
 * would claim evidence the Run does not have (ADR 0009).
 *
 * A visible candidate settles a visibility condition on its own; `false`
 * requires every candidate to have answered.
 */
type ConditionOutcome = boolean | { readonly reason: string };

const conditionHolds = Effect.fn("Runner.conditionHolds")(
  function* conditionHolds<C extends Condition>(
    execution: ReplayExecution,
    when: C,
    pageIndex: number | undefined
  ) {
    const located = yield* Effect.result(
      pageFor(execution, pageIndex, DEFAULT_ACTION_TIMEOUT_MS)
    );
    if (located._tag === "Failure") {
      return { reason: located.failure.message } satisfies ConditionOutcome;
    }
    const page = located.success;

    if (when.type === "urlMatches") {
      const pattern = yield* compilePattern(when.pattern);
      return pattern.test(page.url()) satisfies ConditionOutcome;
    }

    let unanswered = "";
    for (const descriptor of when.target) {
      const outcome = yield* Effect.result(
        Effect.tryPromise({
          catch: (cause: unknown) => cause,
          try: () => locatorFor(page, descriptor).isVisible(),
        })
      );
      if (outcome._tag === "Failure") {
        unanswered = errorMessage(outcome.failure);
        continue;
      }
      if (when.type === "selectorVisible") {
        if (outcome.success) {
          return true satisfies ConditionOutcome;
        }
      } else if (outcome.success) {
        // selectorHidden: the interference the Pre-step clears is present.
        return false satisfies ConditionOutcome;
      }
    }
    // One candidate answering does not settle the condition while another went
    // unanswered: alternatives can match different elements.
    if (unanswered !== "") {
      return {
        reason: `Could not evaluate this condition: ${unanswered}`,
      } satisfies ConditionOutcome;
    }
    return (when.type !== "selectorVisible") satisfies ConditionOutcome;
  }
);

/**
 * Wait until a `waitFor` Step's condition holds, bounded by the Step's own
 * timeout. Timing out fails the Step: unlike a Pre-step's condition, waiting
 * is what this Step exists to do.
 */
const waitUntilCondition = Effect.fn("Runner.waitUntilCondition")(
  function* waitUntilCondition(page: Page, when: Condition, timeoutMs: number) {
    if (when.type === "urlMatches") {
      const pattern = yield* compilePattern(when.pattern);
      const outcome = yield* Effect.result(
        Effect.tryPromise({
          catch: (cause: unknown) => cause,
          try: () => page.waitForURL(pattern, { timeout: timeoutMs }),
        })
      );
      if (outcome._tag === "Failure") {
        return yield* new RunnerError({
          kind: "flowError",
          message: `This waitFor Step timed out after ${timeoutMs}ms waiting for a URL matching "${when.pattern}".`,
        });
      }
      return;
    }

    if (when.type === "selectorVisible") {
      yield* throughLadder(page, when.target, (locator) =>
        locator.waitFor({ state: "visible", timeout: timeoutMs })
      ).pipe(
        Effect.mapError(
          (cause) =>
            new RunnerError({
              kind: cause instanceof RunnerError ? cause.kind : undefined,
              message: `This waitFor Step timed out after ${timeoutMs}ms waiting for a visible target. ${cause.message}`,
            })
        )
      );
      return;
    }

    // selectorHidden: poll until nothing the target names is visible.
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let anyVisible = false;
      let unanswered = "";
      for (const descriptor of when.target) {
        const outcome = yield* Effect.result(
          Effect.tryPromise({
            catch: (cause: unknown) => cause,
            try: () => locatorFor(page, descriptor).isVisible(),
          })
        );
        if (outcome._tag === "Failure") {
          unanswered = errorMessage(outcome.failure);
          continue;
        }
        if (outcome.success) {
          anyVisible = true;
          break;
        }
      }
      // An unanswered candidate keeps the wait unsettled rather than
      // satisfied: alternatives can name different elements, so the
      // interference may be the one that could not be read.
      if (!anyVisible && unanswered === "") {
        return;
      }
      if (Date.now() >= deadline) {
        return yield* new RunnerError({
          kind: "flowError",
          message: `This waitFor Step timed out after ${timeoutMs}ms waiting for its target to hide.${
            unanswered === "" ? "" : ` Last reason: ${unanswered}`
          }`,
        });
      }
      yield* Effect.sleep(WAIT_POLL_MS);
    }
  }
);

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

const executeNavigation = Effect.fn("Runner.executeNavigation")(
  function* executeNavigation(
    execution: ReplayExecution,
    step: Extract<AuthoredStep, { readonly type: "navigate" }>,
    resolvedUrl: string,
    timeoutMs: number
  ) {
    const url = yield* normalizeUrl(resolvedUrl);
    const page = yield* pageFor(execution, step.page, timeoutMs);
    const navigationDeadline = Date.now() + timeoutMs;
    const response = yield* Effect.tryPromise({
      catch: (cause) => new RunnerError({ message: errorMessage(cause) }),
      try: () => page.goto(url, { timeout: timeoutMs, waitUntil: "load" }),
    });
    const idleTimeout = Math.min(
      NAVIGATION_IDLE_BOUND_MS,
      Math.max(0, navigationDeadline - Date.now())
    );
    if (idleTimeout > 0) {
      // Most pages become idle and their response-driven UI is then ready for
      // the next Step. Polling, analytics, and long-lived connections do not:
      // they consume this bound and proceed after load instead of making a
      // valid Flow fail forever.
      yield* Effect.tryPromise(() =>
        page.waitForLoadState("networkidle", { timeout: idleTimeout })
      ).pipe(Effect.ignore);
    }
    // A server error still navigates, so the Step would otherwise pass and
    // the Flow would fail later on a locator missing only because this is an
    // error page. That misreads a broken site as a stale Flow.
    const status = response?.status();
    execution.measuredPage = page;
    if (status !== undefined && status >= HTTP_ERROR_STATUS) {
      return yield* new RunnerError({
        kind: "siteError",
        message: `The site under test failed: the server answered this navigation with HTTP ${status}.`,
      });
    }
    return NO_FINDINGS;
  }
);

/**
 * Replay one Step, returning whatever it found. Only an Audit Step finds
 * anything; every other Step returns none.
 */
const executeStep = Effect.fn("Runner.executeStep")(function* executeStep(
  execution: ReplayExecution,
  step: AuthoredStep,
  index: number
) {
  const resolve = (value: string): string =>
    substituteVariables(value, execution.variables.values);

  if (step.type === "audit") {
    // An Audit runs where its author put it, which is the whole reason Audits
    // are ordered Steps rather than a crawl: the page behind a login and four
    // interactions is reachable no other way (ADR 0005). The Flow names no
    // Page for an Audit, so it reads wherever the Flow currently is.
    const current = execution.pages.at(-1);
    if (current === undefined) {
      return yield* new RunnerError({
        message: "There is no page for this Audit to read.",
      });
    }
    return yield* runAudit(
      current,
      execution.pages,
      accessibilityRuleTags,
      index
    );
  }

  const actionTimeoutMs =
    step.timeout === undefined ? DEFAULT_ACTION_TIMEOUT_MS : step.timeout;
  const navigationTimeoutMs =
    step.timeout === undefined ? DEFAULT_NAVIGATION_TIMEOUT_MS : step.timeout;

  if (step.type === "navigate") {
    return yield* executeNavigation(
      execution,
      step,
      resolve(step.url),
      navigationTimeoutMs
    );
  }

  const page = yield* pageFor(execution, step.page, actionTimeoutMs);

  switch (step.type) {
    case "click": {
      yield* throughLadder(page, step.target, (locator) =>
        locator.click({
          button: step.button ?? "left",
          timeout: actionTimeoutMs,
        })
      );
      return NO_FINDINGS;
    }
    case "change": {
      yield* throughLadder(page, step.target, (locator) =>
        locator.fill(resolve(step.value), { timeout: actionTimeoutMs })
      );
      return NO_FINDINGS;
    }
    case "hover": {
      yield* throughLadder(page, step.target, (locator) =>
        locator.hover({ timeout: actionTimeoutMs })
      );
      return NO_FINDINGS;
    }
    case "selectOption": {
      yield* throughLadder(page, step.target, (locator) =>
        locator.selectOption([...step.values], { timeout: actionTimeoutMs })
      );
      return NO_FINDINGS;
    }
    case "keyDown":
    case "keyUp": {
      // A target focuses first, so a keystroke typed into a field lands there.
      // Playwright remembers a held modifier across later events itself, so a
      // keyDown Step covers everything dispatched until its keyUp pair.
      if (step.target !== undefined) {
        yield* throughLadder(page, step.target, (locator) =>
          locator.focus({ timeout: actionTimeoutMs })
        );
      }
      yield* Effect.tryPromise({
        catch: (cause) => new RunnerError({ message: errorMessage(cause) }),
        try: () =>
          step.type === "keyDown"
            ? page.keyboard.down(step.key)
            : page.keyboard.up(step.key),
      });
      return NO_FINDINGS;
    }
    case "press": {
      const pressed =
        step.target === undefined
          ? Effect.tryPromise({
              catch: (cause) =>
                new RunnerError({ message: errorMessage(cause) }),
              try: () => page.keyboard.press(step.key),
            })
          : throughLadder(page, step.target, (locator) =>
              locator.press(step.key, { timeout: actionTimeoutMs })
            );
      yield* pressed;
      return NO_FINDINGS;
    }
    case "scroll": {
      yield* Effect.tryPromise({
        catch: (cause) => new RunnerError({ message: errorMessage(cause) }),
        try: () => page.mouse.wheel(step.deltaX ?? 0, step.deltaY ?? 0),
      });
      return NO_FINDINGS;
    }
    case "waitFor": {
      yield* waitUntilCondition(page, step.condition, actionTimeoutMs);
      return NO_FINDINGS;
    }
    default: {
      throw new Error("Unknown Step kind.");
    }
  }
});

/**
 * Attach Core Web Vitals to the Step that navigated, reading its page at the
 * last moment the Run is on it. A measurement that cannot be taken does not
 * fail anything: the Flow toggled the Step, and the absence of vitals in the
 * persisted Run is visible on its own.
 */
const measurePending = Effect.fn("Runner.measurePending")(
  function* measurePending(
    execution: ReplayExecution,
    steps: RunStep[],
    pending: number | undefined
  ) {
    if (pending === undefined) {
      return;
    }
    const recorded = steps[pending];
    if (recorded === undefined) {
      return;
    }
    const collected = yield* Effect.result(collectVitals(execution));
    if (collected._tag === "Failure") {
      return;
    }
    steps[pending] = { ...recorded, vitals: collected.success };
  }
);

/**
 * The machine this Run measures on. Core Web Vitals are unthrottled, so a
 * Baseline recorded on a laptop and compared against a busy CI runner reads as
 * a Regression caused entirely by hardware (ADR 0008).
 */
const describeEnvironment = (): RunEnvironment => {
  const processors = cpus();
  return {
    architecture: arch(),
    cpuCount: processors.length,
    cpuModel: processors.at(0)?.model ?? "unknown",
    loadAverage: loadavg().at(0) ?? 0,
    memoryBytes: totalmem(),
    navigationReadiness: "load-then-bounded-network-idle",
    platform: platform(),
  };
};

/**
 * Whether a Pre-step's condition holds. An unanswerable condition stays
 * distinct from a false one, so a skipped Pre-step never claims evidence the
 * Run does not have.
 */
const evaluatePreStep = Effect.fn("Runner.evaluatePreStep")(
  function* evaluatePreStep(
    execution: ReplayExecution,
    preStep: PreStep,
    scope: RunPreStep["scope"],
    /** The Step this Pre-step clears the way for, if its action ever fails. */
    index: number,
    protectedPage: number | undefined
  ) {
    const base = { preStepId: preStep.id, scope } as const;
    const condition = yield* conditionHolds(
      execution,
      preStep.when,
      protectedPage
    );
    if (typeof condition === "object") {
      return { ...base, error: condition.reason, outcome: "failed" } as const;
    }
    if (!condition) {
      return { ...base, outcome: "skipped" } as const;
    }
    const outcome = yield* Effect.result(
      executeStep(execution, preStep.step, index)
    );
    if (outcome._tag === "Success") {
      return { ...base, outcome: "completed" } as const;
    }
    return {
      ...base,
      // A Pre-step can carry a Variable too, and a failure message can echo the
      // value it typed, so the message is redacted before it reaches the Run.
      error: redactSecrets(outcome.failure.message, execution.variables),
      outcome: "failed",
      ...redactedSelector(outcome.failure, execution.variables),
    } as const;
  }
);

/**
 * The Pre-steps to evaluate before one Step, in evaluation order. Flow-level
 * Pre-steps clear interference that can appear anywhere, so they run before
 * every Step — including Audit Steps (ADR 0005) — except the first: a Run
 * opens on a blank page, so there is nothing for a condition to read before
 * the Flow's own opening navigation.
 */
const preStepsFor = (
  flow: Flow,
  step: AuthoredStep,
  index: number
): readonly (readonly [PreStep, RunPreStep["scope"]])[] => {
  if (index === 0) {
    return [];
  }
  const flowLevel = (flow.preSteps ?? []).map(
    (preStep) => [preStep, "flow"] as const
  );
  const stepLevel = (step.preSteps ?? []).map(
    (preStep) => [preStep, "step"] as const
  );
  return [...flowLevel, ...stepLevel];
};

interface AttemptResult {
  readonly failure: RunFailure | undefined;
  /**
   * The context's cookies and storage as a completed attempt left them, for a
   * Flow that opted into persisted state (ADR 0015). A failed or interrupted
   * attempt saves nothing: half of a login is not state worth carrying.
   */
  readonly savedState: BrowserStorageState | undefined;
}

/**
 * Whether one stored cookie could survive Playwright's own validation when the
 * context opens. A snapshot that fails there would fail every later Run of the
 * Flow at `newContext` — a failed Run never writes a replacement, so the bad
 * file would brick the Flow until someone deleted it by hand. Rejecting it
 * here keeps the promise below: an unrestorable snapshot is no snapshot.
 */
const isRestorableCookie = (entry: unknown): boolean => {
  if (typeof entry !== "object" || entry === null) {
    return false;
  }
  return (
    "name" in entry &&
    typeof entry.name === "string" &&
    "value" in entry &&
    typeof entry.value === "string" &&
    (("url" in entry && typeof entry.url === "string") ||
      ("domain" in entry &&
        typeof entry.domain === "string" &&
        "path" in entry &&
        typeof entry.path === "string"))
  );
};

/**
 * What a previous Run of this Flow wrote, if it parses as one. A snapshot is a
 * courtesy and not a contract: anything unreadable — absent on a first Run,
 * truncated, written by another era — restores as nothing, and the Run starts
 * fresh rather than failing.
 */
const parseStoredState = (contents: string): BrowserStorageState | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return null;
  }
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "cookies" in parsed &&
    Array.isArray(parsed.cookies) &&
    parsed.cookies.every(isRestorableCookie) &&
    (!("origins" in parsed) || Array.isArray(parsed.origins))
  ) {
    return parsed as BrowserStorageState;
  }
  return null;
};

const readStoredState = (
  fileSystem: FileSystem.FileSystem,
  statePath: string
): Effect.Effect<BrowserStorageState | null> =>
  fileSystem.readFileString(statePath).pipe(
    Effect.map(parseStoredState),
    Effect.orElseSucceed(() => null)
  );

/**
 * Fold the Run's ceiling outcome into its attempts. A Run that ran out of time
 * is still a Run: the interrupted attempt is recorded from however far it got,
 * and the ceiling breach — which belongs to no single Step — becomes the Run's
 * own unattributed failure.
 */
const accountForCeiling = (
  attempts: RunAttempt[],
  timedOut: boolean,
  ceiling: Duration.Duration,
  finishedAt: Date,
  inFlight: { attempt: number; startedAt: Date; steps: RunStep[] } | undefined,
  retry: number
): RunFailure | undefined => {
  const timeoutFailure: RunFailure = {
    message: `The Run exceeded its ${Duration.format(ceiling)} ceiling during attempt ${inFlight?.attempt ?? attempts.length} of ${retry + 1}.`,
  };
  if (timedOut) {
    attempts.push({
      attempt: inFlight?.attempt ?? attempts.length + 1,
      failure: timeoutFailure,
      finishedAt: finishedAt.toISOString(),
      outcome: "failed",
      startedAt: (inFlight?.startedAt ?? finishedAt).toISOString(),
      steps: inFlight?.steps ?? [],
    });
    return timeoutFailure;
  }
  return attempts.at(-1)?.failure;
};

/**
 * A Finding describes an element on the page, and the engine builds its target
 * from whatever attribute makes that element unique. Both fields the engine
 * renders from the page go through the same redaction a failure message does,
 * because a Variable interpolated into a URL reaches the target verbatim.
 */
const redactFinding = (finding: Finding, variables: VariableResolution) => ({
  ...finding,
  message: redactSecrets(finding.message, variables),
  target: redactSecrets(finding.target, variables),
});

/** The last line a failing tool wrote, which says what went wrong. */
const reportable = (message: string): string => {
  const lines = message
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines.at(-1) ?? message;
};

const deriveVideoSegment = Effect.fn("Runner.deriveVideoSegment")(
  function* deriveVideoSegment(
    capture: ArtifactCapture,
    videoFile: string,
    steps: readonly RunStep[],
    attempt: number,
    prepared: PreparedTraceArtifacts | undefined,
    traceError: string | undefined
  ) {
    const stepIndexes = steps.map((step) => step.index);
    const hasEveryStepFrame = stepIndexes.every((index) =>
      capture.stepFrames.has(index)
    );
    const { settledFrame } = capture;
    const hasEveryFrame = hasEveryStepFrame && settledFrame !== undefined;
    const derived =
      prepared !== undefined && hasEveryFrame
        ? yield* Effect.result(
            deriveVideoFromTrace(prepared, videoFile, stepIndexes)
          )
        : undefined;
    let videoError: string | undefined;
    if (!hasEveryStepFrame) {
      videoError = "The Trace did not capture a frame for every Step.";
    } else if (settledFrame === undefined) {
      videoError = "The Trace did not capture the final settled state.";
    } else if (derived === undefined) {
      videoError = traceError ?? "The Trace was unavailable.";
    } else if (derived._tag === "Failure") {
      videoError = reportable(errorMessage(derived.failure));
    }
    return {
      attempt,
      ...(videoError === undefined ? {} : { error: videoError }),
      file: path.basename(videoFile),
      includesSettledState:
        derived?._tag === "Success" && derived.success.includesSettledState,
      recorded: derived?._tag === "Success",
      steps: derived?._tag === "Success" ? [...derived.success.steps] : [],
    } satisfies RunVideoSegment;
  }
);

/**
 * Stop one attempt's Trace while its context is still open. Rewriting and
 * video encoding happen only after the browser context has closed.
 */
const stopTrace = Effect.fn("Runner.stopTrace")(function* stopTrace(
  context: BrowserContext,
  capture: ArtifactCapture
) {
  const stopped = yield* Effect.result(
    Effect.tryPromise({
      catch: (cause) => new Error(errorMessage(cause)),
      try: () => context.tracing.stop({ path: capture.traceFile }),
    })
  );
  const checked =
    stopped._tag === "Failure"
      ? stopped
      : yield* Effect.result(
          Effect.tryPromise({
            catch: (cause) => new Error(errorMessage(cause)),
            try: () => traceWasWritten(capture.traceFile),
          })
        );
  const recorded = checked._tag === "Success" && checked.success === true;
  let error: string | undefined;
  if (checked._tag === "Failure") {
    error = reportable(errorMessage(checked.failure));
  } else if (!recorded) {
    error = "Playwright wrote no Trace.";
  }
  return { error, recorded };
});

/**
 * Scrub and enrich one stopped Trace in a single archive rewrite, then derive
 * its optional video. Artifact failures never change the Run outcome.
 */
const saveArtifacts = Effect.fn("Runner.saveArtifacts")(function* saveArtifacts(
  capture: ArtifactCapture,
  variables: VariableResolution,
  steps: readonly RunStep[],
  attempt: number,
  stopped: { readonly error: string | undefined; readonly recorded: boolean }
) {
  let prepared: PreparedTraceArtifacts | undefined;
  let prepareError: string | undefined;
  if (stopped.recorded) {
    const secrets = [...variables.secretNames].flatMap((name) => {
      const value = variables.values.get(name);
      return value === undefined ? [] : [value];
    });
    const stepIndexes = steps.map((step) => step.index);
    const settled = capture.settledFrame;
    const hasVideoFrames =
      capture.videoFile !== undefined &&
      settled !== undefined &&
      stepIndexes.every((index) => capture.stepFrames.has(index));
    const result = yield* Effect.result(
      prepareTraceArtifacts(
        capture.traceFile,
        secrets,
        hasVideoFrames ? { settled, steps: capture.stepFrames } : undefined
      )
    );
    if (result._tag === "Success") {
      prepared = result.success;
    } else {
      prepareError = reportable(errorMessage(result.failure));
    }
  }

  if (capture.keepTrace) {
    capture.traceSegments.push({
      attempt,
      ...(stopped.error === undefined ? {} : { error: stopped.error }),
      file: path.basename(capture.traceFile),
      recorded: stopped.recorded,
    });
  }

  if (capture.videoFile !== undefined) {
    capture.videoSegments.push(
      yield* deriveVideoSegment(
        capture,
        capture.videoFile,
        steps,
        attempt,
        prepared,
        prepareError ?? stopped.error
      )
    );
  }

  if (!capture.keepTrace) {
    yield* Effect.promise(() => rm(capture.traceFile, { force: true })).pipe(
      Effect.ignore
    );
  }
});

/**
 * What runs in the Page to establish DOM stability: resolve once the document
 * has gone `windowMs` without a mutation — or once `boundMs` has passed
 * altogether, whichever comes first. A mutation inside the window resets it
 * rather than ending the wait; a page that never goes quiet still ends the
 * wait. Resolving is guarded, because both timers are always armed.
 *
 * Interpolated rather than parameterised: Playwright evaluates a plain-string
 * expression verbatim, so the values travel in the text.
 */
const domStabilityScript = (
  windowMs: number,
  boundMs: number
): string => `(() => {
  const result = Promise.withResolvers();
  let settled = false;
  let timer;
  const finish = (quiet) => {
    if (!settled) {
      settled = true;
      result.resolve(quiet);
    }
  };
  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => finish(true), ${windowMs});
  });
  observer.observe(document, {
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  setTimeout(() => finish(false), ${boundMs});
  timer = setTimeout(() => finish(true), ${windowMs});
  return result.promise;
})()`;

/**
 * Wait for a Page to go quiet — no requests in flight, a DOM that has stopped
 * changing — under one shared bound (ADR 0015). Never throws: a Page that
 * never settles costs the bound and loses the argument, and a Page that died
 * mid-wait has nothing left to settle. This is teardown-adjacent, so it is
 * plain async and sits outside the attempt's error paths on purpose.
 */
const settlePage = async (page: Page | undefined): Promise<void> => {
  if (page === undefined || page.isClosed()) {
    return;
  }
  const deadline = Date.now() + QUIESCE_BOUND_MS;
  try {
    await page.waitForLoadState("networkidle", { timeout: QUIESCE_BOUND_MS });
  } catch {
    // The bound expired or the Page died; either way this wait is over.
  }
  const remaining = deadline - Date.now();
  if (remaining <= 0 || page.isClosed()) {
    return;
  }
  try {
    await page.evaluate(domStabilityScript(DOM_STABLE_WINDOW_MS, remaining));
  } catch {
    // Same: a Page gone mid-wait has nothing left to settle.
  }
};

/** Capture the committed Page even when a navigation is still pending. */
const capturePageScreenshot = (
  page: Page,
  timeout: number
): Effect.Effect<Buffer, unknown> =>
  Effect.tryPromise(() => page.screenshot({ timeout, type: "jpeg" })).pipe(
    Effect.catchCause(() =>
      Effect.tryPromise(() => page.context().newCDPSession(page)).pipe(
        Effect.timeout(Duration.millis(500)),
        Effect.flatMap((session) =>
          Effect.tryPromise(() =>
            session.send("Page.captureScreenshot", { format: "jpeg" })
          ).pipe(
            Effect.timeout(Duration.millis(500)),
            Effect.map((screenshot) => Buffer.from(screenshot.data, "base64")),
            Effect.ensuring(
              Effect.tryPromise(() => session.detach()).pipe(
                Effect.timeout(Duration.millis(250)),
                Effect.ignore
              )
            )
          )
        )
      )
    )
  );

const settleAndCapture = Effect.fn("Runner.settleAndCapture")(
  function* settleAndCapture(
    page: Page | undefined,
    capture: ArtifactCapture | undefined
  ) {
    yield* Effect.promise(() => settlePage(page));
    if (
      capture?.videoFile === undefined ||
      page === undefined ||
      page.isClosed()
    ) {
      return;
    }
    const frame = yield* Effect.result(capturePageScreenshot(page, 1000));
    capture.settledFrame = frame._tag === "Success" ? frame.success : undefined;
  }
);

/**
 * Where an attempt records the accessibility engine's version. Caller-owned
 * like the Steps, so a version an earlier Audit established survives a later
 * Step's failure or a ceiling breach: an attempt that audited anything records
 * its engine, completed or not (ADR 0017).
 */
interface AuditEngine {
  version: string | undefined;
}

/**
 * Replay the whole Flow once in a browser context of its own. A failed Step
 * aborts the attempt rather than continuing against a page state the Flow
 * never described (ADR 0009). Teardown flushes its Trace before closing.
 */
const attemptRun = Effect.fn("Runner.attemptRun")(function* attemptRun(
  browser: Browser,
  flow: Flow,
  variables: VariableResolution,
  /** Caller-owned, so the Steps done so far survive an interrupted attempt. */
  steps: RunStep[],
  engine: AuditEngine,
  capture: ArtifactCapture | undefined,
  /**
   * Storage state saved by an earlier Run of this Flow, for one that opted
   * into persisted state (ADR 0015). Null — the default — is a fresh context:
   * nothing the last Run left behind leaks into this one.
   */
  restoredState: BrowserStorageState | null,
  attempt: number
) {
  let failure: RunFailure | undefined;
  const measures = flow.steps.some(measuresPerformance);
  /** Set once every Step has run and the Page has had its chance to settle. */
  let completed = false;
  let lastActedOn: Page | undefined;
  let savedState: BrowserStorageState | undefined;

  /**
   * Open a context, restoring the given state when it carries one.
   */
  const openContext = (state: BrowserStorageState | null) =>
    Effect.tryPromise({
      catch: (cause) =>
        new RunnerError({
          message: `Could not open a browser context: ${errorMessage(cause)}`,
        }),
      try: () =>
        browser.newContext({
          deviceScaleFactor: RUN_VIEWPORT.deviceScaleFactor,
          ...(state === null ? {} : { storageState: state }),
          viewport: {
            height: RUN_VIEWPORT.height,
            width: RUN_VIEWPORT.width,
          },
        }),
    });

  yield* Effect.acquireUseRelease(
    Effect.gen(function* openAttemptContext() {
      // The parse-time guard is a fast fail on obvious junk, but it cannot
      // mirror Playwright's own validation — the schema moves, and state files
      // outlive the binary that wrote them. So the backstop lives here: a
      // snapshot that survives parsing but not `newContext` costs one failed
      // open and nothing more, and this attempt starts fresh instead. The Run
      // that completes then writes a good snapshot over the bad one.
      const context = yield* restoredState === null
        ? openContext(null)
        : openContext(restoredState).pipe(
            Effect.catch(() => openContext(null))
          );
      if (capture !== undefined) {
        yield* Effect.tryPromise({
          catch: (cause) =>
            new RunnerError({
              message: `Could not start the Trace: ${errorMessage(cause)}`,
            }),
          try: () =>
            context.tracing.start({
              screenshots: true,
              snapshots: true,
              sources: false,
              title: `Attempt ${attempt}`,
            }),
        });
      }
      // Interactions cannot be read back after the fact, so a Run that might
      // measure anything records from the first navigation onwards — on every
      // Page this context opens, popups included.
      if (measures) {
        // Arming cannot fail the attempt: the Run still executes, and a
        // context that never armed reports no vitals at all — which the CLI's
        // unmeasured-Steps warning makes visible.
        yield* Effect.ignore(
          Effect.tryPromise({
            catch: (cause) =>
              new Error(
                `Could not arm Core Web Vitals recording: ${errorMessage(cause)}`
              ),
            try: () => context.addInitScript(VITALS_RECORDER),
          })
        );
      }
      const page = yield* Effect.tryPromise({
        catch: (cause) =>
          new RunnerError({
            message: `Could not open a page: ${errorMessage(cause)}`,
          }),
        try: () => context.newPage(),
      });
      const execution: ReplayExecution = {
        measuredPage: undefined,
        pages: [page],
        variables,
      };
      // Popups and new tabs join the Page registry in the order they opened,
      // which is exactly the identity a Step names.
      context.on("page", (opened) => {
        execution.pages.push(opened);
      });
      return { context, execution } satisfies AttemptSession;
    }),
    ({ execution }) =>
      Effect.gen(function* replayFlow() {
        [lastActedOn] = execution.pages;
        /**
         * Index in `steps` of a Step whose page has not been measured yet.
         */
        let pending: number | undefined;
        /**
         * The Page the current Step names — the first, when none does —
         * resolved as each Step begins, so the Run settles where its final
         * Step acted. A popup that the final Step itself opens is not yet a
         * named Page of any Step, and is not what settles the Run; a later
         * Step that names it would be. Deliberate: the bound covers the rest
         * (ADR 0015).
         */
        for (const [index, step] of flow.steps.entries()) {
          const stepStartedAt = yield* nowIso;

          const preSteps: RunPreStep[] = [];
          for (const [preStep, scope] of preStepsFor(flow, step, index)) {
            preSteps.push(
              yield* evaluatePreStep(
                execution,
                preStep,
                scope,
                index,
                pageIndexOf(step)
              )
            );
          }

          // Leaving this page ends what there is to measure on it, so a Step
          // still awaiting measurement is read now — after Pre-steps, whose
          // actions are interactions on this page like any other.
          if (stepNavigates(step)) {
            yield* measurePending(execution, steps, pending);
            pending = undefined;
          }

          lastActedOn =
            execution.pages[pageIndexOf(step) ?? 0] ?? execution.pages[0];

          const outcome = yield* Effect.result(
            executeStep(execution, step, index)
          );
          const stepFinishedAt = yield* nowIso;
          const actedOn = lastActedOn;
          if (capture?.videoFile !== undefined && actedOn !== undefined) {
            // This action creates an explicit screenshot boundary in the
            // Trace. Video derivation selects these in executed Step order.
            const frame = yield* Effect.result(
              capturePageScreenshot(actedOn, DEFAULT_ACTION_TIMEOUT_MS)
            );
            if (frame._tag === "Success") {
              capture.stepFrames.set(index, frame.success);
            }
          }
          const base = {
            finishedAt: stepFinishedAt.toISOString(),
            index,
            ...(preSteps.length === 0 ? {} : { preSteps }),
            startedAt: stepStartedAt.toISOString(),
            type: step.type,
            ...(step.id === undefined ? {} : { stepId: step.id }),
          };

          if (outcome._tag === "Success") {
            if (measuresPerformance(step)) {
              pending = steps.length;
            }
            engine.version = outcome.success.axeVersion ?? engine.version;
            steps.push({
              ...base,
              ...(outcome.success.findings.length === 0
                ? {}
                : {
                    findings: outcome.success.findings.map((finding) =>
                      redactFinding(finding, variables)
                    ),
                  }),
              ...(outcome.success.elided.length === 0
                ? {}
                : {
                    elidedFindings: outcome.success.elided.map((rule) => ({
                      ...rule,
                      stepIndex: index,
                    })),
                  }),
              outcome: "completed",
            } satisfies RunStep);
            continue;
          }

          // A browser message can echo a value typed into a field, so it is
          // redacted before it reaches the Run.
          const message = redactSecrets(outcome.failure.message, variables);
          const kind = classifyStepFailure(outcome.failure.kind, message);

          steps.push({
            ...base,
            error: message,
            outcome: "failed",
            ...redactedSelector(outcome.failure, variables),
          });
          failure = {
            ...(kind === undefined ? {} : { kind }),
            message,
            stepIndex: index,
          };
          // The navigation that was measured still happened, and a Flow that
          // fails at Step 9 should not lose the metrics from Step 2.
          yield* measurePending(execution, steps, pending);
          yield* settleAndCapture(lastActedOn, capture);
          return;
        }

        yield* measurePending(execution, steps, pending);

        // The Run ends only once its Page has gone quiet (ADR 0015). The Trace
        // stays live through this wait, and its final frame records that state.
        yield* settleAndCapture(lastActedOn, capture);
        completed = true;
      }),
    ({ context }) =>
      // A Run is torn down uninterruptibly so Ctrl-C cannot cut off Trace
      // finalization or context cleanup halfway through.
      Effect.gen(function* teardownAttempt() {
        // Read while the context can still answer. Only a completed attempt
        // contributes: a Run that failed partway must not overwrite the last
        // known-good state a Flow that depends on it relies on.
        if (
          flow.persistedState === true &&
          completed &&
          failure === undefined
        ) {
          const state = yield* Effect.result(
            Effect.tryPromise({
              catch: (cause) =>
                new Error(
                  `Could not read the browser storage state: ${errorMessage(cause)}`
                ),
              try: () => context.storageState(),
            })
          );
          if (state._tag === "Success") {
            savedState = state.success;
          }
        }
        if (
          capture?.videoFile !== undefined &&
          capture.settledFrame === undefined
        ) {
          yield* settleAndCapture(lastActedOn, capture);
        }
        const stopped =
          capture === undefined
            ? undefined
            : yield* stopTrace(context, capture);
        yield* Effect.tryPromise({
          catch: (cause) =>
            new RunnerError({
              message: `Could not close the browser context: ${errorMessage(cause)}`,
            }),
          try: () => context.close(),
        }).pipe(Effect.ignore);
        if (capture !== undefined && stopped !== undefined) {
          yield* saveArtifacts(capture, variables, steps, attempt, stopped);
        }
      })
  );

  return { failure, savedState } satisfies AttemptResult;
});

export const makeRunnerService = () =>
  Effect.gen(function* buildRunner() {
    const fileSystem = yield* FileSystem.FileSystem;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    // One Run at a time per process: concurrent Runs contend for CPU and
    // corrupt each other's measurements (ADR 0009).
    const runPermit = Semaphore.makeUnsafe(1);

    /**
     * The manifest is written even when every derivation failed. Someone
     * looking for a video needs the reason it is absent.
     */
    const writeVideoManifest = Effect.fn("Runner.writeVideoManifest")(
      function* writeVideoManifest(
        capture: boolean,
        directory: string,
        manifest: RunVideoManifest
      ) {
        if (!capture) {
          return;
        }
        yield* fileSystem
          .writeFileString(
            path.join(directory, "video.json"),
            `${JSON.stringify(manifest, null, 2)}\n`
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new RunnerError({
                  message: `Could not write the video manifest: ${errorMessage(cause)}`,
                })
            )
          );
      }
    );

    const writeTraceManifest = Effect.fn("Runner.writeTraceManifest")(
      function* writeTraceManifest(
        keepTrace: boolean,
        directory: string,
        manifest: RunTraceManifest
      ) {
        if (!keepTrace) {
          return;
        }
        yield* fileSystem
          .writeFileString(
            path.join(directory, "trace.json"),
            `${JSON.stringify(manifest, null, 2)}\n`
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new RunnerError({
                  message: `Could not write the Trace manifest: ${errorMessage(cause)}`,
                })
            )
          );
      }
    );

    const persist = Effect.fn("Runner.persist")(function* persist(
      record: Run,
      outputDirectory: string,
      startedAt: Date
    ) {
      const directory = runDirectory(
        outputDirectory,
        record.flowId,
        startedAt,
        record.runId
      );
      yield* fileSystem.makeDirectory(directory, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new RunnerError({
              message: `Could not create the Run directory: ${errorMessage(cause)}`,
            })
        )
      );
      yield* fileSystem
        .writeFileString(
          path.join(directory, "run.json"),
          `${JSON.stringify(record, null, 2)}\n`
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new RunnerError({
                message: `Could not write the Run: ${errorMessage(cause)}`,
              })
          )
        );
      return { directory, run: record } satisfies RunResult;
    });

    const run = (flow: Flow, options: RunnerRunOptions) =>
      runPermit
        .withPermit(
          Effect.gen(function* executeRun() {
            const variables = options.variables ?? NO_VARIABLES;
            const retry = Math.max(
              0,
              Math.trunc(options.retry ?? DEFAULT_RETRY)
            );
            const runId = randomUUID();
            const flowHash = hashFlow(flow);
            const flowId = flowIdentity(flow, flowHash);
            const startedAt = yield* nowIso;
            const environment = describeEnvironment();
            // Read once, before anything runs: a ceiling declared by the Flow
            // stands unless the invocation overrides it.
            const ceiling =
              options.timeout ??
              (flow.timeout === undefined
                ? DEFAULT_TIMEOUT
                : Duration.millis(flow.timeout));

            const directory = runDirectory(
              options.outputDirectory,
              flowId,
              startedAt,
              runId
            );

            /**
             * The artifact directory exists before tracing begins, and both
             * manifest finalizers register before replay. An interrupted Run
             * still accounts for every artifact it did or did not produce.
             */
            const keepTrace = options.trace ?? true;
            const makeVideo = options.video === true;
            const capture = keepTrace || makeVideo;
            if (capture) {
              yield* fileSystem
                .makeDirectory(directory, { recursive: true })
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new RunnerError({
                        message: `Could not create the Run directory: ${errorMessage(cause)}`,
                      })
                  )
                );
            }
            const traceSegments: RunTraceSegment[] = [];
            const videoSegments: RunVideoSegment[] = [];
            const traceManifest = writeTraceManifest(keepTrace, directory, {
              // Exact values are scrubbed from readable entries where
              // possible, but DOM snapshots and payloads make completeness
              // unprovable. This flag remains the upload gate (ADR 0014).
              containsSecrets: variables.secretNames.size > 0,
              runId,
              scrubbing: "best-effort",
              segments: traceSegments,
            }).pipe(Effect.ignore);
            const videoManifest = writeVideoManifest(makeVideo, directory, {
              containsSecrets: variables.secretNames.size > 0,
              runId,
              segments: videoSegments,
            }).pipe(Effect.ignore);
            yield* Effect.addFinalizer(() => traceManifest);
            yield* Effect.addFinalizer(() => videoManifest);

            const attempts: RunAttempt[] = [];
            let inFlight:
              | { attempt: number; startedAt: Date; steps: RunStep[] }
              | undefined;
            /** The saved state of the attempt that ran last, if it earned one. */
            let lastSavedState: BrowserStorageState | undefined;
            /**
             * The engine version of whichever attempt audited anything. The
             * version is pinned, so any attempt's answer is the Run's.
             */
            const engine: AuditEngine = { version: undefined };
            /**
             * Where this Flow's persisted browser state lives: one snapshot
             * beside its Run history, keyed by the Flow's identity (ADR 0015).
             */
            const statePath = path.join(
              flowRunsDirectory(options.outputDirectory, flow),
              "storage-state.json"
            );

            const replay = Effect.gen(function* replayUntilItHolds() {
              // A Flow that opted into persisted state starts from whatever
              // its last completed Run saved; every other Flow starts from
              // nothing, which is the default and stays the default.
              const restoredState =
                flow.persistedState === true
                  ? yield* readStoredState(fileSystem, statePath)
                  : null;
              // One Chromium process per Run, closed when it ends; each
              // attempt replays in a context of its own. Runs are
              // deliberately Chromium-only (ADR 0016).
              const browser = yield* Effect.acquireRelease(
                ensureChromiumInstalled.pipe(
                  Effect.mapError(
                    (failure) => new RunnerError({ message: failure.message })
                  ),
                  Effect.andThen(
                    Effect.tryPromise({
                      catch: (cause) =>
                        new RunnerError({
                          message: `Could not start Chromium: ${errorMessage(cause)}`,
                        }),
                      // Playwright installs process-wide SIGINT/SIGTERM/SIGHUP
                      // handlers of its own by default, which would force-exit the
                      // CLI mid-teardown instead of letting the unwind flush its
                      // Trace. Signals belong to the CLI's runtime alone.
                      try: () =>
                        chromium.launch({
                          handleSIGHUP: false,
                          handleSIGINT: false,
                          handleSIGTERM: false,
                          headless: true,
                        }),
                    })
                  )
                ),
                (launched) =>
                  Effect.tryPromise({
                    catch: () =>
                      new RunnerError({ message: "Chromium did not close." }),
                    try: () => launched.close(),
                  }).pipe(Effect.ignore)
              );
              for (let index = 0; index <= retry; index += 1) {
                const attemptStartedAt = yield* nowIso;
                const steps: RunStep[] = [];
                inFlight = {
                  attempt: index + 1,
                  startedAt: attemptStartedAt,
                  steps,
                };
                // A fresh context every time: a retry inside a context that has
                // already been navigated, cookied, and clicked is not a rerun of
                // the Flow, it is a rerun of whatever the last attempt left.
                const result = yield* attemptRun(
                  browser,
                  flow,
                  variables,
                  steps,
                  engine,
                  capture
                    ? {
                        keepTrace,
                        settledFrame: undefined,
                        stepFrames: new Map(),
                        traceFile: path.join(
                          directory,
                          keepTrace
                            ? `attempt-${index + 1}.trace.zip`
                            : `.attempt-${index + 1}.trace.zip`
                        ),
                        traceSegments,
                        videoFile: makeVideo
                          ? path.join(directory, `attempt-${index + 1}.webm`)
                          : undefined,
                        videoSegments,
                      }
                    : undefined,
                  restoredState,
                  index + 1
                ).pipe(
                  Effect.provideService(
                    ChildProcessSpawner.ChildProcessSpawner,
                    childProcessSpawner
                  )
                );
                lastSavedState = result.savedState;
                const attemptFinishedAt = yield* nowIso;
                inFlight = undefined;
                attempts.push({
                  attempt: index + 1,
                  ...(result.failure === undefined
                    ? {}
                    : { failure: result.failure }),
                  finishedAt: attemptFinishedAt.toISOString(),
                  outcome:
                    result.failure === undefined ? "completed" : "failed",
                  startedAt: attemptStartedAt.toISOString(),
                  steps,
                });

                if (result.failure === undefined) {
                  return;
                }
              }
            });

            // The ceiling covers replay only. A Run that ran out of time is still
            // a Run, and losing it would throw away everything it did establish.
            const timedOut = yield* replay.pipe(
              Effect.timeoutOption(ceiling),
              Effect.map((finished) => finished._tag === "None")
            );

            const finishedAt = yield* nowIso;
            const failure = accountForCeiling(
              attempts,
              timedOut,
              ceiling,
              finishedAt,
              inFlight,
              retry
            );

            const last = attempts.at(-1);

            // Persisting what the Run carried out is best-effort: a Run that
            // executed its Flow is a completed Run even if the snapshot for
            // the next one could not be written — the next one starts fresh.
            if (lastSavedState !== undefined) {
              yield* fileSystem
                .makeDirectory(path.dirname(statePath), { recursive: true })
                .pipe(Effect.ignore);
              yield* fileSystem
                .writeFileString(
                  statePath,
                  `${JSON.stringify(lastSavedState)}\n`
                )
                .pipe(Effect.ignore);
            }

            const record: Run = {
              attempts,
              environment: {
                ...environment,
                ...(engine.version === undefined
                  ? {}
                  : { axeVersion: engine.version }),
              },
              ...(failure === undefined ? {} : { failure }),
              finishedAt: finishedAt.toISOString(),
              flow,
              flowHash,
              flowId,
              outcome: failure === undefined ? "completed" : "failed",
              runId,
              startedAt: startedAt.toISOString(),
              steps: last?.steps ?? [],
              trace: keepTrace,
              video: makeVideo,
            };

            return yield* persist(record, options.outputDirectory, startedAt);
          })
        )
        .pipe(Effect.scoped);

    return Runner.of({ run });
  });

export const RunnerLive: Layer.Layer<
  RunnerService,
  never,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> = Layer.effect(Runner, makeRunnerService());

/** Decode a Flow file, failing with a message a developer can act on. */
export const decodeFlowDocument = Effect.fn("Runner.decodeFlowDocument")(
  function* decodeFlowDocument(contents: string, source: string) {
    const parsed = yield* Effect.try({
      catch: (cause) =>
        new RunnerError({
          message: `${source} is not valid JSON: ${errorMessage(cause)}`,
        }),
      try: () => JSON.parse(contents) as unknown,
    });

    return yield* Schema.decodeUnknownEffect(FlowSchema)(parsed).pipe(
      Effect.mapError(
        (cause) =>
          new RunnerError({
            message: `${source} is not a valid Flow: ${errorMessage(cause)}`,
          })
      )
    );
  }
);
