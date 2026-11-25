import {
  AgentElementRef,
  AgentSessionCompact,
  AgentSessionHistoryPage,
  AgentSessionSnapshot,
  OperationId,
} from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";

import { connectMcp, servingMcpHttp } from "../helpers/mcp-http.ts";
import {
  agentProcessLayer,
  findNode,
  runTool,
  sessionTool,
} from "./agent-process.ts";
import { fixtureServer } from "./harness.ts";
import { mcpProgram } from "./scripted-agent.ts";

const operation = OperationId.make;

const CompactSessionList = Schema.Struct({
  sessions: Schema.Array(AgentSessionCompact),
});

const SessionStartGuidance = Schema.Struct({
  nextAction: Schema.String,
  viewUrl: Schema.String,
});

it.live(
  "returns an immediate Workspace link reminder for full and compact starts",
  () =>
    Effect.gen(function* startGuidance() {
      const fixture = yield* fixtureServer;
      const { request } = yield* connectMcp(
        yield* servingMcpHttp({ demo: true })
      );
      const { call } = mcpProgram(request);
      const catalog = Schema.decodeUnknownSync(
        Schema.Struct({ workspaceUrl: Schema.String })
      )(yield* call("agent_catalog_get", {}));
      const workspaceUrl = new URL(catalog.workspaceUrl);
      expect(workspaceUrl.pathname).toBe("/");
      expect(workspaceUrl.search).toBe("");
      const sessions = Schema.decodeUnknownSync(CompactSessionList)(
        yield* call("agent_sessions_get", { view: "compact" })
      );
      expect(sessions.sessions).toHaveLength(0);
      for (const view of ["full", "compact"]) {
        for (const name of ["agent_session_start", "agent_example_run_start"]) {
          const args =
            name === "agent_session_start"
              ? {
                  activity: "teaching",
                  clientName: "link-proof",
                  clientVersion: "1",
                  group: "",
                  name: `link-${view}`,
                  url: fixture.url("checkout.html"),
                  viewport: { deviceScaleFactor: 1, height: 480, width: 640 },
                }
              : {
                  example: "example-delivery-cart",
                  inputs: [
                    { name: "city", value: "Boulder" },
                    { name: "area", value: "Pearl Street" },
                    { name: "product", value: "Trail Hammer" },
                  ],
                };
          const answer = yield* call(name, {
            ...args,
            operationId: `link-${name}-${view}`,
            view,
          });
          expect(JSON.stringify(answer)).toMatch(/^\{"nextAction":/u);
          const started =
            Schema.decodeUnknownSync(SessionStartGuidance)(answer);
          expect(new URL(started.viewUrl).origin).toBe(workspaceUrl.origin);
          expect(started.nextAction).toContain(
            `[Open Workspace](${started.viewUrl})`
          );
          expect(started.nextAction).toContain("before calling another tool");
        }
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live("answers compact sessions and pages the history they omit", () =>
  Effect.gen(function* compactSessions() {
    const fixture = yield* fixtureServer;
    const origin = yield* servingMcpHttp();
    const { request } = yield* connectMcp(origin);
    const { call } = mcpProgram(request);

    const startAnswer = yield* call("agent_run_start", {
      inputs: [],
      operationId: "compact-start",
      referencedFlows: [],
      requestedTask: "Fill in the checkout details",
      url: fixture.url("checkout.html"),
    });
    expect(JSON.stringify(startAnswer)).toMatch(/^\{"nextAction":/u);
    const started = Schema.decodeUnknownSync(
      Schema.Struct({
        nextAction: Schema.String,
        ...AgentSessionCompact.fields,
      })
    )(startAnswer);
    expect(started.nextAction).toContain(
      `[Open Workspace](${started.viewUrl})`
    );
    expect(started.view).toBe("compact");
    expect(started.run).toEqual(
      expect.objectContaining({
        kind: "task",
        lifecycle: { phase: "running" },
        requestedTask: "Fill in the checkout details",
      })
    );
    const sessionId = started.id;

    for (const [index, text] of ["Ada", "Grace", "Linus"].entries()) {
      yield* call("agent_browser_act", {
        action: { text: "Checkout", type: "wait_for_text" },
        operationId: `compact-wait-${index}`,
        sessionId,
      });
      yield* call("agent_browser_act", {
        action: { type: "navigate", url: fixture.url("checkout.html") },
        intent: { objective: `Reload before typing ${text}` },
        operationId: `compact-reload-${index}`,
        sessionId,
      });
    }

    const fullAnswer = yield* call("agent_session_get", {
      sessionId,
      view: "full",
    });
    const compactAnswer = yield* call("agent_session_get", { sessionId });
    const full = Schema.decodeUnknownSync(AgentSessionSnapshot)(fullAnswer);
    const compact =
      Schema.decodeUnknownSync(AgentSessionCompact)(compactAnswer);
    expect(compact.history.timeline).toBe(full.timeline.length);
    expect(compact.latestAttempt?.id).toBe(full.timeline.at(-1)?.id);
    expect(compact.pendingDecisions).toEqual(full.pendingDecisions);
    expect(JSON.stringify(compactAnswer).length).toBeLessThan(
      JSON.stringify(fullAnswer).length
    );

    const listed = Schema.decodeUnknownSync(CompactSessionList)(
      yield* call("agent_sessions_get", {})
    );
    expect(listed.sessions.map((session) => session.id)).toEqual([sessionId]);

    // Paging newest first, two at a time, reaches every retained attempt.
    const seen: string[] = [];
    let before: string | null = null;
    do {
      const first = { kind: "timeline", limit: 2, sessionId };
      const args = before === null ? first : { ...first, before };
      const page: AgentSessionHistoryPage = Schema.decodeUnknownSync(
        AgentSessionHistoryPage
      )(yield* call("agent_session_history_get", args));
      expect(page.total).toBe(full.timeline.length);
      seen.push(...page.timeline.map((entry) => entry.id));
      before = page.nextBefore;
    } while (before !== null);
    expect(seen).toEqual(full.timeline.map((entry) => entry.id).toReversed());

    const expired = yield* Effect.flip(
      call("agent_session_history_get", {
        before: "attempt-gone",
        kind: "timeline",
        sessionId,
      })
    );
    expect(expired.code).toBe("agent_session_history_cursor_expired");

    const assessedAnswer = yield* call("agent_run_assess", {
      evidence: [{ id: full.timeline.at(-1)?.id ?? "", kind: "attempt" }],
      explanation: "The checkout page reloaded each time.",
      operationId: "compact-assess",
      outcome: "working",
      sessionId,
      view: "compact",
    });
    const assessed =
      Schema.decodeUnknownSync(AgentSessionCompact)(assessedAnswer);
    expect(assessed.run).toEqual(
      expect.objectContaining({
        assessment: expect.objectContaining({ outcome: "working" }),
      })
    );
    yield* call("agent_run_complete", {
      operationId: "compact-complete",
      sessionId,
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live(
  "performs a bounded action sequence and stops where the agent must look again",
  () =>
    Effect.gen(function* boundedSequence() {
      const files = yield* FileSystem.FileSystem;
      const root = yield* files.makeTempDirectoryScoped({
        prefix: "contingency-sequence-",
      });
      const fixture = yield* fixtureServer;
      yield* Effect.scoped(
        Effect.gen(function* driveSequence() {
          const started = yield* runTool("agent_run_start", {
            inputs: [],
            operationId: operation("sequence-start"),
            referencedFlows: [],
            requestedTask: "Fill in the checkout details",
            url: fixture.url("checkout.html"),
          });
          const sessionId = started.id;
          const page = yield* sessionTool("agent_browser_snapshot", {
            sessionId,
          });
          const name = findNode(page.nodes, "textbox", "Name");
          const email = findNode(page.nodes, "textbox", "Email");
          const colour = findNode(page.nodes, "combobox", "Colour");
          const submit = findNode(page.nodes, "button", "Place order");

          const actions = [
            {
              action: { ref: name.ref, text: "Ada", type: "fill" as const },
              operationId: operation("sequence-name"),
            },
            {
              action: {
                ref: email.ref,
                text: "ada@example.com",
                type: "fill" as const,
              },
              operationId: operation("sequence-email"),
            },
            {
              action: {
                ref: colour.ref,
                type: "select" as const,
                values: ["blue"],
              },
              operationId: operation("sequence-colour"),
            },
          ];
          const filled = yield* sessionTool("agent_browser_act_sequence", {
            actions,
            sessionId,
          });
          expect(filled.stopped).toBeNull();
          expect(filled.actions.map((entry) => entry.entry.outcome)).toEqual([
            "completed",
            "completed",
            "completed",
          ]);
          expect(
            findNode(filled.snapshot?.nodes ?? [], "textbox", "Email").value
          ).toBe("ada@example.com");

          // Replaying the same operation ids replays, not repeats.
          const replayed = yield* sessionTool("agent_browser_act_sequence", {
            actions,
            sessionId,
          });
          expect(replayed.actions.map((entry) => entry.entry.id)).toEqual(
            filled.actions.map((entry) => entry.entry.id)
          );

          const duplicated = yield* Effect.flip(
            sessionTool("agent_browser_act_sequence", {
              actions: [
                {
                  action: { ref: name.ref, text: "Ada", type: "fill" },
                  operationId: operation("sequence-twice"),
                },
                {
                  action: { ref: email.ref, text: "Ada", type: "fill" },
                  operationId: operation("sequence-twice"),
                },
              ],
              sessionId,
            })
          );
          expect(duplicated.code).toBe("agent_session_invalid");

          const navigated = yield* sessionTool("agent_browser_act_sequence", {
            actions: [
              {
                action: { ref: submit.ref, type: "click" },
                operationId: operation("sequence-submit"),
              },
              {
                action: { ref: name.ref, text: "Grace", type: "fill" },
                operationId: operation("sequence-after-submit"),
              },
            ],
            sessionId,
          });
          expect(navigated.stopped).toEqual({
            code: null,
            index: 0,
            message: null,
            reason: "navigated",
          });
          expect(navigated.actions).toHaveLength(1);
          expect(navigated.url).toContain("confirmed.html");

          const stale = yield* sessionTool("agent_browser_act_sequence", {
            actions: [
              {
                action: {
                  type: "navigate",
                  url: fixture.url("checkout.html"),
                },
                operationId: operation("sequence-return"),
              },
              {
                action: { ref: name.ref, text: "Linus", type: "fill" },
                operationId: operation("sequence-stale"),
              },
            ],
            sessionId,
          });
          expect(stale.actions).toHaveLength(1);
          expect(stale.stopped?.index).toBe(0);
          expect(stale.stopped?.reason).toBe("navigated");

          const fresh = yield* sessionTool("agent_browser_snapshot", {
            sessionId,
          });
          const confirm = yield* sessionTool("agent_browser_act_sequence", {
            actions: [
              {
                action: {
                  ref: findNode(fresh.nodes, "button", "Place order").ref,
                  type: "click",
                },
                intent: { irreversible: true },
                operationId: operation("sequence-irreversible"),
              },
            ],
            sessionId,
          });
          expect(confirm.stopped?.reason).toBe("intervention");
          expect(confirm.actions[0]?.intervention?.reason).toBe("confirmation");

          const expiredRef = yield* sessionTool("agent_browser_act_sequence", {
            actions: [
              {
                action: {
                  ref: AgentElementRef.make("e9999"),
                  text: "nobody",
                  type: "fill",
                },
                operationId: operation("sequence-missing-ref"),
              },
            ],
            sessionId,
          });
          expect(expiredRef.actions).toHaveLength(0);
          expect(expiredRef.stopped?.reason).toBe("error");
          expect(expiredRef.stopped?.code).not.toBeNull();
        }).pipe(Effect.provide(agentProcessLayer(root)))
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
