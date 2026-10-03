import {
  AgentElementRef,
  ContingencyRpcs,
  OperationId,
} from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { RpcTest } from "effect/rpc";

import { RpcHandlersLive } from "../../src/routes/rpc.ts";
import { makeAgentSessionLayer } from "../../src/services/agent-session.ts";
import { CreateBrowserLive } from "../../src/services/create-browser.ts";
import {
  AgentSessionToolHandlersLive,
  AgentSessionTools,
} from "../../src/services/mcp-agent-session.ts";
import { findNode, makeCall } from "./agent-harness.ts";
import { fixtureServer } from "./harness.ts";

/**
 * The Browser Snapshot an external agent reads. These tests hold the shape it
 * is handed by default — compact lines, references only where an action can
 * land — and that a reference keeps naming one element across reads, which
 * is what makes a diff between two reads meaningful.
 */
const AgentBrowserLive = Layer.mergeAll(
  RpcHandlersLive,
  AgentSessionToolHandlersLive
).pipe(
  Layer.provideMerge(
    makeAgentSessionLayer({
      allowedActivity: "any",
      baseUrl: "http://127.0.0.1:7777",
    }).pipe(
      Layer.provideMerge(CreateBrowserLive),
      Layer.provideMerge(NodeServices.layer)
    )
  )
);

const client = RpcTest.makeClient(ContingencyRpcs, { flatten: true });
type AgentClient = Effect.Success<typeof client>;

/** Calls as an agent makes them, with no format named. */
const agentTool = makeCall(AgentSessionTools, "agent");
/** Calls that read node fields. */
const callTool = makeCall(AgentSessionTools);

const startSession = (agent: AgentClient, url: string, operationId: string) =>
  agent("agent.session.start", {
    activity: "run",
    clientName: "integration-agent",
    clientVersion: "1.0.0",
    name: "snapshot-format",
    operationId: OperationId.make(operationId),
    url,
    viewport: { deviceScaleFactor: 1, height: 720, width: 1024 },
  }).pipe(Effect.map(({ session }) => session));

/** The reference a text Snapshot gives the control on a line, or a failure. */
const refOn = (text: string, line: RegExp): AgentElementRef => {
  const ref = text.match(line)?.groups?.["ref"];
  if (ref === undefined) {
    throw new Error(`No line matched ${line}:\n${text}`);
  }
  return AgentElementRef.make(ref);
};

it.live("answers agents compact text with references only on controls", () =>
  Effect.gen(function* compactText() {
    const fixtures = yield* fixtureServer;
    const agent = yield* client;
    const session = yield* startSession(
      agent,
      fixtures.url("snapshot-format.html"),
      "format-text"
    );
    const read = yield* agentTool("agent_browser_snapshot", {
      sessionId: session.id,
    });
    expect(read.nodes).toEqual([]);
    const text = read.text ?? "";
    const lines = text.split("\n").map((line) => line.trim());

    // Landmarks and text carry no reference: nothing acts on them.
    expect(lines).toContain('navigation "Primary"');
    expect(lines).toContain("main");
    expect(lines).toContain('heading "Preferences"');
    expect(lines).toContain('form "Settings"');
    // A container does not repeat the text of what it holds, and an inline
    // run of text reads inside its sentence rather than on a line of its own.
    expect(lines).toContain('paragraph "Your plan renews on 1 March."');
    expect(lines.filter((line) => line.includes("1 March"))).toHaveLength(1);
    // A focus target is not a control, and an empty live region says nothing.
    expect(text).not.toMatch(/@e\d+ generic/u);
    expect(text).not.toContain("status");

    // Controls carry the reference an action names them by, and only the
    // state that applies to them.
    expect(text).toMatch(/^\s*@e\d+ link "Shop"$/mu);
    expect(text).toMatch(/^\s*@e\d+ link "Cart"$/mu);
    expect(text).toMatch(/^\s*@e\d+ checkbox "Newsletter" \[unchecked\]$/mu);
    expect(text).toMatch(/^\s*@e\d+ radio "Small" \[checked\]$/mu);
    expect(text).toMatch(/^\s*@e\d+ textbox "Nickname" \[value="Ada"\]$/mu);
    expect(text).toMatch(/^\s*@e\d+ combobox "Colour" \[value="Red"\]$/mu);
    expect(text).toMatch(/^\s*@e\d+ button "Save"$/mu);
    expect(text).not.toContain("Choose…");
    expect(text).not.toContain("checked=false");
    expect(text).not.toContain('value=""');
  }).pipe(Effect.scoped, Effect.provide(AgentBrowserLive))
);

it.live(
  "keeps a control's reference across reads until the Page replaces it",
  () =>
    Effect.gen(function* stableReferences() {
      const fixtures = yield* fixtureServer;
      const agent = yield* client;
      const session = yield* startSession(
        agent,
        fixtures.url("snapshot-format.html"),
        "format-stable"
      );
      const first = yield* callTool("agent_browser_snapshot", {
        sessionId: session.id,
      });
      const second = yield* callTool("agent_browser_snapshot", {
        sessionId: session.id,
      });
      expect(second.nodes.map(({ ref }) => ref)).toEqual(
        first.nodes.map(({ ref }) => ref)
      );

      const save = findNode(first.nodes, "button", "Save");
      const replace = findNode(first.nodes, "button", "Replace save");
      const replaced = yield* callTool("agent_browser_act", {
        action: { ref: replace.ref, type: "click" },
        operationId: OperationId.make("format-replace"),
        sessionId: session.id,
      });
      // The new button reads the same but is another element, so it gets a
      // new reference, and the old one misses instead of finding it.
      const replacement = findNode(replaced.snapshot.nodes, "button", "Save");
      expect(replacement.ref).not.toBe(save.ref);
      expect(findNode(replaced.snapshot.nodes, "button", "Replace").ref).toBe(
        replace.ref
      );
      const stale = yield* Effect.flip(
        callTool("agent_browser_act", {
          action: { ref: save.ref, type: "click" },
          operationId: OperationId.make("format-stale-save"),
          sessionId: session.id,
        })
      );
      expect(stale.code).toBe("agent_element_stale");

      // A reload keeps the URL but replaces the document: every reference
      // ends, and the next read still answers.
      yield* callTool("agent_browser_act", {
        action: { action: "reload", type: "history" },
        operationId: OperationId.make("format-reload"),
        sessionId: session.id,
      });
      const reloaded = yield* callTool("agent_browser_snapshot", {
        sessionId: session.id,
      });
      expect(findNode(reloaded.nodes, "button", "Replace").ref).not.toBe(
        replace.ref
      );
      const expired = yield* Effect.flip(
        callTool("agent_browser_act", {
          action: { ref: replace.ref, type: "click" },
          operationId: OperationId.make("format-stale-replace"),
          sessionId: session.id,
        })
      );
      expect(expired.code).toBe("agent_element_stale");
    }).pipe(Effect.scoped, Effect.provide(AgentBrowserLive))
);

it.live("answers an action with only what changed when asked for a diff", () =>
  Effect.gen(function* diffAfterAction() {
    const fixtures = yield* fixtureServer;
    const agent = yield* client;
    const session = yield* startSession(
      agent,
      fixtures.url("snapshot-format.html"),
      "format-diff"
    );
    const read = yield* agentTool("agent_browser_snapshot", {
      sessionId: session.id,
    });
    const save = refOn(read.text ?? "", /@(?<ref>e\d+) button "Save"$/mu);

    const saved = yield* agentTool("agent_browser_act", {
      action: { ref: save, type: "click" },
      format: "diff",
      operationId: OperationId.make("format-diff-save"),
      sessionId: session.id,
    });
    expect(saved.snapshot.nodes).toEqual([]);
    const diff = saved.snapshot.text ?? "";
    expect(diff).toMatch(/^diff: 1 added, 0 removed, \d+ unchanged$/mu);
    expect(diff).toMatch(/^\+ \s*status "Saved"$/mu);

    // Without a format an action answers the whole Page as text.
    const again = yield* agentTool("agent_browser_act", {
      action: { ref: save, type: "click" },
      operationId: OperationId.make("format-text-save"),
      sessionId: session.id,
    });
    expect(again.snapshot.text).toContain('form "Settings"');
    expect(again.snapshot.text).not.toMatch(/^diff:/u);

    // A diff against another document would describe changes that never
    // happened, so a navigation answers the whole new Page.
    const navigated = yield* agentTool("agent_browser_act", {
      action: { type: "navigate", url: fixtures.url("shop.html") },
      format: "diff",
      operationId: OperationId.make("format-diff-navigate"),
      sessionId: session.id,
    });
    expect(navigated.snapshot.text).not.toMatch(/^diff:/u);
    expect(navigated.snapshot.text).toContain('heading "Anvil Works"');
  }).pipe(Effect.scoped, Effect.provide(AgentBrowserLive))
);

it.live("reads only controls, and link destinations on request", () =>
  Effect.gen(function* scopedReads() {
    const fixtures = yield* fixtureServer;
    const agent = yield* client;
    const session = yield* startSession(
      agent,
      fixtures.url("snapshot-format.html"),
      "format-scope"
    );
    const controls = yield* callTool("agent_browser_snapshot", {
      interactive: true,
      sessionId: session.id,
    });
    expect(controls.coverage?.interactive).toBe(true);
    expect(controls.nodes.length).toBeGreaterThan(0);
    expect(controls.nodes.every((node) => node.interactive === true)).toBe(
      true
    );
    expect(controls.nodes.some((node) => node.role === "heading")).toBe(false);
    findNode(controls.nodes, "checkbox", "Newsletter");

    const plain = yield* callTool("agent_browser_snapshot", {
      sessionId: session.id,
    });
    expect(plain.nodes.some((node) => node.url !== undefined)).toBe(false);

    const linked = yield* callTool("agent_browser_snapshot", {
      sessionId: session.id,
      urls: true,
    });
    expect(findNode(linked.nodes, "link", "Shop").url).toBe("/shop.html");
    // Another origin keeps its whole URL, with secret-looking values masked.
    const help = findNode(linked.nodes, "link", "Help").url ?? "";
    expect(help.startsWith("https://example.com/help?token=")).toBe(true);
    expect(help).not.toContain("abc");
  }).pipe(Effect.scoped, Effect.provide(AgentBrowserLive))
);
