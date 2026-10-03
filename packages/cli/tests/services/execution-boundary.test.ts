import { AgentSessionId, OperationId } from "@contingency/protocol";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { makeExecutionBoundary } from "../../src/services/execution-boundary.ts";
import type {
  BoundaryAttempt,
  BoundaryCheck,
  ExecutionBoundary,
} from "../../src/services/execution-boundary.ts";

const withBoundary = <A, E>(
  use: (boundary: ExecutionBoundary) => Effect.Effect<A, E>,
  scope: "interactive" | "dry-run" = "interactive"
) =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      makeExecutionBoundary({
        hosts: ["shop.example", "*.trusted.example"],
        now: () => new Date("2026-10-03T00:00:00.000Z"),
        scope,
        sessionId: AgentSessionId.make("agent-boundary-test"),
      })
    ),
    use,
    (boundary) => Effect.sync(boundary.dispose)
  );

const attempt = (patch: Partial<BoundaryAttempt> = {}): BoundaryAttempt => ({
  action: { type: "navigate", url: "https://shop.example/cart" },
  capturedAction: { type: "navigate", url: "https://shop.example/cart" },
  description: "Open the cart",
  intent: {},
  objective: "Investigate the cart",
  operationId: "attempt-1",
  step: undefined,
  ...patch,
});

const requirePause = (check: BoundaryCheck | undefined): BoundaryCheck => {
  expect(check).toBeDefined();
  if (check === undefined) {
    throw new Error("Expected a boundary pause");
  }
  return check;
};

const answer = (
  boundary: ExecutionBoundary,
  check: BoundaryCheck,
  decision: "allow" | "refuse" = "allow",
  paused = false
) =>
  boundary.resolve(
    {
      decision,
      operationId: OperationId.make(`answer-${check.pending.boundary.id}`),
      pendingDecisionId: check.pending.decision.pendingDecisionId,
    },
    paused
  );

it.effect(
  "releases policy state without breaking pending-decision scans of ended sessions",
  () =>
    withBoundary((boundary) =>
      Effect.sync(() => {
        expect(boundary.allows("https://shop.example")).toBe(true);
        boundary.dispose();
        expect(boundary.pending()).toBeUndefined();
        expect(boundary.allows("https://shop.example")).toBe(false);
      })
    )
);

it.effect(
  "matches exact and wildcard hosts without admitting apexes, suffix tricks, or non-web URLs",
  () =>
    withBoundary((boundary) =>
      Effect.sync(() => {
        for (const url of [
          "https://SHOP.EXAMPLE:8443/cart",
          "http://a.trusted.example",
          "https://a.b.trusted.example",
        ]) {
          expect(boundary.allows(url)).toBe(true);
        }
        for (const url of [
          "https://trusted.example",
          "https://evilshop.example",
          "https://a.trusted.example.evil",
          "data:text/html,hello",
          "file:///shop.example",
          "not a URL",
        ]) {
          expect(boundary.allows(url)).toBe(false);
        }
      })
    )
);

it.effect(
  "shares a single pending request across navigation and action checks, then grants a host for the Run",
  () =>
    withBoundary((boundary) =>
      Effect.gen(function* checkPolicy1() {
        const navigation = requirePause(
          yield* boundary.checkNavigation(
            "https://outside.example/path?token=secret",
            "click-1"
          )
        );
        expect(navigation.pending.boundary.reason).toBe("domain");
        expect(navigation.pending.decision.boundaryId).toBe(
          navigation.pending.boundary.id
        );
        expect(navigation.pending.decision.scopeSummary).toContain(
          "outside.example"
        );
        const blocked = requirePause(yield* boundary.checkAttempt(attempt()));
        expect(blocked.created).toBe(false);
        expect(blocked.pending).toBe(navigation.pending);
        yield* answer(boundary, navigation);
        expect(boundary.pending()).toBeUndefined();
        expect(boundary.allows("https://outside.example/another-path")).toBe(
          true
        );
        expect(
          yield* boundary.checkNavigation(
            "https://outside.example/another-path",
            "click-2"
          )
        ).toBeUndefined();
      })
    )
);

it.effect(
  "keeps domain, unrelated objective, and Confirmation independent and consumes all grants only at dispatch",
  () =>
    withBoundary((boundary) =>
      Effect.gen(function* checkPolicy2() {
        const input = attempt({
          action: { type: "navigate", url: "https://outside.example" },
          intent: { irreversible: true, objectiveKind: "new" },
        });
        for (const reason of ["domain", "objective", "confirmation"]) {
          const check = requirePause(yield* boundary.checkAttempt(input));
          expect(check.pending.boundary.reason).toBe(reason);
          yield* answer(boundary, check);
        }
        expect(yield* boundary.checkAttempt(input)).toBeUndefined();
        const spent = requirePause(yield* boundary.checkAttempt(input));
        expect(spent.pending.boundary.reason).toBe("objective");
        yield* answer(boundary, spent, "refuse");
        const retry = requirePause(
          yield* boundary.checkAttempt({ ...input, operationId: "retry" })
        );
        expect(retry.pending.boundary.reason).toBe("objective");
      })
    )
);

it.effect(
  "requires fresh Confirmation for a new operation or changed action and preserves an untouched attempt grant",
  () =>
    withBoundary((boundary) =>
      Effect.gen(function* checkPolicy3() {
        const input = attempt({ intent: { irreversible: true } });
        const first = requirePause(yield* boundary.checkAttempt(input));
        yield* answer(boundary, first);
        const changed = requirePause(
          yield* boundary.checkAttempt({
            ...input,
            action: { type: "navigate", url: "https://shop.example/checkout" },
          })
        );
        yield* answer(boundary, changed, "refuse");
        expect(yield* boundary.checkAttempt(input)).toBeUndefined();
        const retry = requirePause(
          yield* boundary.checkAttempt({
            ...input,
            operationId: "retry-after-timeout",
          })
        );
        expect(retry.pending.boundary.reason).toBe("confirmation");
      })
    )
);

it.effect(
  "refuses stale and invalid decisions without consuming the pending request",
  () =>
    withBoundary((boundary) =>
      Effect.gen(function* checkPolicy4() {
        const check = requirePause(
          yield* boundary.checkAttempt(
            attempt({ intent: { irreversible: true } })
          )
        );
        const invalid = yield* Effect.flip(
          boundary.resolve(
            {
              decision: "supply",
              operationId: OperationId.make("invalid"),
              pendingDecisionId: check.pending.decision.pendingDecisionId,
            },
            false
          )
        );
        expect(invalid.code).toBe("agent_session_conflict");
        expect(boundary.pending()).toBe(check.pending);
        yield* answer(boundary, check, "refuse");
        expect((yield* Effect.flip(answer(boundary, check))).code).toBe(
          "agent_session_conflict"
        );
        const next = requirePause(
          yield* boundary.checkAttempt(
            attempt({ intent: { irreversible: true } })
          )
        );
        expect(next.pending.decision.pendingDecisionId).not.toBe(
          check.pending.decision.pendingDecisionId
        );
        expect((yield* Effect.flip(answer(boundary, check))).code).toBe(
          "agent_session_conflict"
        );
        expect(boundary.pending()).toBe(next.pending);
      })
    )
);

it.effect(
  "rejects non-HTTP approvals and retains their pending request for refusal",
  () =>
    withBoundary((boundary) =>
      Effect.gen(function* checkPolicy5() {
        for (const url of ["file:///tmp/page", "not a URL"]) {
          const check = requirePause(
            yield* boundary.checkNavigation(url, "navigation")
          );
          expect((yield* Effect.flip(answer(boundary, check))).code).toBe(
            "agent_session_invalid"
          );
          expect(boundary.pending()).toBe(check.pending);
          yield* answer(boundary, check, "refuse");
        }
      })
    )
);

it.effect(
  "invalidates attempt grants on Takeover, retains host approvals, and permits refusal while paused",
  () =>
    withBoundary((boundary) =>
      Effect.gen(function* checkPolicy6() {
        const domain = requirePause(
          yield* boundary.checkNavigation(
            "https://outside.example",
            "navigation"
          )
        );
        yield* answer(boundary, domain);
        const input = attempt({ intent: { irreversible: true } });
        const check = requirePause(yield* boundary.checkAttempt(input));
        expect(
          (yield* Effect.flip(answer(boundary, check, "allow", true))).code
        ).toBe("agent_control_unavailable");
        yield* answer(boundary, check, "refuse", true);
        const approved = requirePause(yield* boundary.checkAttempt(input));
        yield* answer(boundary, approved);
        boundary.invalidateAttempts();
        expect(boundary.allows("https://outside.example")).toBe(true);
        expect(
          requirePause(yield* boundary.checkAttempt(input)).pending.boundary
            .reason
        ).toBe("confirmation");
      })
    )
);

it.effect(
  "authorizes task exploration and preserves historical Step Confirmation without treating objective prose as authority",
  () =>
    withBoundary((boundary) =>
      Effect.gen(function* checkPolicy7() {
        expect(
          yield* boundary.checkAttempt(
            attempt({
              intent: {
                objective: "Explore an alternate route",
                objectiveKind: "task",
              },
            })
          )
        ).toBeUndefined();
        const unrelated = requirePause(
          yield* boundary.checkAttempt(
            attempt({
              intent: { objectiveKind: "new" },
              objective: "New user instruction",
            })
          )
        );
        expect(unrelated.pending.boundary.reason).toBe("objective");
        expect(unrelated.pending.boundary.requested).toBe(
          "New user instruction"
        );
        yield* answer(boundary, unrelated, "refuse");
        const step = { confirmation: true, index: 2 };
        expect(yield* boundary.checkAttempt(attempt({ step }))).toBeUndefined();
        const action = { key: "Enter", type: "press" as const };
        const historical = requirePause(
          yield* boundary.checkAttempt(
            attempt({ action, capturedAction: action, step })
          )
        );
        expect(historical.pending.boundary.reason).toBe("confirmation");
        yield* answer(boundary, historical);
        const nextStep = requirePause(
          yield* boundary.checkAttempt(
            attempt({
              action,
              capturedAction: action,
              step: { ...step, index: 3 },
            })
          )
        );
        expect(nextStep.pending.boundary.reason).toBe("confirmation");
      })
    )
);

it.effect("admits later requested Interactive Run hosts", () =>
  withBoundary((boundary) =>
    Effect.gen(function* checkPolicy8() {
      expect(boundary.allows("https://later.example")).toBe(false);
      yield* boundary.admitRequestedHosts(["LATER.EXAMPLE"]);
      expect(boundary.allows("https://later.example")).toBe(true);
    })
  )
);

it.effect(
  "keeps Dry Run scope fixed when a prerequisite declares another host",
  () =>
    withBoundary(
      (boundary) =>
        Effect.gen(function* checkPolicy9() {
          expect(
            (yield* Effect.flip(
              boundary.admitRequestedHosts(["prerequisite.example"])
            )).code
          ).toBe("agent_session_invalid");
          expect(boundary.allows("https://prerequisite.example")).toBe(false);
          expect(boundary.allows("https://shop.example")).toBe(true);
        }),
      "dry-run"
    )
);
