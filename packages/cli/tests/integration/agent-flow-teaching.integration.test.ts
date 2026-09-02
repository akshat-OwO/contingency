import path from "node:path";

import { OperationId } from "@contingency/protocol";
import type {
  AgentFlowDiagnostic,
  AgentSnapshotNode,
  EvidenceSlice,
} from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Stream } from "effect";
import type { Tool, Toolkit } from "effect/unstable/ai";

import { makeAgentFlowCatalogLayer } from "../../src/services/agent-flow-catalog.ts";
import { makeAgentSessionLayer } from "../../src/services/agent-session.ts";
import { CreateBrowserLive } from "../../src/services/create-browser.ts";
import {
  AgentFlowToolHandlersLive,
  AgentFlowTools,
} from "../../src/services/mcp-agent-flow.ts";
import {
  AgentSessionToolHandlersLive,
  AgentSessionTools,
} from "../../src/services/mcp-agent-session.ts";
import { fixtureServer } from "./harness.ts";

const viewport = {
  deviceScaleFactor: 1,
  height: 480,
  width: 640,
} as const;

interface ToolFailure {
  readonly code: string;
  readonly diagnostics?: readonly AgentFlowDiagnostic[];
  readonly message: string;
}

const isToolFailure = (value: unknown): value is ToolFailure =>
  typeof value === "object" &&
  value !== null &&
  "code" in value &&
  "message" in value;

/**
 * One MCP tool call, as the external agent makes it: validated parameters in,
 * the tool's success value out, and a structured failure raised so a test
 * asserts on it with `Effect.flip`.
 */
const makeCall =
  <Tools extends Record<string, Tool.Any>>(toolkit: Toolkit.Toolkit<Tools>) =>
  <Name extends keyof Tools>(
    name: Name,
    params: Tool.Parameters<Tools[Name]>
  ) =>
    Effect.gen(function* callTool() {
      const handlers = yield* toolkit;
      const results = yield* handlers
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
      return result as Tool.Success<Tools[Name]>;
    });

const session = makeCall(AgentSessionTools);
const flow = makeCall(AgentFlowTools);

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

/**
 * The whole Teaching surface over one real Chromium and one temporary Catalog
 * Root: the external agent drives the browser through MCP, reads the bounded
 * Teaching Feed, compiles a draft, and finds it again by search.
 */
const teachingLayer = (catalogRoot: string) =>
  Layer.mergeAll(AgentSessionToolHandlersLive, AgentFlowToolHandlersLive).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        makeAgentSessionLayer({ baseUrl: "http://127.0.0.1:7777" }),
        makeAgentFlowCatalogLayer({ root: catalogRoot })
      ).pipe(
        Layer.provideMerge(CreateBrowserLive),
        Layer.provideMerge(NodeServices.layer)
      )
    )
  );

it.live("teaches a public journey and saves a searchable draft", () =>
  Effect.gen(function* teachPublicJourney() {
    const fileSystem = yield* FileSystem.FileSystem;
    const catalogRoot = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-catalog-",
    });
    yield* Effect.gen(function* teach() {
      const fixtures = yield* fixtureServer;
      const shopUrl = fixtures.url("shop.html");
      const fixtureHost = new URL(shopUrl).hostname;

      const started = yield* session("agent_session_start", {
        activity: "teaching",
        clientName: "integration-agent",
        clientVersion: "1.0.0",
        operationId: OperationId.make("start-teaching"),
        url: shopUrl,
        viewport,
      });
      expect(started.teaching).toEqual({
        actionCount: 0,
        draft: null,
        instructionCount: 0,
      });

      // The user says what to do; the agent relays it and acts.
      yield* flow("agent_teaching_instruction_record", {
        operationId: OperationId.make("instruct-search"),
        sessionId: started.id,
        text: "Search the catalogue for an anvil.",
      });
      const observed = yield* session("agent_browser_snapshot", {
        sessionId: started.id,
      });
      const search = findNode(
        observed.nodes,
        "textbox",
        "Search the catalogue"
      );
      const filled = yield* session("agent_browser_act", {
        action: { ref: search.ref, text: "anvil", type: "fill" },
        operationId: OperationId.make("act-fill"),
        sessionId: started.id,
      });

      yield* flow("agent_teaching_instruction_record", {
        operationId: OperationId.make("instruct-cart"),
        sessionId: started.id,
        text: "Now open the cart and make sure it has one item.",
      });
      const viewCart = findNode(filled.snapshot.nodes, "button", "View cart");
      const clicked = yield* session("agent_browser_act", {
        action: { ref: viewCart.ref, type: "click" },
        operationId: OperationId.make("act-view-cart"),
        sessionId: started.id,
      });
      const waited = yield* session("agent_browser_act", {
        action: { text: "1 item", type: "wait_for_text" },
        operationId: OperationId.make("act-wait-cart"),
        sessionId: started.id,
      });
      // A failed attempt is part of the Demonstration too.
      const failure = yield* Effect.flip(
        session("agent_browser_act", {
          action: { text: "Sold out", timeoutMs: 300, type: "wait_for_text" },
          operationId: OperationId.make("act-wait-missing"),
          sessionId: started.id,
        })
      );
      expect(failure.code).toBe("agent_browser_failed");

      // The bounded feed: instructions, actor-attributed actions, URL
      // transitions, and observed hosts. No cookies, headers, or network.
      const feed = yield* flow("agent_teaching_feed_get", {
        includeSnapshots: true,
        sessionId: started.id,
      });
      expect(feed.instructions.map(({ text }) => text)).toEqual([
        "Search the catalogue for an anvil.",
        "Now open the cart and make sure it has one item.",
      ]);
      expect(feed.actions.map(({ outcome }) => outcome)).toEqual([
        "completed",
        "completed",
        "completed",
        "failed",
      ]);
      expect(feed.actions.every(({ actor }) => actor === "agent")).toBe(true);
      expect(feed.actions[0]?.snapshotBefore).toBe(observed.snapshotId);
      expect(feed.actions[0]?.snapshotAfter).toBe(filled.snapshot.snapshotId);
      expect(feed.actions[0]?.urlBefore).toBe(shopUrl);
      expect(feed.observedHosts).toEqual([fixtureHost]);
      expect(feed.urlTransitions).toEqual([
        expect.objectContaining({
          actionId: null,
          from: "about:blank",
          to: shopUrl,
        }),
      ]);
      expect(feed.snapshots.map(({ snapshotId }) => snapshotId)).toEqual(
        expect.arrayContaining([
          observed.snapshotId,
          filled.snapshot.snapshotId,
          clicked.snapshot.snapshotId,
          waited.snapshot.snapshotId,
        ])
      );
      const serialized = JSON.stringify(feed);
      expect(serialized).not.toContain("cookie");
      expect(serialized).not.toContain("<");

      const [fillAction, clickAction, waitAction] = feed.actions;
      if (
        fillAction === undefined ||
        clickAction === undefined ||
        waitAction === undefined
      ) {
        throw new Error("The feed lost captured actions.");
      }
      const catalogBefore = yield* flow("agent_catalog_get", {});
      expect(catalogBefore).toEqual({ agentFlowCount: 0, root: catalogRoot });

      // Invalid compiler output is refused with diagnostics and saves nothing.
      const refused = yield* Effect.flip(
        flow("agent_flow_draft_save", {
          basedOnRevisionId: null,
          draft: {
            description: "Search and open the cart.",
            domainScope: { hosts: ["shop.example.com"] },
            steps: [
              {
                confirmation: false,
                description: "Type anvil into the search box.",
                firstActionId: fillAction.id,
                lastActionId: "action-missing",
                name: "Search",
              },
            ],
            title: "Anvil cart",
          },
          operationId: OperationId.make("save-refused"),
          sessionId: started.id,
        })
      );
      expect(refused.code).toBe("agent_flow_invalid");
      expect(refused.diagnostics?.map(({ code }) => code)).toEqual([
        "unknown_action",
      ]);
      expect(refused.message).toContain("unknown_action");
      expect((yield* flow("agent_catalog_get", {})).agentFlowCount).toBe(0);

      const saved = yield* flow("agent_flow_draft_save", {
        basedOnRevisionId: null,
        draft: {
          description:
            "Search the catalogue and confirm the cart holds an item.",
          domainScope: { hosts: [fixtureHost] },
          steps: [
            {
              confirmation: false,
              description: "Type anvil into the catalogue search box.",
              firstActionId: fillAction.id,
              lastActionId: fillAction.id,
              name: "Search for an anvil",
            },
            {
              confirmation: false,
              description: "Open the cart and see one item in it.",
              firstActionId: clickAction.id,
              lastActionId: waitAction.id,
              name: "Open the cart",
            },
          ],
          tags: ["shop", "cart"],
          title: "Anvil Works cart check",
        },
        operationId: OperationId.make("save-draft"),
        sessionId: started.id,
      });
      expect(saved.catalogRoot).toBe(catalogRoot);
      expect(saved.manifest.status).toBe("draft");
      expect(saved.manifest.compiler).toEqual({
        clientName: "integration-agent",
        clientVersion: "1.0.0",
      });
      expect(saved.manifest.sourceSessionId).toBe(started.id);
      expect(saved.manifest.emulation.viewport).toEqual(viewport);
      expect(saved.manifest.steps.map(({ name }) => name)).toEqual([
        "Search for an anvil",
        "Open the cart",
      ]);

      // The Evidence Slice is derived from the demonstrated span, with the
      // Page as it stood before and after, and the instruction in force.
      const [, secondStep] = saved.manifest.steps;
      const slice = JSON.parse(
        yield* fileSystem.readFileString(
          path.join(
            catalogRoot,
            "agent-flows",
            saved.manifest.agentFlowId,
            secondStep?.evidence.path ?? ""
          )
        )
      ) as EvidenceSlice;
      expect(slice.actions.map(({ id }) => id)).toEqual([
        clickAction.id,
        waitAction.id,
      ]);
      expect(slice.instructions.map(({ text }) => text)).toEqual([
        "Now open the cart and make sure it has one item.",
      ]);
      expect(slice.before?.snapshotId).toBe(filled.snapshot.snapshotId);
      expect(slice.after?.snapshotId).toBe(waited.snapshot.snapshotId);
      expect(
        findNode(slice.after?.nodes ?? [], "main", "1 item").name
      ).toContain("1 item");
      expect(
        findNode(slice.before?.nodes ?? [], "main", "0 items").name
      ).toContain("0 items");

      // Agent View learns the draft through the session.
      const current = yield* session("agent_session_get", {
        sessionId: started.id,
      });
      expect(current.teaching).toEqual({
        actionCount: 4,
        draft: {
          agentFlowId: saved.manifest.agentFlowId,
          revisionId: saved.manifest.revisionId,
          savedAt: saved.manifest.createdAt,
          title: "Anvil Works cart check",
        },
        instructionCount: 2,
      });

      // A later conversation finds the draft, labelled as one.
      const found = yield* flow("agent_catalog_search", {
        query: "anvil cart",
      });
      expect(found.hits).toHaveLength(1);
      expect(found.hits[0]).toMatchObject({
        agentFlowId: saved.manifest.agentFlowId,
        revisionId: saved.manifest.revisionId,
        status: "draft",
        stepCount: 2,
        title: "Anvil Works cart check",
      });
      const byHost = yield* flow("agent_catalog_search", { host: fixtureHost });
      expect(byHost.hits.map(({ title }) => title)).toEqual([
        "Anvil Works cart check",
      ]);
      const approvedOnly = yield* flow("agent_catalog_search", {
        status: "approved",
      });
      expect(approvedOnly.hits).toEqual([]);
      const read = yield* flow("agent_flow_get", {
        agentFlowId: saved.manifest.agentFlowId,
      });
      expect(read).toEqual(saved);

      yield* session("agent_session_close", {
        operationId: OperationId.make("close-teaching"),
        sessionId: started.id,
      });
    }).pipe(Effect.scoped, Effect.provide(teachingLayer(catalogRoot)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
