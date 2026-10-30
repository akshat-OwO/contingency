import { AgentSessionId, OperationId } from "@contingency/protocol";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { makeExecutionBoundary } from "../../src/services/execution-boundary.ts";
import { checkNativeAppConfirmation } from "../../src/services/native-app-confirmation.ts";

for (const platform of ["android", "ios"] as const) {
  for (const allow of [true, false]) {
    it.effect(
      `${platform} Confirmation ${allow ? "grants one attempt" : "refuses"}`,
      () =>
        Effect.gen(function* confirmation() {
          const boundary = makeExecutionBoundary({
            hosts: [],
            now: () => new Date(0),
            scope: "interactive",
            sessionId: AgentSessionId.make("agent-native-confirmation"),
          });
          const command = {
            _tag: "input" as const,
            action: { _tag: "activate" as const, target: "@alert" },
            irreversible: true,
            observationId: "one",
            operationId: OperationId.make("first"),
            sessionId: AgentSessionId.make("agent-native-confirmation"),
          };
          const target = {
            name: "Allow",
            packageName: "system.dialog",
            role: "button",
          };
          const check = () =>
            checkNativeAppConfirmation(
              boundary,
              platform,
              command,
              "Login",
              target
            );
          const paused = yield* check();
          expect(paused?.pending.boundary.reason).toBe("confirmation");
          expect(paused?.pending.boundary.action.type).toBe(platform);
          expect(paused?.pending.boundary.description).toBe(
            'Activate button "Allow" in system.dialog'
          );
          if (paused === undefined) {
            return yield* Effect.die("Expected Confirmation");
          }
          const firstId = paused.pending.decision.pendingDecisionId;
          expect(firstId).toBeDefined();
          expect((yield* check())?.created).toBe(false);
          yield* boundary.resolve(
            {
              decision: allow ? "allow" : "refuse",
              operationId: OperationId.make("decision"),
              pendingDecisionId: paused.pending.decision.pendingDecisionId,
            },
            false
          );
          if (allow) {
            expect(yield* check()).toBeUndefined();
          }
          const retry = yield* check();
          expect(retry?.created).toBe(true);
          expect(retry?.pending.decision.pendingDecisionId).not.toBe(firstId);
          boundary.dispose();
        })
    );
  }
}
