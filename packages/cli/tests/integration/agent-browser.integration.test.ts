import { ContingencyRpcs, OperationId } from "@contingency/protocol";
import type { AgentSnapshotNode } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Stream } from "effect";
import type { Tool } from "effect/unstable/ai";
import { RpcTest } from "effect/unstable/rpc";

import { RpcHandlersLive } from "../../src/routes/rpc.ts";
import { makeAgentSessionLayer } from "../../src/services/agent-session.ts";
import { CreateBrowserLive } from "../../src/services/create-browser.ts";
import {
  AgentSessionToolHandlersLive,
  AgentSessionTools,
} from "../../src/services/mcp-agent-session.ts";
import { RecordingLive } from "../../src/services/recorder.ts";
import { RunSession } from "../../src/services/run-session.ts";
import type { RunSessionService } from "../../src/services/run-session.ts";
import {
  CART_VIEWED_BEACON,
  fixtureServer,
  NEVER_ANSWERED,
  USER_INPUT_BEACON,
} from "./harness.ts";

const viewport = {
  deviceScaleFactor: 1,
  height: 480,
  width: 640,
} as const;

const runSession: RunSessionService = {
  answerVariable: () => Effect.die("Not under test."),
  artifactPath: () => Effect.die("Not under test."),
  changes: () => Stream.never,
  get: () => Effect.succeed(null),
  loadFlow: () => Effect.die("Not under test."),
  start: () => Effect.die("Not under test."),
};

/**
 * Two public seams over one Agent Session, exactly as the product has them:
 * the external agent observes and acts through MCP tools, and the user acts
 * through Agent View's loopback RPC. The browser below is real Chromium —
 * nothing about Browser Snapshots, stale references, or Takeover can be
 * proved against a fake one.
 */
const AgentBrowserLive = Layer.mergeAll(
  RpcHandlersLive,
  AgentSessionToolHandlersLive
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      makeAgentSessionLayer({ baseUrl: "http://127.0.0.1:7777" }),
      RecordingLive
    ).pipe(
      Layer.provideMerge(CreateBrowserLive),
      Layer.provideMerge(NodeServices.layer)
    )
  ),
  Layer.provide(Layer.succeed(RunSession, runSession))
);

const client = RpcTest.makeClient(ContingencyRpcs, { flatten: true });
type AgentClient = Effect.Success<typeof client>;

interface ToolFailure {
  readonly code: string;
  readonly message: string;
}

const isToolFailure = (value: unknown): value is ToolFailure =>
  typeof value === "object" &&
  value !== null &&
  "code" in value &&
  "message" in value;

/**
 * One MCP tool call, as the external agent makes it: validated parameters in,
 * and the tool's success value out — a structured tool failure is raised so a
 * test asserts it with `Effect.flip` rather than by inspecting a union.
 */
type AgentTools = typeof AgentSessionTools.tools;

const callTool = <Name extends keyof AgentTools>(
  name: Name,
  params: Tool.Parameters<AgentTools[Name]>
) =>
  Effect.gen(function* callAgentTool() {
    const toolkit = yield* AgentSessionTools;
    const results = yield* toolkit
      .handle(name, params)
      .pipe(Effect.orDie, Effect.flatMap(Stream.runCollect));
    const last = results.at(-1);
    if (last === undefined) {
      return yield* Effect.die(`The ${String(name)} tool answered nothing.`);
    }
    const { result } = last;
    if (isToolFailure(result)) {
      return yield* Effect.fail(result);
    }
    return result as Tool.Success<AgentTools[Name]>;
  });

const startSession = (agent: AgentClient, url: string, operationId: string) =>
  agent("agent.session.start", {
    data: {
      activity: "run",
      clientName: "integration-agent",
      clientVersion: "1.0.0",
      name: "agent-browser",
      operationId: OperationId.make(operationId),
      url,
      viewport,
    },
    type: "agent.session.start",
  }).pipe(Effect.map(({ data }) => data.session));

const findNode = (
  nodes: readonly AgentSnapshotNode[],
  role: string,
  name: string
): AgentSnapshotNode => {
  const found = nodes.find(
    (node) => node.role === role && node.name.includes(name)
  );
  if (found === undefined) {
    throw new Error(
      `The Browser Snapshot had no ${role} named ${name}: ${nodes
        .map((node) => `${node.role}/${node.name}`)
        .join(", ")}`
    );
  }
  return found;
};

it.live(
  "observes the Page, acts on it, and performs a repeated operation id once",
  () =>
    Effect.gen(function* observeAndAct() {
      const fixtures = yield* fixtureServer;
      const agent = yield* client;
      const session = yield* startSession(
        agent,
        fixtures.url("shop.html"),
        "start-observe"
      );

      const observed = yield* callTool("agent_browser_snapshot", {
        sessionId: session.id,
      });
      const snapshot = observed;
      expect(snapshot.title).toBe("Anvil Works");
      expect(snapshot.url).toBe(fixtures.url("shop.html"));
      // A compact accessibility representation, not a DOM dump.
      expect(JSON.stringify(snapshot)).not.toContain("<button");
      findNode(snapshot.nodes, "heading", "Anvil Works");
      const search = findNode(
        snapshot.nodes,
        "textbox",
        "Search the catalogue"
      );
      const viewCart = findNode(snapshot.nodes, "button", "View cart");

      const filled = yield* callTool("agent_browser_act", {
        action: { ref: search.ref, text: "anvil", type: "fill" },
        operationId: OperationId.make("act-fill"),
        sessionId: session.id,
      });
      expect(filled.entry.outcome).toBe("completed");
      expect(findNode(filled.snapshot.nodes, "textbox", "Search").value).toBe(
        "anvil"
      );

      // The reference came from the Snapshot before the fill, and the fill
      // took another one: within a document, a reference lives until its
      // element does.
      const clicked = yield* callTool("agent_browser_act", {
        action: { ref: viewCart.ref, type: "click" },
        operationId: OperationId.make("act-view-cart"),
        sessionId: session.id,
      });
      expect(clicked.entry.dispatched).toBe(true);
      yield* Effect.sleep("500 millis");
      expect(
        fixtures.requests.filter((path) => path === CART_VIEWED_BEACON)
      ).toHaveLength(1);

      // The same operation id answers with the recorded result and never
      // reaches the browser a second time.
      const replayed = yield* callTool("agent_browser_act", {
        action: { ref: viewCart.ref, type: "click" },
        operationId: OperationId.make("act-view-cart"),
        sessionId: session.id,
      });
      expect(replayed).toEqual(clicked);
      yield* Effect.sleep("500 millis");
      expect(
        fixtures.requests.filter((path) => path === CART_VIEWED_BEACON)
      ).toHaveLength(1);

      const current = yield* agent("agent.session.get", {
        data: { sessionId: session.id },
        type: "agent.session.get",
      });
      // Agent View may be closed at any time; the link is available again for
      // as long as the Agent Session lives.
      expect(current.data.session.viewUrl).toBe(session.viewUrl);
      expect(
        current.data.session.timeline.map(({ description }) => description)
      ).toEqual([`Fill ${search.ref}`, `Click ${viewCart.ref}`]);
      expect(current.data.session.controller).toBe("agent");
    }).pipe(Effect.scoped, Effect.provide(AgentBrowserLive))
);

it.live("reports rows a Page makes clickable only in script", () =>
  Effect.gen(function* scriptedRows() {
    const fixtures = yield* fixtureServer;
    const agent = yield* client;
    const session = yield* startSession(
      agent,
      fixtures.url("scripted-rows.html"),
      "start-scripted-rows"
    );
    const observed = yield* callTool("agent_browser_snapshot", {
      sessionId: session.id,
    });
    expect(observed.nodes.length).toBeLessThanOrEqual(300);

    // The row declares nothing: no role, no href, no onclick attribute. Its
    // pointer cursor is what marks it a control, and its text is what tells
    // it from the row below it.
    const row = findNode(observed.nodes, "generic", "Sector 14");
    expect(row.clickable).toBe(true);
    expect(row.name).toContain("Gurugram");
    const other = findNode(observed.nodes, "generic", "Sector 144");
    expect(other.ref).not.toBe(row.ref);

    // Only the outermost element of an inherited-pointer run is the control,
    // so the row is reported once rather than once per descendant.
    const clickable = observed.nodes.filter((node) => node.clickable === true);
    expect(clickable).toHaveLength(2);

    yield* callTool("agent_browser_act", {
      action: { ref: row.ref, type: "click" },
      operationId: OperationId.make("act-scripted-row"),
      sessionId: session.id,
    });
    const after = yield* callTool("agent_browser_snapshot", {
      sessionId: session.id,
    });
    expect(findNode(after.nodes, "paragraph", "Chosen").name).toContain(
      "gurugram"
    );
  }).pipe(Effect.scoped, Effect.provide(AgentBrowserLive))
);

it.live("expires element references when the Page navigates", () =>
  Effect.gen(function* staleReferences() {
    const fixtures = yield* fixtureServer;
    const agent = yield* client;
    const session = yield* startSession(
      agent,
      fixtures.url("shop.html"),
      "start-stale"
    );
    const observed = yield* callTool("agent_browser_snapshot", {
      sessionId: session.id,
    });
    const viewCart = findNode(observed.nodes, "button", "View cart");

    yield* callTool("agent_browser_act", {
      action: { type: "navigate", url: fixtures.url("cart.html") },
      operationId: OperationId.make("act-navigate"),
      sessionId: session.id,
    });

    // References are minted from a counter that never restarts, so the new
    // document's Snapshot cannot reuse the old numbers, and the superseded
    // reference misses rather than resolving to whatever now sits there.
    const second = yield* callTool("agent_browser_snapshot", {
      sessionId: session.id,
    });
    expect(second.nodes.map(({ ref }) => ref)).not.toContain(viewCart.ref);
    const superseded = yield* Effect.flip(
      callTool("agent_browser_act", {
        action: { ref: viewCart.ref, type: "click" },
        operationId: OperationId.make("act-superseded"),
        sessionId: session.id,
      })
    );
    expect(superseded.code).toBe("agent_element_stale");

    const stale = yield* Effect.flip(
      callTool("agent_browser_act", {
        action: { ref: viewCart.ref, type: "click" },
        operationId: OperationId.make("act-stale"),
        sessionId: session.id,
      })
    );
    expect(stale.code).toBe("agent_element_stale");

    // A meaningful page mutation expires a reference too: this fixture
    // re-creates its button, so the element the Snapshot named is gone even
    // though the Page never navigated.
    yield* callTool("agent_browser_act", {
      action: { type: "navigate", url: fixtures.url("unstable.html") },
      operationId: OperationId.make("act-navigate-unstable"),
      sessionId: session.id,
    });
    const unstable = yield* callTool("agent_browser_snapshot", {
      sessionId: session.id,
    });
    const flappy = findNode(unstable.nodes, "button", "Flappy");
    yield* Effect.sleep("200 millis");
    const mutated = yield* Effect.flip(
      callTool("agent_browser_act", {
        action: { ref: flappy.ref, type: "click" },
        operationId: OperationId.make("act-mutated"),
        sessionId: session.id,
      })
    );
    expect(mutated.code).toBe("agent_element_stale");

    const screenshot = yield* callTool("agent_browser_screenshot", {
      sessionId: session.id,
    });
    expect(screenshot.format).toBe("png");
    expect(screenshot.image.length).toBeGreaterThan(0);
  }).pipe(Effect.scoped, Effect.provide(AgentBrowserLive))
);

it.live(
  "pauses agent actions when the agent requests Takeover and resumes on return",
  () =>
    Effect.gen(function* requestedTakeover() {
      const fixtures = yield* fixtureServer;
      const agent = yield* client;
      const session = yield* startSession(
        agent,
        fixtures.url("shop.html"),
        "start-requested"
      );
      const requested = yield* callTool("agent_session_takeover_request", {
        operationId: OperationId.make("takeover-request"),
        reason: "The catalogue needs a signed-in account.",
        sessionId: session.id,
      });
      // The link comes back immediately: no MCP call is held open while the
      // user acts.
      expect(requested.viewUrl).toBe(session.viewUrl);
      expect(requested.phase).toBe("takeover");
      // The agent may ask, but it cannot hand the user control the user has
      // not taken: the session is paused, not user-driven.
      expect(requested.controller).toBe("agent");
      expect(requested.takeover?.requestedBy).toBe("agent");

      const refused = yield* Effect.flip(
        callTool("agent_browser_act", {
          action: { action: "reload", type: "history" },
          operationId: OperationId.make("act-during-takeover"),
          sessionId: session.id,
        })
      );
      expect(refused.code).toBe("agent_control_unavailable");

      const returned = yield* agent("agent.session.control.return", {
        data: {
          operationId: OperationId.make("control-return"),
          sessionId: session.id,
        },
        type: "agent.session.control.return",
      });
      expect(returned.data.session.controller).toBe("agent");
      expect(returned.data.session.phase).toBe("running");
      expect(returned.data.session.takeover).toBeNull();

      const observed = yield* callTool("agent_browser_snapshot", {
        sessionId: session.id,
      });
      const viewCart = findNode(observed.nodes, "button", "View cart");
      const acted = yield* callTool("agent_browser_act", {
        action: { ref: viewCart.ref, type: "click" },
        operationId: OperationId.make("act-after-return"),
        sessionId: session.id,
      });
      expect(acted.entry.outcome).toBe("completed");
    }).pipe(Effect.scoped, Effect.provide(AgentBrowserLive))
);

it.live("gives a user Takeover priority over the in-flight agent action", () =>
  Effect.gen(function* priorityTakeover() {
    const fixtures = yield* fixtureServer;
    const agent = yield* client;
    const session = yield* startSession(
      agent,
      fixtures.url("shop.html"),
      "start-priority"
    );

    // A navigation the fixture server never answers: the action is dispatched
    // to the browser and still in flight when the user takes control.
    const inFlight = yield* Effect.forkChild(
      Effect.result(
        callTool("agent_browser_act", {
          action: {
            type: "navigate",
            url: `${fixtures.origin}${NEVER_ANSWERED}`,
          },
          operationId: OperationId.make("act-never-answered"),
          sessionId: session.id,
        })
      )
    );
    yield* Effect.sleep("500 millis");

    const takeover = yield* agent("agent.session.takeover", {
      data: {
        operationId: OperationId.make("takeover-user"),
        reason: "I will finish this myself.",
        sessionId: session.id,
      },
      type: "agent.session.takeover",
    });
    expect(takeover.data.session.controller).toBe("user");
    expect(takeover.data.session.takeover?.requestedBy).toBe("user");
    // Takeover cannot undo an effect the browser was already asked for, so the
    // attempt is disclosed rather than erased.
    expect(takeover.data.session.interruptedAction?.dispatched).toBe(true);
    expect(takeover.data.session.interruptedAction?.outcome).toBe(
      "interrupted"
    );
    expect(
      takeover.data.session.timeline.map(({ outcome }) => outcome)
    ).toContain("interrupted");

    const outcome = yield* Fiber.join(inFlight);
    expect(outcome._tag).toBe("Failure");

    // The interrupted action was dispatched, so its operation id is spent:
    // retrying it answers with the same refusal rather than acting again.
    const retried = yield* Effect.flip(
      callTool("agent_browser_act", {
        action: {
          type: "navigate",
          url: `${fixtures.origin}${NEVER_ANSWERED}`,
        },
        operationId: OperationId.make("act-never-answered"),
        sessionId: session.id,
      })
    );
    expect(retried.code).toBe("agent_control_unavailable");
    expect(retried.message).toContain("may already have happened");

    const stillPaused = yield* Effect.flip(
      callTool("agent_browser_act", {
        action: { action: "reload", type: "history" },
        operationId: OperationId.make("act-after-priority"),
        sessionId: session.id,
      })
    );
    expect(stillPaused.code).toBe("agent_control_unavailable");
  }).pipe(Effect.scoped, Effect.provide(AgentBrowserLive))
);

it.live(
  "gives the browser to the user, and only to the user, during Takeover",
  () =>
    Effect.gen(function* userDrivesDuringTakeover() {
      const fixtures = yield* fixtureServer;
      const agent = yield* client;
      const session = yield* startSession(
        agent,
        fixtures.url("takeover.html"),
        "start-user-input"
      );
      const userInput = () =>
        fixtures.requests.filter((path) => path.startsWith(USER_INPUT_BEACON));

      // Control is exclusive: while the agent holds the browser, Agent View
      // cannot drive it.
      const refused = yield* Effect.flip(
        agent("agent.browser.input.send", {
          data: {
            input: {
              button: "left",
              clickCount: 1,
              eventType: "mousePressed",
              type: "input_mouse",
              x: 40,
              y: 40,
            },
            sessionId: session.id,
          },
          type: "agent.browser.input.send",
        })
      );
      expect(refused.code).toBe("agent_control_unavailable");
      expect(userInput()).toHaveLength(0);

      yield* agent("agent.session.takeover", {
        data: {
          operationId: OperationId.make("takeover-to-drive"),
          reason: "I will enter this myself.",
          sessionId: session.id,
        },
        type: "agent.session.takeover",
      });

      yield* agent("agent.browser.input.send", {
        data: {
          input: {
            button: "left",
            clickCount: 1,
            eventType: "mousePressed",
            type: "input_mouse",
            x: 40,
            y: 40,
          },
          sessionId: session.id,
        },
        type: "agent.browser.input.send",
      });
      yield* Effect.sleep("500 millis");
      expect(userInput().length).toBeGreaterThan(0);

      // Agent actions stay disabled until the user explicitly returns control.
      const paused = yield* Effect.flip(
        callTool("agent_browser_act", {
          action: { action: "reload", type: "history" },
          operationId: OperationId.make("act-while-user-drives"),
          sessionId: session.id,
        })
      );
      expect(paused.code).toBe("agent_control_unavailable");

      yield* agent("agent.session.control.return", {
        data: {
          operationId: OperationId.make("return-after-driving"),
          sessionId: session.id,
        },
        type: "agent.session.control.return",
      });
      const afterReturn = yield* Effect.flip(
        agent("agent.browser.input.send", {
          data: {
            input: {
              button: "left",
              clickCount: 1,
              eventType: "mousePressed",
              type: "input_mouse",
              x: 40,
              y: 40,
            },
            sessionId: session.id,
          },
          type: "agent.browser.input.send",
        })
      );
      expect(afterReturn.code).toBe("agent_control_unavailable");
    }).pipe(Effect.scoped, Effect.provide(AgentBrowserLive))
);

it.live("completes an action that navigates the Page it was read from", () =>
  Effect.gen(function* submitNavigates() {
    const fixtures = yield* fixtureServer;
    const agent = yield* client;
    const session = yield* startSession(
      agent,
      fixtures.url("shop.html"),
      "start-submit"
    );
    const observed = yield* callTool("agent_browser_snapshot", {
      sessionId: session.id,
    });
    const search = findNode(observed.nodes, "textbox", "Search the catalogue");

    yield* callTool("agent_browser_act", {
      action: { ref: search.ref, text: "anvil", type: "fill" },
      operationId: OperationId.make("submit-fill"),
      sessionId: session.id,
    });
    // Submitting navigates, which destroys the context the post-action read
    // runs in. The action did happen, so it is reported as what it was.
    const submitted = yield* callTool("agent_browser_act", {
      action: { key: "Enter", ref: search.ref, type: "press" },
      operationId: OperationId.make("submit-enter"),
      sessionId: session.id,
    });
    expect(submitted.entry.outcome).toBe("completed");
    expect(submitted.url).toContain("search=anvil");
    expect(submitted.snapshot.url).toBe(submitted.url);

    const current = yield* agent("agent.session.get", {
      data: { sessionId: session.id },
      type: "agent.session.get",
    });
    expect(current.data.session.currentUrl).toBe(submitted.url);
  }).pipe(Effect.scoped, Effect.provide(AgentBrowserLive))
);

it.live("reads the destination after a same-document navigation", () =>
  Effect.gen(function* sameDocumentNavigation() {
    const fixtures = yield* fixtureServer;
    const agent = yield* client;
    const session = yield* startSession(
      agent,
      fixtures.url("same-document-navigation.html"),
      "start-same-document"
    );
    const observed = yield* callTool("agent_browser_snapshot", {
      sessionId: session.id,
    });
    const navigate = findNode(observed.nodes, "button", "Open destination");

    const navigated = yield* callTool("agent_browser_act", {
      action: { ref: navigate.ref, type: "click" },
      operationId: OperationId.make("act-same-document"),
      sessionId: session.id,
    });

    expect(navigated.snapshot.url).toBe(
      `${fixtures.url("same-document-navigation.html")}/destination`
    );
    findNode(navigated.snapshot.nodes, "heading", "Destination page");
    findNode(navigated.snapshot.nodes, "button", "Continue");
    expect(navigated.snapshot.nodes.map(({ name }) => name)).not.toContain(
      "Origin page"
    );
  }).pipe(Effect.scoped, Effect.provide(AgentBrowserLive))
);

it.live("tells an MCP caller why an action failed", () =>
  Effect.gen(function* readableToolFailure() {
    const fixtures = yield* fixtureServer;
    const agent = yield* client;
    const session = yield* startSession(
      agent,
      fixtures.url("shop.html"),
      "start-failure"
    );

    const failed = yield* Effect.flip(
      callTool("agent_browser_act", {
        action: {
          text: "no such text here",
          timeoutMs: 1000,
          type: "wait_for_text",
        },
        operationId: OperationId.make("failure-wait"),
        sessionId: session.id,
      })
    );
    // The MCP server reports a declared failure to the client by its message,
    // and only when it is an Error. Anything else reaches the agent as
    // "an internal server error", which names no cause it can act on.
    expect(failed).toBeInstanceOf(Error);
    expect(failed.message).toContain("no such text here");
    expect(failed.message).toContain(failed.code);
  }).pipe(Effect.scoped, Effect.provide(AgentBrowserLive))
);
