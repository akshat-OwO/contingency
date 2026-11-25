import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Metric, Schema } from "effect";

import { REDACTED } from "../../src/services/diagnostic-log.ts";
import { connectMcp, servingMcpHttp } from "../helpers/mcp-http.ts";
import { makeRecordingTracer } from "../helpers/recording-tracer.ts";
import { fixtureServer } from "./harness.ts";

const HOME = "/Users/someone";

const Execution = Schema.Struct({
  result: Schema.Struct({
    isError: Schema.Boolean,
    structuredContent: Schema.Struct({
      status: Schema.String,
      value: Schema.optional(Schema.Unknown),
    }),
  }),
});

it.live(
  "gives one web agent action an mcp.tool span with a runtime.act child, through the allowlist",
  () =>
    Effect.gen(function* webAction() {
      const fixture = yield* fixtureServer;
      const { layer, spans, within } = makeRecordingTracer(HOME);
      const { request } = yield* connectMcp(
        yield* servingMcpHttp().pipe(Effect.provide(layer))
      );
      const answer = yield* request("tools/call", {
        arguments: {
          code: `
            const run = await tools.agent_run_start({
              inputs: [],
              operationId: "web-span-start",
              referencedFlows: [],
              requestedTask: "Sign in",
              url: ${JSON.stringify(fixture.url("task-session.html"))},
              view: "compact",
            });
            const page = await tools.agent_browser_snapshot({ sessionId: run.id, format: "structured" });
            const signIn = page.nodes.find((node) => node.role === "button" && node.name.includes("Sign in"));
            await tools.agent_browser_act({
              action: { ref: signIn.ref, type: "click" },
              intent: { objective: "Sign in" },
              operationId: "web-span-click",
              sessionId: run.id,
            });
            return run.id;
          `,
        },
        name: "agent_code_execute",
      });
      const { structuredContent } =
        Schema.decodeUnknownSync(Execution)(answer).result;
      expect(structuredContent.status, JSON.stringify(answer)).toBe(
        "completed"
      );
      const sessionId = Schema.decodeUnknownSync(Schema.String)(
        structuredContent.value
      );

      const act = spans.find(
        (span) =>
          span.name === "mcp.tool" &&
          span.attributes.get("operation") === "agent_browser_act"
      );
      expect(act?.attributes.get("sessionId")).toBe(sessionId);
      expect(act?.attributes.get("outcome")).toBe("succeeded");
      expect(
        spans.some(
          (span) =>
            span.name === "runtime.act" &&
            span.attributes.get("platform") === "web" &&
            span.attributes.get("action") === "click" &&
            within(span, act)
        )
      ).toBe(true);
      // The settled read after the click is part of the same operation.
      expect(
        spans.some(
          (span) =>
            span.name === "runtime.observe" &&
            span.attributes.get("platform") === "web" &&
            within(span, act)
        )
      ).toBe(true);
      const start = spans.find(
        (span) =>
          span.name === "mcp.tool" &&
          span.attributes.get("operation") === "agent_run_start"
      );
      expect(start?.attributes.get("sessionId")).toBe(sessionId);
      for (const span of spans.filter((each) =>
        ["mcp.tool", "runtime.act", "runtime.observe"].includes(each.name)
      )) {
        for (const key of ["operation", "sessionId", "outcome", "platform"]) {
          expect(span.attributes.get(key)).not.toBe(REDACTED);
        }
      }

      const snapshots = yield* Metric.snapshot;
      const duration = snapshots.find(
        (snapshot) =>
          snapshot.id === "contingency.action.duration" &&
          snapshot.attributes?.platform === "web"
      );
      expect(duration?.type === "Histogram" && duration.state.count).toBe(1);
      const calls = snapshots.find(
        (snapshot) =>
          snapshot.id === "contingency.mcp.calls" &&
          snapshot.attributes?.operation === "agent_browser_act" &&
          snapshot.attributes?.outcome === "succeeded"
      );
      expect(calls?.type === "Counter" && calls.state.count).toBe(1);
    }).pipe(
      Effect.scoped,
      Effect.provideService(Metric.MetricRegistry, new Map()),
      Effect.provide(NodeServices.layer)
    )
);
