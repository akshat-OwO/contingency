import {
  AgentElementRef,
  AgentFlowId,
  AgentFlowRevisionId,
  makeBrowserRpcError,
  OperationId,
  SessionId,
  UserAgentProfileId,
} from "@contingency/protocol";
import type {
  BrowserRpcErrorType,
  DraftEmulation,
  Viewport,
} from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Context, Deferred, Effect, Exit, Fiber, Layer, Stream } from "effect";

import {
  AgentSession,
  describeCapturedAction,
  makeAgentSessionLayer,
  makeAgentSessionService,
  verificationStartingUrl,
} from "../../src/services/agent-session.ts";
import type { AgentSessionStartInput } from "../../src/services/agent-session.ts";
import { CreateBrowser } from "../../src/services/create-browser-contract.ts";
import type { CreateBrowserService } from "../../src/services/create-browser-contract.ts";
import { makeDemonstrationCapture } from "../../src/services/teaching-capture.ts";

const viewport = {
  deviceScaleFactor: 1,
  height: 480,
  width: 640,
} as const;

/** One suspended `currentUrl` read: it reports entry, then waits. */
interface HeldRead {
  readonly entered: Deferred.Deferred<true>;
  readonly release: Deferred.Deferred<true>;
}

interface FakeBrowser {
  readonly activePageCalls: () => number;
  readonly browser: CreateBrowserService;
  readonly closed: SessionId[];
  readonly created: SessionId[];
  /** The Emulation each `open` was asked to apply, in order. */
  readonly emulations: DraftEmulation[];
  /** The viewport each session was created at, in order. */
  readonly viewports: Viewport[];
  /** Suspend the next `currentUrl` read, the way a real one can suspend. */
  readonly holdNextCurrentUrl: (held: HeldRead) => void;
  /** Move the fake Page the way a user click during Takeover would. */
  readonly visit: (url: string) => void;
}

const notUnderTest = () => Effect.die("Not under test.");

const makeFakeBrowser = (options?: {
  readonly blockClose?: {
    readonly entered: Deferred.Deferred<true>;
    readonly release: Deferred.Deferred<true>;
  };
  readonly blockCurrentUrl?: Deferred.Deferred<true>;
  readonly failCurrentUrl?: boolean;
  readonly failOpen?: boolean;
}): FakeBrowser => {
  const created: SessionId[] = [];
  const closed: SessionId[] = [];
  const emulations: DraftEmulation[] = [];
  const viewports: Viewport[] = [];
  let pageUrl = "about:blank";
  let activePageCalls = 0;
  const blockClose = options?.blockClose;
  const blockCurrentUrl = options?.blockCurrentUrl;
  /** Armed by a test to suspend the next `currentUrl` read. */
  let hold: HeldRead | undefined;
  const failure = makeBrowserRpcError(
    "agent_browser_failed",
    "The fake browser failed."
  );
  const browser: CreateBrowserService = {
    acknowledgeFrame: notUnderTest,
    // The fake has no real Page, so reaching the browser is observable as
    // this failure rather than as a successful action.
    activePage: () => {
      activePageCalls += 1;
      return Effect.fail(failure);
    },
    clearStorage: notUnderTest,
    close: (sessionId) => {
      if (blockClose === undefined) {
        return Effect.sync(() => {
          closed.push(sessionId);
        });
      }
      return Effect.gen(function* blockedClose() {
        closed.push(sessionId);
        yield* Deferred.succeed(blockClose.entered, true);
        yield* Deferred.await(blockClose.release);
      });
    },
    closeTab: notUnderTest,
    create: (_name, createdViewport) =>
      Effect.sync(() => {
        const sessionId = SessionId.make(`create-agent-${created.length + 1}`);
        created.push(sessionId);
        viewports.push(createdViewport);
        return sessionId;
      }),
    currentUrl: () => {
      if (hold !== undefined) {
        const held = hold;
        hold = undefined;
        return Effect.gen(function* heldCurrentUrl() {
          yield* Deferred.succeed(held.entered, true);
          yield* Deferred.await(held.release);
          return pageUrl;
        });
      }
      if (blockCurrentUrl !== undefined) {
        return Effect.gen(function* blockedCurrentUrl() {
          yield* Deferred.succeed(blockCurrentUrl, true);
          return yield* Effect.never;
        });
      }
      return options?.failCurrentUrl
        ? Effect.fail(failure)
        : Effect.succeed(pageUrl);
    },
    deleteStorage: notUnderTest,
    getEmulation: notUnderTest,
    getNetworkRequest: notUnderTest,
    getNetworkRequests: notUnderTest,
    getStorage: notUnderTest,
    getTabs: notUnderTest,
    list: notUnderTest,
    navigate: notUnderTest,
    newTab: notUnderTest,
    open: (sessionId, url, emulation) => {
      if (options?.failOpen || sessionId === undefined) {
        return Effect.fail(failure);
      }
      pageUrl = url;
      emulations.push(emulation);
      return Effect.succeed({ sessionId, url });
    },
    recorderTarget: notUnderTest,
    sendInput: notUnderTest,
    setEmulation: notUnderTest,
    setStorage: notUnderTest,
    setUserAgent: notUnderTest,
    setViewport: notUnderTest,
    stream: () => Stream.never,
    switchTab: notUnderTest,
  };
  return {
    activePageCalls: () => activePageCalls,
    browser,
    closed,
    created,
    emulations,
    holdNextCurrentUrl: (held) => {
      hold = held;
    },
    viewports,
    visit: (url: string) => {
      pageUrl = url;
    },
  };
};

const startInput = (operationId: string): AgentSessionStartInput => ({
  activity: "run",
  clientName: "test-agent",
  clientVersion: "1",
  name: "test-session",
  operationId: OperationId.make(operationId),
  url: "data:text/html,<main>test</main>",
  viewport,
});

const serviceFor = (fake: FakeBrowser, baseUrl = "http://127.0.0.1:7777") =>
  makeAgentSessionService(fake.browser, {
    baseUrl,
    processId: "test-owner",
  });

it("bounds relayed Teaching instructions without retaining the oldest text", () => {
  const capture = makeDemonstrationCapture("about:blank");
  for (let index = 0; index < 201; index += 1) {
    capture.recordInstruction(
      `Instruction ${index}`,
      "2026-09-01T00:00:00.000Z"
    );
  }
  expect(capture.current().instructions).toHaveLength(200);
  expect(capture.current().instructions[0]?.text).toBe("Instruction 1");
  expect(capture.current().instructions.at(-1)?.text).toBe("Instruction 200");
});

it.effect("replays identical mutations and rejects operation-id reuse", () =>
  Effect.gen(function* idempotentAgentSession() {
    const fake = makeFakeBrowser();
    const service = yield* serviceFor(fake);
    const input = startInput("start-once");
    const started = yield* service.start(input);
    const replay = yield* service.start(input);

    expect(replay).toEqual(started);
    expect(fake.created).toHaveLength(1);

    const startConflict = yield* Effect.flip(
      service.start({ ...input, name: "different-session" })
    );
    expect(startConflict.code).toBe("agent_session_conflict");
    expect(fake.created).toHaveLength(1);

    const closed = yield* service.close(
      started.id,
      OperationId.make("close-once")
    );
    const closeReplay = yield* service.close(
      started.id,
      OperationId.make("close-once")
    );
    expect(closeReplay).toEqual(closed);
    expect(fake.closed).toHaveLength(1);

    const closeConflict = yield* Effect.flip(
      service.close(started.id, OperationId.make("start-once"))
    );
    expect(closeConflict.code).toBe("agent_session_conflict");
    expect(fake.closed).toHaveLength(1);
  })
);

it.effect("closes and forgets a session when setup fails", () =>
  Effect.gen(function* failedAgentSession() {
    const fake = makeFakeBrowser({ failOpen: true });
    const service = yield* serviceFor(fake);
    const failure = yield* Effect.flip(service.start(startInput("failed")));

    expect(failure).toEqual<BrowserRpcErrorType>(
      makeBrowserRpcError("agent_browser_failed", "The fake browser failed.")
    );
    expect(fake.created).toHaveLength(1);
    expect(fake.closed).toEqual(fake.created);
    expect(yield* service.list()).toEqual([]);
  })
);

it.effect("closes a browser when setup is interrupted", () =>
  Effect.gen(function* interruptedSetup() {
    const setupEntered = yield* Deferred.make<true>();
    const fake = makeFakeBrowser({ blockCurrentUrl: setupEntered });
    const context = yield* Layer.build(
      makeAgentSessionLayer({
        baseUrl: "http://127.0.0.1:7777",
        processId: "test-owner",
      }).pipe(
        Layer.provideMerge(Layer.succeed(CreateBrowser, fake.browser)),
        Layer.provideMerge(NodeServices.layer)
      )
    );
    const service = Context.get(context, AgentSession);
    const start = yield* Effect.forkChild(
      service.start(startInput("interrupted"))
    );

    yield* Deferred.await(setupEntered);
    yield* Fiber.interrupt(start);

    expect(fake.closed).toEqual(fake.created);
    expect(fake.closed).toHaveLength(1);
    expect(yield* service.list()).toEqual([]);
  }).pipe(Effect.scoped)
);

it.effect("keeps close atomic when browser cleanup is interrupted", () =>
  Effect.gen(function* interruptedClose() {
    const closeEntered = yield* Deferred.make<true>();
    const releaseClose = yield* Deferred.make<true>();
    const fake = makeFakeBrowser({
      blockClose: { entered: closeEntered, release: releaseClose },
    });
    const service = yield* serviceFor(fake);
    const started = yield* service.start(startInput("close-interrupted"));
    const operationId = OperationId.make("close-after-interrupt");
    const close = yield* Effect.forkChild(
      service.close(started.id, operationId)
    );

    yield* Deferred.await(closeEntered);
    close.interruptUnsafe();
    yield* Deferred.succeed(releaseClose, true);
    yield* Effect.yieldNow;
    const closeExit = yield* Effect.exit(Fiber.join(close));

    expect(Exit.isFailure(closeExit)).toBe(true);
    expect(fake.closed).toEqual(fake.created);
    expect(fake.closed).toHaveLength(1);
    const closed = yield* service.close(started.id, operationId);
    expect(closed.phase).toBe("closed");
    expect(fake.closed).toHaveLength(1);
    expect(yield* service.list()).toEqual([]);
  })
);

it.effect("does not miss changes while delivering the initial snapshot", () =>
  Effect.gen(function* subscribedBeforeInitialSnapshot() {
    const fake = makeFakeBrowser();
    const service = yield* serviceFor(fake);
    const started = yield* service.start(startInput("stream-close"));
    const initialDelivered = yield* Deferred.make<true>();
    const releaseInitial = yield* Deferred.make<true>();
    let isInitial = true;
    const snapshotsFiber = yield* Effect.forkChild(
      service.changes(started.id).pipe(
        Stream.mapEffect((snapshot) => {
          if (!isInitial) {
            return Effect.succeed(snapshot);
          }
          isInitial = false;
          return Deferred.succeed(initialDelivered, true).pipe(
            Effect.andThen(Deferred.await(releaseInitial)),
            Effect.as(snapshot)
          );
        }),
        Stream.take(2),
        Stream.runCollect
      )
    );

    yield* Deferred.await(initialDelivered);
    yield* service.close(started.id);
    yield* Deferred.succeed(releaseInitial, true);
    const snapshots = yield* Fiber.join(snapshotsFiber);

    expect([...snapshots].map(({ phase }) => phase)).toEqual([
      "running",
      "closed",
    ]);
  })
);

it.effect("marks live sessions interrupted during owner shutdown", () =>
  Effect.gen(function* interruptedAgentSession() {
    const fake = makeFakeBrowser();
    const service = yield* serviceFor(fake);
    const started = yield* service.start(startInput("shutdown"));

    yield* service.closeAll();
    const interrupted = yield* service.get(started.id);
    expect(interrupted.phase).toBe("interrupted");
    expect(interrupted.controller).toBe("agent");
    expect(interrupted.error).toContain("owning process stopped");
    expect(fake.closed).toHaveLength(1);

    yield* service.closeAll();
    expect(fake.closed).toHaveLength(1);
    expect(yield* service.list()).toEqual([]);
  })
);

it.effect("refuses a non-loopback Agent View before opening a browser", () =>
  Effect.gen(function* invalidAgentView() {
    const fake = makeFakeBrowser();
    const service = yield* serviceFor(fake, "https://agent.example");
    const failure = yield* Effect.flip(service.start(startInput("invalid")));

    expect(failure.code).toBe("agent_session_invalid");
    expect(fake.created).toHaveLength(0);
  })
);

it.effect(
  "replays an ordinary browser-action failure without dispatching again",
  () =>
    Effect.gen(function* replayFailedAction() {
      const fake = makeFakeBrowser();
      const service = yield* serviceFor(fake);
      const started = yield* service.start(startInput("start-failed-action"));
      const operationId = OperationId.make("failed-action");
      const action = { action: "reload" as const, type: "history" as const };

      const first = yield* Effect.flip(
        service.act(started.id, action, operationId)
      );
      const repeated = yield* Effect.flip(
        service.act(started.id, action, operationId)
      );

      expect(first).toEqual(repeated);
      expect(first.code).toBe("agent_browser_failed");
      expect(fake.activePageCalls()).toBe(1);
    })
);

it.effect("refuses user navigation while the agent holds the browser", () =>
  Effect.gen(function* refuseUserNavigation() {
    const fake = makeFakeBrowser();
    const service = yield* serviceFor(fake);
    const started = yield* service.start(startInput("start-navigation"));

    const refusal = yield* Effect.flip(
      service.userNavigate(started.id, { action: "back", type: "history" })
    );
    expect(refusal.code).toBe("agent_control_unavailable");

    yield* service.takeover(
      started.id,
      "I will finish this myself.",
      OperationId.make("takeover-navigation")
    );
    // Control is the only gate: with it held, navigation reaches the browser
    // rather than being refused.
    const dispatched = yield* Effect.flip(
      service.userNavigate(started.id, { action: "back", type: "history" })
    );
    expect(dispatched.code).toBe("agent_browser_failed");
  })
);

it.effect("reads where the browser is, not where it was last driven", () =>
  Effect.gen(function* trackUserNavigation() {
    const fake = makeFakeBrowser();
    const service = yield* serviceFor(fake);
    const started = yield* service.start(startInput("start-url-tracking"));
    expect(started.currentUrl).toBe("data:text/html,<main>test</main>");

    yield* service.takeover(
      started.id,
      "I will finish this myself.",
      OperationId.make("takeover-url-tracking")
    );
    // A click that navigates goes through raw input: no action path records
    // it, so only re-reading the Page keeps the session honest.
    fake.visit("https://example.com/pricing?access_token=private-value");

    const read = yield* service.get(started.id);
    expect(read.currentUrl).not.toContain("private-value");
    const listed = yield* service.list();
    expect(listed.map(({ currentUrl }) => currentUrl)).toEqual([
      read.currentUrl,
    ]);
  })
);

it.effect("runs a session under the Emulation it was started with", () =>
  Effect.gen(function* mobileAgentSession() {
    const fake = makeFakeBrowser();
    const service = yield* serviceFor(fake);
    const phone = {
      permissions: [],
      userAgentProfile: UserAgentProfileId.make("safari-iphone"),
      viewport: { deviceScaleFactor: 3, height: 844, width: 390 },
    } as const;

    yield* service.start({
      ...startInput("start-mobile"),
      emulation: phone,
    });

    // The browser is created at the Emulation's viewport, not the shorthand
    // one, so the first document is laid out for the device.
    expect(fake.viewports.at(0)).toEqual(phone.viewport);
    expect(fake.emulations.at(0)).toEqual(phone);
  })
);

it.effect("runs the default identity when no Emulation is given", () =>
  Effect.gen(function* defaultAgentSession() {
    const fake = makeFakeBrowser();
    const service = yield* serviceFor(fake);

    yield* service.start(startInput("start-default-identity"));

    expect(fake.viewports.at(0)).toEqual(viewport);
    expect(fake.emulations.at(0)).toEqual({
      permissions: [],
      userAgentProfile: UserAgentProfileId.make("default"),
      viewport,
    });
  })
);

it.effect("refuses to return control that was never taken", () =>
  Effect.gen(function* guardReturnControl() {
    const fake = makeFakeBrowser();
    const service = yield* serviceFor(fake);
    const started = yield* service.start(startInput("start-return-guard"));

    // Nothing to hand back: the agent is running and no one asked for help.
    const refused = yield* Effect.flip(
      service.returnControl(started.id, OperationId.make("return-guard"))
    );
    expect(refused.code).toBe("agent_control_unavailable");
    const current = yield* service.get(started.id);
    expect(current.controller).toBe("agent");
    expect(current.timeline).toHaveLength(0);

    // An agent that asked for help may be resumed without a Takeover, so a
    // paused session still accepts the handover.
    yield* service.requestTakeover(
      started.id,
      "The catalogue needs a signed-in account.",
      OperationId.make("request-return-guard")
    );
    const resumed = yield* service.returnControl(
      started.id,
      OperationId.make("return-guard-resume")
    );
    expect(resumed.controller).toBe("agent");
    expect(resumed.phase).toBe("running");
  })
);

it.effect("applies the Emulation to a session started without a URL", () =>
  Effect.gen(function* emulationWithoutUrl() {
    const fake = makeFakeBrowser();
    const service = yield* serviceFor(fake);
    const phone = {
      permissions: [],
      userAgentProfile: UserAgentProfileId.make("safari-iphone"),
      viewport: { deviceScaleFactor: 3, height: 844, width: 390 },
    } as const;

    yield* service.start({
      ...startInput("start-emulation-no-url"),
      emulation: phone,
      url: undefined,
    });

    // An Emulation reaches a document at its navigation, so a session with no
    // URL still opens one rather than carrying an identity nothing applies.
    expect(fake.emulations.at(0)).toEqual(phone);
  })
);

it.effect("records a Demonstration only for a Teaching session", () =>
  Effect.gen(function* teachingDemonstration() {
    const fake = makeFakeBrowser();
    const service = yield* serviceFor(fake);
    const run = yield* service.start(startInput("start-run-no-feed"));
    expect(run.teaching).toBeNull();
    const refused = yield* Effect.flip(service.teachingFeed(run.id));
    expect(refused.code).toBe("agent_session_invalid");
    const refusedInstruction = yield* Effect.flip(
      service.recordInstruction(run.id, "Open the shop")
    );
    expect(refusedInstruction.code).toBe("agent_session_invalid");

    const teaching = yield* service.start({
      ...startInput("start-teaching"),
      activity: "teaching",
      url: "https://shop.example.com/",
    });
    expect(teaching.teaching).toEqual({
      actionCount: 0,
      draft: null,
      instructionCount: 0,
    });

    const instructed = yield* service.recordInstruction(
      teaching.id,
      "Add the first item to the cart.",
      OperationId.make("instruction-1")
    );
    expect(instructed.teaching?.instructionCount).toBe(1);
    expect(instructed.timeline.at(-1)).toMatchObject({
      actor: "user",
      description: "The user gave an instruction",
      detail: "Add the first item to the cart.",
    });
    const replayed = yield* service.recordInstruction(
      teaching.id,
      "Add the first item to the cart.",
      OperationId.make("instruction-1")
    );
    expect(replayed).toEqual(instructed);
    const conflict = yield* Effect.flip(
      service.recordInstruction(
        teaching.id,
        "Something else.",
        OperationId.make("instruction-1")
      )
    );
    expect(conflict.code).toBe("agent_session_conflict");

    // A URL the user reaches during Takeover is a transition with no action.
    yield* service.takeover(
      teaching.id,
      "I will pick the item.",
      OperationId.make("takeover-teaching")
    );
    fake.visit("https://shop.example.com/cart");
    yield* service.get(teaching.id);

    const feed = yield* service.teachingFeed(teaching.id);
    expect(feed.sessionId).toBe(teaching.id);
    expect(feed.instructions.map(({ text }) => text)).toEqual([
      "Add the first item to the cart.",
    ]);
    expect(feed.actions).toEqual([]);
    expect(feed.snapshots).toEqual([]);
    expect(feed.observedHosts).toEqual([]);
    expect(feed.urlTransitions).toEqual([
      expect.objectContaining({
        actionId: null,
        from: "about:blank",
        to: "https://shop.example.com/",
      }),
      expect.objectContaining({
        actionId: null,
        from: "https://shop.example.com/",
        to: "https://shop.example.com/cart",
      }),
    ]);

    const source = yield* service.teachingSource(teaching.id);
    expect(source.emulation.viewport).toEqual(viewport);
    expect(source.demonstration.instructions).toHaveLength(1);

    const withDraft = yield* service.recordDraft(teaching.id, {
      agentFlowId: AgentFlowId.make("flow-one"),
      revisionId: AgentFlowRevisionId.make("rev-one"),
      savedAt: "2026-09-01T00:00:00.000Z",
      steps: [],
      title: "Shop cart",
    });
    expect(withDraft.teaching?.draft?.title).toBe("Shop cart");
    expect(withDraft.teaching?.instructionCount).toBe(1);
  })
);

it.effect(
  "keeps a Takeover that lands while a snapshot read is in flight",
  () =>
    Effect.gen(function* takeoverSurvivesStaleWrite() {
      const entered = yield* Deferred.make<true>();
      const release = yield* Deferred.make<true>();
      const fake = makeFakeBrowser();
      const service = yield* serviceFor(fake);
      const started = yield* service.start(startInput("start-stale-write"));
      fake.visit("https://example.com/moved");
      fake.holdNextCurrentUrl({ entered, release });

      // The read suspends inside the browser, a Takeover completes, and only
      // then does the read save what it found.
      const reading = yield* Effect.forkChild(service.get(started.id));
      yield* Deferred.await(entered);
      const taken = yield* service.takeover(
        started.id,
        "I will finish this myself.",
        OperationId.make("takeover-stale-write")
      );
      expect(taken.controller).toBe("user");
      yield* Deferred.succeed(release, true);
      const read = yield* Fiber.join(reading);

      expect(read.currentUrl).toBe("https://example.com/moved");
      expect(read.controller).toBe("user");
      expect(read.phase).toBe("takeover");
      const after = yield* service.get(started.id);
      expect(after.controller).toBe("user");
    })
);

/**
 * Teaching *proposes* a Domain Scope; it does not have one yet, so no
 * navigation boundary is installed and nothing is enforced during the draft
 * phase. This is intentional, not an oversight
 * ([ADR 0035](../../docs/adr/0035-domain-scope-governs-top-level-documents.md)).
 */
it.effect("installs no Execution Boundary during Teaching", () =>
  Effect.gen(function* teachingIsUnenforced() {
    const fake = makeFakeBrowser();
    const service = yield* serviceFor(fake);
    // The fake's `recorderTarget` dies, so a session that reached for a page to
    // install a boundary on would fail here rather than start.
    const teaching = yield* service.start({
      ...startInput("start-teaching-unenforced"),
      activity: "teaching",
      url: "https://shop.example.com/",
    });
    expect(teaching.boundary).toBeNull();
  })
);

it("carries only a real page into a Verification Run's starting URL", () => {
  expect(verificationStartingUrl("https://shop.example/cart?item=1")).toBe(
    "https://shop.example/cart?item=1"
  );
  // Credentials and secret query values never travel, the same as anywhere
  // else Contingency records a URL.
  expect(verificationStartingUrl("https://user:pw@shop.example/cart")).toBe(
    "https://shop.example/cart"
  );
  expect(
    verificationStartingUrl("https://shop.example/cart?token=abc123")
  ).toBe("https://shop.example/cart?token=%5Bsensitive%5D");
  // A blank or non-document page leaves the Run opening on `about:blank`.
  expect(verificationStartingUrl("about:blank")).toBeNull();
  expect(verificationStartingUrl("file:///tmp/page.html")).toBeNull();
  expect(verificationStartingUrl("[invalid URL]")).toBeNull();
});

/**
 * A description is a sentence assembled from length-limited fragments, so a
 * private literal longer than that limit is already cut in half by the time a
 * whole-sentence redaction pass looks for it. Redaction runs per field, before
 * assembly, so no prefix of a long token reaches the timeline.
 */
it("redacts a private literal longer than the label limit", () => {
  const secret = `sk-${"a".repeat(200)}`;
  const described = describeCapturedAction(
    { name: "API token", role: "textbox" },
    { ref: AgentElementRef.make("e7"), text: secret, type: "fill" },
    {},
    [secret]
  );
  expect(described).toBe('Fill textbox "API token" with [sensitive input]');
  expect(described).not.toContain("sk-a");
});

/** A control whose accessible name echoes a private value is redacted too. */
it("redacts a private literal in an accessible name or objective", () => {
  const secret = "hunter2-hunter2-hunter2";
  expect(
    describeCapturedAction(
      { name: `Signed in as ${secret}`, role: "button" },
      { ref: AgentElementRef.make("e7"), type: "click" },
      { objective: `Confirm ${secret} is signed in` },
      [secret]
    )
  ).toBe("Confirm [sensitive input] is signed in");
  expect(
    describeCapturedAction(
      { name: `Signed in as ${secret}`, role: "button" },
      { ref: AgentElementRef.make("e7"), type: "click" },
      {},
      [secret]
    )
  ).toBe('Click button "Signed in as [sensitive input]"');
});
