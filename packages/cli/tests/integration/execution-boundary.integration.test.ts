import { OperationId } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";

import {
  agentProcessLayer,
  findNode,
  resolveBoundary,
  runTool,
  sessionTool,
} from "./agent-harness.ts";
import { fixtureServer } from "./harness.ts";

it.live(
  "enforces top-level redirect and popup scope while allowing third-party subframes",
  () =>
    Effect.gen(function* interceptNavigation() {
      const files = yield* FileSystem.FileSystem;
      const root = yield* files.makeTempDirectoryScoped({
        prefix: "contingency-navigation-policy-",
      });
      const fixture = yield* fixtureServer;
      yield* Effect.scoped(
        Effect.gen(function* verifyNavigationPolicy() {
          const started = yield* runTool("agent_run_start", {
            inputs: [],
            operationId: OperationId.make("navigation-policy-start"),
            referencedSkills: [],
            requestedTask: "Inspect boundary navigation",
            url: fixture.url("agent-boundary-frame.html"),
          });
          const sessionId = started.id;
          yield* sessionTool("agent_browser_snapshot", { sessionId });
          expect(fixture.requests).toContain("/outside-frame.html");
          expect(
            (yield* sessionTool("agent_session_get", { sessionId })).boundary
          ).toBeNull();

          const redirected = yield* sessionTool("agent_browser_act", {
            action: {
              type: "navigate",
              url: fixture.url("boundary-redirect-chain"),
            },
            operationId: OperationId.make("navigation-policy-redirect"),
            sessionId,
          });
          expect(redirected.intervention?.reason).toBe("domain");
          expect(fixture.requests).toContain("/boundary-redirect");
          expect(fixture.requests).not.toContain("/outside-boundary");
          yield* resolveBoundary({
            boundaryId: redirected.intervention?.id ?? "missing",
            decision: "refuse",
            operationId: "navigation-policy-refuse-redirect",
            sessionId,
          });

          const allowed = yield* sessionTool("agent_browser_act", {
            action: {
              type: "navigate",
              url: fixture.url("boundary-approved-redirect"),
            },
            operationId: OperationId.make(
              "navigation-policy-approved-redirect"
            ),
            sessionId,
          });
          expect(allowed.entry.outcome).toBe("completed");
          expect(allowed.intervention).toBeUndefined();
          const popup = yield* sessionTool("agent_browser_act", {
            action: {
              ref: findNode(allowed.snapshot.nodes, "link", "Outside popup")
                .ref,
              type: "click",
            },
            operationId: OperationId.make("navigation-policy-popup"),
            sessionId,
          });
          expect(popup.intervention?.reason).toBe("domain");
          expect(fixture.requests).not.toContain("/outside-boundary");
          yield* resolveBoundary({
            boundaryId: popup.intervention?.id ?? "missing",
            decision: "refuse",
            operationId: "navigation-policy-refuse-popup",
            sessionId,
          });
          const next = yield* sessionTool("agent_session_get", { sessionId });
          expect(next.boundary).toBeNull();
          expect(
            next.decisionHistory.filter((entry) => entry.kind === "boundary")
          ).toHaveLength(2);
          yield* runTool("agent_run_complete", {
            operationId: OperationId.make("navigation-policy-complete"),
            sessionId,
          });
        }).pipe(Effect.provide(agentProcessLayer(root)))
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
