import type {
  BrowserRpcError,
  Flow,
  PreStep,
  Run,
  SessionId,
} from "@contingency/protocol";
import {
  makeBrowserRpcError,
  runIsBaselineEligible,
} from "@contingency/protocol";
import { expect, it } from "@effect/vitest";
import { Duration, Effect, FileSystem } from "effect";

import type { AgentBrowser } from "../../src/services/agent-browser";
import {
  flowDirectorySegment,
  flowRunsDirectory,
  flowIdentity,
  hashFlow,
  makeRunnerService,
  selectorCandidates,
} from "../../src/services/runner";

const unused = (): never => {
  throw new Error("Unexpected browser call");
};

interface BrowserCall {
  readonly args: readonly string[];
  readonly command: string;
}

interface WrittenFile {
  readonly contents: string;
  readonly path: string;
}

const makeFixture = (options?: {
  /** HTTP status the loaded document reports. Defaults to a served page. */
  readonly documentStatus?: number;
  readonly failOn?: (call: BrowserCall) => string | BrowserRpcError | undefined;
  /** Wall-clock a navigation takes, for exercising the Run's own ceiling. */
  readonly navigationDelay?: Duration.Duration;
  /** Selectors the page shows. Anything else is absent, as the browser reports it. */
  readonly visible?: readonly string[];
}) => {
  const calls: BrowserCall[] = [];
  const written: WrittenFile[] = [];
  const directories: string[] = [];

  const record = (command: string, args: readonly string[]) => {
    const call = { args, command };
    calls.push(call);
    const failure = options?.failOn?.(call);
    if (failure === undefined) {
      return Effect.void;
    }
    return Effect.fail(
      typeof failure === "string"
        ? makeBrowserRpcError("agent_browser_failed", failure)
        : failure
    );
  };

  const stub: Partial<AgentBrowser> = {
    clickSelector: (_session, selector) => record("click", [selector]),
    close: (session) => record("close", [session]),
    create: (name) =>
      record("create", [name]).pipe(Effect.as(name as SessionId)),
    documentStatus: () =>
      record("documentStatus", []).pipe(
        Effect.as(options?.documentStatus ?? 200)
      ),
    fillSelector: (_session, selector, value) =>
      record("fill", [selector, value]),
    goto: (_session, url) =>
      record("goto", [url]).pipe(
        Effect.andThen(
          options?.navigationDelay === undefined
            ? Effect.void
            : Effect.sleep(options.navigationDelay)
        )
      ),
    // `isVisible` absorbs the browser's element-not-found answer into `false`,
    // so a failure here means the question never reached the page.
    isVisible: (_session, selector) =>
      record("isVisible", [selector]).pipe(
        Effect.as(options?.visible?.includes(selector) === true)
      ),
    keyDown: (_session, key) => record("keyDown", [key]),
    keyUp: (_session, key) => record("keyUp", [key]),
    typeSelector: (_session, selector, value) =>
      record("type", [selector, value]),
    waitForSelector: (_session, selector) => record("wait", [selector]),
  };
  // Only the replay surface is stubbed; any other call is a test failure.
  const browser = new Proxy(stub, {
    get: (target, property) =>
      property in target ? target[property as keyof AgentBrowser] : unused,
  }) as AgentBrowser;

  const fileSystemLayer = FileSystem.layerNoop({
    makeDirectory: (target) =>
      Effect.sync(() => {
        directories.push(target);
      }),
    writeFileString: (target, contents) =>
      Effect.sync(() => {
        written.push({ contents, path: target });
      }),
  });

  return { browser, calls, directories, fileSystemLayer, written };
};

const flow = (steps: Flow["steps"], contingency?: Flow["contingency"]): Flow =>
  ({
    ...(contingency === undefined ? {} : { contingency }),
    steps,
    title: "Checkout",
  }) as Flow;

const writtenRun = (written: readonly WrittenFile[]): Run => {
  const entry = written.find(({ path }) => path.endsWith("run.json"));
  if (entry === undefined) {
    throw new Error("No run.json was written");
  }
  return JSON.parse(entry.contents) as Run;
};

it.effect(
  "executes browser Steps in Flow order in a fresh run- session",
  () => {
    const fixture = makeFixture();

    return Effect.gen(function* replayInOrder() {
      const runner = yield* makeRunnerService(fixture.browser);
      const result = yield* runner.run(
        flow([
          { type: "navigate", url: "https://example.com/login" },
          {
            offsetX: 1,
            offsetY: 2,
            selectors: [["#submit"]],
            type: "click",
          },
          { selectors: [["#email"]], type: "change", value: "a@b.test" },
          { key: "Enter", selectors: [["#email"]], type: "keyDown" },
        ]),
        { outputDirectory: "/runs" }
      );

      expect(fixture.calls.map(({ command }) => command)).toEqual([
        "create",
        "goto",
        "documentStatus",
        "click",
        "fill",
        "wait",
        "keyDown",
        "close",
      ]);
      const [created] = fixture.calls;
      expect(created?.args[0]).toMatch(/^run-/u);
      expect(result.run.outcome).toBe("completed");
      expect(result.run.steps.map(({ outcome }) => outcome)).toEqual([
        "completed",
        "completed",
        "completed",
        "completed",
      ]);
    }).pipe(Effect.provide(fixture.fileSystemLayer));
  }
);

it.effect("closes the session even when a Step fails", () => {
  const fixture = makeFixture({
    failOn: ({ command }) =>
      command === "click" ? "Selector did not resolve" : undefined,
  });

  return Effect.gen(function* closeAfterFailure() {
    const runner = yield* makeRunnerService(fixture.browser);
    const result = yield* runner.run(
      flow([
        { type: "navigate", url: "https://example.com/login" },
        { offsetX: 1, offsetY: 2, selectors: [["#submit"]], type: "click" },
      ]),
      { outputDirectory: "/runs" }
    );

    expect(fixture.calls.at(-1)?.command).toBe("close");
    expect(result.run.outcome).toBe("failed");
    expect(result.run.failure?.stepIndex).toBe(1);
  }).pipe(Effect.provide(fixture.fileSystemLayer));
});

it.effect("aborts the Run at the first failed Step", () => {
  const fixture = makeFixture({
    failOn: ({ command }) =>
      command === "click" ? "Selector did not resolve" : undefined,
  });

  return Effect.gen(function* abortOnFailure() {
    const runner = yield* makeRunnerService(fixture.browser);
    const result = yield* runner.run(
      flow([
        { type: "navigate", url: "https://example.com/login" },
        { offsetX: 1, offsetY: 2, selectors: [["#submit"]], type: "click" },
        { selectors: [["#never"]], type: "change", value: "unreached" },
      ]),
      { outputDirectory: "/runs" }
    );

    // The Step after the failure never runs: later Steps must not execute
    // against a page state the Flow never described.
    expect(fixture.calls.map(({ command }) => command)).not.toContain("fill");
    expect(result.run.steps).toHaveLength(2);
    expect(result.run.steps.at(-1)?.outcome).toBe("failed");
  }).pipe(Effect.provide(fixture.fileSystemLayer));
});

it.effect("stops trying selectors once a click has reached the page", () => {
  const fixture = makeFixture({
    failOn: ({ args, command }) =>
      command === "click" && args[0] === "#moved"
        ? makeBrowserRpcError(
            "input_already_dispatched",
            "#moved moved before the click landed, which reached <body> instead."
          )
        : undefined,
  });

  return Effect.gen(function* stopAfterSideEffect() {
    const runner = yield* makeRunnerService(fixture.browser);
    const result = yield* runner.run(
      flow([
        {
          offsetX: 1,
          offsetY: 2,
          selectors: [["#moved"], ["#fallback"]],
          type: "click",
        },
      ]),
      { outputDirectory: "/runs" }
    );

    // #fallback would resolve, but the page has already been clicked once:
    // a second click would repeat whatever the first one set off.
    expect(fixture.calls.map(({ args }) => args[0])).not.toContain("#fallback");
    expect(result.run.outcome).toBe("failed");
    expect(result.run.failure?.message).toContain("moved before the click");
  }).pipe(Effect.provide(fixture.fileSystemLayer));
});

it.effect("tries each alternative selector before failing the Step", () => {
  const fixture = makeFixture({
    failOn: ({ args, command }) =>
      command === "click" && args[0] !== "#stable"
        ? "Selector did not resolve"
        : undefined,
  });

  return Effect.gen(function* fallBackToNextSelector() {
    const runner = yield* makeRunnerService(fixture.browser);
    const result = yield* runner.run(
      flow([
        { type: "navigate", url: "https://example.com/" },
        {
          offsetX: 1,
          offsetY: 2,
          selectors: [["#stale"], ["#stable"]],
          type: "click",
        },
      ]),
      { outputDirectory: "/runs" }
    );

    expect(
      fixture.calls
        .filter(({ command }) => command === "click")
        .map(({ args }) => args[0])
    ).toEqual(["#stale", "#stable"]);
    expect(result.run.outcome).toBe("completed");
  }).pipe(Effect.provide(fixture.fileSystemLayer));
});

const dismissBanner = (id: string, selector: string): PreStep => ({
  id,
  step: {
    offsetX: 1,
    offsetY: 2,
    selectors: [[selector]],
    type: "click",
  },
  when: { selectors: [["#banner"]], type: "selectorVisible" },
});

it.effect(
  "evaluates Flow Pre-steps before every Step after the initial navigation",
  () => {
    const fixture = makeFixture({ visible: ["#banner"] });

    return Effect.gen(function* evaluateFlowPreSteps() {
      const runner = yield* makeRunnerService(fixture.browser);
      const result = yield* runner.run(
        flow(
          [
            { type: "navigate", url: "https://shop.test/" },
            { offsetX: 1, offsetY: 2, selectors: [["#buy"]], type: "click" },
            {
              name: "contingency.audit",
              parameters: { kind: "accessibility" },
              type: "customStep",
            },
          ],
          { preSteps: [dismissBanner("dismiss", "#accept")] }
        ),
        { outputDirectory: "/runs" }
      );

      // Not before Step 0: the initial navigation opens the page a Pre-step
      // would be evaluated against.
      expect(result.run.steps[0]?.preSteps).toBeUndefined();
      // Before the browser Step and before the Audit Step alike (ADR 0005).
      expect(result.run.steps[1]?.preSteps).toEqual([
        { outcome: "completed", preStepId: "dismiss", scope: "flow" },
      ]);
      expect(result.run.steps[2]?.preSteps).toEqual([
        { outcome: "completed", preStepId: "dismiss", scope: "flow" },
      ]);
      expect(
        fixture.calls
          .filter(({ command }) => command === "click")
          .map(({ args }) => args[0])
      ).toEqual(["#accept", "#buy", "#accept"]);
      expect(result.run.outcome).toBe("completed");
    }).pipe(Effect.provide(fixture.fileSystemLayer));
  }
);

it.effect("evaluates a per-Step Pre-step only before its own Step", () => {
  const fixture = makeFixture({ visible: ["#banner"] });

  return Effect.gen(function* evaluateStepPreStep() {
    const runner = yield* makeRunnerService(fixture.browser);
    const result = yield* runner.run(
      flow([
        { type: "navigate", url: "https://shop.test/" },
        { offsetX: 1, offsetY: 2, selectors: [["#buy"]], type: "click" },
        {
          contingency: {
            id: "confirm",
            preSteps: [dismissBanner("dismiss", "#accept")],
          },
          offsetX: 1,
          offsetY: 2,
          selectors: [["#confirm"]],
          type: "click",
        },
      ]),
      { outputDirectory: "/runs" }
    );

    expect(result.run.steps[1]?.preSteps).toBeUndefined();
    expect(result.run.steps[2]?.preSteps).toEqual([
      { outcome: "completed", preStepId: "dismiss", scope: "step" },
    ]);
  }).pipe(Effect.provide(fixture.fileSystemLayer));
});

it.effect("skips a Pre-step whose condition does not hold", () => {
  const fixture = makeFixture();

  return Effect.gen(function* skipUnmetCondition() {
    const runner = yield* makeRunnerService(fixture.browser);
    const result = yield* runner.run(
      flow(
        [
          { type: "navigate", url: "https://shop.test/" },
          { offsetX: 1, offsetY: 2, selectors: [["#buy"]], type: "click" },
        ],
        { preSteps: [dismissBanner("dismiss", "#accept")] }
      ),
      { outputDirectory: "/runs" }
    );

    // No banner on the page, so nothing was clicked to dismiss it.
    expect(
      fixture.calls
        .filter(({ command }) => command === "click")
        .map(({ args }) => args[0])
    ).toEqual(["#buy"]);
    expect(result.run.steps[1]?.preSteps).toEqual([
      { outcome: "skipped", preStepId: "dismiss", scope: "flow" },
    ]);
    expect(result.run.outcome).toBe("completed");
  }).pipe(Effect.provide(fixture.fileSystemLayer));
});

it.effect("records a failed Pre-step without failing the Run", () => {
  const fixture = makeFixture({
    failOn: ({ args, command }) =>
      command === "click" && args[0] === "#accept"
        ? "Selector did not resolve"
        : undefined,
    visible: ["#banner"],
  });

  return Effect.gen(function* tolerateFailedPreStep() {
    const runner = yield* makeRunnerService(fixture.browser);
    const result = yield* runner.run(
      flow(
        [
          { type: "navigate", url: "https://shop.test/" },
          { offsetX: 1, offsetY: 2, selectors: [["#buy"]], type: "click" },
        ],
        { preSteps: [dismissBanner("dismiss", "#accept")] }
      ),
      { outputDirectory: "/runs" }
    );

    // The real Step still ran, and it decides the Run's outcome (ADR 0009).
    expect(result.run.outcome).toBe("completed");
    expect(result.run.steps[1]?.outcome).toBe("completed");
    const [preStep] = result.run.steps[1]?.preSteps ?? [];
    expect(preStep?.outcome).toBe("failed");
    expect(preStep?.error).toContain("Selector did not resolve");
  }).pipe(Effect.provide(fixture.fileSystemLayer));
});

it.effect("records the Pre-steps of a Step that then failed", () => {
  const fixture = makeFixture({
    failOn: ({ args, command }) =>
      command === "click" && args[0] === "#buy"
        ? "Selector did not resolve"
        : undefined,
    visible: ["#banner"],
  });

  return Effect.gen(function* recordPreStepsOnFailure() {
    const runner = yield* makeRunnerService(fixture.browser);
    const result = yield* runner.run(
      flow(
        [
          { type: "navigate", url: "https://shop.test/" },
          { offsetX: 1, offsetY: 2, selectors: [["#buy"]], type: "click" },
        ],
        { preSteps: [dismissBanner("dismiss", "#accept")] }
      ),
      { outputDirectory: "/runs" }
    );

    // The failing Step is the interesting case: what was cleared before it is
    // the first thing anyone reads when a Run differs from its Baseline.
    expect(result.run.steps[1]?.outcome).toBe("failed");
    expect(result.run.steps[1]?.preSteps).toEqual([
      { outcome: "completed", preStepId: "dismiss", scope: "flow" },
    ]);
  }).pipe(Effect.provide(fixture.fileSystemLayer));
});

it.effect("records an unanswerable condition as failed, not skipped", () => {
  const fixture = makeFixture({
    failOn: ({ command }) =>
      command === "isVisible" ? "Session is not running" : undefined,
    visible: ["#banner"],
  });

  return Effect.gen(function* recordUnanswerableCondition() {
    const runner = yield* makeRunnerService(fixture.browser);
    const result = yield* runner.run(
      flow(
        [
          { type: "navigate", url: "https://shop.test/" },
          { offsetX: 1, offsetY: 2, selectors: [["#buy"]], type: "click" },
        ],
        { preSteps: [dismissBanner("dismiss", "#accept")] }
      ),
      { outputDirectory: "/runs" }
    );

    // A browser that cannot answer is not evidence that the banner was absent.
    const [preStep] = result.run.steps[1]?.preSteps ?? [];
    expect(preStep?.outcome).toBe("failed");
    expect(preStep?.error).toContain("Session is not running");
    expect(result.run.outcome).toBe("completed");
  }).pipe(Effect.provide(fixture.fileSystemLayer));
});

it.effect("does not let one answered candidate mask an unanswered one", () => {
  const fixture = makeFixture({
    failOn: ({ args, command }) =>
      command === "isVisible" && args[0] === "#late"
        ? "Session is not running"
        : undefined,
  });

  return Effect.gen(function* preserveMixedCandidateResults() {
    const runner = yield* makeRunnerService(fixture.browser);
    const result = yield* runner.run(
      flow(
        [
          { type: "navigate", url: "https://shop.test/" },
          { offsetX: 1, offsetY: 2, selectors: [["#buy"]], type: "click" },
        ],
        {
          preSteps: [
            {
              ...dismissBanner("dismiss", "#accept"),
              // `#early` answers "not visible"; `#late` never answers at all.
              when: {
                selectors: [["#early"], ["#late"]],
                type: "selectorVisible",
              },
            },
          ],
        }
      ),
      { outputDirectory: "/runs" }
    );

    // Alternatives can match different elements, so `#early` saying no does not
    // rule out the banner that `#late` describes.
    const [preStep] = result.run.steps[1]?.preSteps ?? [];
    expect(preStep?.outcome).toBe("failed");
    expect(preStep?.error).toContain("Session is not running");
  }).pipe(Effect.provide(fixture.fileSystemLayer));
});

it.effect("records a condition it could not evaluate as failed", () => {
  const fixture = makeFixture();

  return Effect.gen(function* recordUnevaluatedCondition() {
    const runner = yield* makeRunnerService(fixture.browser);
    const result = yield* runner.run(
      flow(
        [
          { type: "navigate", url: "https://shop.test/" },
          { offsetX: 1, offsetY: 2, selectors: [["#buy"]], type: "click" },
        ],
        {
          preSteps: [
            {
              ...dismissBanner("dismiss", "#accept"),
              // Only a chained shadow-root selector, which cannot be resolved.
              when: {
                selectors: [["#host", "#banner"]],
                type: "selectorVisible",
              },
            },
          ],
        }
      ),
      { outputDirectory: "/runs" }
    );

    // Not `skipped`: that would claim the interference was absent, which the
    // Run never established.
    const [preStep] = result.run.steps[1]?.preSteps ?? [];
    expect(preStep?.outcome).toBe("failed");
    expect(preStep?.error).toContain("can be resolved by the browser");
    expect(fixture.calls.map(({ command }) => command)).not.toContain(
      "isVisible"
    );
    expect(result.run.outcome).toBe("completed");
  }).pipe(Effect.provide(fixture.fileSystemLayer));
});

it.effect("retries a failing Flow in a completely fresh session", () => {
  let clicks = 0;
  const fixture = makeFixture({
    failOn: ({ command }) => {
      if (command !== "click") {
        return;
      }
      clicks += 1;
      return clicks < 3 ? "Selector did not resolve" : undefined;
    },
  });

  return Effect.gen(function* retryUntilItHolds() {
    const runner = yield* makeRunnerService(fixture.browser);
    const result = yield* runner.run(
      flow([
        { type: "navigate", url: "https://shop.test/" },
        { offsetX: 1, offsetY: 2, selectors: [["#buy"]], type: "click" },
      ]),
      { outputDirectory: "/runs", retry: 3 }
    );

    // A retry inside a session that has already been navigated and clicked is
    // a rerun of what the last attempt left, not of the Flow.
    const sessions = fixture.calls
      .filter(({ command }) => command === "create")
      .map(({ args }) => args[0]);
    expect(sessions).toHaveLength(3);
    expect(new Set(sessions).size).toBe(3);
    expect(
      fixture.calls.filter(({ command }) => command === "close")
    ).toHaveLength(3);
    expect(result.run.outcome).toBe("completed");
  }).pipe(Effect.provide(fixture.fileSystemLayer));
});

it.effect("records every attempt's failure even after one succeeds", () => {
  let clicks = 0;
  const fixture = makeFixture({
    failOn: ({ command }) => {
      if (command !== "click") {
        return;
      }
      clicks += 1;
      return clicks === 1 ? "Selector did not resolve" : undefined;
    },
  });

  return Effect.gen(function* recordEveryAttempt() {
    const runner = yield* makeRunnerService(fixture.browser);
    const result = yield* runner.run(
      flow([
        { type: "navigate", url: "https://shop.test/" },
        { offsetX: 1, offsetY: 2, selectors: [["#buy"]], type: "click" },
      ]),
      { outputDirectory: "/runs", retry: 3 }
    );

    // Silent retry is how a Flow that fails 40% of the time reports green.
    expect(result.run.outcome).toBe("completed");
    expect(result.run.attempts.map(({ outcome }) => outcome)).toEqual([
      "failed",
      "completed",
    ]);
    expect(result.run.attempts[0]?.failure?.message).toContain(
      "Selector did not resolve"
    );
    expect(result.run.attempts.map(({ attempt }) => attempt)).toEqual([1, 2]);
    expect(writtenRun(fixture.written).attempts).toHaveLength(2);
  }).pipe(Effect.provide(fixture.fileSystemLayer));
});

it.effect("does not retry at all when retries are disabled", () => {
  const fixture = makeFixture({
    failOn: ({ command }) =>
      command === "click" ? "Selector did not resolve" : undefined,
  });

  return Effect.gen(function* honourZeroRetry() {
    const runner = yield* makeRunnerService(fixture.browser);
    const result = yield* runner.run(
      flow([
        { type: "navigate", url: "https://shop.test/" },
        { offsetX: 1, offsetY: 2, selectors: [["#buy"]], type: "click" },
      ]),
      { outputDirectory: "/runs", retry: 0 }
    );

    // A Flow with real side effects cannot be retried: a rerun places a second
    // order or sends a second email.
    expect(
      fixture.calls.filter(({ command }) => command === "create")
    ).toHaveLength(1);
    expect(result.run.attempts).toHaveLength(1);
    expect(result.run.outcome).toBe("failed");
  }).pipe(Effect.provide(fixture.fileSystemLayer));
});

it.effect("classifies a failed navigation as a siteError", () => {
  const fixture = makeFixture({
    failOn: ({ command }) =>
      command === "goto"
        ? "Navigation failed: net::ERR_NAME_NOT_RESOLVED"
        : undefined,
  });

  return Effect.gen(function* classifyNavigation() {
    const runner = yield* makeRunnerService(fixture.browser);
    const result = yield* runner.run(
      flow([{ type: "navigate", url: "https://gone.test/" }]),
      { outputDirectory: "/runs", retry: 0 }
    );

    expect(result.run.failure?.kind).toBe("siteError");
  }).pipe(Effect.provide(fixture.fileSystemLayer));
});

it.effect("classifies a document served as an error as a siteError", () => {
  const fixture = makeFixture({ documentStatus: 503 });

  return Effect.gen(function* classifyHttpStatus() {
    const runner = yield* makeRunnerService(fixture.browser);
    const result = yield* runner.run(
      flow([
        { type: "navigate", url: "https://shop.test/" },
        { offsetX: 1, offsetY: 2, selectors: [["#buy"]], type: "click" },
      ]),
      { outputDirectory: "/runs", retry: 0 }
    );

    // The navigation itself succeeds, so without this the Flow would fail a
    // few Steps later on a selector missing only because this is an error page.
    expect(result.run.failure?.kind).toBe("siteError");
    expect(result.run.failure?.message).toContain("HTTP 503");
    expect(result.run.failure?.stepIndex).toBe(0);
    expect(fixture.calls.map(({ command }) => command)).not.toContain("click");
  }).pipe(Effect.provide(fixture.fileSystemLayer));
});

it.effect("classifies a selector that never resolves as a flowError", () => {
  const fixture = makeFixture({
    failOn: ({ command }) =>
      command === "click" ? "Element not found: #buy" : undefined,
  });

  return Effect.gen(function* classifySelector() {
    const runner = yield* makeRunnerService(fixture.browser);
    const result = yield* runner.run(
      flow([
        { type: "navigate", url: "https://shop.test/" },
        { offsetX: 1, offsetY: 2, selectors: [["#buy"]], type: "click" },
      ]),
      { outputDirectory: "/runs", retry: 2 }
    );

    // Unresolvable across every attempt: the Flow has gone stale.
    expect(result.run.attempts).toHaveLength(3);
    expect(result.run.failure?.kind).toBe("flowError");
  }).pipe(Effect.provide(fixture.fileSystemLayer));
});

it.live("persists a Run that ran out of time rather than losing it", () => {
  // A real clock: the ceiling has to fire mid-navigation, which needs the
  // navigation to actually take time.
  const fixture = makeFixture({ navigationDelay: Duration.seconds(2) });

  return Effect.gen(function* persistTimedOutRun() {
    const runner = yield* makeRunnerService(fixture.browser);
    const result = yield* runner.run(
      flow([
        { type: "navigate", url: "https://slow.test/" },
        { offsetX: 1, offsetY: 2, selectors: [["#buy"]], type: "click" },
      ]),
      { outputDirectory: "/runs", timeout: Duration.millis(50) }
    );

    // A Run that ran out of time is still a Run; losing it would throw away
    // everything it did establish.
    expect(result.run.outcome).toBe("failed");
    expect(result.run.failure?.message).toContain("ceiling");
    expect(result.run.failure?.kind).toBeUndefined();
    expect(result.run.attempts).toHaveLength(1);
    expect(writtenRun(fixture.written).outcome).toBe("failed");
    expect(runIsBaselineEligible(result.run)).toBe(false);
  }).pipe(Effect.provide(fixture.fileSystemLayer));
});

it.effect("runs a second Run only after the first has finished", () => {
  const fixture = makeFixture();
  const order: string[] = [];

  return Effect.gen(function* serializeRuns() {
    const runner = yield* makeRunnerService(fixture.browser);
    const one = flow([{ type: "navigate", url: "https://one.test/" }], {
      flowId: "one",
    });
    const two = flow([{ type: "navigate", url: "https://two.test/" }], {
      flowId: "two",
    });

    yield* Effect.all(
      [
        runner
          .run(one, { outputDirectory: "/runs" })
          .pipe(Effect.tap(() => Effect.sync(() => order.push("one")))),
        runner
          .run(two, { outputDirectory: "/runs" })
          .pipe(Effect.tap(() => Effect.sync(() => order.push("two")))),
      ],
      { concurrency: "unbounded" }
    );

    // Concurrent Runs contend for CPU, which corrupts both Runs' Core Web
    // Vitals, so the second waits rather than interleaving (ADR 0009).
    const sessions = fixture.calls.filter(({ command }) => command === "close");
    expect(sessions).toHaveLength(2);
    expect(order).toHaveLength(2);
    const closes = fixture.calls
      .map(({ command }, index) => ({ command, index }))
      .filter(({ command }) => command === "create" || command === "close")
      .map(({ command }) => command);
    // create/close strictly alternate: no second session opens while one is up.
    expect(closes).toEqual(["create", "close", "create", "close"]);
  }).pipe(Effect.provide(fixture.fileSystemLayer));
});

it.effect("marks a Run whose Steps failed ineligible as a Baseline", () => {
  const fixture = makeFixture({
    failOn: ({ command }) =>
      command === "click" ? "Element not found: #buy" : undefined,
  });

  return Effect.gen(function* rejectFailedBaseline() {
    const runner = yield* makeRunnerService(fixture.browser);
    const result = yield* runner.run(
      flow([
        { type: "navigate", url: "https://shop.test/" },
        { offsetX: 1, offsetY: 2, selectors: [["#buy"]], type: "click" },
      ]),
      { outputDirectory: "/runs", retry: 0 }
    );

    expect(runIsBaselineEligible(result.run)).toBe(false);
  }).pipe(Effect.provide(fixture.fileSystemLayer));
});

it.effect("writes a Run directory keyed on the Flow's stable identity", () => {
  const fixture = makeFixture();

  return Effect.gen(function* writeRunArtifact() {
    const runner = yield* makeRunnerService(fixture.browser);
    const executed = flow([{ type: "navigate", url: "https://example.com/" }], {
      flowId: "checkout-flow",
    });
    const result = yield* runner.run(executed, { outputDirectory: "/runs" });

    expect(result.directory).toContain("/runs/checkout-flow-");
    expect(fixture.directories).toContain(result.directory);

    const written = writtenRun(fixture.written);
    expect(written.flowId).toBe("checkout-flow");
    expect(written.flowHash).toBe(hashFlow(executed));
    // The Run embeds the Flow it executed, so it is interpretable alone.
    expect(written.flow).toEqual(executed);
    expect(written.runId).toBe(result.run.runId);
  }).pipe(Effect.provide(fixture.fileSystemLayer));
});

it.effect("keys a Flow with no declared identity on its content hash", () => {
  const fixture = makeFixture();

  return Effect.gen(function* fallBackToContentHash() {
    const runner = yield* makeRunnerService(fixture.browser);
    const executed = flow([{ type: "navigate", url: "https://example.com/" }]);
    const result = yield* runner.run(executed, { outputDirectory: "/runs" });

    // Never the title, which the user can edit.
    expect(result.run.flowId).not.toBe("Checkout");
    expect(result.run.flowId).toBe(flowIdentity(executed, hashFlow(executed)));
  }).pipe(Effect.provide(fixture.fileSystemLayer));
});

it.effect("writes a Run even when the Run failed", () => {
  const fixture = makeFixture({
    failOn: ({ command }) =>
      command === "goto" ? "Navigation failed" : undefined,
  });

  return Effect.gen(function* persistFailedRun() {
    const runner = yield* makeRunnerService(fixture.browser);
    const result = yield* runner.run(
      flow([{ type: "navigate", url: "https://example.com/" }]),
      { outputDirectory: "/runs" }
    );

    const written = writtenRun(fixture.written);
    expect(written.outcome).toBe("failed");
    expect(written.failure?.message).toContain("Navigation failed");
    expect(result.run.outcome).toBe("failed");
  }).pipe(Effect.provide(fixture.fileSystemLayer));
});

/** Rebuild an object graph with every key order reversed. */
const withReversedKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(withReversedKeys);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .toReversed()
      .map(([key, entry]) => [key, withReversedKeys(entry)])
  );
};

it.effect("keeps secret values out of the persisted Run", () => {
  const fixture = makeFixture({
    // The browser echoes the value it was given, as a real one does.
    failOn: ({ args, command }) =>
      command === "fill" ? `Could not fill with ${args[1]}` : undefined,
  });

  return Effect.gen(function* redactSecretsFromRun() {
    const runner = yield* makeRunnerService(fixture.browser);
    const result = yield* runner.run(
      flow(
        [
          { type: "navigate", url: "https://example.com/login" },
          { selectors: [["#password"]], type: "change", value: "{{PASSWORD}}" },
        ],
        {
          flowId: "login",
          variables: [{ name: "PASSWORD", runtime: false, secret: true }],
        }
      ),
      {
        outputDirectory: "/runs",
        variables: {
          secretNames: new Set(["PASSWORD"]),
          values: new Map([["PASSWORD", "hunter2"]]),
        },
      }
    );

    // The browser was given the real value...
    expect(fixture.calls.some(({ args }) => args.includes("hunter2"))).toBe(
      true
    );

    // ...but nothing written to disk contains it, including the failure
    // message the browser produced while holding it.
    const serialized = JSON.stringify(writtenRun(fixture.written));
    expect(serialized).not.toContain("hunter2");
    expect(serialized).toContain("{{PASSWORD}}");
    expect(result.run.failure?.message).toContain("{{PASSWORD}}");
  }).pipe(Effect.provide(fixture.fileSystemLayer));
});

it.effect("substitutes a Variable into a navigate URL", () => {
  const fixture = makeFixture();

  return Effect.gen(function* substituteIntoUrl() {
    const runner = yield* makeRunnerService(fixture.browser);
    yield* runner.run(
      flow([{ type: "navigate", url: "https://{{HOST}}/login" }]),
      {
        outputDirectory: "/runs",
        variables: {
          secretNames: new Set(),
          values: new Map([["HOST", "staging.example.com"]]),
        },
      }
    );

    expect(
      fixture.calls.find(({ command }) => command === "goto")?.args[0]
    ).toBe("https://staging.example.com/login");
  }).pipe(Effect.provide(fixture.fileSystemLayer));
});

it("files every Run of a Flow in the directory preflight probes", () => {
  // Preflight and persistence must agree on the path, or preflight checks
  // somewhere the Run never writes.
  const executed = flow([{ type: "navigate", url: "https://example.com/" }], {
    flowId: "checkout-flow",
  });

  expect(flowRunsDirectory("/runs", executed)).toBe(
    `/runs/${flowDirectorySegment("checkout-flow")}`
  );
});

it("hashes a Flow independently of key order", () => {
  // Two Flows that differ only in key order are the same Flow, so a Run's
  // embedded hash must not change when a serializer reorders them.
  const executed = flow([{ type: "navigate", url: "https://a.test/" }]);

  expect(hashFlow(withReversedKeys(executed) as Flow)).toBe(hashFlow(executed));
});

it("translates Chrome Recorder selector forms the browser can use", () => {
  expect(
    selectorCandidates([
      ["aria/Buy now"],
      ["#buy"],
      ["xpath///*[@id='buy']"],
      ["pierce/#buy-inner"],
      ["text/Buy now"],
    ])
  ).toEqual(["#buy", "//*[@id='buy']", "#buy-inner", "text=Buy now"]);
});

it("drops a chained selector rather than acting on the wrong element", () => {
  // Flattening ["#host", "#target"] to "#target" resolves against the top
  // document, which silently clicks a same-named decoy outside the shadow
  // root. Verified against a real browser before this rule was added.
  expect(selectorCandidates([["#host", "#shadow-child"]])).toEqual([]);
  expect(selectorCandidates([["#host", "#shadow-child"], ["#direct"]])).toEqual(
    ["#direct"]
  );
});

it.effect("fails a Step whose only selectors are chains", () => {
  const fixture = makeFixture();

  return Effect.gen(function* rejectChainOnlyStep() {
    const runner = yield* makeRunnerService(fixture.browser);
    const result = yield* runner.run(
      flow([
        { type: "navigate", url: "https://example.com/" },
        {
          offsetX: 1,
          offsetY: 2,
          selectors: [["#host", "#shadow-child"]],
          type: "click",
        },
      ]),
      { outputDirectory: "/runs" }
    );

    expect(fixture.calls.map(({ command }) => command)).not.toContain("click");
    expect(result.run.outcome).toBe("failed");
    expect(result.run.failure?.message).toContain("Chained shadow-root");
  }).pipe(Effect.provide(fixture.fileSystemLayer));
});

it.effect("dispatches a Recorder keyDown and keyUp pair as itself", () => {
  const fixture = makeFixture();

  return Effect.gen(function* replayKeystrokeFaithfully() {
    const runner = yield* makeRunnerService(fixture.browser);
    const result = yield* runner.run(
      flow([
        { type: "navigate", url: "https://example.com/" },
        { key: "Enter", selectors: [["#email"]], type: "keyDown" },
        { key: "Enter", selectors: [["#email"]], type: "keyUp" },
      ]),
      { outputDirectory: "/runs" }
    );

    // One press and one release — not two complete keystrokes, which would
    // submit a form twice.
    expect(
      fixture.calls
        .filter(({ command }) => command.startsWith("key"))
        .map(({ args, command }) => [command, args[0]])
    ).toEqual([
      ["keyDown", "Enter"],
      ["keyUp", "Enter"],
    ]);
    expect(result.run.outcome).toBe("completed");
  }).pipe(Effect.provide(fixture.fileSystemLayer));
});

it.effect("holds a modifier across the Steps it was recorded around", () => {
  const fixture = makeFixture();

  return Effect.gen(function* holdModifier() {
    const runner = yield* makeRunnerService(fixture.browser);
    const result = yield* runner.run(
      flow([
        { type: "navigate", url: "https://example.com/" },
        { key: "Shift", selectors: [["#grid"]], type: "keyDown" },
        { offsetX: 1, offsetY: 2, selectors: [["#row"]], type: "click" },
        { key: "Shift", selectors: [["#grid"]], type: "keyUp" },
      ]),
      { outputDirectory: "/runs" }
    );

    // The Step no longer fails: the modifier goes down, the click happens
    // while it is held, and it comes back up.
    expect(
      fixture.calls
        .filter(({ command }) => command !== "create" && command !== "close")
        .map(({ command }) => command)
    ).toEqual([
      "goto",
      "documentStatus",
      "wait",
      "keyDown",
      "click",
      "wait",
      "keyUp",
    ]);
    expect(result.run.outcome).toBe("completed");
  }).pipe(Effect.provide(fixture.fileSystemLayer));
});

it.effect("fails a Step that targets a nested frame", () => {
  const fixture = makeFixture();

  return Effect.gen(function* rejectFrameStep() {
    const runner = yield* makeRunnerService(fixture.browser);
    const result = yield* runner.run(
      flow([
        { type: "navigate", url: "https://example.com/" },
        {
          frame: [0],
          offsetX: 1,
          offsetY: 2,
          selectors: [["#inside"]],
          type: "click",
        },
      ]),
      { outputDirectory: "/runs" }
    );

    expect(fixture.calls.map(({ command }) => command)).not.toContain("click");
    expect(result.run.outcome).toBe("failed");
    expect(result.run.failure?.message).toContain("nested frame");
  }).pipe(Effect.provide(fixture.fileSystemLayer));
});

it("keeps a hostile Flow identity inside the output directory", () => {
  expect(flowDirectorySegment("../../escaped")).not.toContain("..");
  expect(flowDirectorySegment("../../escaped")).not.toContain("/");
  expect(flowDirectorySegment("a/b\\c")).not.toMatch(/[/\\]/u);
  // A name that sanitizes away entirely still yields a stable segment.
  expect(flowDirectorySegment("../..")).toMatch(/^flow-[a-f0-9]{16}$/u);
  expect(flowDirectorySegment("checkout-flow")).toMatch(
    /^checkout-flow-[a-f0-9]{16}$/u
  );
});

it("gives distinct Flow identities distinct directories", () => {
  // Sanitizing alone maps both of these to "a-b", which would file two
  // unrelated Flows' Runs under one history.
  expect(flowDirectorySegment("a/b")).not.toBe(flowDirectorySegment("a\\b"));

  // Truncation alone collides for identities sharing a long prefix.
  const prefix = "f".repeat(60);
  expect(flowDirectorySegment(`${prefix}-one`)).not.toBe(
    flowDirectorySegment(`${prefix}-two`)
  );
});

it("keeps Windows device names out of a directory key", () => {
  // `CON`, `PRN`, `NUL`, and `COM1`..`LPT9` cannot name a directory on
  // Windows, so a Run would execute and then fail to persist. They stay
  // reserved with an extension and in any case, so a key must never leave a
  // reserved stem before a dot.
  const reservedStems = [
    "CON",
    "PRN",
    "AUX",
    "NUL",
    "COM1",
    "COM9",
    "LPT1",
    "LPT9",
  ];
  const identities = reservedStems.flatMap((stem) => [
    stem,
    stem.toLowerCase(),
    `${stem}.txt`,
    `${stem.toLowerCase()}.log`,
  ]);

  for (const identity of identities) {
    const segment = flowDirectorySegment(identity);
    expect(segment).not.toBe(identity);
    // No dot means the whole segment is the stem, and it ends in the hash.
    expect(segment).not.toContain(".");
    expect(segment).toMatch(/-[a-f0-9]{16}$/u);
  }
});

it("keeps a directory key free of trailing dots and spaces", () => {
  // Windows silently strips both, which would break the mapping.
  expect(flowDirectorySegment("checkout.")).not.toMatch(/[. ]$/u);
  expect(flowDirectorySegment("checkout ")).not.toMatch(/[. ]$/u);
});

it.effect(
  "writes a traversing Flow identity under the output directory",
  () => {
    const fixture = makeFixture();

    return Effect.gen(function* containHostileIdentity() {
      const runner = yield* makeRunnerService(fixture.browser);
      const result = yield* runner.run(
        flow([{ type: "navigate", url: "https://example.com/" }], {
          flowId: "../../etc/escaped",
        }),
        { outputDirectory: "/runs" }
      );

      expect(result.directory.startsWith("/runs/")).toBe(true);
      expect(result.directory).not.toContain("..");
      // The Run still records the identity the Flow declared.
      expect(result.run.flowId).toBe("../../etc/escaped");
    }).pipe(Effect.provide(fixture.fileSystemLayer));
  }
);
