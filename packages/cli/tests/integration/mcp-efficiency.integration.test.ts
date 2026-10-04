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
import type { JsonValue } from "../helpers/mcp-http.ts";
import {
  agentProcessLayer,
  findNode,
  runTool,
  sessionTool,
} from "./agent-harness.ts";
import { fixtureServer } from "./harness.ts";

const operation = OperationId.make;

const CallResult = Schema.Struct({
  result: Schema.Struct({
    isError: Schema.Boolean,
    structuredContent: Schema.optional(Schema.Unknown),
  }),
});

/** One MCP tool call over the real HTTP transport. */
const callOver =
  (
    request: (
      method: string,
      params: { readonly [key: string]: JsonValue }
    ) => Effect.Effect<unknown>
  ) =>
  <A>(
    schema: Schema.Decoder<A>,
    name: string,
    args: { readonly [key: string]: JsonValue }
  ) =>
    Effect.gen(function* callTool() {
      const body = yield* request("tools/call", { arguments: args, name });
      const { result } = Schema.decodeUnknownSync(CallResult)(body);
      expect(result.isError, JSON.stringify(body)).toBe(false);
      if (name.endsWith("_start")) {
        expect(JSON.stringify(result.structuredContent)).toMatch(
          /^\{"nextAction":/u
        );
      }
      return {
        bytes: JSON.stringify(result.structuredContent).length,
        value: Schema.decodeUnknownSync(schema)(result.structuredContent),
      };
    });

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
      const { request } = yield* connectMcp(yield* servingMcpHttp());
      const call = callOver(request);
      const catalog = yield* call(
        Schema.Struct({ workspaceUrl: Schema.String }),
        "agent_catalog_get",
        {}
      );
      const workspaceUrl = new URL(catalog.value.workspaceUrl);
      expect(workspaceUrl.pathname).toBe("/");
      expect(workspaceUrl.search).toBe("");
      const sessions = yield* call(CompactSessionList, "agent_sessions_get", {
        view: "compact",
      });
      expect(sessions.value.sessions).toHaveLength(0);
      for (const view of ["full", "compact"]) {
        for (const name of ["agent_session_start", "agent_example_run_start"]) {
          const args =
            name === "agent_session_start"
              ? {
                  activity: "teaching",
                  clientName: "link-proof",
                  clientVersion: "1",
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
          const started = yield* call(SessionStartGuidance, name, {
            ...args,
            operationId: `link-${name}-${view}`,
            view,
          });
          expect(new URL(started.value.viewUrl).origin).toBe(
            workspaceUrl.origin
          );
          expect(started.value.nextAction).toContain(
            `[Open Workspace](${started.value.viewUrl})`
          );
          expect(started.value.nextAction).toContain(
            "before calling another tool"
          );
        }
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live("answers compact sessions and pages the history they omit", () =>
  Effect.gen(function* compactSessions() {
    const fixture = yield* fixtureServer;
    const origin = yield* servingMcpHttp();
    const { request } = yield* connectMcp(origin);
    const call = callOver(request);

    const started = yield* call(
      Schema.Struct({
        nextAction: Schema.String,
        ...AgentSessionCompact.fields,
      }),
      "agent_run_start",
      {
        inputs: [],
        operationId: "compact-start",
        referencedSkills: [],
        requestedTask: "Fill in the checkout details",
        url: fixture.url("checkout.html"),
        view: "compact",
      }
    );
    expect(started.value.nextAction).toContain(
      `[Open Workspace](${started.value.viewUrl})`
    );
    expect(started.value.view).toBe("compact");
    expect(started.value.run).toEqual(
      expect.objectContaining({
        kind: "task",
        lifecycle: { phase: "running" },
        requestedTask: "Fill in the checkout details",
      })
    );
    const sessionId = started.value.id;

    for (const [index, text] of ["Ada", "Grace", "Linus"].entries()) {
      yield* request("tools/call", {
        arguments: {
          action: { text: "Checkout", type: "wait_for_text" },
          operationId: `compact-wait-${index}`,
          sessionId,
        },
        name: "agent_browser_act",
      });
      yield* request("tools/call", {
        arguments: {
          action: { type: "navigate", url: fixture.url("checkout.html") },
          intent: { objective: `Reload before typing ${text}` },
          operationId: `compact-reload-${index}`,
          sessionId,
        },
        name: "agent_browser_act",
      });
    }

    const full = yield* call(AgentSessionSnapshot, "agent_session_get", {
      sessionId,
    });
    const compact = yield* call(AgentSessionCompact, "agent_session_get", {
      sessionId,
      view: "compact",
    });
    expect(compact.value.history.timeline).toBe(full.value.timeline.length);
    expect(compact.value.latestAttempt?.id).toBe(
      full.value.timeline.at(-1)?.id
    );
    expect(compact.value.pendingDecisions).toEqual(full.value.pendingDecisions);
    expect(compact.bytes).toBeLessThan(full.bytes);

    const listed = yield* call(CompactSessionList, "agent_sessions_get", {
      view: "compact",
    });
    expect(listed.value.sessions.map((session) => session.id)).toEqual([
      sessionId,
    ]);

    // Paging newest first, two at a time, reaches every retained attempt.
    const seen: string[] = [];
    let before: string | null = null;
    do {
      const first = { kind: "timeline", limit: 2, sessionId };
      const args = before === null ? first : { ...first, before };
      const page: { readonly value: AgentSessionHistoryPage } = yield* call(
        AgentSessionHistoryPage,
        "agent_session_history_get",
        args
      );
      expect(page.value.total).toBe(full.value.timeline.length);
      seen.push(...page.value.timeline.map((entry) => entry.id));
      before = page.value.nextBefore;
    } while (before !== null);
    expect(seen).toEqual(
      full.value.timeline.map((entry) => entry.id).toReversed()
    );

    const expired = yield* request("tools/call", {
      arguments: { before: "attempt-gone", kind: "timeline", sessionId },
      name: "agent_session_history_get",
    });
    expect(JSON.stringify(expired)).toContain(
      "agent_session_history_cursor_expired"
    );

    const assessed = yield* call(AgentSessionCompact, "agent_run_assess", {
      evidence: [{ id: full.value.timeline.at(-1)?.id ?? "", kind: "attempt" }],
      explanation: "The checkout page reloaded each time.",
      operationId: "compact-assess",
      outcome: "working",
      sessionId,
      view: "compact",
    });
    expect(assessed.value.run).toEqual(
      expect.objectContaining({
        assessment: expect.objectContaining({ outcome: "working" }),
      })
    );
    yield* request("tools/call", {
      arguments: { operationId: "compact-complete", sessionId },
      name: "agent_run_complete",
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
            referencedSkills: [],
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
