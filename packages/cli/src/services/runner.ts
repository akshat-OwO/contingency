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
  Run,
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
}

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
    // Piercing selectors are plain CSS; the tool already crosses shadow roots.
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
 * order, each of which may be a chain that pierces frames or shadow roots. The
 * browser tool takes one CSS or XPath selector, so the chain is flattened to
 * its last element — the one that addresses the target itself — and prefixed
 * forms the tool cannot parse are dropped.
 */
export const selectorCandidates = (selectors: Selector): readonly string[] => {
  const candidates: string[] = [];
  for (const entry of selectors) {
    const chain = typeof entry === "string" ? [entry] : [...entry];
    const target = chain.at(-1);
    if (target === undefined) {
      continue;
    }
    const translated = translateSelector(target);
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
}

/** Replay one Step. Fails with a message naming what could not be done. */
const executeStep = Effect.fn("Runner.executeStep")(function* executeStep(
  { browser, sessionId }: StepExecution,
  step: FlowStep
) {
  if (step.type === "customStep") {
    // Audits arrive in their own ticket; until then a Flow's Audit Steps are
    // recorded as executed without producing Findings.
    return;
  }
  if (step.type === "navigate") {
    yield* browser.goto(sessionId, step.url);
    return;
  }

  const candidates = selectorCandidates(step.selectors);
  if (candidates.length === 0) {
    return yield* new RunnerError({
      message: `No selector on this ${step.type} Step can be resolved by the browser.`,
    });
  }

  const attempt = (
    selector: string
  ): Effect.Effect<void, BrowserRpcErrorType> => {
    if (step.type === "click") {
      return browser.clickSelector(sessionId, selector);
    }
    if (step.type === "change") {
      return browser.fillSelector(sessionId, selector, step.value);
    }
    return browser
      .waitForSelector(sessionId, selector)
      .pipe(Effect.andThen(browser.pressKey(sessionId, step.key)));
  };

  // Selectors are alternatives, not a sequence: the first that resolves wins,
  // and only the exhaustion of every one of them is a Step failure.
  let lastMessage = "";
  for (const selector of candidates) {
    const outcome = yield* Effect.result(attempt(selector));
    if (outcome._tag === "Success") {
      return;
    }
    lastMessage = outcome.failure.message;
  }

  return yield* new RunnerError({
    message: `Could not resolve a selector for this ${step.type} Step (tried ${candidates.length}): ${lastMessage}`,
  });
});

export const makeRunnerService = (browser: AgentBrowser) =>
  Effect.gen(function* buildRunner() {
    const fileSystem = yield* FileSystem.FileSystem;
    // One Run at a time per process: concurrent Runs contend for CPU and
    // corrupt each other's measurements (ADR 0009).
    const runPermit = Semaphore.makeUnsafe(1);

    const run = (flow: Flow, options: RunnerRunOptions) =>
      runPermit.withPermit(
        Effect.gen(function* executeRun() {
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
                for (const [index, step] of flow.steps.entries()) {
                  const stepStartedAt = yield* nowIso;
                  const outcome = yield* Effect.result(
                    executeStep({ browser, sessionId: opened }, step).pipe(
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

                  // A failed Step aborts the Run rather than continuing against
                  // a page state the Flow never described (ADR 0009).
                  steps.push({
                    ...base,
                    error: outcome.failure.message,
                    outcome: "failed",
                  });
                  failure = {
                    message: outcome.failure.message,
                    stepIndex: index,
                  };
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
            flowId,
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
