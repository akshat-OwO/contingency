import type { Flow, Run, SessionId } from "@contingency/protocol";
import { makeBrowserRpcError } from "@contingency/protocol";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";

import type { AgentBrowser } from "../../src/services/agent-browser";
import {
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
  readonly failOn?: (call: BrowserCall) => string | undefined;
}) => {
  const calls: BrowserCall[] = [];
  const written: WrittenFile[] = [];
  const directories: string[] = [];

  const record = (command: string, args: readonly string[]) => {
    const call = { args, command };
    calls.push(call);
    const failure = options?.failOn?.(call);
    return failure === undefined
      ? Effect.void
      : Effect.fail(makeBrowserRpcError("agent_browser_failed", failure));
  };

  const stub: Partial<AgentBrowser> = {
    clickSelector: (_session, selector) => record("click", [selector]),
    close: (session) => record("close", [session]),
    create: (name) =>
      record("create", [name]).pipe(Effect.as(name as SessionId)),
    fillSelector: (_session, selector, value) =>
      record("fill", [selector, value]),
    goto: (_session, url) => record("goto", [url]),
    pressKey: (_session, key) => record("press", [key]),
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
        "click",
        "fill",
        "wait",
        "press",
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

it.effect("writes a Run directory keyed on the Flow's stable identity", () => {
  const fixture = makeFixture();

  return Effect.gen(function* writeRunArtifact() {
    const runner = yield* makeRunnerService(fixture.browser);
    const executed = flow([{ type: "navigate", url: "https://example.com/" }], {
      flowId: "checkout-flow",
    });
    const result = yield* runner.run(executed, { outputDirectory: "/runs" });

    expect(result.directory).toContain("/runs/checkout-flow/");
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

it("addresses the target at the end of a piercing selector chain", () => {
  expect(selectorCandidates([["#host", "#shadow-child"]])).toEqual([
    "#shadow-child",
  ]);
});
