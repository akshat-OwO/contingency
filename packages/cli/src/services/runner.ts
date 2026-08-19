import { createHash, randomUUID } from "node:crypto";
import { arch, cpus, loadavg, platform, totalmem } from "node:os";
import path from "node:path";

import {
  accessibilityRuleTags,
  Flow as FlowSchema,
  stepNavigates,
  SessionId as SessionIdSchema,
} from "@contingency/protocol";
import type {
  BrowserRpcErrorType,
  Finding,
  RunEnvironment,
  Flow,
  FlowStep,
  PreStep,
  Run,
  RunAttempt,
  RunFailure,
  RunPreStep,
  RunStep,
  Selector,
  SessionId,
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

import { AgentBrowser, isElementNotFound } from "./agent-browser";
import type { AuditResult } from "./agent-browser";
import type { VariableResolution } from "./variables";
import { redactSecrets, substituteVariables } from "./variables";

/**
 * Run sessions replay a Flow, so they open at the Flow's own viewport rather
 * than a canvas-sized one. Headless is the browser's default; a Run never
 * enables streaming and never starts the recorder sidecar.
 */
const RUN_VIEWPORT = {
  deviceScaleFactor: 1,
  height: 800,
  width: 1280,
} as const;

export class RunnerError extends Data.TaggedError("RunnerError")<{
  /**
   * Who the failure belongs to, when the Runner knows. Only the Runner can
   * say: by the time a failure is a message, "no selector resolved" and "the
   * session died" read alike.
   */
  readonly kind?: RunFailure["kind"];
  readonly message: string;
}> {}

export interface RunnerRunOptions {
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
 * none — a plain Chrome Recorder export — falls back to its content hash,
 * which is stable and, unlike the title, not user-editable.
 */
export const flowIdentity = (flow: Flow, flowHash: string): string =>
  flow.contingency?.flowId ?? `sha256-${flowHash.slice(0, 16)}`;

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
 * `-<hash>`. Windows reserves device names such as `CON` and `LPT1` both bare
 * and with any extension, so `CON.txt` would otherwise keep a reserved stem
 * and fail to create after the Run had already executed.
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

const translateSelector = (selector: string): string | undefined => {
  if (selector.startsWith("xpath/")) {
    return selector.slice("xpath/".length);
  }
  if (selector.startsWith("pierce/")) {
    // A `pierce/` selector is a single CSS selector the browser resolves
    // through open shadow roots on its own.
    return selector.slice("pierce/".length);
  }
  if (selector.startsWith("text/")) {
    return `text=${selector.slice("text/".length)}`;
  }
  if (selector.startsWith("aria/")) {
    // No accessible-name selector engine is exposed, and guessing a role would
    // resolve the wrong element. Other candidates cover this Step.
    return undefined;
  }
  return selector;
};

/**
 * A Chrome Recorder Step carries several alternative selectors in priority
 * order. Most are a single selector; some are a **chain** that walks into a
 * shadow root, one element per hop.
 *
 * A chain is dropped rather than flattened to its last hop. The browser tool
 * resolves a selector against the current document, so a flattened chain does
 * not fail — it silently matches a same-named element elsewhere in the page
 * and acts on the wrong one. Verified against a fixture whose top-level decoy
 * and shadow child share an id: the flattened selector clicked the decoy.
 * A Step that offers only chains is unsupported and fails loudly.
 */
export const selectorCandidates = (selectors: Selector): readonly string[] => {
  const candidates: string[] = [];
  for (const entry of selectors) {
    const chain = typeof entry === "string" ? [entry] : [...entry];
    if (chain.length !== 1) {
      continue;
    }
    const [target] = chain;
    const translated =
      target === undefined ? undefined : translateSelector(target);
    if (translated !== undefined && !candidates.includes(translated)) {
      candidates.push(translated);
    }
  }
  return candidates;
};

const nowIso = Effect.sync(() => new Date());

/** The first status a site is answering with rather than serving a page. */
const HTTP_ERROR_STATUS = 400;

/**
 * agent-browser's own wording for a navigation that did not complete, verified
 * against the bundled binary: `Navigation failed: net::ERR_NAME_NOT_RESOLVED`.
 */
const NAVIGATION_FAILED = "Navigation failed:";

/**
 * Who a failed Step belongs to.
 *
 * A navigation that did not complete is the site's. Selector exhaustion is the
 * Flow's, and only the Runner can say that one: by the time a failure is a
 * message, "no selector resolved" and "the session died" read alike, which is
 * why the attribution travels on the error rather than being re-derived here.
 *
 * Everything else is left unattributed. A dead session, a browser-process
 * failure, or a click that landed wrong establishes nothing about whose fault
 * it is, and a guess routes it to someone who cannot act on it.
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
const measuresPerformance = (step: FlowStep): boolean =>
  step.type !== "customStep" &&
  step.contingency?.performance === true &&
  stepNavigates(step);

/**
 * Attach Core Web Vitals to the Step that navigated, reading the page at the
 * last moment the Run is on it — just before navigating away, or when the
 * attempt ends.
 *
 * Sampling the instant the navigation finishes would be wrong in two ways that
 * both understate the page. Layout shifts and larger paints keep arriving
 * after load, so CLS and LCP would be whatever had happened so far — verified
 * against the bundled binary, a shift 250ms in is missed entirely. And INP
 * would be structurally unmeasurable: a page nobody has interacted with yet
 * has no interaction to report, so every Run would record it as absent.
 *
 * A measurement that cannot be taken does not fail the Step. The Flow did its
 * work — the navigation happened and the page is there — and failing the Run
 * over a metric read would report a broken site on the strength of our own
 * inability to observe it. The absence is visible: the Flow says the Step was
 * toggled and the Run carries no vitals for it, which the CLI reports.
 */
const measurePending = Effect.fn("Runner.measurePending")(
  function* measurePending(
    { browser, sessionId }: StepExecution,
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
    const collected = yield* Effect.result(browser.collectVitals(sessionId));
    if (collected._tag === "Failure") {
      return;
    }
    steps[pending] = { ...recorded, vitals: collected.success };
  }
);

/**
 * The machine this Run measures on. Core Web Vitals are unthrottled, so a
 * Baseline recorded on a laptop and compared against a busy CI runner reads as
 * a Regression caused entirely by hardware (ADR 0008). A Run that did not
 * record this cannot be rescued into comparability later.
 */
const describeEnvironment = (): RunEnvironment => {
  const processors = cpus();
  return {
    architecture: arch(),
    cpuCount: processors.length,
    // A machine with no reportable CPU model is still a machine class, and an
    // empty string would fail the schema rather than describe it.
    cpuModel: processors.at(0)?.model ?? "unknown",
    loadAverage: loadavg().at(0) ?? 0,
    memoryBytes: totalmem(),
    platform: platform(),
  };
};

/** One shared empty result, for every Step that finds nothing. */
const NO_FINDINGS: AuditResult = { elided: [], findings: [] };

interface StepExecution {
  readonly browser: AgentBrowser;
  readonly sessionId: SessionId;
  readonly variables: VariableResolution;
}

/**
 * Replay one Step, returning whatever it found. Fails with a message naming
 * what could not be done. Only an Audit Step finds anything; every other Step
 * returns none.
 */
const executeStep = Effect.fn("Runner.executeStep")(function* executeStep(
  { browser, sessionId, variables }: StepExecution,
  step: FlowStep,
  index: number
) {
  const resolve = (value: string): string =>
    substituteVariables(value, variables.values);

  if (step.type === "customStep") {
    // An Audit runs where its author put it, which is the whole reason Audits
    // are ordered Steps rather than a crawl: the page behind a login and four
    // interactions is reachable no other way (ADR 0005).
    return yield* browser.audit(sessionId, accessibilityRuleTags, index);
  }
  if (step.type === "navigate") {
    yield* browser.goto(sessionId, resolve(step.url));
    // A server error still navigates, so the Step would otherwise pass and the
    // Flow would fail several Steps later on a selector that is missing only
    // because the page is an error page. That misreads a broken site as a
    // stale Flow, which is exactly the confusion classification exists to end.
    // A browser that cannot report the status is not evidence of a bad one:
    // the navigation itself already succeeded.
    const probed = yield* Effect.result(browser.documentStatus(sessionId));
    const status = probed._tag === "Success" ? probed.success : undefined;
    if (status !== undefined && status >= HTTP_ERROR_STATUS) {
      return yield* new RunnerError({
        kind: "siteError",
        message: `The site under test failed: the server answered this navigation with HTTP ${status}.`,
      });
    }
    return NO_FINDINGS;
  }

  if (step.frame !== undefined && step.frame.length > 0) {
    // Selectors resolve against the top document only. Acting there would
    // address a different document than the Flow recorded.
    return yield* new RunnerError({
      message: `This ${step.type} Step targets a nested frame, which replay does not support yet.`,
    });
  }

  const candidates = selectorCandidates(step.selectors);
  if (candidates.length === 0) {
    return yield* new RunnerError({
      kind: "flowError",
      message: `No selector on this ${step.type} Step can be resolved by the browser. Chained shadow-root selectors are not supported yet.`,
    });
  }

  const attempt = (
    selector: string
  ): Effect.Effect<void, BrowserRpcErrorType> => {
    if (step.type === "click") {
      return browser.clickSelector(sessionId, selector);
    }
    if (step.type === "change") {
      return browser.fillSelector(sessionId, selector, resolve(step.value));
    }
    // Each half of the Recorder's pair is dispatched as itself, so a modifier
    // stays down across the Steps it was recorded around.
    return browser
      .waitForSelector(sessionId, selector)
      .pipe(
        Effect.andThen(
          step.type === "keyDown"
            ? browser.keyDown(sessionId, step.key)
            : browser.keyUp(sessionId, step.key)
        )
      );
  };

  // Selectors are alternatives, not a sequence: the first that resolves wins,
  // and only the exhaustion of every one of them is a Step failure.
  let lastMessage = "";
  for (const selector of candidates) {
    const outcome = yield* Effect.result(attempt(selector));
    if (outcome._tag === "Success") {
      return NO_FINDINGS;
    }
    // A candidate that already reached the page is not an unresolved selector:
    // trying the next one would act on the page a second time.
    if (outcome.failure.code === "input_already_dispatched") {
      return yield* new RunnerError({ message: outcome.failure.message });
    }
    // Only "the element is not there" is evidence about the selector. A dead
    // session or a browser-process failure says nothing about it, and treating
    // it as a miss would blame the Flow author for someone else's problem.
    if (!isElementNotFound(outcome.failure.message)) {
      return yield* new RunnerError({ message: outcome.failure.message });
    }
    lastMessage = outcome.failure.message;
  }

  // Every alternative the Recorder offered was tried and none resolved: the
  // element the Flow named is not on the page any more.
  return yield* new RunnerError({
    kind: "flowError",
    message: `Could not resolve a selector for this ${step.type} Step (tried ${candidates.length}): ${lastMessage}`,
  });
});

/**
 * Whether a Pre-step's condition holds — `true`, `false`, or a reason it could
 * not be established at all.
 *
 * The third case is kept separate on purpose. An unanswerable condition — a
 * dead session, an unusable response, or a condition offering no selector the
 * browser can resolve — is not evidence that the interference was absent, and
 * recording it as `skipped` would claim evidence the Run does not have.
 *
 * A visible candidate settles the condition on its own; `false` requires every
 * candidate to have answered.
 */
const conditionHolds = Effect.fn("Runner.conditionHolds")(
  function* conditionHolds(
    { browser, sessionId }: StepExecution,
    when: PreStep["when"]
  ) {
    const candidates = selectorCandidates(when.selectors);
    if (candidates.length === 0) {
      return {
        reason:
          "No selector on this Pre-step's condition can be resolved by the browser. Chained shadow-root selectors are not supported yet.",
      };
    }
    let unanswered = "";
    for (const selector of candidates) {
      const outcome = yield* Effect.result(
        browser.isVisible(sessionId, selector)
      );
      if (outcome._tag === "Failure") {
        unanswered = outcome.failure.message;
        continue;
      }
      if (outcome.success) {
        return true;
      }
    }
    // One candidate answering "not visible" does not settle the condition while
    // another went unanswered: alternatives can match different elements, so the
    // interference may be the one described by the candidate that failed.
    return unanswered === ""
      ? false
      : {
          reason: `Could not evaluate this Pre-step's condition (tried ${candidates.length}): ${unanswered}`,
        };
  }
);

/**
 * Evaluate one Pre-step and report what happened. Best-effort by design: a
 * Pre-step never fails the Run. If the interference it clears genuinely blocked
 * the journey, the real Step fails on its own and is reported as itself
 * (ADR 0009).
 */
const evaluatePreStep = Effect.fn("Runner.evaluatePreStep")(
  function* evaluatePreStep(
    execution: StepExecution,
    preStep: PreStep,
    scope: RunPreStep["scope"],
    index: number
  ) {
    const base = { preStepId: preStep.id, scope } as const;
    const condition = yield* conditionHolds(execution, preStep.when);
    if (typeof condition === "object") {
      return {
        ...base,
        error: condition.reason,
        outcome: "failed",
      } satisfies RunPreStep;
    }
    if (!condition) {
      return { ...base, outcome: "skipped" } satisfies RunPreStep;
    }
    // The index of the Step this Pre-step clears the way for. A Pre-step's
    // action is a click, change, or key Step, so nothing attributes Findings
    // to it today; if one ever could, this is the Step they belong to.
    const outcome = yield* Effect.result(
      executeStep(execution, preStep.step, index)
    );
    if (outcome._tag === "Success") {
      return { ...base, outcome: "completed" } satisfies RunPreStep;
    }
    return {
      ...base,
      // A Pre-step can carry a Variable too, and a browser message can echo the
      // value it typed, so the message is redacted before it reaches the Run.
      error: redactSecrets(outcome.failure.message, execution.variables),
      outcome: "failed",
    } satisfies RunPreStep;
  }
);

/**
 * The Pre-steps to evaluate before one Step, in evaluation order. Flow-level
 * Pre-steps clear interference that can appear anywhere, so they run before
 * every Step — including Audit Steps (ADR 0005) — except the first.
 *
 * The exemption is positional rather than a test for a navigate Step. A Run
 * opens a fresh session on a blank page, so before the first Step there is no
 * page for a condition to be evaluated against, whatever that Step's type is.
 */
const preStepsFor = (
  flow: Flow,
  step: FlowStep,
  index: number
): readonly (readonly [PreStep, RunPreStep["scope"]])[] => {
  if (index === 0) {
    return [];
  }
  const flowLevel = (flow.contingency?.preSteps ?? []).map(
    (preStep) => [preStep, "flow"] as const
  );
  const stepLevel = (
    step.type === "customStep" ? [] : (step.contingency?.preSteps ?? [])
  ).map((preStep) => [preStep, "step"] as const);
  return [...flowLevel, ...stepLevel];
};

interface AttemptResult {
  readonly failure: RunFailure | undefined;
}

/**
 * A Finding describes an element on the page, and the engine builds its target
 * from whatever attribute makes that element unique. Verified against the
 * bundled binary: two otherwise-alike links are reported as
 * `a[href="/next?token=..."]`, so a Variable interpolated into a URL reaches
 * the target verbatim. Both fields the engine renders from the page go through
 * the same redaction a failure message does.
 */
const redactFinding = (
  finding: Finding,
  variables: VariableResolution
): Finding => ({
  ...finding,
  message: redactSecrets(finding.message, variables),
  target: redactSecrets(finding.target, variables),
});

/**
 * Replay the whole Flow once in a session of its own. A failed Step aborts the
 * attempt rather than continuing against a page state the Flow never described
 * (ADR 0009).
 */
const attemptRun = Effect.fn("Runner.attemptRun")(function* attemptRun(
  browser: AgentBrowser,
  flow: Flow,
  sessionId: SessionId,
  variables: VariableResolution,
  /** Caller-owned, so the Steps done so far survive an interrupted attempt. */
  steps: RunStep[]
) {
  let failure: RunFailure | undefined;
  const measures = flow.steps.some(measuresPerformance);

  yield* Effect.acquireUseRelease(
    // Interactions cannot be read back after the fact, so a Run that might
    // measure anything has to record from the first navigation onwards.
    browser.create(sessionId, RUN_VIEWPORT, { recordVitals: measures }).pipe(
      Effect.mapError(
        (cause) =>
          new RunnerError({
            message: `Could not open a browser session: ${cause.message}`,
          })
      )
    ),
    (opened) =>
      Effect.gen(function* replayFlow() {
        const execution = { browser, sessionId: opened, variables };
        /** Index in `steps` of a Step whose page has not been measured yet. */
        let pending: number | undefined;
        for (const [index, step] of flow.steps.entries()) {
          const stepStartedAt = yield* nowIso;

          const preSteps: RunPreStep[] = [];
          for (const [preStep, scope] of preStepsFor(flow, step, index)) {
            preSteps.push(
              yield* evaluatePreStep(execution, preStep, scope, index)
            );
          }

          // Leaving this page ends what there is to measure on it, so a Step
          // still awaiting measurement is read now — after Pre-steps, whose
          // clicks are interactions on this page like any other.
          if (stepNavigates(step)) {
            yield* measurePending(execution, steps, pending);
            pending = undefined;
          }

          const outcome = yield* Effect.result(
            executeStep(execution, step, index).pipe(
              Effect.mapError((cause) =>
                cause instanceof RunnerError
                  ? cause
                  : new RunnerError({ message: cause.message })
              )
            )
          );
          const stepFinishedAt = yield* nowIso;
          const base = {
            finishedAt: stepFinishedAt.toISOString(),
            index,
            ...(preSteps.length === 0 ? {} : { preSteps }),
            startedAt: stepStartedAt.toISOString(),
            type: step.type,
            ...(step.type === "customStep" || step.contingency?.id === undefined
              ? {}
              : { stepId: step.contingency.id }),
          };

          if (outcome._tag === "Success") {
            if (measuresPerformance(step)) {
              pending = steps.length;
            }
            steps.push({
              ...base,
              // Findings never change an outcome: every real site has
              // pre-existing violations, and a Run that failed on their count
              // would be red on day one and switched off by the second.
              ...(outcome.success.elided.length === 0
                ? {}
                : { elidedFindings: outcome.success.elided }),
              ...(outcome.success.findings.length === 0
                ? {}
                : {
                    findings: outcome.success.findings.map((finding) =>
                      redactFinding(finding, variables)
                    ),
                  }),
              outcome: "completed",
            });
            continue;
          }

          // A browser message can echo a value typed into a field, so it is
          // redacted before it reaches the Run.
          const message = redactSecrets(outcome.failure.message, variables);
          const kind = classifyStepFailure(outcome.failure.kind, message);

          steps.push({ ...base, error: message, outcome: "failed" });
          failure = {
            ...(kind === undefined ? {} : { kind }),
            message,
            stepIndex: index,
          };
          // The navigation that was measured still happened, and a Flow that
          // fails at Step 9 should not lose the metrics from Step 2.
          yield* measurePending(execution, steps, pending);
          return;
        }

        yield* measurePending(execution, steps, pending);
      }),
    (opened) => browser.close(opened).pipe(Effect.ignore)
  );

  return { failure } satisfies AttemptResult;
});

export const makeRunnerService = (browser: AgentBrowser) =>
  Effect.gen(function* buildRunner() {
    const fileSystem = yield* FileSystem.FileSystem;
    // One Run at a time per process: concurrent Runs contend for CPU and
    // corrupt each other's measurements (ADR 0009).
    const runPermit = Semaphore.makeUnsafe(1);

    const persist = Effect.fn("Runner.persist")(function* persist(
      record: Run,
      outputDirectory: string,
      startedAt: Date
    ) {
      const directory = path.join(
        outputDirectory,
        flowDirectorySegment(record.flowId),
        runDirectoryName(startedAt, record.runId)
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
      runPermit.withPermit(
        Effect.gen(function* executeRun() {
          const variables = options.variables ?? NO_VARIABLES;
          const retry = Math.max(0, Math.trunc(options.retry ?? DEFAULT_RETRY));
          const runId = randomUUID();
          const flowHash = hashFlow(flow);
          const flowId = flowIdentity(flow, flowHash);
          const startedAt = yield* nowIso;
          // Read once, at the start: load average taken after a slow Run would
          // describe the Run's own effect on the machine, not the machine.
          const environment = describeEnvironment();

          const attempts: RunAttempt[] = [];
          let inFlight:
            | { attempt: number; startedAt: Date; steps: RunStep[] }
            | undefined;

          const replay = Effect.gen(function* replayUntilItHolds() {
            for (let index = 0; index <= retry; index += 1) {
              const attemptStartedAt = yield* nowIso;
              const steps: RunStep[] = [];
              inFlight = {
                attempt: index + 1,
                startedAt: attemptStartedAt,
                steps,
              };
              // A fresh session every time: a retry inside a session that has
              // already been navigated, cookied, and clicked is not a rerun of
              // the Flow, it is a rerun of whatever the last attempt left.
              const sessionId = yield* Schema.decodeUnknownEffect(
                SessionIdSchema
              )(`run-${runId.slice(0, 8)}-${index + 1}`).pipe(
                Effect.mapError(
                  (cause) =>
                    new RunnerError({
                      message: `Invalid Run session: ${errorMessage(cause)}`,
                    })
                )
              );

              const result = yield* attemptRun(
                browser,
                flow,
                sessionId,
                variables,
                steps
              );
              const attemptFinishedAt = yield* nowIso;
              inFlight = undefined;
              attempts.push({
                attempt: index + 1,
                ...(result.failure === undefined
                  ? {}
                  : { failure: result.failure }),
                finishedAt: attemptFinishedAt.toISOString(),
                outcome: result.failure === undefined ? "completed" : "failed",
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
            Effect.timeoutOption(options.timeout ?? DEFAULT_TIMEOUT),
            Effect.map((finished) => finished._tag === "None")
          );

          const finishedAt = yield* nowIso;
          const timeoutFailure: RunFailure = {
            message: `The Run exceeded its ${Duration.format(options.timeout ?? DEFAULT_TIMEOUT)} ceiling during attempt ${inFlight?.attempt ?? attempts.length} of ${retry + 1}.`,
          };
          if (timedOut) {
            // The interrupted attempt is still an attempt, and the Steps it did
            // complete are the record of how far the Flow got.
            attempts.push({
              attempt: inFlight?.attempt ?? attempts.length + 1,
              failure: timeoutFailure,
              finishedAt: finishedAt.toISOString(),
              outcome: "failed",
              startedAt: (inFlight?.startedAt ?? finishedAt).toISOString(),
              steps: inFlight?.steps ?? [],
            });
          }

          const last = attempts.at(-1);
          const failure = timedOut ? timeoutFailure : last?.failure;

          const record: Run = {
            attempts,
            environment,
            ...(failure === undefined ? {} : { failure }),
            finishedAt: finishedAt.toISOString(),
            flow,
            flowHash,
            flowId,
            outcome: failure === undefined ? "completed" : "failed",
            runId,
            startedAt: startedAt.toISOString(),
            steps: last?.steps ?? [],
          };

          return yield* persist(record, options.outputDirectory, startedAt);
        })
      );

    return Runner.of({ run });
  });

export const RunnerLive: Layer.Layer<
  RunnerService,
  never,
  AgentBrowser | FileSystem.FileSystem
> = Layer.effect(
  Runner,
  Effect.gen(function* buildRunnerLive() {
    const browser = yield* AgentBrowser;
    return yield* makeRunnerService(browser);
  })
);

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
