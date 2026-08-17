import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import {
  Flow as FlowSchema,
  SessionId as SessionIdSchema,
} from "@contingency/protocol";
import type {
  BrowserRpcErrorType,
  Flow,
  FlowStep,
  PreStep,
  Run,
  RunPreStep,
  RunStep,
  Selector,
  SessionId,
} from "@contingency/protocol";
import {
  Context,
  Data,
  Effect,
  FileSystem,
  Layer,
  Schema,
  Semaphore,
} from "effect";

import { AgentBrowser } from "./agent-browser";
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
  readonly message: string;
}> {}

export interface RunnerRunOptions {
  /** Directory holding one subdirectory per Flow. Defaults to the state dir. */
  readonly outputDirectory: string;
  /** Values for the Flow's Variables, resolved by preflight before this runs. */
  readonly variables?: VariableResolution | undefined;
}

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

interface StepExecution {
  readonly browser: AgentBrowser;
  readonly sessionId: SessionId;
  readonly variables: VariableResolution;
}

/** Replay one Step. Fails with a message naming what could not be done. */
const executeStep = Effect.fn("Runner.executeStep")(function* executeStep(
  { browser, sessionId, variables }: StepExecution,
  step: FlowStep
) {
  const resolve = (value: string): string =>
    substituteVariables(value, variables.values);

  if (step.type === "customStep") {
    // Audits arrive in their own ticket; until then a Flow's Audit Steps are
    // recorded as executed without producing Findings.
    return;
  }
  if (step.type === "navigate") {
    yield* browser.goto(sessionId, resolve(step.url));
    return;
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
      return;
    }
    // A candidate that already reached the page is not an unresolved selector:
    // trying the next one would act on the page a second time.
    if (outcome.failure.code === "input_already_dispatched") {
      return yield* new RunnerError({ message: outcome.failure.message });
    }
    lastMessage = outcome.failure.message;
  }

  return yield* new RunnerError({
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
    let answered = false;
    let lastFailure = "";
    for (const selector of candidates) {
      const outcome = yield* Effect.result(
        browser.isVisible(sessionId, selector)
      );
      if (outcome._tag === "Failure") {
        lastFailure = outcome.failure.message;
        continue;
      }
      if (outcome.success) {
        return true;
      }
      // The browser answered for this selector: the element is not on the page.
      answered = true;
    }
    // A candidate that answered settles it. If none did, the question never
    // reached the page and the condition is unknown rather than false.
    return answered
      ? false
      : {
          reason: `Could not evaluate this Pre-step's condition (tried ${candidates.length}): ${lastFailure}`,
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
    scope: RunPreStep["scope"]
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
    const outcome = yield* Effect.result(executeStep(execution, preStep.step));
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

export const makeRunnerService = (browser: AgentBrowser) =>
  Effect.gen(function* buildRunner() {
    const fileSystem = yield* FileSystem.FileSystem;
    // One Run at a time per process: concurrent Runs contend for CPU and
    // corrupt each other's measurements (ADR 0009).
    const runPermit = Semaphore.makeUnsafe(1);

    const run = (flow: Flow, options: RunnerRunOptions) =>
      runPermit.withPermit(
        Effect.gen(function* executeRun() {
          const variables = options.variables ?? NO_VARIABLES;
          const runId = randomUUID();
          const flowHash = hashFlow(flow);
          const flowId = flowIdentity(flow, flowHash);
          const startedAt = yield* nowIso;

          const sessionId = yield* Schema.decodeUnknownEffect(SessionIdSchema)(
            `run-${runId.slice(0, 8)}`
          ).pipe(
            Effect.mapError(
              (cause) =>
                new RunnerError({
                  message: `Invalid Run session: ${errorMessage(cause)}`,
                })
            )
          );

          const steps: RunStep[] = [];
          let failure: Run["failure"];

          yield* Effect.acquireUseRelease(
            browser.create(sessionId, RUN_VIEWPORT).pipe(
              Effect.mapError(
                (cause) =>
                  new RunnerError({
                    message: `Could not open a browser session: ${cause.message}`,
                  })
              )
            ),
            (opened) =>
              Effect.gen(function* replayFlow() {
                const execution = {
                  browser,
                  sessionId: opened,
                  variables,
                };
                for (const [index, step] of flow.steps.entries()) {
                  const stepStartedAt = yield* nowIso;

                  const preSteps: RunPreStep[] = [];
                  for (const [preStep, scope] of preStepsFor(
                    flow,
                    step,
                    index
                  )) {
                    preSteps.push(
                      yield* evaluatePreStep(execution, preStep, scope)
                    );
                  }

                  const outcome = yield* Effect.result(
                    executeStep(execution, step).pipe(
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
                    ...(step.type === "customStep" ||
                    step.contingency?.id === undefined
                      ? {}
                      : { stepId: step.contingency.id }),
                  };

                  if (outcome._tag === "Success") {
                    steps.push({ ...base, outcome: "completed" });
                    continue;
                  }

                  // A browser message can echo a value typed into a field, so
                  // it is redacted before it reaches the Run.
                  const message = redactSecrets(
                    outcome.failure.message,
                    variables
                  );

                  // A failed Step aborts the Run rather than continuing against
                  // a page state the Flow never described (ADR 0009).
                  steps.push({ ...base, error: message, outcome: "failed" });
                  failure = { message, stepIndex: index };
                  return;
                }
              }),
            (opened) => browser.close(opened).pipe(Effect.ignore)
          );

          const finishedAt = yield* nowIso;
          const record: Run = {
            ...(failure === undefined ? {} : { failure }),
            finishedAt: finishedAt.toISOString(),
            flow,
            flowHash,
            flowId,
            outcome: failure === undefined ? "completed" : "failed",
            runId,
            startedAt: startedAt.toISOString(),
            steps,
          };

          const directory = path.join(
            options.outputDirectory,
            flowDirectorySegment(flowId),
            runDirectoryName(startedAt, runId)
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

          return { directory, run: record };
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
