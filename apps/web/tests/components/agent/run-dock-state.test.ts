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

test("a driven Run is live, and starting or reconnecting is busy", () => {
  expect(runDockPresentation(runSession({}), true).tone).toBe("live");
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

test("an ended Run stays neutral unless it failed", () => {
  expect(runDockPresentation(runSession({ phase: "closed" }), true).tone).toBe(
    "default"
  );
  expect(
    runDockPresentation(runSession({ phase: "completed" }), true).tone
  ).toBe("default");
  expect(
    runDockPresentation(runSession({ phase: "interrupted" }), true).tone
  ).toBe("failed");
});
