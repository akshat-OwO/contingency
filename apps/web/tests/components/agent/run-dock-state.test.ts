import { AgentSessionSnapshot } from "@contingency/protocol";
import { Schema } from "effect";
import { expect, test } from "vitest";

import {
  AGENT_IDLE_NOTICE_MS,
  agentIdleNotice,
  runDockPresentation,
} from "@/components/agent/run-dock-state";
import type { RunSessionSnapshot } from "@/components/agent/run-dock-state";

const lastActivity = Date.parse("2026-09-28T12:00:00.000Z");

const sessionWith = (
  overrides: {
    readonly controller?: "agent" | "user";
    readonly outcome?: "completed" | null;
    readonly phase?: "running" | "takeover";
  } = {}
) => ({
  controller: overrides.controller ?? "agent",
  phase: overrides.phase ?? "running",
  run: {
    lastAgentActivityAt: new Date(lastActivity).toISOString(),
    outcome: overrides.outcome ?? null,
  },
});

test("says nothing until the agent has been quiet for ten minutes", () => {
  expect(AGENT_IDLE_NOTICE_MS).toBe(10 * 60_000);
  expect(
    agentIdleNotice(sessionWith(), lastActivity + AGENT_IDLE_NOTICE_MS - 1)
  ).toBeUndefined();
  expect(
    agentIdleNotice(sessionWith(), lastActivity + AGENT_IDLE_NOTICE_MS)
  ).toBe("Agent idle for 10 min");
  expect(agentIdleNotice(sessionWith(), lastActivity + 47.5 * 60_000)).toBe(
    "Agent idle for 47 min"
  );
});

test("takes an injected threshold", () => {
  expect(agentIdleNotice(sessionWith(), lastActivity + 60_000, 60_000)).toBe(
    "Agent idle for 1 min"
  );
});

test("an agent waiting on the user is not idle", () => {
  expect(
    agentIdleNotice(
      sessionWith({ controller: "user" }),
      lastActivity + 60 * 60_000
    )
  ).toBeUndefined();
});

test("an agent that asked for a Takeover is waiting, not idle", () => {
  expect(
    agentIdleNotice(
      sessionWith({ phase: "takeover" }),
      lastActivity + 60 * 60_000
    )
  ).toBeUndefined();
});

test("an ended Run has no idle agent", () => {
  expect(
    agentIdleNotice(
      sessionWith({ outcome: "completed" }),
      lastActivity + 60 * 60_000
    )
  ).toBeUndefined();
});

const decodeSnapshot = Schema.decodeUnknownSync(AgentSessionSnapshot);
const at = "2026-09-02T00:00:00.000Z";

/** A Run session decoded through the protocol, as the Workspace receives it. */
const runSession = (
  overrides: Readonly<Record<string, Schema.Json>>
): RunSessionSnapshot => {
  const session = decodeSnapshot({
    activity: "run",
    boundary: null,
    captureState: null,
    clientName: "Test agent",
    clientVersion: "1.0",
    controller: "agent",
    createdAt: at,
    currentUrl: "https://shop.example.com/",
    dryRun: null,
    flowName: "checkout",
    id: "agent-one",
    interruptedAction: null,
    ownerProcessId: "mcp-test",
    pendingDecisions: [],
    phase: "running",
    recordingId: "recording-checkout",
    run: null,
    takeover: null,
    teaching: null,
    timeline: [],
    updatedAt: at,
    viewUrl: "http://127.0.0.1:7777/?session=agent-one",
    ...overrides,
  });
  if (session.activity !== "run") {
    throw new Error("expected a Run session");
  }
  return session;
};

test("a Run waiting on the person asks for attention", () => {
  expect(
    runDockPresentation(runSession({ phase: "takeover" }), true).tone
  ).toBe("attention");
  expect(
    runDockPresentation(
      runSession({
        boundary: {
          action: { ref: "e1", type: "click" },
          description: "Place the order",
          id: "boundary-1",
          operationId: "op-1",
          reason: "confirmation",
          requested: "Click Place order",
        },
      }),
      true
    ).tone
  ).toBe("attention");
});

test("the user driving is live; the agent driving, starting or reconnecting is busy", () => {
  // The agent driving reads as running work, so the pointer mark stays the
  // user's own (#753).
  expect(runDockPresentation(runSession({}), true).tone).toBe("busy");
  expect(
    runDockPresentation(
      runSession({ controller: "user", phase: "takeover" }),
      true
    ).tone
  ).toBe("live");
  expect(runDockPresentation(runSession({}), false).tone).toBe("busy");
  expect(
    runDockPresentation(runSession({ phase: "starting" }), true).tone
  ).toBe("busy");
});

test("an ended Run reads Ended unless it failed", () => {
  const closed = runDockPresentation(runSession({ phase: "closed" }), true);
  expect(closed.tone).toBe("ended");
  expect(closed.badge).toBe("Ended");
  // Nothing here drives the browser any more (#757).
  expect(closed.nextStep).toBe(
    "This browser session ended. Its Run is read-only."
  );
  expect(
    runDockPresentation(runSession({ phase: "completed" }), true).tone
  ).toBe("ended");
  expect(
    runDockPresentation(runSession({ phase: "interrupted" }), true).tone
  ).toBe("failed");
});

test("the badge says who drives and what waits on the person", () => {
  const driving = runDockPresentation(runSession({}), true);
  expect(driving.badge).toBe("Agent driving");
  // The badge already names the holder, so the sentence does not repeat it.
  expect(driving.nextStep).not.toContain("The agent has control");
  const boundary = runDockPresentation(
    runSession({
      boundary: {
        action: { ref: "e1", type: "click" },
        description: "Place the order",
        id: "boundary-1",
        operationId: "op-1",
        reason: "confirmation",
        requested: "Click Place order",
      },
    }),
    true
  );
  expect(boundary.badge).toBe("Needs you");
  // The status line is a sentence, never an empty button (#753).
  expect(boundary.nextStep).toBe(
    "The agent is waiting on you. Answer the request to let it continue; nothing runs until you do."
  );
});

test("any open request turns the chip to Needs you", () => {
  const variable = runDockPresentation(
    runSession({
      pendingDecisions: [
        {
          createdAt: at,
          kind: "supply_variable",
          pendingDecisionId: "pending-decision-1",
          scopeSummary: "Supply PROMO_CODE",
          sessionId: "agent-one",
          variable: { name: "PROMO_CODE", secret: false },
        },
      ],
    }),
    true
  );
  expect(variable.badge).toBe("Needs you");
  expect(variable.tone).toBe("attention");
  // Over a Takeover too: the request is what the person does next.
  expect(
    runDockPresentation(
      runSession({
        controller: "user",
        dryRun: {
          flowName: "checkout",
          recordingId: "recording-checkout",
          startedAt: at,
          variables: [
            { name: "PASSWORD", runtime: false, secret: true, supplied: false },
          ],
        },
        phase: "takeover",
      }),
      true
    ).badge
  ).toBe("Needs you");
  // An ended Run waits on nobody.
  expect(
    runDockPresentation(
      runSession({
        boundary: {
          action: { ref: "e1", type: "click" },
          description: "Place the order",
          id: "boundary-1",
          operationId: "op-1",
          reason: "confirmation",
          requested: "Click Place order",
        },
        phase: "closed",
      }),
      true
    ).badge
  ).toBe("Ended");
});
