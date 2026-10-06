import { ContingencyRpcs, OperationId } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { RpcTest } from "effect/rpc";

import {
  agentProcessLayer,
  findNode,
  resolveBoundary,
  requireBoundaryDecision,
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

it.live(
  "resumes Workspace-approved single and sequence attempts once without reconstructing their requests",
  () =>
    Effect.gen(function* workspaceApproval() {
      const files = yield* FileSystem.FileSystem;
      const root = yield* files.makeTempDirectoryScoped({
        prefix: "contingency-boundary-resume-",
      });
      const fixture = yield* fixtureServer;
      yield* Effect.scoped(
        Effect.gen(function* checkResumption() {
          const client = yield* RpcTest.makeClient(ContingencyRpcs, {
            flatten: true,
          });
          const started = yield* runTool("agent_run_start", {
            inputs: [],
            operationId: OperationId.make("resume-start"),
            referencedSkills: [],
            requestedTask: "Add an anvil to the cart",
            url: fixture.url("task-session.html"),
          });
          const sessionId = started.id;
          const snapshot = yield* sessionTool("agent_browser_snapshot", {
            sessionId,
          });
          const request = {
            action: {
              ref: findNode(snapshot.nodes, "button", "Add anvil").ref,
              type: "click" as const,
            },
            intent: { irreversible: true, objective: "Add an anvil" },
            operationId: OperationId.make("resume-click"),
            sessionId,
          };
          const paused = yield* sessionTool("agent_browser_act", request);
          expect(paused.entry.dispatched).toBe(false);
          const boundaryId = paused.intervention?.id ?? "missing";
          const pending = requireBoundaryDecision(
            yield* sessionTool("agent_session_get", { sessionId }),
            boundaryId
          );
          const premature = yield* Effect.flip(
            sessionTool("agent_browser_resume", { boundaryId, sessionId })
          );
          expect(premature.message).toContain("not approved");
          const answer = {
            decision: "allow" as const,
            operationId: OperationId.make("resume-ui-allow"),
            pendingDecisionId: pending.pendingDecisionId,
            sessionId,
          };
          const approvals = yield* Effect.all(
            [
              client("agent.boundary.decision", answer),
              client("agent.boundary.decision", answer),
            ],
            { concurrency: "unbounded" }
          );
          expect(approvals[0].session.decisionHistory).toEqual(
            approvals[1].session.decisionHistory
          );
          expect(approvals[0].session.decisionHistory.at(-1)?.source).toBe(
            "workspace"
          );
          const mismatch = yield* Effect.flip(
            sessionTool("agent_browser_act", { ...request, intent: {} })
          );
          expect(mismatch.code).toBe("agent_session_conflict");
          const resumed = yield* Effect.all(
            [
              sessionTool("agent_browser_resume", { boundaryId, sessionId }),
              sessionTool("agent_browser_resume", { boundaryId, sessionId }),
            ],
            { concurrency: "unbounded" }
          );
          expect(resumed[0].entry.id).toBe(resumed[1].entry.id);
          expect(resumed[0].entry.dispatched).toBe(true);
          const legacyReplay = yield* sessionTool("agent_browser_act", request);
          expect(legacyReplay.entry.id).toBe(resumed[0].entry.id);
          expect(
            legacyReplay.snapshot.nodes.some((node) =>
              node.name.includes("Cart has 1 items")
            )
          ).toBe(true);

          const sequence = yield* sessionTool("agent_browser_act_sequence", {
            actions: [
              {
                action: request.action,
                intent: request.intent,
                operationId: OperationId.make("resume-sequence-click"),
              },
            ],
            sessionId,
          });
          const sequenceBoundaryId =
            sequence.actions[0]?.intervention?.id ?? "missing";
          const sequencePending = requireBoundaryDecision(
            yield* sessionTool("agent_session_get", { sessionId }),
            sequenceBoundaryId
          );
          yield* client("agent.boundary.decision", {
            ...answer,
            operationId: OperationId.make("resume-ui-sequence"),
            pendingDecisionId: sequencePending.pendingDecisionId,
          });
          // A user handoff before dispatch does not spend the approved operation.
          yield* client("agent.session.takeover", {
            operationId: OperationId.make("resume-takeover"),
            reason: "Inspect cart",
            sessionId,
          });
          const held = yield* Effect.flip(
            sessionTool("agent_browser_resume", {
              boundaryId: sequenceBoundaryId,
              sessionId,
            })
          );
          expect(held.code).toBe("agent_control_unavailable");
          yield* client("agent.session.control.return", {
            operationId: OperationId.make("resume-return"),
            sessionId,
          });
          const recheck = yield* sessionTool("agent_browser_resume", {
            boundaryId: sequenceBoundaryId,
            sessionId,
          });
          expect(recheck.entry.dispatched).toBe(false);
          const freshBoundaryId = recheck.intervention?.id ?? "missing";
          const fresh = requireBoundaryDecision(
            yield* sessionTool("agent_session_get", { sessionId }),
            freshBoundaryId
          );
          yield* client("agent.boundary.decision", {
            ...answer,
            operationId: OperationId.make("resume-ui-after-takeover"),
            pendingDecisionId: fresh.pendingDecisionId,
          });
          const sequenceResumed = yield* sessionTool("agent_browser_resume", {
            boundaryId: freshBoundaryId,
            sessionId,
          });
          expect(sequenceResumed.entry.dispatched).toBe(true);
          const sequenceReplay = yield* sessionTool(
            "agent_browser_act_sequence",
            {
              actions: [
                {
                  action: request.action,
                  intent: request.intent,
                  operationId: OperationId.make("resume-sequence-click"),
                },
              ],
              sessionId,
            }
          );
          expect(sequenceReplay.actions[0]?.entry.id).toBe(
            sequenceResumed.entry.id
          );
          expect(
            sequenceReplay.snapshot?.nodes.some((node) =>
              node.name.includes("Cart has 2 items")
            )
          ).toBe(true);

          const refused = yield* sessionTool("agent_browser_act", {
            ...request,
            operationId: OperationId.make("resume-refused-click"),
          });
          const refusedId = refused.intervention?.id ?? "missing";
          const refusedPending = requireBoundaryDecision(
            yield* sessionTool("agent_session_get", { sessionId }),
            refusedId
          );
          yield* client("agent.session.takeover", {
            operationId: OperationId.make("resume-refuse-takeover"),
            reason: "Refuse from Workspace",
            sessionId,
          });
          const denied = yield* Effect.flip(
            client("agent.boundary.decision", {
              ...answer,
              operationId: OperationId.make("resume-held-allow"),
              pendingDecisionId: refusedPending.pendingDecisionId,
            })
          );
          expect(denied.code).toBe("agent_control_unavailable");
          yield* client("agent.boundary.decision", {
            ...answer,
            decision: "refuse",
            operationId: OperationId.make("resume-ui-refuse"),
            pendingDecisionId: refusedPending.pendingDecisionId,
          });
          const refusal = yield* Effect.flip(
            sessionTool("agent_browser_resume", {
              boundaryId: refusedId,
              sessionId,
            })
          );
          expect(refusal.message).toContain("refused");
          const final = yield* sessionTool("agent_session_get", { sessionId });
          expect(
            final.timeline.filter(
              (entry) => entry.actor === "agent" && entry.dispatched
            )
          ).toHaveLength(2);
          yield* runTool("agent_run_complete", {
            operationId: OperationId.make("resume-complete"),
            sessionId,
          });
        }).pipe(Effect.provide(agentProcessLayer(root)))
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
